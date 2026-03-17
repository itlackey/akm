import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "./common";
import type { LlmConnectionConfig } from "./config";
import {
  closeDatabase,
  DB_VERSION,
  type DbIndexedEntry,
  deleteEntriesByDir,
  deleteEntriesByStashDir,
  getEntriesByDir,
  getEntryCount,
  getMeta,
  isVecAvailable,
  openDatabase,
  rebuildFts,
  setMeta,
  upsertEmbedding,
  upsertEntry,
  warnIfVecMissing,
} from "./db";
import { generateMetadataFlat, loadStashFile, type StashEntry, type StashFile } from "./metadata";
import { getDbPath } from "./paths";
import { walkStashFlat } from "./walker";
import { warn } from "./warn";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexResponse {
  stashDir: string;
  totalEntries: number;
  generatedMetadata: number;
  indexPath: string;
  mode: "full" | "incremental";
  directoriesScanned: number;
  directoriesSkipped: number;
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; walkMs: number; llmMs: number; embedMs: number; ftsMs: number };
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export async function akmIndex(options?: { stashDir?: string; full?: boolean }): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir();

  // Load config and resolve all stash sources
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const { resolveAllStashDirs } = await import("./search-source.js");
  const allStashDirs = resolveAllStashDirs(stashDir);

  const t0 = Date.now();

  // Open database — pass embedding dimension from config if available
  const dbPath = getDbPath();
  const embeddingDim = config.embedding?.dimension;
  const db = openDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);

  try {
    // Check if we should do incremental
    const prevStashDir = getMeta(db, "stashDir");
    const prevBuiltAt = getMeta(db, "builtAt");
    const isIncremental = !options?.full && prevStashDir === stashDir && !!prevBuiltAt;
    const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;

    if (options?.full || !isIncremental) {
      // HI-5: the delete is now merged into the insert transaction inside
      // indexEntries() so that a reader never sees an empty database between
      // the wipe and the re-inserts.  The doFullDelete flag signals this path.
    } else {
      // Incremental: purge entries from stash dirs that have been removed
      // (e.g. after `akm remove`) so orphaned entries don't linger.
      const prevStashDirsJson = getMeta(db, "stashDirs");
      if (prevStashDirsJson) {
        let prevStashDirs: string[] = [];
        try {
          const parsed: unknown = JSON.parse(prevStashDirsJson);
          if (Array.isArray(parsed)) {
            prevStashDirs = parsed.filter((d): d is string => typeof d === "string");
          } else {
            warn("index_meta stashDirs value is not an array — treating as empty");
          }
        } catch {
          warn("index_meta stashDirs value is corrupt JSON — treating as empty");
        }
        const currentSet = new Set(allStashDirs);
        for (const dir of prevStashDirs) {
          if (!currentSet.has(dir)) {
            deleteEntriesByStashDir(db, dir);
          }
        }
      }
    }

    const tWalkStart = Date.now();

    // Walk stash dirs and index entries.
    // doFullDelete=true merges the wipe into the same transaction as the
    // inserts (HI-5) so readers never see an empty database mid-rebuild.
    const doFullDelete = options?.full || !isIncremental;
    const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm } = await indexEntries(
      db,
      allStashDirs,
      stashDir,
      isIncremental,
      builtAtMs,
      doFullDelete,
    );

    const tWalkEnd = Date.now();

    // Enhance entries with LLM if configured
    await enhanceDirsWithLlm(db, config, dirsNeedingLlm);

    const tLlmEnd = Date.now();

    // Rebuild FTS after all inserts
    rebuildFts(db);
    const tFtsEnd = Date.now();

    // Generate embeddings if semantic search is enabled
    const hasEmbeddings = await generateEmbeddingsForDb(db, config);

    const tEmbedEnd = Date.now();

    // Update metadata
    setMeta(db, "version", String(DB_VERSION));
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "stashDirs", JSON.stringify(allStashDirs));
    setMeta(db, "hasEmbeddings", hasEmbeddings ? "1" : "0");

    const totalEntries = getEntryCount(db);

    // Warn on every index run if using JS fallback with many entries
    warnIfVecMissing(db);

    const tEnd = Date.now();

    return {
      stashDir,
      totalEntries,
      generatedMetadata: generatedCount,
      indexPath: dbPath,
      mode: isIncremental ? "incremental" : "full",
      directoriesScanned: scannedDirs,
      directoriesSkipped: skippedDirs,
      timing: {
        totalMs: tEnd - t0,
        walkMs: tWalkEnd - tWalkStart,
        llmMs: tLlmEnd - tWalkEnd,
        embedMs: tEmbedEnd - tFtsEnd,
        ftsMs: tFtsEnd - tLlmEnd,
      },
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

async function indexEntries(
  db: import("bun:sqlite").Database,
  allStashDirs: string[],
  _stashDir: string,
  isIncremental: boolean,
  builtAtMs: number,
  doFullDelete = false,
): Promise<{
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>;
}> {
  // Phase 1 (async): walk directories and pre-generate all metadata outside the transaction.
  // generateMetadataFlat is async (uses dynamic import for matcher/renderer registry),
  // so it cannot be called inside a db.transaction() callback.
  type DirRecord = {
    dirPath: string;
    currentStashDir: string;
    files: string[];
    stash: StashFile | null;
    skip: boolean;
  };

  let scannedDirs = 0;
  let skippedDirs = 0;
  let generatedCount = 0;
  const seenPaths = new Set<string>();
  const dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }> = [];

  const dirRecords: DirRecord[] = [];

  for (const currentStashDir of allStashDirs) {
    const fileContexts = walkStashFlat(currentStashDir);

    const dirGroups = new Map<string, string[]>();
    for (const ctx of fileContexts) {
      const dir = ctx.parentDirAbs;
      const group = dirGroups.get(dir);
      if (group) group.push(ctx.absPath);
      else dirGroups.set(dir, [ctx.absPath]);
    }

    for (const [dirPath, files] of dirGroups) {
      if (seenPaths.has(path.resolve(dirPath))) {
        dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true });
        continue;
      }
      seenPaths.add(path.resolve(dirPath));

      // Incremental: skip directories that haven't changed
      if (isIncremental) {
        const prevEntries = getEntriesByDir(db, dirPath);
        if (prevEntries.length > 0 && !isDirStale(dirPath, files, prevEntries, builtAtMs)) {
          skippedDirs++;
          dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true });
          continue;
        }
      }

      scannedDirs++;

      // Try loading existing .stash.json (user metadata overrides)
      let stash = loadStashFile(dirPath);

      if (stash) {
        const coveredFiles = new Set(
          stash.entries.map((e) => (e.filename ? path.basename(e.filename) : "")).filter((e) => !!e),
        );
        const uncoveredFiles = files.filter((f) => !coveredFiles.has(path.basename(f)));
        if (uncoveredFiles.length > 0) {
          const generated = await generateMetadataFlat(currentStashDir, uncoveredFiles);
          if (generated.entries.length > 0) {
            stash = { entries: [...stash.entries, ...generated.entries] };
            generatedCount += generated.entries.length;
          }
        }
      }

      if (!stash) {
        const generated = await generateMetadataFlat(currentStashDir, files);
        if (generated.entries.length > 0) {
          stash = { entries: generated.entries };
          generatedCount += generated.entries.length;
        }
      }

      dirRecords.push({ dirPath, currentStashDir, files, stash, skip: false });
    }
  }

  // Phase 2 (sync): write all pre-generated metadata inside a single transaction.
  //
  // Cross-stash dedup: track indexed assets by content identity
  // (type + filename + description) so the same asset from a lower-priority
  // stash root is skipped when a higher-priority root already covers it.
  // Sources are ordered by priority (primary stash first), so the first
  // occurrence wins.
  const indexedAssetIdentities = new Set<string>();

  const insertTransaction = db.transaction(() => {
    // HI-5: Perform the full-rebuild wipe as the FIRST step of the insert
    // transaction so delete and re-insert are atomic — a concurrent reader
    // never observes an empty database between the two operations.
    if (doFullDelete) {
      try {
        db.exec("DELETE FROM embeddings");
      } catch {
        /* ignore */
      }
      if (isVecAvailable(db)) {
        try {
          db.exec("DELETE FROM entries_vec");
        } catch {
          /* ignore */
        }
      }
      db.exec("DELETE FROM entries_fts");
      db.exec("DELETE FROM entries");
    }

    for (const { dirPath, currentStashDir, files, stash, skip } of dirRecords) {
      if (skip) continue;

      // Delete old entries for this dir (will be re-inserted)
      deleteEntriesByDir(db, dirPath);

      if (stash) {
        // Build a lookup for matching filename-less entries to actual files
        const fileBasenameMap = buildFileBasenameMap(files);
        for (const entry of stash.entries) {
          const entryPath = entry.filename
            ? path.join(dirPath, entry.filename)
            : matchEntryToFile(entry.name, fileBasenameMap, files);
          if (!entryPath) continue; // skip unresolvable entries

          // Skip if a higher-priority stash root already indexed this asset
          const basename = path.basename(entryPath);
          const identityKey = `${entry.type}\0${basename}\0${entry.description ?? ""}`;
          if (indexedAssetIdentities.has(identityKey)) continue;
          indexedAssetIdentities.add(identityKey);

          const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
          const searchText = buildSearchText(entry);
          const entryWithSize = attachFileSize(entry, entryPath);

          upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, entryWithSize, searchText);
        }

        // Collect dirs needing LLM enhancement during the first walk
        if (stash.entries.some((e) => e.quality === "generated")) {
          dirsNeedingLlm.push({ dirPath, files, currentStashDir, stash });
        }
      }
    }
  });

  insertTransaction();

  return { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm };
}

