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
  timing?: { totalMs: number; walkMs: number; embedMs: number; ftsMs: number };
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export async function agentikitIndex(options?: { stashDir?: string; full?: boolean }): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir();

  // Load config and resolve all stash sources
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const { resolveAllStashDirs } = await import("./stash-source.js");
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
      // Wipe all entries for full rebuild or stashDir change
      // Delete from child tables first to respect foreign key constraints
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
    } else {
      // Incremental: purge entries from stash dirs that have been removed
      // (e.g. after `akm remove`) so orphaned entries don't linger.
      const prevStashDirsJson = getMeta(db, "stashDirs");
      if (prevStashDirsJson) {
        const prevStashDirs: string[] = JSON.parse(prevStashDirsJson);
        const currentSet = new Set(allStashDirs);
        for (const dir of prevStashDirs) {
          if (!currentSet.has(dir)) {
            deleteEntriesByStashDir(db, dir);
          }
        }
      }
    }

    const tWalkStart = Date.now();

    // Walk stash dirs and index entries
    const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm } = indexEntries(
      db,
      allStashDirs,
      stashDir,
      isIncremental,
      builtAtMs,
    );

    // Enhance entries with LLM if configured
    await enhanceDirsWithLlm(db, config, dirsNeedingLlm);

    const tWalkEnd = Date.now();

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
        embedMs: tEmbedEnd - tFtsEnd,
        ftsMs: tFtsEnd - tWalkEnd,
      },
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

function indexEntries(
  db: import("bun:sqlite").Database,
  allStashDirs: string[],
  _stashDir: string,
  isIncremental: boolean,
  builtAtMs: number,
): {
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>;
} {
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

  const insertTransaction = db.transaction(() => {
    for (const currentStashDir of allStashDirs) {
      // Walk the entire stash directory — matchers classify each file
      const fileContexts = walkStashFlat(currentStashDir);

      // Group files by parent directory
      const dirGroups = new Map<string, string[]>();
      for (const ctx of fileContexts) {
        const dir = ctx.parentDirAbs;
        const group = dirGroups.get(dir);
        if (group) group.push(ctx.absPath);
        else dirGroups.set(dir, [ctx.absPath]);
      }

      for (const [dirPath, files] of dirGroups) {
        if (seenPaths.has(path.resolve(dirPath))) continue;
        seenPaths.add(path.resolve(dirPath));

        // Incremental: skip directories that haven't changed
        if (isIncremental) {
          const prevEntries = getEntriesByDir(db, dirPath);
          if (prevEntries.length > 0 && !isDirStale(dirPath, files, prevEntries, builtAtMs)) {
            skippedDirs++;
            continue;
          }
        }

        scannedDirs++;

        // Delete old entries for this dir (will be re-inserted)
        deleteEntriesByDir(db, dirPath);

        // Try loading existing .stash.json (user metadata overrides)
        let stash = loadStashFile(dirPath);

        if (stash) {
          // Check for files on disk that aren't covered by existing .stash.json entries.
          const coveredFiles = new Set(
            stash.entries.map((e) => (e.filename ? path.basename(e.filename) : "")).filter((e) => !!e),
          );
          const uncoveredFiles = files.filter((f) => !coveredFiles.has(path.basename(f)));
          if (uncoveredFiles.length > 0) {
            const generated = generateMetadataFlat(currentStashDir, uncoveredFiles);
            if (generated.entries.length > 0) {
              stash = { entries: [...stash.entries, ...generated.entries] };
              generatedCount += generated.entries.length;
            }
          }
        }

        if (!stash) {
          const generated = generateMetadataFlat(currentStashDir, files);
          if (generated.entries.length > 0) {
            stash = { entries: generated.entries };
            generatedCount += generated.entries.length;
          }
        }

        if (stash) {
          for (const entry of stash.entries) {
            const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
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
    }
  });

  insertTransaction();

  return { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm };
}

async function enhanceDirsWithLlm(
  db: import("bun:sqlite").Database,
  config: import("./config").AgentikitConfig,
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

    // Re-upsert only the enhanced (generated) entries
    for (const entry of enhanced.entries) {
      const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
      const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
      const searchText = buildSearchText(entry);
      upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, attachFileSize(entry, entryPath), searchText);
    }
  }
}

async function generateEmbeddingsForDb(
  db: import("bun:sqlite").Database,
  config: import("./config").AgentikitConfig,
): Promise<boolean> {
  if (!config.semanticSearch) return false;

  try {
    const { embedBatch } = await import("./embedder.js");
    const allEntries = getAllEntriesForEmbedding(db);
    if (allEntries.length === 0) return true;
    const texts = allEntries.map((e) => e.searchText);
    const embeddings = await embedBatch(texts, config.embedding);
    for (let i = 0; i < allEntries.length; i++) {
      upsertEmbedding(db, allEntries[i].id, embeddings[i]);
    }
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

export function buildSearchText(entry: StashEntry): string {
  const parts: string[] = [entry.name.replace(/[-_]/g, " ")];
  if (entry.description) parts.push(entry.description);
  if (entry.tags) parts.push(entry.tags.join(" "));
  if (entry.examples) parts.push(entry.examples.join(" "));
  if (entry.aliases) parts.push(entry.aliases.join(" "));
  if (entry.searchHints) parts.push(entry.searchHints.join(" "));
  if (entry.intent) {
    if (entry.intent.when) parts.push(entry.intent.when);
    if (entry.intent.input) parts.push(entry.intent.input);
    if (entry.intent.output) parts.push(entry.intent.output);
  }
  if (entry.toc) {
    parts.push(entry.toc.map((h) => h.text).join(" "));
  }
  return parts.join(" ").toLowerCase();
}
