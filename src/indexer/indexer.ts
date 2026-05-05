import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { isHttpUrl, resolveStashDir, toErrorMessage } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { getDbPath } from "../core/paths";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { resolveIndexPassLLM } from "../llm/index-passes";
import { takeWorkflowDocument } from "../workflows/document-cache";
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
  openExistingDatabase,
  rebuildFts,
  setMeta,
  upsertEmbedding,
  upsertEntry,
  upsertUtilityScore,
  warnIfVecMissing,
} from "./db";
import { runGraphExtractionPass } from "./graph-extraction";
import { runMemoryInferencePass } from "./memory-inference";
import {
  applyCuratedFrontmatter,
  applyWikiFrontmatter,
  generateMetadataFlat,
  isWorkflowSkipWarning,
  loadStashFile,
  type StashEntry,
  type StashFile,
  shouldIndexStashFile,
} from "./metadata";
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
  processed?: number;
  total?: number;
}

interface IndexOptions {
  stashDir?: string;
  full?: boolean;
  enrich?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export async function akmIndex(options?: IndexOptions): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir();
  const onProgress = options?.onProgress ?? (() => {});
  const signal = options?.signal;
  const enrich = options?.enrich === true;

  // Load config and resolve all stash sources
  const { loadConfig } = await import("../core/config.js");
  const config = loadConfig();

