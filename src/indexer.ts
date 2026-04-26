import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { isHttpUrl, resolveStashDir } from "./common";
import type { AkmConfig, LlmConnectionConfig } from "./config";
import {
  closeDatabase,
  type DbIndexedEntry,
  deleteEntriesByDir,
  deleteEntriesByStashDir,
  getEmbeddingCount,
  getEntriesByDir,
  getEntryCount,
  getMeta,
  isVecAvailable,
  openDatabase,
  rebuildFts,
  setMeta,
  upsertEmbedding,
  upsertEntry,
  upsertUtilityScore,
  warnIfVecMissing,
} from "./db";
import { generateMetadataFlat, loadStashFile, type StashEntry, type StashFile, shouldIndexStashFile } from "./metadata";
import { getDbPath } from "./paths";
import { buildSearchText } from "./search-fields";
import type { SearchSource } from "./search-source";
import {
  classifySemanticFailure,
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  type SemanticSearchRuntimeStatus,
  writeSemanticStatus,
} from "./semantic-status";
import { ensureUsageEventsSchema, purgeOldUsageEvents } from "./usage-events";
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
  warnings?: string[];
  verification: IndexVerification;
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; walkMs: number; llmMs: number; embedMs: number; ftsMs: number };
}

export interface IndexVerification {
  ok: boolean;
  message: string;
  guidance?: string;
  semanticSearchEnabled: boolean;
  semanticSearchMode: "off" | "auto";
  semanticStatus: "disabled" | SemanticSearchRuntimeStatus;
  embeddingProvider: "local" | "remote";
  entryCount: number;
  embeddingCount: number;
  vecAvailable: boolean;
}

export interface IndexProgressEvent {
  phase: "summary" | "scan" | "llm" | "fts" | "embeddings" | "verify";
  message: string;
}

interface IndexOptions {
  stashDir?: string;
  full?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export async function akmIndex(options?: IndexOptions): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir();
  const onProgress = options?.onProgress ?? (() => {});

  // Load config and resolve all stash sources
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();

  // Ensure git stash caches are extracted before resolving stash dirs,
  // so their content directories exist on disk for the walker to discover.
  const { ensureStashCaches, resolveStashSources } = await import("./search-source.js");
  await ensureStashCaches(config);
  const allStashSources = resolveStashSources(stashDir, config);
  const allStashDirs = allStashSources.map((s) => s.path);

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
    onProgress({
      phase: "summary",
      message: buildIndexSummaryMessage({
        mode: isIncremental ? "incremental" : "full",
        stashSources: allStashDirs.length,
        semanticSearchMode: config.semanticSearchMode,
        embeddingProvider: getEmbeddingProvider(config.embedding),
        llmEnabled: !!config.llm,
        vecAvailable: isVecAvailable(db),
      }),
    });

    if (options?.full || !isIncremental) {
      // The delete is now merged into the insert transaction inside
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
    // inserts so readers never see an empty database mid-rebuild.
    const doFullDelete = options?.full || !isIncremental;
    const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm, warnings } = await indexEntries(
      db,
      allStashSources,
      isIncremental,
      builtAtMs,
      doFullDelete,
    );
    onProgress({
      phase: "scan",
      message: `Scanned ${scannedDirs} ${scannedDirs === 1 ? "directory" : "directories"} and skipped ${skippedDirs}.`,
    });

    const tWalkEnd = Date.now();

    // Enhance entries with LLM if configured
    await enhanceDirsWithLlm(db, config, dirsNeedingLlm);
    onProgress({
      phase: "llm",
      message: config.llm
        ? `LLM enhancement reviewed ${dirsNeedingLlm.length} ${dirsNeedingLlm.length === 1 ? "directory" : "directories"}.`
        : "LLM enhancement disabled.",
    });

    const tLlmEnd = Date.now();

    // Rebuild FTS after all inserts
    rebuildFts(db);
    onProgress({ phase: "fts", message: "Rebuilt full-text search index." });
    const tFtsEnd = Date.now();

    // Re-link detached usage_events to their new entry_ids via entry_ref.
    // entry_ref is "type:name" (e.g., "skill:code-review"), entry_key is "stashDir:type:name".
    // Use substr to extract the "type:name" suffix from entry_key for exact comparison
    // (avoids LIKE which would require escaping % and _ in user-facing names).
    try {
      db.exec(`
        UPDATE usage_events SET entry_id = (
          SELECT e.id FROM entries e
          WHERE substr(e.entry_key, length(e.entry_key) - length(usage_events.entry_ref)) = ':' || usage_events.entry_ref
          LIMIT 1
        )
        WHERE entry_id IS NULL AND entry_ref IS NOT NULL
      `);
    } catch {
      /* ignore if table doesn't exist yet */
    }

    // Recompute utility scores from usage_events after FTS rebuild
    recomputeUtilityScores(db);