async function enhanceDirsWithLlm(
  db: import("bun:sqlite").Database,
  config: import("./config").AkmConfig,
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>,
): Promise<void> {
  if (!config.llm || dirsNeedingLlm.length === 0) return;

  for (const { dirPath, files, currentStashDir, stash: originalStash } of dirsNeedingLlm) {
    // Only enhance generated entries; user-provided overrides should not be overwritten
    const generatedEntries = originalStash.entries.filter((e) => e.quality === "generated");
    if (generatedEntries.length === 0) continue;
    const generatedStash: StashFile = { entries: generatedEntries };
    const enhanced = await enhanceStashWithLlm(config.llm, generatedStash, dirPath, files);

    // HI-2: Re-upsert the enhanced entries in a single transaction so a crash
    // cannot leave half the entries updated and the rest stale.
    db.transaction(() => {
      for (const entry of enhanced.entries) {
        const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
        const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
        const searchText = buildSearchText(entry);
        upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, attachFileSize(entry, entryPath), searchText);
      }
    })();
  }
}

async function generateEmbeddingsForDb(
  db: import("bun:sqlite").Database,
  config: import("./config").AkmConfig,
): Promise<boolean> {
  if (!config.semanticSearch) return false;

  try {
    const { embedBatch } = await import("./embedder.js");
    const allEntries = getAllEntriesForEmbedding(db);
    if (allEntries.length === 0) return true;
    const texts = allEntries.map((e) => e.searchText);
    const embeddings = await embedBatch(texts, config.embedding);
    // HI-3: Wrap all embedding upserts in a single transaction so partial
    // state is rolled back on failure rather than leaving the table half-filled.
    db.transaction(() => {
      for (let i = 0; i < allEntries.length; i++) {
        upsertEmbedding(db, allEntries[i].id, embeddings[i]);
      }
    })();
    return true;
  } catch (error) {
    warn("Embedding generation failed, continuing without:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAllEntriesForEmbedding(db: import("bun:sqlite").Database): Array<{ id: number; searchText: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string }>;
}

function attachFileSize(entry: StashEntry, entryPath: string): StashEntry {
  try {
    return { ...entry, fileSize: fs.statSync(entryPath).size };
  } catch {
    return entry;
  }
}

/** Set of all known type directory names */
function isDirStale(
  dirPath: string,
  currentFiles: string[],
  previousEntries: DbIndexedEntry[],
  builtAtMs: number,
): boolean {
  // Check if file set changed (additions or deletions)
  const prevFileNames = new Set(previousEntries.map((ie) => ie.entry.filename).filter((e): e is string => !!e));
  const currFileNames = new Set(currentFiles.map((f) => path.basename(f)));
  if (prevFileNames.size !== currFileNames.size) return true;
  for (const name of currFileNames) {
    if (!prevFileNames.has(name)) return true;
  }

  // Check modification times of current files
  for (const file of currentFiles) {
    try {
      if (fs.statSync(file).mtimeMs > builtAtMs) return true;
    } catch {
      return true;
    }
  }

  // Check .stash.json modification time
  const stashPath = path.join(dirPath, ".stash.json");
  try {
    if (fs.statSync(stashPath).mtimeMs > builtAtMs) return true;
  } catch {
    // file doesn't exist, not stale
  }

  return false;
}

async function enhanceStashWithLlm(
  llmConfig: LlmConnectionConfig,
  stash: StashFile,
  _dirPath: string,
  files: string[],
): Promise<StashFile> {
  const { enhanceMetadata } = await import("./llm.js");

  const enhanced: StashEntry[] = [];
  for (const entry of stash.entries) {
    try {
      const entryFile = entry.filename
        ? (files.find((f) => path.basename(f) === entry.filename) ?? files[0])
        : files[0];
      let fileContent: string | undefined;
      if (entryFile) {
        try {
          fileContent = fs.readFileSync(entryFile, "utf8");
        } catch {
          /* ignore unreadable files */
        }
      }

      const improvements = await enhanceMetadata(llmConfig, entry, fileContent);
      const updated = { ...entry };
      if (improvements.description) updated.description = improvements.description;
      if (improvements.searchHints?.length) updated.searchHints = improvements.searchHints;
      if (improvements.tags?.length) updated.tags = improvements.tags;
      enhanced.push(updated);
    } catch {
      enhanced.push(entry);
    }
  }
  return { entries: enhanced };
}

/**
 * Build a map from base filename (without extension) to full path for quick lookups.
 */
export function buildFileBasenameMap(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    const base = path.basename(file, path.extname(file));
    // Only keep first match per base name to avoid ambiguity
    if (!map.has(base)) map.set(base, file);
  }
  return map;
}

/**
 * Try to match a filename-less entry to an actual file in the directory.
 *
 * Matching strategy (in priority order):
 *   1. Exact basename match: entry.name === filename without extension
 *   2. Last path segment match: for entries with names like "dir/sub-entry",
 *      try matching the last segment
 *   3. Fallback: first file in the directory, or null if no files are available
 */
export function matchEntryToFile(entryName: string, fileMap: Map<string, string>, files: string[]): string | null {
  // Exact match on entry name
  const exact = fileMap.get(entryName);
  if (exact) return exact;

  // Try last segment for hierarchical names (e.g. "corpus/agentic-patterns/foo")
  const lastSegment = entryName.split("/").pop() ?? entryName;
  if (lastSegment !== entryName) {
    const segmentMatch = fileMap.get(lastSegment);
    if (segmentMatch) return segmentMatch;
  }

  // Fallback to first file, or null if no files are available
  return files[0] || null;
}

/**
 * Return per-field search text for multi-column FTS5 indexing.
 *
 * Fields:
 *  - name: entry name with hyphens/underscores replaced by spaces
 *  - description: entry description
 *  - tags: tags + aliases joined
 *  - hints: searchHints + examples + usage + intent fields
 *  - content: TOC headings (lowest-weight catch-all)
 */
export function buildSearchFields(entry: StashEntry): {
  name: string;
  description: string;
  tags: string;
  hints: string;
  content: string;
} {
  const name = entry.name.replace(/[-_]/g, " ").toLowerCase();

  const description = (entry.description ?? "").toLowerCase();

  const tagParts: string[] = [];
  if (entry.tags) tagParts.push(entry.tags.join(" "));
  if (entry.aliases) tagParts.push(entry.aliases.join(" "));
  const tags = tagParts.join(" ").toLowerCase();

  const hintParts: string[] = [];
  if (entry.searchHints) hintParts.push(entry.searchHints.join(" "));
  if (entry.examples) hintParts.push(entry.examples.join(" "));
  if (entry.usage) hintParts.push(entry.usage.join(" "));
  if (entry.intent) {
    if (entry.intent.when) hintParts.push(entry.intent.when);
    if (entry.intent.input) hintParts.push(entry.intent.input);
    if (entry.intent.output) hintParts.push(entry.intent.output);
  }
  const hints = hintParts.join(" ").toLowerCase();

  const contentParts: string[] = [];
  if (entry.toc) {
    contentParts.push(entry.toc.map((h) => h.text).join(" "));
  }
  if (entry.parameters) {
    for (const param of entry.parameters) {
      contentParts.push(param.name);
      if (param.description) contentParts.push(param.description);
    }
  }
  const content = contentParts.join(" ").toLowerCase();

  return { name, description, tags, hints, content };
}

/**
 * Build a single concatenated search text string for an entry.
 * Used for the `search_text` column in the entries table (backward compat)
 * and for generating embedding text.
 */
export function buildSearchText(entry: StashEntry): string {
  const fields = buildSearchFields(entry);
  return [fields.name, fields.description, fields.tags, fields.hints, fields.content]
    .filter((s) => s.length > 0)
    .join(" ");
}