  // Ensure git stash caches are extracted before resolving stash dirs,
  // so their content directories exist on disk for the walker to discover.
  const { ensureSourceCaches, resolveSourceEntries } = await import("./search-source.js");
  await ensureSourceCaches(config);
  const allSourceEntries = resolveSourceEntries(stashDir, config);
  const allSourceDirs = allSourceEntries.map((s) => s.path);

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
        sourcesCount: allSourceDirs.length,
        semanticSearchMode: config.semanticSearchMode,
        embeddingProvider: getEmbeddingProvider(config.embedding),
        llmEnabled: enrich && !!resolveIndexPassLLM("enrichment", config),
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
        const currentSet = new Set(allSourceDirs);
        for (const dir of prevStashDirs) {
          if (!currentSet.has(dir)) {
            deleteEntriesByStashDir(db, dir);
          }
        }
      }
    }

    throwIfAborted(signal);

    // Memory inference pass (#201). Runs before the walk so any derived-memory
    // children that get written are picked up by the walker in this same run
    // and don't have to wait for the next `akm index`. Gated entirely by
    // `resolveIndexPassLLM("memory", config)` — when the user has no
    // `akm.llm` block or has set `index.memory.llm = false`, this is a no-op
    // and existing inferred children are left in place.
    if (enrich) {
      try {
        const inferenceResult = await runMemoryInferencePass(config, allSourceEntries, signal);
        if (inferenceResult.writtenFacts > 0) {
          onProgress({
            phase: "llm",
            message: `Memory inference wrote ${inferenceResult.writtenFacts} derived memor${inferenceResult.writtenFacts === 1 ? "y" : "ies"} from ${inferenceResult.splitParents} parent memor${inferenceResult.splitParents === 1 ? "y" : "ies"}.`,
          });
        }
      } catch (err) {
        warn(`Memory inference pass aborted: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      onProgress({
        phase: "llm",
        message: "LLM passes disabled; rerun with --enrich to enable inference and enrichment.",
      });
    }

    // Graph extraction pass (#207). Runs after memory inference so any
    // atomic-fact children that just got written are visible to the graph
    // walk. Persists `<stashRoot>/.akm/graph.json` — an indexer artifact,
    // NOT a user-visible asset, so it is not routed through
    // writeAssetToSource. The artifact feeds the existing FTS5+boosts
    // pipeline as a single boost component (see graph-boost.ts); there is
    // no parallel scoring track. Disabled when either gate (the locked
    // `llm.features.graph_extraction` feature flag or the per-pass
    // `index.graph.llm` toggle) is off; the existing graph file is
    // preserved on disk in that case.
    if (enrich) {
      try {
        const graphResult = await runGraphExtractionPass(config, allSourceEntries, signal);
        if (graphResult.written) {
          onProgress({
            phase: "llm",
            message: `Graph extraction wrote ${graphResult.totalEntities} entit${graphResult.totalEntities === 1 ? "y" : "ies"} and ${graphResult.totalRelations} relation${graphResult.totalRelations === 1 ? "" : "s"} from ${graphResult.extracted} file${graphResult.extracted === 1 ? "" : "s"}.`,
          });
        }
      } catch (err) {
        warn(`Graph extraction pass aborted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throwIfAborted(signal);

    const tWalkStart = Date.now();

    // Walk stash dirs and index entries.
    // doFullDelete=true merges the wipe into the same transaction as the
    // inserts so readers never see an empty database mid-rebuild.
    const doFullDelete = options?.full || !isIncremental;
    const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm, warnings } = await indexEntries(
      db,
      allSourceEntries,
      isIncremental,
      builtAtMs,
      doFullDelete,
      onProgress,
    );
    onProgress({
      phase: "scan",
      message: `Scanned ${scannedDirs} ${scannedDirs === 1 ? "directory" : "directories"} and skipped ${skippedDirs}.`,
    });

    // Workflow validation noise gate (issue #273): per-spec stderr lines from
    // `buildMetadataSkipWarning` are suppressed at default verbosity in
    // `metadata.ts`. Replace them with a single summary line so operators
    // running a cold-start search against a fresh registry-cloned source
    // don't get the impression akm is broken. Verbose mode keeps the
    // per-spec output instead of (not in addition to) the summary.
    if (!isVerbose()) {
      const skippedWorkflowCount = warnings.filter(isWorkflowSkipWarning).length;
      if (skippedWorkflowCount > 0) {
        const noun = skippedWorkflowCount === 1 ? "workflow spec" : "workflow specs";
        warn(
          `${skippedWorkflowCount} ${noun} skipped due to validation errors; ` +
            "rerun with --verbose (or AKM_VERBOSE=1) to see details.",
        );
      }
    }

    const tWalkEnd = Date.now();

    throwIfAborted(signal);

    // Enhance entries with LLM if configured
    await enhanceDirsWithLlm(db, config, dirsNeedingLlm, signal, enrich);
    onProgress({
      phase: "llm",
      message:
        enrich && resolveIndexPassLLM("enrichment", config)
          ? `LLM enhancement reviewed ${dirsNeedingLlm.length} ${dirsNeedingLlm.length === 1 ? "directory" : "directories"}.`
          : "LLM enhancement disabled.",
    });

    const tLlmEnd = Date.now();

    throwIfAborted(signal);

    // Rebuild FTS after all inserts. Use incremental mode when this whole
    // index run is incremental — only entries touched by `upsertEntry`
    // since the last rebuild are re-indexed, instead of re-scanning every
    // row on every `akm index` invocation.
    rebuildFts(db, { incremental: isIncremental });
    onProgress({
      phase: "fts",
      message: isIncremental ? "Rebuilt full-text search index (dirty rows only)." : "Rebuilt full-text search index.",
    });
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
      const { regenerateAllWikiIndexes } = await import("../wiki/wiki.js");
      regenerateAllWikiIndexes(stashDir);
    } catch {
      /* best-effort */
    }

    throwIfAborted(signal);

    // Generate embeddings if semantic search is enabled
    const embeddingResult = await generateEmbeddingsForDb(db, config, onProgress);

    const tEmbedEnd = Date.now();

    // Update metadata
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "stashDirs", JSON.stringify(allSourceDirs));
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
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  doFullDelete = false,
  onProgress?: (event: IndexProgressEvent) => void,
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
  let processedDirs = 0;

  const reportScanProgress = (message: string) => {
    onProgress?.({
      phase: "scan",
      message,
      processed: processedDirs,
      total: allSourceEntries.length,
    });
  };

  for (const sourceAdded of allSourceEntries) {
    const currentStashDir = sourceAdded.path;
    const fileContexts = walkStashFlat(currentStashDir);
    processedDirs++;
    reportScanProgress(
      `Processed ${processedDirs}/${allSourceEntries.length} source${allSourceEntries.length === 1 ? "" : "s"}.`,
    );

    // Wiki-root stashes: all .md files are indexed as wiki pages under wikiName
    if (sourceAdded.wikiName) {
      const wikiName = sourceAdded.wikiName;
      const wikiDirGroups = new Map<string, { files: string[]; entries: StashEntry[] }>();
      for (const ctx of fileContexts) {
        if (ctx.ext !== ".md") continue;
        if (!shouldIndexStashFile(currentStashDir, ctx.absPath, { treatStashRootAsWikiRoot: true })) continue;
        const relNoExt = ctx.relPath.replace(/\.md$/, "");
        const frontmatter = ctx.frontmatter() ?? {};
        const entry: StashEntry = {
          name: `${wikiName}/${relNoExt}`,
          type: "wiki",
          filename: ctx.fileName,
          quality: "generated",
          confidence: 0.55,
          source: "filename",
        };
        applyCuratedFrontmatter(entry, frontmatter);
        applyWikiFrontmatter(entry, frontmatter);
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

        if (isIncremental) {
          const prevEntries = getEntriesByDir(db, dirPath);
          if (prevEntries.length > 0 && !isDirStale(dirPath, files, prevEntries, builtAtMs)) {
            skippedDirs++;
            dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true });
            continue;
          }
        }

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
      const indexableFiles = files.filter((file) => shouldIndexStashFile(currentStashDir, file));

      if (seenPaths.has(path.resolve(dirPath))) {
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true });
        continue;
      }
      seenPaths.add(path.resolve(dirPath));

      if (indexableFiles.length === 0) {
        skippedDirs++;
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true });
        continue;
      }

      // Incremental: skip directories that haven't changed
      if (isIncremental) {
        const prevEntries = getEntriesByDir(db, dirPath);
        if (prevEntries.length > 0 && !isDirStale(dirPath, indexableFiles, prevEntries, builtAtMs)) {
          skippedDirs++;
          dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true });
          continue;
        }
      }

      scannedDirs++;

      const generated = await generateMetadataFlat(currentStashDir, indexableFiles);
      if (generated.warnings?.length) warnings.push(...generated.warnings);

      const legacyOverrides = loadStashFile(dirPath, { requireFilename: true });
      const mergedEntries = legacyOverrides
        ? generated.entries.map((entry) => mergeLegacyEntry(entry, legacyOverrides.entries))
        : generated.entries;

      if (generated.entries.length > 0) {
        generatedCount += generated.entries.length;
      }

      const stash = mergedEntries.length > 0 ? { entries: mergedEntries } : legacyOverrides;

      dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash, skip: false });
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
        for (const entry of stash.entries) {
          const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
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

          const entryId = upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, entryWithSize, searchText);

          if (entry.type === "workflow") {
            const doc = takeWorkflowDocument(entry);
            if (doc) {
              upsertWorkflowDocument(db, entryId, doc, fs.readFileSync(entryPath));
            }
          }
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
  config: import("../core/config").AkmConfig,
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>,
  signal?: AbortSignal,
  enrich = false,
): Promise<void> {
  if (!enrich) return;

  // Resolve per-pass LLM config via the unified shim. Returns undefined when
  // either no `akm.llm` is configured or the user opted this pass out via
  // `index.enrichment.llm = false`. (#208)
  const llmConfig = resolveIndexPassLLM("enrichment", config);
  if (!llmConfig || dirsNeedingLlm.length === 0) return;

  // Aggregate per-entry failures so a misconfigured LLM endpoint surfaces
  // as a single visible warning instead of silently degrading every entry
  // and leaving the user wondering why nothing got enhanced.
  const summary: LlmEnhancementSummary = { attempted: 0, succeeded: 0, failureSamples: [] };

  for (const { dirPath, files, currentStashDir, stash: originalStash } of dirsNeedingLlm) {
    throwIfAborted(signal);
    // Only enhance generated entries; user-provided overrides should not be overwritten
    const generatedEntries = originalStash.entries.filter((e) => e.quality === "generated");
    if (generatedEntries.length === 0) continue;
    const generatedStash: StashFile = { entries: generatedEntries };
    const enhanced = await enhanceStashWithLlm(llmConfig, generatedStash, files, summary, signal);

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

  if (summary.attempted > 0 && summary.succeeded === 0) {
    const sample = summary.failureSamples.length ? ` Example: ${summary.failureSamples[0]}` : "";
    warn(
      `LLM enhancement failed for all ${summary.attempted} attempted entries — index built without LLM enrichment.` +
        ` Check llm.endpoint and llm.model in your config.${sample}`,
    );
  } else if (summary.attempted > 0 && summary.succeeded < summary.attempted) {
    const failed = summary.attempted - summary.succeeded;
    const sample = summary.failureSamples.length ? ` Examples: ${summary.failureSamples.join("; ")}` : "";
    warn(`LLM enhancement failed for ${failed}/${summary.attempted} entries — they were left un-enhanced.${sample}`);
  }
}

async function generateEmbeddingsForDb(
  db: Database,
  config: AkmConfig,
  onProgress: (event: IndexProgressEvent) => void,
  signal?: AbortSignal,
): Promise<EmbeddingGenerationResult> {
  throwIfAborted(signal);

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
    const { embedBatch } = await import("../llm/embedder.js");
    const { estimateTokenCount } = await import("../llm/embedders/remote.js");
    throwIfAborted(signal);
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

    // Verbose: log each document before it is sent to the embedding API so
    // operators can see exactly where embedding fails without waiting for an error.
    if (isVerbose()) {
      const EMBED_BATCH_SIZE = 100; // mirrors REMOTE_BATCH_SIZE in remote.ts
      const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);
      for (let i = 0; i < texts.length; i++) {
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        const chars = texts[i].length;
        const tokens = estimateTokenCount(texts[i]);
        const ref = allEntries[i].entryKey.split(":").slice(1).join(":"); // strip stashDir prefix
        warnVerbose(`[embed] ${ref} (${chars} chars, est. ${tokens} tokens) → batch ${batchNum}/${totalBatches}`);
      }
    }

    const embeddings = await embedBatch(texts, config.embedding, signal);
    throwIfAborted(signal);
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

function getAllEntriesForEmbedding(
  db: Database,
): Array<{ id: number; searchText: string; entryKey: string; filePath: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText, e.entry_key AS entryKey, e.file_path AS filePath FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string; entryKey: string; filePath: string }>;
}