    // Regenerate each wiki's index.md from its pages' frontmatter. Best-effort
    // — errors are caught inside regenerateAllWikiIndexes and never block the
    // index run. The primary stash is the only target: additional sources
    // are read-only caches, and regenerating their indexes would mutate
    // cache content.
    try {
      const { regenerateAllWikiIndexes } = await import("./wiki.js");
      regenerateAllWikiIndexes(stashDir);
    } catch {
      /* best-effort */
    }

    // Generate embeddings if semantic search is enabled
    const embeddingResult = await generateEmbeddingsForDb(db, config, onProgress);

    const tEmbedEnd = Date.now();

    // Update metadata
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "stashDirs", JSON.stringify(allStashDirs));
    setMeta(db, "hasEmbeddings", embeddingResult.success ? "1" : "0");

    const totalEntries = getEntryCount(db);

    // Warn on every index run if using JS fallback with many entries
    warnIfVecMissing(db);

    const tEnd = Date.now();
    const verification = verifyIndexState(db, config, totalEntries, embeddingResult);
    if (config.semanticSearchMode === "off") {
      clearSemanticStatus();
    } else {
      writeSemanticStatus({
        status: verification.semanticStatus === "disabled" ? "pending" : verification.semanticStatus,
        ...(embeddingResult.reason ? { reason: embeddingResult.reason } : {}),
        ...(embeddingResult.message ? { message: embeddingResult.message } : {}),
        providerFingerprint: deriveSemanticProviderFingerprint(config.embedding),
        lastCheckedAt: new Date().toISOString(),
        entryCount: verification.entryCount,
        embeddingCount: verification.embeddingCount,
      });
    }
    onProgress({ phase: "verify", message: verification.message });

    return {
      stashDir,
      totalEntries,
      generatedMetadata: generatedCount,
      indexPath: dbPath,
      mode: isIncremental ? "incremental" : "full",
      directoriesScanned: scannedDirs,
      directoriesSkipped: skippedDirs,
      ...(warnings.length > 0 ? { warnings } : {}),
      verification,
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
  db: Database,
  allStashSources: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  doFullDelete = false,
): Promise<{
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
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
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }> = [];

  const dirRecords: DirRecord[] = [];

  for (const stashSource of allStashSources) {
    const currentStashDir = stashSource.path;
    const fileContexts = walkStashFlat(currentStashDir);

    // Wiki-root stashes: all .md files are indexed as wiki pages under wikiName
    if (stashSource.wikiName) {
      const wikiName = stashSource.wikiName;
      const wikiDirGroups = new Map<string, { files: string[]; entries: StashEntry[] }>();
      for (const ctx of fileContexts) {
        if (ctx.ext !== ".md") continue;
        if (!shouldIndexStashFile(currentStashDir, ctx.absPath, { treatStashRootAsWikiRoot: true })) continue;
        const relNoExt = ctx.relPath.replace(/\.md$/, "");
        const entry: StashEntry = {
          name: `${wikiName}/${relNoExt}`,
          type: "wiki",
          filename: ctx.fileName,
          description: ctx.frontmatter()?.description as string | undefined,
          source: "frontmatter",
        };
        const dir = ctx.parentDirAbs;
        const group = wikiDirGroups.get(dir);
        if (group) {
          group.files.push(ctx.absPath);
          group.entries.push(entry);
        } else {
          wikiDirGroups.set(dir, { files: [ctx.absPath], entries: [entry] });
        }
      }
      for (const [dirPath, { files, entries }] of wikiDirGroups) {
        if (seenPaths.has(path.resolve(dirPath))) {
          dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true });
          continue;
        }
        seenPaths.add(path.resolve(dirPath));
        scannedDirs++;
        dirRecords.push({ dirPath, currentStashDir, files, stash: { entries }, skip: false });
      }
      continue;
    }

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
          if (generated.warnings?.length) warnings.push(...generated.warnings);
          if (generated.entries.length > 0) {
            stash = { entries: [...stash.entries, ...generated.entries] };
            generatedCount += generated.entries.length;
          }
        }
      }

      if (!stash) {
        const generated = await generateMetadataFlat(currentStashDir, files);
        if (generated.warnings?.length) warnings.push(...generated.warnings);
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
    // Perform the full-rebuild wipe as the FIRST step of the insert
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
      db.exec("DELETE FROM utility_scores");
      // Detach usage_events from entries about to be deleted — null out entry_id
      // but keep entry_ref so events can be re-linked after entries are rebuilt.
      try {
        db.exec("UPDATE usage_events SET entry_id = NULL WHERE entry_id IS NOT NULL");
      } catch {
        /* ignore if table doesn't exist */
      }
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
          if (!shouldIndexStashFile(currentStashDir, entryPath)) continue;

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

  return { scannedDirs, skippedDirs, generatedCount, warnings, dirsNeedingLlm };
}

async function enhanceDirsWithLlm(
  db: Database,
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
    const enhanced = await enhanceStashWithLlm(config.llm, generatedStash, files);

    // Re-upsert the enhanced entries in a single transaction so a crash
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
  db: Database,
  config: AkmConfig,
  onProgress: (event: IndexProgressEvent) => void,
): Promise<EmbeddingGenerationResult> {
  if (config.semanticSearchMode === "off") {
    onProgress({ phase: "embeddings", message: "Semantic search disabled; skipping embeddings." });
    return { success: false, reason: "index-missing", message: "Semantic search is disabled." };
  }

  // Detect embedding model/provider changes and purge stale embeddings
  // so that incremental reindex regenerates all vectors with the new model.
  const currentFingerprint = deriveSemanticProviderFingerprint(config.embedding);
  const storedFingerprint = getMeta(db, "embeddingFingerprint");
  if (storedFingerprint && storedFingerprint !== currentFingerprint) {
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
    setMeta(db, "hasEmbeddings", "0");
  }

  try {
    const { embedBatch } = await import("./embedder.js");
    const allEntries = getAllEntriesForEmbedding(db);
    if (allEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true };
    }
    onProgress({
      phase: "embeddings",
      message: `Generating embeddings for ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"}.`,
    });
    const texts = allEntries.map((e) => e.searchText);
    const embeddings = await embedBatch(texts, config.embedding);
    // Wrap all embedding upserts in a single transaction so partial
    // state is rolled back on failure rather than leaving the table half-filled.
    db.transaction(() => {
      for (let i = 0; i < allEntries.length; i++) {
        upsertEmbedding(db, allEntries[i].id, embeddings[i]);
      }
    })();
    onProgress({
      phase: "embeddings",
      message: `Stored ${embeddings.length} embedding${embeddings.length === 1 ? "" : "s"}.`,
    });
    setMeta(db, "embeddingFingerprint", currentFingerprint);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn("Embedding generation failed, continuing without:", message);
    onProgress({
      phase: "embeddings",
      message: `Embedding generation failed: ${message}`,
    });
    return {
      success: false,
      reason: classifySemanticFailure(message),
      message: `Semantic search verification failed: ${message}`,
    };
  }
}