function attachFileSize(entry: StashEntry, entryPath: string): StashEntry {
  try {
    return { ...entry, fileSize: fs.statSync(entryPath).size };
  } catch {
    return entry;
  }
}

function upsertWorkflowDocument(
  db: Database,
  entryId: number,
  doc: import("../workflows/schema").WorkflowDocument,
  content: Buffer,
): void {
  const sourceHash = computeSourceHash(content);
  db.prepare(
    `INSERT INTO workflow_documents (entry_id, schema_version, document_json, source_path, source_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       document_json = excluded.document_json,
       source_path = excluded.source_path,
       source_hash = excluded.source_hash,
       updated_at = excluded.updated_at`,
  ).run(entryId, doc.schemaVersion, JSON.stringify(doc), doc.source.path, sourceHash, new Date().toISOString());
}

function computeSourceHash(content: Buffer): string {
  // Cheap, stable identity for the source markdown — used by future
  // incremental fast-paths that skip re-validation when content is unchanged.
  // Not security-sensitive; FNV-1a over the bytes is sufficient.
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function buildIndexSummaryMessage(options: {
  mode: "full" | "incremental";
  sourcesCount: number;
  semanticSearchMode: AkmConfig["semanticSearchMode"];
  embeddingProvider: "local" | "remote";
  llmEnabled: boolean;
  vecAvailable: boolean;
}): string {
  const stashSourceLabel = options.sourcesCount === 1 ? "stash source" : "stash sources";
  const semanticDetail = getSemanticSearchLabel(
    options.semanticSearchMode,
    options.embeddingProvider,
    options.vecAvailable,
  );
  return `Starting ${options.mode} index (${options.sourcesCount} ${stashSourceLabel}, semantic search: ${semanticDetail}, LLM: ${options.llmEnabled ? "enabled" : "disabled"}).`;
}

function getEmbeddingProvider(embedding?: import("../core/config").EmbeddingConnectionConfig): "local" | "remote" {
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
  const prevFileNames = new Set(
    previousEntries
      .map((ie) => {
        const fromPath = path.basename(ie.filePath);
        return fromPath || ie.entry.filename;
      })
      .filter((e): e is string => !!e),
  );
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

  // Check legacy .stash.json modification time so explicit-file overrides still reindex.
  const stashPath = path.join(dirPath, ".stash.json");
  try {
    if (fs.statSync(stashPath).mtimeMs > builtAtMs) return true;
  } catch {
    // file doesn't exist, not stale
  }

  return false;
}

interface LlmEnhancementSummary {
  attempted: number;
  succeeded: number;
  /** Sample of error messages from failed entries (first 3, deduped). */
  failureSamples: string[];
}

async function enhanceStashWithLlm(
  llmConfig: LlmConnectionConfig,
  stash: StashFile,
  files: string[],
  summary: LlmEnhancementSummary,
  signal?: AbortSignal,
): Promise<StashFile> {
  const { enhanceMetadata } = await import("../llm/metadata-enhance");

  const enhanced: StashEntry[] = [];
  for (const entry of stash.entries) {
    throwIfAborted(signal);
    summary.attempted++;
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

      const improvements = await enhanceMetadata(llmConfig, entry, fileContent, signal);
      const updated = { ...entry };
      if (improvements.description) updated.description = improvements.description;
      if (improvements.searchHints?.length) updated.searchHints = improvements.searchHints;
      if (improvements.tags?.length) updated.tags = improvements.tags;
      enhanced.push(updated);
      summary.succeeded++;
    } catch (err) {
      enhanced.push(entry);
      const msg = toErrorMessage(err);
      // failureSamples is bounded to 3 items, so a linear scan is cheaper
      // than maintaining a parallel Set for membership checks (#177 review).
      if (summary.failureSamples.length < 3 && !summary.failureSamples.includes(msg)) {
        summary.failureSamples.push(msg);
      }
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
 *   3. No implicit file fallback: ambiguous legacy entries are skipped
 */
export function matchEntryToFile(entryName: string, fileMap: Map<string, string>, _files: string[]): string | null {
  // Exact match on entry name
  const exact = fileMap.get(entryName);
  if (exact) return exact;

  // Try last segment for hierarchical names (e.g. "corpus/agentic-patterns/foo")
  const lastSegment = entryName.split("/").pop() ?? entryName;
  if (lastSegment !== entryName) {
    const segmentMatch = fileMap.get(lastSegment);
    if (segmentMatch) return segmentMatch;
  }

  return null;
}

function mergeLegacyEntry(entry: StashEntry, legacyEntries: StashEntry[]): StashEntry {
  const legacy = legacyEntries.find((candidate) => candidate.filename === entry.filename);
  if (!legacy) return entry;

  return {
    ...entry,
    ...legacy,
    filename: entry.filename,
    source: legacy.source ?? entry.source,
    quality: legacy.quality ?? entry.quality,
    confidence: legacy.confidence ?? entry.confidence,
  };
}

// `buildSearchFields` and `buildSearchText` were previously re-exported from
// here for backwards compatibility. Importers should now pull them directly
// from `./search-fields` to avoid loading the indexer's full dependency
// graph (LLM client, embedder facade) when only the text builder is needed.

// ── lookup ─────────────────────────────────────────────────────────────────

import type { AssetRef } from "../core/asset-ref";

export interface IndexEntry {
  /** Absolute path of the indexed file on disk. */
  filePath: string;
  /** Source root (the directory the walker rooted at). */
  stashDir: string;
  /** Raw entry_key from the entries table — `${stashDir}:${type}:${name}`. */
  entryKey: string;
  /** Asset type (skill, command, knowledge, ...). */
  type: string;
  /** Asset name as recorded by the indexer. */
  name: string;
}

/**
 * Look up a single asset by ref. Spec §6.2 — `akm show` queries this and
 * reads the file from disk. The index is the source of truth for which
 * file corresponds to which ref; the indexer walks `provider.path()` for
 * every configured source, so this query covers all source kinds.
 *
 * Match rules:
 *   - `ref.origin === undefined` → first match across all sources (primary
 *     source first, then in declared order — same priority as the indexer's
 *     write order).
 *   - `ref.origin === "local"`   → primary source only (entry_key prefix is
 *     the primary stash dir).
 *   - `ref.origin === <name>`    → restrict to the matching source name. We
 *     resolve the source's directory and match on `entry_key` prefix.
 *
 * Returns `null` when no row matches — callers translate that into a
 * `NotFoundError` with their own messaging.
 */
export async function lookup(ref: AssetRef): Promise<IndexEntry | null> {
  const { loadConfig } = await import("../core/config.js");
  const { resolveSourceEntries } = await import("./search-source.js");
  const config = loadConfig();
  const sources = resolveSourceEntries(undefined, config);
  if (sources.length === 0) return null;

  const dbPath = getDbPath();
  const db = openExistingDatabase(dbPath);
  try {
    // entry_key shape: `${stashDir}:${type}:${name}`. Suffix-match on
    // `:type:name` so we can scope by source dir as a prefix when origin is
    // supplied. Use parameterised queries throughout — names may include
    // user-supplied glob characters.
    const escapeLike = (value: string): string =>
      value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const suffix = `:${ref.type}:${ref.name}`;
    const escapedSuffix = escapeLike(suffix);

    const candidateDirs: string[] = (() => {
      if (!ref.origin) return sources.map((s) => s.path);
      if (ref.origin === "local") return [sources[0].path];
      const named = sources.find((s) => s.registryId === ref.origin);
      return named ? [named.path] : [];
    })();

    if (candidateDirs.length === 0) return null;

    for (const dir of candidateDirs) {
      const escapedDir = escapeLike(dir);
      const row = db
        .prepare(
          "SELECT entry_key AS entryKey, file_path AS filePath, stash_dir AS stashDir, entry_type AS type FROM entries " +
            "WHERE entry_key LIKE ? ESCAPE '\\' AND entry_type = ? LIMIT 1",
        )
        .get(`${escapedDir}${escapedSuffix}`, ref.type) as
        | { entryKey: string; filePath: string; stashDir: string; type: string }
        | undefined;
      if (row) {
        return {
          entryKey: row.entryKey,
          filePath: row.filePath,
          stashDir: row.stashDir,
          type: row.type,
          name: ref.name,
        };
      }
    }
    return null;
  } finally {
    closeDatabase(db);
  }
}

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