interface EmbeddingGenerationResult {
  success: boolean;
  reason?: import("./semantic-status").SemanticSearchReason;
  message?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAllEntriesForEmbedding(db: Database): Array<{ id: number; searchText: string }> {
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

function buildIndexSummaryMessage(options: {
  mode: "full" | "incremental";
  stashSources: number;
  semanticSearchMode: AkmConfig["semanticSearchMode"];
  embeddingProvider: "local" | "remote";
  llmEnabled: boolean;
  vecAvailable: boolean;
}): string {
  const stashSourceLabel = options.stashSources === 1 ? "stash source" : "stash sources";
  const semanticDetail = getSemanticSearchLabel(
    options.semanticSearchMode,
    options.embeddingProvider,
    options.vecAvailable,
  );
  return `Starting ${options.mode} index (${options.stashSources} ${stashSourceLabel}, semantic search: ${semanticDetail}, LLM: ${options.llmEnabled ? "enabled" : "disabled"}).`;
}

function getEmbeddingProvider(embedding?: import("./config").EmbeddingConnectionConfig): "local" | "remote" {
  return isHttpUrl(embedding?.endpoint) ? "remote" : "local";
}

function getSemanticSearchLabel(
  semanticSearchMode: AkmConfig["semanticSearchMode"],
  embeddingProvider: "local" | "remote",
  vecAvailable: boolean,
): string {
  if (semanticSearchMode === "off") return "disabled";
  return `${embeddingProvider} embeddings, ${vecAvailable ? "sqlite-vec" : "JS fallback"}`;
}

function verifyIndexState(
  db: Database,
  config: AkmConfig,
  totalEntries: number,
  embeddingResult: EmbeddingGenerationResult,
): IndexVerification {
  const embeddingCount = getEmbeddingCount(db);
  const vecAvailable = isVecAvailable(db);
  const embeddingProvider = getEmbeddingProvider(config.embedding);

  if (totalEntries === 0) {
    return {
      ok: true,
      message: "Index ready. No assets were found yet.",
      semanticSearchEnabled: config.semanticSearchMode === "auto",
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: config.semanticSearchMode === "off" ? "disabled" : "pending",
      embeddingProvider,
      entryCount: totalEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  if (config.semanticSearchMode === "off") {
    return {
      ok: true,
      message: "Keyword index ready. Semantic search is disabled.",
      semanticSearchEnabled: false,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: "disabled",
      embeddingProvider,
      entryCount: totalEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  if (embeddingCount >= totalEntries) {
    return {
      ok: true,
      message: `Semantic search ready (${embeddingCount}/${totalEntries} embeddings, ${vecAvailable ? "sqlite-vec active" : "JS fallback active"}).`,
      semanticSearchEnabled: true,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: vecAvailable ? "ready-vec" : "ready-js",
      embeddingProvider,
      entryCount: totalEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  return {
    ok: false,
    message:
      embeddingResult.message ??
      `Semantic search verification failed (${embeddingCount}/${totalEntries} embeddings available).`,
    guidance:
      embeddingProvider === "remote"
        ? "Check your embedding endpoint and credentials, then retry `akm index --full --verbose`."
        : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/configuration.md for local embedding dependency setup.",
    semanticSearchEnabled: true,
    semanticSearchMode: config.semanticSearchMode,
    semanticStatus: "blocked",
    embeddingProvider,
    entryCount: totalEntries,
    embeddingCount,
    vecAvailable,
  };
}

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

export { buildSearchFields, buildSearchText } from "./search-fields";

// ── Utility score recomputation ──────────────────────────────────────────────

/** Retention window for usage events: events older than this are purged. */
const USAGE_EVENT_RETENTION_DAYS = 90;

/**
 * Recompute utility scores for all entries based on usage_events data.
 *
 * For each entry:
 *   - Count search appearances (event_type = 'search')
 *   - Count show events (event_type = 'show')
 *   - Count positive/negative feedback events
 *   - Compute select_rate = showCount / searchCount, clamped to [0, 1]
 *   - Convert feedback counts into a positive-only feedback_rate
 *   - Update utility via EMA from the stronger of select_rate / feedback_rate
 *
 * Also purges usage_events older than 90 days and ensures the M-1
 * usage_events table exists before querying.
 *
 * Called during `akm index` after FTS rebuild.
 */
export function recomputeUtilityScores(db: Database): void {
  const EMA_DECAY = 0.7;

  // Ensure usage_events table exists before querying
  ensureUsageEventsSchema(db);

  // Purge stale usage events (90-day retention)
  purgeOldUsageEvents(db, USAGE_EVENT_RETENTION_DAYS);

  // Time-proportional decay: apply one round of EMA per elapsed day so
  // indexing frequency doesn't affect how fast scores decay.
  const lastComputedAt = getMeta(db, "last_utility_computed_at");
  let elapsedDays = 1; // default for first run
  if (lastComputedAt) {
    const ms = Date.now() - new Date(lastComputedAt).getTime();
    elapsedDays = Math.max(1, ms / (1000 * 60 * 60 * 24));
  }
  const emaDecay = EMA_DECAY ** elapsedDays;
  const emaNew = 1 - emaDecay; // complement so weights still sum to 1

  // Single aggregate query instead of N+1 per-entry queries.
  // Only processes entries that actually have usage events.
  const usageRows = db
    .prepare(`
      SELECT entry_id,
             SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) AS search_count,
             SUM(CASE WHEN event_type = 'show'   THEN 1 ELSE 0 END) AS show_count,
             SUM(CASE WHEN event_type = 'feedback' AND signal = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
             SUM(CASE WHEN event_type = 'feedback' AND signal = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
             MAX(created_at) AS last_used_at
      FROM usage_events
      WHERE entry_id IS NOT NULL
      GROUP BY entry_id
    `)
    .all() as Array<{
    entry_id: number;
    search_count: number;
    show_count: number;
    positive_feedback_count: number;
    negative_feedback_count: number;
    last_used_at: string | null;
  }>;

  if (usageRows.length === 0) {
    setMeta(db, "last_utility_computed_at", new Date().toISOString());
    return;
  }

  // Batch-load existing utility scores
  const existingScores = new Map<number, number>();
  const scoreRows = db.prepare("SELECT entry_id, utility FROM utility_scores").all() as Array<{
    entry_id: number;
    utility: number;
  }>;
  for (const row of scoreRows) {
    existingScores.set(row.entry_id, row.utility);
  }

  for (const row of usageRows) {
    const selectRate = row.search_count > 0 ? Math.min(1, row.show_count / row.search_count) : 0;
    const feedbackTotal = row.positive_feedback_count + row.negative_feedback_count;
    const feedbackRate =
      feedbackTotal > 0 ? Math.max(0, row.positive_feedback_count - row.negative_feedback_count) / feedbackTotal : 0;
    const effectiveRate = Math.max(selectRate, feedbackRate);
    const prevUtility = existingScores.get(row.entry_id) ?? 0;
    const utility = prevUtility * emaDecay + effectiveRate * emaNew;

    upsertUtilityScore(db, row.entry_id, {
      utility,
      showCount: row.show_count,
      searchCount: row.search_count,
      selectRate,
      lastUsedAt: row.last_used_at ?? undefined,
    });
  }

  setMeta(db, "last_utility_computed_at", new Date().toISOString());
}
