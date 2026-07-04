// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { SCRIPT_EXTENSIONS } from "../core/asset/asset-spec";
import { isHttpUrl, resolveStashDir, toErrorMessage } from "../core/common";
import { concurrentMap } from "../core/concurrent";
import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { getDbPath } from "../core/paths";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { resolveIndexPassLLM } from "../llm/index-passes";
/**
 * M-4 / #395 — Index Consistency Architecture Decision Record
 *
 * AKM maintains four indexes per stash:
 *   1. Frontmatter index (SQLite `entries` table) — asset metadata.
 *   2. FTS5 full-text search index (SQLite `entries_fts` virtual table).
 *   3. Vector (embedding) index (SQLite `embedding` / `vec_entries` table).
 *   4. Graph index (SQLite `graph_nodes`, `graph_edges` tables).
 *
 * Decision (2026-05-16): No transactional boundary spans all four indexes.
 * Each step is individually crash-tolerant; cross-step consistency is
 * **opportunistic recovery** — subsequent index runs detect and heal drift.
 *
 * Audit findings:
 *   - FTS5 is redundant with the main `entries` table when semantic search is
 *     on, but is the primary search path for keyword-only stashes.
 *   - The vector index depends on the `entries` table for entry IDs; orphan
 *     detection in `clearStaleCacheEntries` covers most drift cases.
 *   - The graph index is rebuilt from scratch on each extraction pass; it is
 *     not incremental, so cross-step drift resolves on the next extraction.
 *   - Eliminating any of the four indexes would break the current keyword/
 *     semantic/graph search paths. Merge is not currently feasible.
 *
 * Accepted strategy: opportunistic recovery (reindex heals drift).
 * CRDT-based convergence (Shapiro et al. 2011) would require per-operation
 * CRDTs for all four stores — deferred pending a dedicated storage refactor.
 *
 * See docs/technical/index-consistency-adr.md for the full analysis.
 */
import type { Database } from "../storage/database";
import { takeWorkflowDocument } from "../workflows/runtime/document-cache";
import {
  clearStaleCacheEntries,
  closeDatabase,
  deleteEntriesByDir,
  deleteEntriesByIds,
  deleteEntriesByStashDir,
  deleteIndexDirStatesByStashDir,
  getAllEntriesForEmbedding,
  getEmbeddableEntryCount,
  getEmbeddingCount,
  getEntryCount,
  getMeta,
  isVecAvailable,
  openExistingDatabase,
  openIndexDatabase,
  purgeEmbeddings,
  rebuildFts,
  relinkUsageEvents,
  setMeta,
  upsertEmbedding,
  upsertEntry,
  upsertIndexDirState,
  upsertUtilityScore,
  upsertWorkflowDocument,
  warnIfVecMissing,
} from "./db/db";
import { deleteStoredGraph } from "./db/graph-db";
import { withIndexWriterLease } from "./index-writer-lock";
import {
  canUseIncrementalSkip,
  computeDirFingerprint,
  getCachedZeroRowDirState,
  getDirIndexState,
  inferZeroRowReason,
} from "./passes/dir-staleness";
import {
  applyCuratedFrontmatter,
  applyWikiFrontmatter,
  generateMetadataFlat,
  isEnrichmentComplete,
  isWorkflowSkipWarning,
  loadStashFile,
  type StashEntry,
  type StashFile,
  shouldIndexStashFile,
} from "./passes/metadata";
import { buildSearchText } from "./search/search-fields";
import type { SearchSource } from "./search/search-source";
import {
  classifySemanticFailure,
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  writeSemanticStatus,
} from "./search/semantic-status";
import { ensureUsageEventsSchema, purgeOldUsageEvents } from "./usage/usage-events";
import type { IndexRunContext, IndexVerification } from "./walk/index-context";
import { walkStashFlat } from "./walk/walker";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexCleanResult {
  /** Number of entries checked for disk presence. */
  checked: number;
  /** Number of entries deleted (0 when dryRun is true). */
  removed: number;
  /** Refs of entries whose source file was missing (also populated in dry-run). */
  removedRefs: string[];
  /** Whether the run was a dry-run (no deletions performed). */
  dryRun: boolean;
}

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
  graphQuality?: {
    consideredFiles: number;
    extractedFiles: number;
    entityCount: number;
    relationCount: number;
    extractionCoverage: number;
    density: number;
  };
  /** Timing counters in milliseconds */
  timing?: {
    totalMs: number;
    walkMs: number;
    llmMs: number;
    embedMs: number;
    ftsMs: number;
    finalizeMs: number;
    cleanMs: number;
    preflightMs: number;
    leaseWaitMs: number;
    sourceCacheMs: number;
    endToEndMs: number;
  };
  /** Present when --clean was passed: stale-entry purge results. */
  clean?: IndexCleanResult;
}

export interface IndexProgressEvent {
  phase: "summary" | "preflight" | "scan" | "llm" | "embeddings" | "fts" | "finalize" | "verify";
  message: string;
  processed?: number;
  total?: number;
}

interface IndexOptions {
  stashDir?: string;
  full?: boolean;
  /**
   * When true, re-enrich all entries regardless of quality (including already
   * `"enriched"` entries). Default: false — already-enriched entries are skipped.
   */
  reEnrich?: boolean;
  /**
   * When true, run a post-pass after indexing that removes entries whose source
   * file no longer exists on disk. Remote entries (empty file_path) are skipped.
   */
  clean?: boolean;
  /**
   * When true (and `clean` is also true), report which entries would be removed
   * without actually deleting them.
   */
  dryRun?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
}

interface IndexedDirCandidate {
  stash: StashFile | null;
  staleFiles: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

function getDefaultLlmConcurrency(llmConfig?: LlmConnectionConfig): number {
  if (typeof llmConfig?.concurrency === "number") return llmConfig.concurrency;
  if (!llmConfig?.endpoint) return 1;
  try {
    const url = new URL(llmConfig.endpoint);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) return 1;
  } catch {
    return 1;
  }
  return 4;
}

// ── Phase functions ──────────────────────────────────────────────────────────

/**
 * Source cache phase: ensure git stash caches are up to date and purge orphaned
 * entries from removed sources (incremental only).
 */
async function runSourceCachePhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, sourceDirs, isIncremental, full } = ctx;

  if (isIncremental && !full) {
    // Purge entries from stash dirs that have been removed since the last run
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
      const currentSet = new Set(sourceDirs);
      for (const dir of prevStashDirs) {
        if (!currentSet.has(dir)) {
          ctx.hadRemovedSources = true;
          deleteEntriesByStashDir(db, dir);
          deleteIndexDirStatesByStashDir(db, dir);
          deleteStoredGraph(db, dir);
        }
      }
    }
  }
  // Source caches are hydrated before akmIndex() calls this phase; nothing
  // further to do here. The flag is exposed on ctx for runWalkPhase().
  void config;
}

/**
 * Walk phase: scan the filesystem, generate metadata, and persist entries to
 * the database. Also kicks off LLM enrichment for directories that need it.
 *
 * Writes `ctx.scannedDirs`, `ctx.skippedDirs`, `ctx.generatedCount`,
 * `ctx.walkWarnings`, and `ctx.dirsNeedingLlm` for downstream phases.
 */
async function runWalkPhase(ctx: IndexRunContext): Promise<void> {
  const { db, sources, isIncremental, builtAtMs, hadRemovedSources, full, reEnrich, signal, onProgress, config } = ctx;

  throwIfAborted(signal);

  ctx.timing.tWalkStart = Date.now();

  const doFullDelete = full || !isIncremental;
  const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm, warnings } = await indexEntries(
    db,
    sources,
    isIncremental,
    builtAtMs,
    hadRemovedSources,
    doFullDelete,
    onProgress,
  );

  ctx.scannedDirs = scannedDirs;
  ctx.skippedDirs = skippedDirs;
  ctx.generatedCount = generatedCount;
  ctx.walkWarnings = warnings;
  ctx.dirsNeedingLlm = dirsNeedingLlm;

  onProgress({
    phase: "scan",
    message: `Scanned ${scannedDirs} ${scannedDirs === 1 ? "directory" : "directories"} and skipped ${skippedDirs}.`,
  });

  // Workflow validation noise gate (issue #273): suppress per-spec stderr lines
  // at default verbosity and emit a single summary instead.
  // In verbose mode the per-spec lines are already printed by
  // buildMetadataSkipWarning at generation time — no second pass needed here.
  if (!isVerbose()) {
    const workflowSkipWarnings = warnings.filter(isWorkflowSkipWarning);
    const skippedWorkflowCount = workflowSkipWarnings.length;
    if (skippedWorkflowCount > 0) {
      const noun = skippedWorkflowCount === 1 ? "workflow spec" : "workflow specs";
      warn(
        `${skippedWorkflowCount} ${noun} skipped due to validation errors; ` +
          "rerun with --verbose (or AKM_VERBOSE=1) to see details.",
      );
    }
  }

  ctx.timing.tWalkEnd = Date.now();

  throwIfAborted(signal);

  // LLM enrichment for directories that need it
  await enhanceDirsWithLlm(db, config, dirsNeedingLlm, onProgress, signal, reEnrich);
  onProgress({
    phase: "llm",
    message: resolveIndexPassLLM("enrichment", config)
      ? `LLM enhancement reviewed ${dirsNeedingLlm.length} ${dirsNeedingLlm.length === 1 ? "directory" : "directories"}.`
      : "LLM enhancement disabled.",
  });

  ctx.timing.tLlmEnd = Date.now();
}

/**
 * Embedding phase: generate and store vector embeddings for all unembedded
 * entries. Writes `ctx.embeddingResult` for the finalize phase.
 */
async function runEmbeddingPhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, signal, onProgress } = ctx;

  throwIfAborted(signal);

  ctx.embeddingResult = await generateEmbeddingsForDb(db, config, onProgress);
  ctx.timing.tEmbedEnd = Date.now();
}

/**
 * Finalize phase: rebuild FTS, re-link usage events, recompute utility scores,
 * regenerate wiki indexes, update index metadata, and emit the verify event.
 */
async function runFinalizePhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, sources, sourceDirs, isIncremental, stashDir, signal, onProgress } = ctx;
  ctx.timing.tFinalizeStart = Date.now();

  // Rebuild FTS after all inserts. Use incremental mode when this whole
  // index run is incremental — only entries touched by `upsertEntry`
  // since the last rebuild are re-indexed.
  rebuildFts(db, { incremental: isIncremental });
  onProgress({
    phase: "fts",
    message: isIncremental ? "Rebuilt full-text search index (dirty rows only)." : "Rebuilt full-text search index.",
  });
  ctx.timing.tFtsEnd = Date.now();

  // Re-link detached usage_events and recompute utility scores.
  onProgress({ phase: "finalize", message: "Relinking usage events." });
  relinkUsageEvents(db);
  onProgress({ phase: "finalize", message: "Recomputing utility scores." });
  recomputeUtilityScores(db);

  // Purge LLM cache entries for assets that no longer exist in the index.
  try {
    onProgress({ phase: "finalize", message: "Clearing stale LLM cache entries." });
    clearStaleCacheEntries(db);
  } catch {
    /* ignore */
  }

  // Regenerate each wiki's index.md from its pages' frontmatter. Best-effort.
  try {
    onProgress({ phase: "finalize", message: "Regenerating wiki indexes." });
    const { regenerateAllWikiIndexes } = await import("../wiki/wiki.js");
    regenerateAllWikiIndexes(stashDir);
  } catch {
    /* best-effort */
  }

  throwIfAborted(signal);

  // Update index metadata
  const embeddingResult = ctx.embeddingResult ?? { success: false };
  setMeta(db, "builtAt", new Date().toISOString());
  setMeta(db, "stashDir", stashDir);
  setMeta(db, "stashDirs", JSON.stringify(sourceDirs));
  setMeta(db, "hasEmbeddings", embeddingResult.success ? "1" : "0");

  warnIfVecMissing(db);

  const totalEntries = getEntryCount(db);
  const semanticEntryCount = getEmbeddableEntryCount(db);
  onProgress({ phase: "finalize", message: "Verifying semantic search state." });
  const verification = verifyIndexState(db, config, semanticEntryCount, embeddingResult);

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

  // Store verification result and totalEntries on ctx for the caller to use
  ctx.verification = verification;
  ctx.totalEntries = totalEntries;
  ctx.timing.tFinalizeEnd = Date.now();

  // suppress unused warning — sources was previously used inline
  void sources;
}

// ── Clean pass ───────────────────────────────────────────────────────────────

/**
 * Post-index clean pass: scan the `entries` table for rows whose source file
 * no longer exists on disk and remove them (unless `dryRun` is true).
 *
 * Only rows with a non-empty `file_path` are checked — remote/virtual entries
 * that have no local path are always skipped.
 */
function runCleanPass(db: Database, dryRun: boolean): IndexCleanResult {
  const allEntries = db.prepare("SELECT id, entry_key AS ref, file_path AS path FROM entries").all() as {
    id: number;
    ref: string;
    path: string;
  }[];

  // Only check entries that have a non-empty local path (skip remote/virtual).
  const localEntries = allEntries.filter((e) => typeof e.path === "string" && e.path.trim() !== "");

  const missing = localEntries.filter((e) => !fs.existsSync(e.path));

  if (!dryRun && missing.length > 0) {
    deleteEntriesByIds(
      db,
      missing.map((e) => e.id),
    );
  }

  return {
    checked: localEntries.length,
    removed: dryRun ? 0 : missing.length,
    removedRefs: missing.map((e) => e.ref),
    dryRun,
  };
}

// ── Indexer ──────────────────────────────────────────────────────────────────

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let akmIndexOverride: typeof akmIndexReal | undefined;

/** TEST-ONLY. Swap the implementation of `akmIndex`; pass undefined to restore. */
export function _setAkmIndexForTests(fake?: typeof akmIndexReal): void {
  akmIndexOverride = fake;
}

export async function akmIndex(options?: IndexOptions): Promise<IndexResponse> {
  if (akmIndexOverride) return akmIndexOverride(options);
  return akmIndexReal(options);
}

async function akmIndexReal(options?: IndexOptions): Promise<IndexResponse> {
  const requestedAt = Date.now();
  let acquiredAt = requestedAt;
  return withIndexWriterLease(
    {
      purpose: "akm-index",
      signal: options?.signal,
      onWait: ({ waitedMs }) => {
        options?.onProgress?.({
          phase: "preflight",
          message: `Waiting for index writer lease (${Math.round(waitedMs / 1000)}s elapsed).`,
        });
      },
      onAcquired: ({ waitedMs }) => {
        acquiredAt = requestedAt + waitedMs;
      },
    },
    async () => {
      const stashDir = options?.stashDir || resolveStashDir();
      const onProgress = options?.onProgress ?? (() => {});
      const signal = options?.signal;
      const reEnrich = options?.reEnrich === true;
      const full = options?.full === true;
      const clean = options?.clean === true;
      const dryRun = options?.dryRun === true;

      // Load config and resolve all stash sources
      const { loadConfig } = await import("../core/config/config.js");
      const config = loadConfig();

      // One-time, read-only guard: warn if the writable stash still holds an
      // un-migrated `vaults/` directory. In 0.9.0 the indexer skips `vaults/`
      // entirely, so an unmigrated vault's `.env` data would silently never be
      // indexed. Non-destructive — only stats, never reads/writes/deletes.
      const { warnOnUnmigratedVaults } = await import("./usage/unmigrated-vaults-guard.js");
      warnOnUnmigratedVaults(stashDir);

      // Ensure git stash caches are extracted before resolving stash dirs,
      // so their content directories exist on disk for the walker to discover.
      const sourceCacheStart = Date.now();
      onProgress({ phase: "preflight", message: "Hydrating source caches." });
      const { ensureSourceCaches, resolveSourceEntries } = await import("./search/search-source.js");
      await ensureSourceCaches(config, { force: full });
      const sourceCacheEnd = Date.now();
      const allSourceEntries = resolveSourceEntries(stashDir, config);
      const allSourceDirs = allSourceEntries.map((s) => s.path);
      onProgress({
        phase: "preflight",
        message: `Resolved ${allSourceDirs.length} stash source${allSourceDirs.length === 1 ? "" : "s"}.`,
      });

      const t0 = Date.now();

      // Open database — pass embedding dimension from config if available
      const dbPath = getDbPath();
      const embeddingDim = config.embedding?.dimension;
      const db = openIndexDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);

      try {
        // Determine incremental vs full mode
        const prevStashDir = getMeta(db, "stashDir");
        const prevBuiltAt = getMeta(db, "builtAt");
        const isIncremental = !full && prevStashDir === stashDir && !!prevBuiltAt;
        const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;

        // Assemble the run context
        const ctx: IndexRunContext = {
          db,
          config,
          sources: allSourceEntries,
          sourceDirs: allSourceDirs,
          full,
          reEnrich,
          stashDir,
          onProgress,
          signal,
          timing: {
            t0,
            tWalkStart: t0,
            tWalkEnd: t0,
            tLlmEnd: t0,
            tFtsEnd: t0,
            tEmbedEnd: t0,
            tFinalizeStart: t0,
            tFinalizeEnd: t0,
          },
          isIncremental,
          builtAtMs,
          hadRemovedSources: false,
          scannedDirs: 0,
          skippedDirs: 0,
          generatedCount: 0,
          walkWarnings: [],
          dirsNeedingLlm: [],
          embeddingResult: null,
          graphExtractionResult: null,
        };

        onProgress({
          phase: "summary",
          message: buildIndexSummaryMessage({
            mode: isIncremental ? "incremental" : "full",
            sourcesCount: allSourceDirs.length,
            semanticSearchMode: config.semanticSearchMode,
            embeddingProvider: getEmbeddingProvider(config.embedding),
            llmEnabled: !!resolveIndexPassLLM("enrichment", config),
            vecAvailable: isVecAvailable(db),
          }),
        });

        // ── Phase sequence ───────────────────────────────────────────────────────
        await runSourceCachePhase(ctx);
        await runWalkPhase(ctx);
        await runEmbeddingPhase(ctx);
        await runFinalizePhase(ctx);
        // ────────────────────────────────────────────────────────────────────────

        // runFinalizePhase always populates these before returning.
        const verification = ctx.verification as IndexVerification;
        const totalEntries = ctx.totalEntries as number;
        const { timing } = ctx;

        // ── Clean pass ───────────────────────────────────────────────────────────
        // After the normal index completes, remove entries whose source files no
        // longer exist on disk. Remote entries (empty file_path) are skipped.
        let cleanResult: IndexCleanResult | undefined;
        const cleanStart = Date.now();
        if (clean) {
          onProgress({
            phase: "finalize",
            message: dryRun ? "Scanning for stale index entries (dry run)." : "Removing stale index entries.",
          });
          cleanResult = runCleanPass(db, dryRun);
        }
        const cleanEnd = Date.now();
        // ────────────────────────────────────────────────────────────────────────

        return {
          stashDir,
          totalEntries,
          generatedMetadata: ctx.generatedCount,
          indexPath: dbPath,
          mode: isIncremental ? "incremental" : "full",
          directoriesScanned: ctx.scannedDirs,
          directoriesSkipped: ctx.skippedDirs,
          ...(ctx.walkWarnings.length > 0 ? { warnings: ctx.walkWarnings } : {}),
          verification,
          timing: {
            totalMs: Date.now() - timing.t0,
            walkMs: timing.tWalkEnd - timing.tWalkStart,
            llmMs: timing.tLlmEnd - timing.tWalkEnd,
            embedMs: timing.tEmbedEnd - timing.tLlmEnd,
            ftsMs: timing.tFtsEnd - timing.tEmbedEnd,
            finalizeMs: timing.tFinalizeEnd - timing.tFinalizeStart,
            cleanMs: clean ? cleanEnd - cleanStart : 0,
            preflightMs: timing.t0 - requestedAt,
            leaseWaitMs: acquiredAt - requestedAt,
            sourceCacheMs: sourceCacheEnd - sourceCacheStart,
            endToEndMs: Date.now() - requestedAt,
          },
          ...(cleanResult !== undefined ? { clean: cleanResult } : {}),
        };
      } finally {
        closeDatabase(db);
      }
    },
  );
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

async function indexEntries(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  hadRemovedSources: boolean,
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
    reason?: DirScanReason;
    persistedRowCount?: number;
  };

  type DirScanReason = {
    kind:
      | "duplicate-dir"
      | "no-indexable-files"
      | "unchanged"
      | "full-rebuild"
      | "no-previous-rows"
      | "cached-zero-row-state"
      | "mtime-changed"
      | "file-set-changed"
      | "missing-file";
    detail?: string;
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
  let priorDirsChanged = hadRemovedSources;

  const reportScanProgress = (message: string) => {
    onProgress?.({
      phase: "scan",
      message,
      processed: processedDirs,
      total: allSourceEntries.length,
    });
  };

  const reportDirDecision = (
    kind: "scan" | "skip",
    dirPath: string,
    currentStashDir: string,
    reason: DirScanReason,
    persistedRowCount?: number,
  ) => {
    if (!isVerbose()) return;
    const detail = reason.detail ? ` (${reason.detail})` : "";
    const rowInfo = persistedRowCount !== undefined ? `; previous rows=${persistedRowCount}` : "";
    reportScanProgress(
      `${kind === "scan" ? "Rescanning" : "Skipping"} ${path.relative(currentStashDir, dirPath) || "."} ` +
        `from ${currentStashDir}: ${reason.kind}${detail}${rowInfo}`,
    );
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
          const reason = { kind: "duplicate-dir" } satisfies DirScanReason;
          dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true, reason });
          reportDirDecision("skip", dirPath, currentStashDir, reason);
          continue;
        }
        seenPaths.add(path.resolve(dirPath));

        const previousState = getDirIndexState(db, dirPath, files, builtAtMs);
        if (isIncremental && !previousState.stale && canUseIncrementalSkip(previousState, priorDirsChanged)) {
          skippedDirs++;
          dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true, reason: previousState.reason });
          reportDirDecision("skip", dirPath, currentStashDir, previousState.reason, previousState.persistedRowCount);
          continue;
        }

        scannedDirs++;
        priorDirsChanged = true;
        const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
        dirRecords.push({
          dirPath,
          currentStashDir,
          files,
          stash: { entries },
          skip: false,
          reason,
          persistedRowCount: previousState.persistedRowCount,
        });
        reportDirDecision("scan", dirPath, currentStashDir, reason, previousState.persistedRowCount);
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
        const reason = { kind: "duplicate-dir" } satisfies DirScanReason;
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true, reason });
        reportDirDecision("skip", dirPath, currentStashDir, reason);
        continue;
      }
      seenPaths.add(path.resolve(dirPath));

      if (indexableFiles.length === 0) {
        skippedDirs++;
        const reason = { kind: "no-indexable-files" } satisfies DirScanReason;
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true, reason });
        reportDirDecision("skip", dirPath, currentStashDir, reason);
        continue;
      }

      const cachedZeroRowState =
        isIncremental && getCachedZeroRowDirState(db, dirPath, indexableFiles, builtAtMs, priorDirsChanged);
      if (cachedZeroRowState) {
        skippedDirs++;
        dirRecords.push({
          dirPath,
          currentStashDir,
          files: indexableFiles,
          stash: null,
          skip: true,
          reason: cachedZeroRowState.reason,
        });
        reportDirDecision(
          "skip",
          dirPath,
          currentStashDir,
          cachedZeroRowState.reason,
          cachedZeroRowState.persistedRowCount,
        );
        continue;
      }

      const generated = await generateMetadataFlat(currentStashDir, indexableFiles);
      if (generated.warnings?.length) warnings.push(...generated.warnings);

      const legacyOverrides = loadStashFile(dirPath, { requireFilename: true });
      const { stash, staleFiles } = buildIndexedDirCandidate(dirPath, indexableFiles, generated, legacyOverrides);

      if (generated.entries.length > 0) {
        generatedCount += generated.entries.length;
      }

      const previousState = getDirIndexState(db, dirPath, staleFiles, builtAtMs);
      if (isIncremental && !previousState.stale && canUseIncrementalSkip(previousState, priorDirsChanged)) {
        skippedDirs++;
        dirRecords.push({
          dirPath,
          currentStashDir,
          files: staleFiles,
          stash: null,
          skip: true,
          reason: previousState.reason,
        });
        reportDirDecision("skip", dirPath, currentStashDir, previousState.reason, previousState.persistedRowCount);
        continue;
      }

      scannedDirs++;
      priorDirsChanged = true;
      const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
      dirRecords.push({
        dirPath,
        currentStashDir,
        files: staleFiles,
        stash,
        skip: false,
        reason,
        persistedRowCount: previousState.persistedRowCount,
      });
      reportDirDecision("scan", dirPath, currentStashDir, reason, previousState.persistedRowCount);
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
      db.exec("DELETE FROM index_dir_state");
      // Detach usage_events from entries about to be deleted — null out entry_id
      // but keep entry_ref so events can be re-linked after entries are rebuilt.
      try {
        db.exec("UPDATE usage_events SET entry_id = NULL WHERE entry_id IS NOT NULL");
      } catch {
        /* ignore if table doesn't exist */
      }
      db.exec("DELETE FROM entries");
    }

    for (const { dirPath, currentStashDir, files, stash, skip, reason } of dirRecords) {
      if (skip) {
        if (reason?.kind === "unchanged") {
          const fingerprint = computeDirFingerprint(dirPath, files);
          upsertIndexDirState(db, {
            dirPath,
            fileSetHash: fingerprint.fileSetHash,
            fileMtimeMaxMs: fingerprint.fileMtimeMaxMs,
            reason: reason.kind,
          });
        }
        continue;
      }

      // Delete old entries for this dir (will be re-inserted)
      deleteEntriesByDir(db, dirPath);

      let persistedRows = 0;
      let dedupedRows = 0;

      if (stash) {
        for (const entry of stash.entries) {
          const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
          if (!entryPath) {
            warn(`Skipping entry with no resolvable path in ${dirPath}`);
            continue;
          }
          if (!shouldIndexStashFile(currentStashDir, entryPath)) continue;

          // Skip if a higher-priority stash root already indexed this asset
          const identityKey = `${entry.type}\0${entry.name}`;
          if (indexedAssetIdentities.has(identityKey)) {
            dedupedRows++;
            continue;
          }
          indexedAssetIdentities.add(identityKey);

          const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
          const searchText = buildSearchText(entry);
          const entryWithSize = attachFileSize(entry, entryPath);

          const entryId = upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, entryWithSize, searchText);
          persistedRows++;

          if (entry.type === "workflow") {
            const doc = takeWorkflowDocument(entry);
            if (doc) {
              upsertWorkflowDocument(db, entryId, doc, fs.readFileSync(entryPath));
            }
          }
        }

        // Collect dirs needing LLM enhancement during the first walk.
        // Only dirs with "generated" entries need enrichment (unless reEnrich
        // forces re-processing of already-enriched entries).
        if (stash.entries.some((e) => e.quality === "generated")) {
          dirsNeedingLlm.push({ dirPath, files, currentStashDir, stash });
        }
      }

      const fingerprint = computeDirFingerprint(dirPath, files);
      const persistedReason =
        persistedRows === 0
          ? inferZeroRowReason(stash, reason, warnings, dirPath, dedupedRows)
          : reason?.kind === "full-rebuild"
            ? "full-rebuild"
            : (reason?.kind ?? "updated");
      upsertIndexDirState(db, {
        dirPath,
        fileSetHash: fingerprint.fileSetHash,
        fileMtimeMaxMs: fingerprint.fileMtimeMaxMs,
        reason: persistedReason,
      });
      if (persistedRows === 0) {
        // Warn only when the dir had files that *could* produce entries (.md or
        // known script extensions). Dirs with only non-indexable types (.json,
        // .yaml, .conf, .env, .gitkeep) or deduped-only rows are expected and
        // not actionable at normal log level.
        const hasIndexableExtension = files.some((f) => {
          const ext = path.extname(f).toLowerCase();
          return ext === ".md" || SCRIPT_EXTENSIONS.has(ext);
        });
        if (persistedReason !== "deduped-zero-row" && hasIndexableExtension) {
          warn(`[index] zero-row ${dirPath}: ${persistedReason}`);
        } else {
          warnVerbose(`[index] zero-row ${dirPath}: ${persistedReason}`);
        }
      }
    }
  });

  insertTransaction();

  return { scannedDirs, skippedDirs, generatedCount, warnings, dirsNeedingLlm };
}

async function enhanceDirsWithLlm(
  db: Database,
  config: import("../core/config/config").AkmConfig,
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>,
  onProgress?: (event: IndexProgressEvent) => void,
  signal?: AbortSignal,
  reEnrich = false,
): Promise<void> {
  // Resolve per-pass LLM config via the unified shim. Returns undefined when
  // either no `akm.llm` is configured or the user opted this pass out via
  // `index.enrichment.llm = false`. (#208)
  const llmConfig = resolveIndexPassLLM("enrichment", config);
  if (!llmConfig || dirsNeedingLlm.length === 0) return;

  // Aggregate per-entry failures so a misconfigured LLM endpoint surfaces
  // as a single visible warning instead of silently degrading every entry
  // and leaving the user wondering why nothing got enhanced.
  const summary: LlmEnhancementSummary = { attempted: 0, succeeded: 0, failureSamples: [] };
  let completedDirs = 0;
  let completedEntries = 0;
  const totalDirs = dirsNeedingLlm.length;
  const totalEntries = dirsNeedingLlm.reduce((sum, { stash }) => {
    const entriesToEnhance = stash.entries.filter((e) => {
      if (e.quality !== "generated" && !(reEnrich && e.quality === "enriched")) return false;
      if (!reEnrich && isEnrichmentComplete(e)) return false;
      return true;
    });
    return sum + entriesToEnhance.length;
  }, 0);

  // P3 — wall-clock budget for the enrichment pass. Defaults to llm.timeoutMs
  // (or 10 minutes if not set). Users can extend this via llm.timeoutMs in
  // config — no separate knob needed.
  const budgetMs = (llmConfig.timeoutMs ?? 10 * 60 * 1000) * Math.max(totalEntries, 1);
  const enrichDeadline = AbortSignal.timeout(budgetMs);
  let deadlineHit = false;
  const enrichSignal: AbortSignal = (() => {
    if (!signal) return enrichDeadline;
    // Combine: abort when either fires.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    enrichDeadline.addEventListener(
      "abort",
      () => {
        deadlineHit = true;
        controller.abort();
      },
      { once: true },
    );
    return controller.signal;
  })();

  if (totalEntries > 0) {
    onProgress?.({
      phase: "llm",
      message:
        `LLM enhancement starting for ${totalEntries} entr${totalEntries === 1 ? "y" : "ies"} ` +
        `across ${totalDirs} director${totalDirs === 1 ? "y" : "ies"} (concurrency ${getDefaultLlmConcurrency(llmConfig)}).`,
      processed: 0,
      total: totalEntries,
    });
  }

  let currentDirLabel: string | undefined;
  let lastProgressAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (totalEntries > 0 && onProgress) {
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastProgressAt < 15000) return;
      onProgress({
        phase: "llm",
        message:
          `Still enriching ${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"}` +
          (currentDirLabel ? `; waiting on ${currentDirLabel}` : "") +
          ".",
        processed: completedEntries,
        total: totalEntries,
      });
      lastProgressAt = Date.now();
    }, 15000);
  }

  try {
    await concurrentMap(
      dirsNeedingLlm,
      async ({ dirPath, files, currentStashDir, stash: originalStash }) => {
        if (enrichSignal.aborted) return undefined;
        // Only enhance generated entries (or all when reEnrich=true);
        // user-provided overrides should not be overwritten.
        // Skip entries that are already fully enriched (description + tags + searchHints)
        // unless the caller explicitly requests re-enrichment via reEnrich=true.
        const entriesToEnhance = originalStash.entries.filter((e) => {
          if (e.quality !== "generated" && !(reEnrich && e.quality === "enriched")) return false;
          if (!reEnrich && isEnrichmentComplete(e)) {
            warnVerbose(`[akm] skipping LLM enrichment for "${e.name}" — entry already complete`);
            return false;
          }
          return true;
        });
        if (entriesToEnhance.length === 0) return undefined;
        currentDirLabel = path.relative(currentStashDir, dirPath) || ".";
        onProgress?.({
          phase: "llm",
          message:
            `Enhancing ${currentDirLabel} ` +
            `(${entriesToEnhance.length} entr${entriesToEnhance.length === 1 ? "y" : "ies"}).`,
          processed: completedEntries,
          total: totalEntries,
        });
        lastProgressAt = Date.now();
        const targetStash: StashFile = { entries: entriesToEnhance };
        const entryKeys = entriesToEnhance.map((e) => `${currentStashDir}:${e.type}:${e.name}`);
        const enhanced = await enhanceStashWithLlm(
          llmConfig,
          targetStash,
          files,
          summary,
          enrichSignal,
          db,
          entryKeys,
          reEnrich,
          config,
          (event) => {
            completedEntries++;
            lastProgressAt = Date.now();
            onProgress?.({
              phase: "llm",
              message:
                `Enhanced ${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"}; ` +
                `${completedDirs}/${totalDirs} director${totalDirs === 1 ? "y" : "ies"} complete` +
                (event.entryName ? `; current ${event.entryName}` : "") +
                (currentDirLabel ? ` in ${currentDirLabel}` : "") +
                (event.outcome === "cache-hit" ? " (cache hit)" : ""),
              processed: completedEntries,
              total: totalEntries,
            });
          },
        );

        // Re-upsert the enhanced entries in a single transaction so a crash
        // cannot leave half the entries updated and the rest stale.
        db.transaction(() => {
          for (const entry of enhanced.entries) {
            const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
            const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`;
            const searchText = buildSearchText(entry);
            upsertEntry(
              db,
              entryKey,
              dirPath,
              entryPath,
              currentStashDir,
              attachFileSize(entry, entryPath),
              searchText,
            );
          }
        })();
        completedDirs++;
        lastProgressAt = Date.now();
        onProgress?.({
          phase: "llm",
          message:
            `Completed ${completedDirs}/${totalDirs} director${totalDirs === 1 ? "y" : "ies"}; ` +
            `${completedEntries}/${totalEntries} entr${totalEntries === 1 ? "y" : "ies"} processed.`,
          processed: completedEntries,
          total: totalEntries,
        });
        return undefined;
      },
      // Default concurrency of 4 works well for cloud LLM APIs. Local model
      // servers (LM Studio, Ollama) run one inference at a time — set
      // `llm.concurrency: 1` in config.json to avoid "Model reloaded" / 500
      // errors from concurrent request overload.
      getDefaultLlmConcurrency(llmConfig),
    );
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  if (deadlineHit) {
    warn(
      "[akm] LLM enrichment budget exceeded. Re-run `akm index` to continue. Increase llm.timeoutMs for a larger budget.",
    );
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
    // Model/provider changed → stored vectors are incompatible. Clear them
    // (same dimension, so keep the vec table); re-embedded by this index run.
    purgeEmbeddings(db);
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

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeatTimer = setInterval(() => {
        onProgress({
          phase: "embeddings",
          message: `Still generating embeddings for ${allEntries.length} entr${allEntries.length === 1 ? "y" : "ies"}; waiting on embedding provider.`,
        });
      }, 15000);

      const embeddings = await embedBatch(texts, config.embedding, signal);
      throwIfAborted(signal);
      // Wrap all embedding upserts in a single transaction so partial
      // state is rolled back on failure rather than leaving the table half-filled.
      let storedCount = 0;
      let skippedCount = 0;
      db.transaction(() => {
        for (let i = 0; i < allEntries.length; i++) {
          if (upsertEmbedding(db, allEntries[i].id, embeddings[i])) {
            storedCount++;
          } else {
            skippedCount++;
          }
        }
      })();
      if (skippedCount > 0) {
        warn(
          `[embed] ${skippedCount} embedding${skippedCount === 1 ? "" : "s"} skipped (entry deleted between queue and write)`,
        );
      }
      onProgress({
        phase: "embeddings",
        message: `Stored ${storedCount} embedding${storedCount === 1 ? "" : "s"}.`,
      });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      return { success: true };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
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
  reason?: import("./search/semantic-status").SemanticSearchReason;
  message?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function attachFileSize(entry: StashEntry, entryPath: string): StashEntry {
  try {
    return { ...entry, fileSize: fs.statSync(entryPath).size };
  } catch {
    return entry;
  }
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

function getEmbeddingProvider(
  embedding?: import("../core/config/config").EmbeddingConnectionConfig,
): "local" | "remote" {
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
  embeddableEntries: number,
  embeddingResult: EmbeddingGenerationResult,
): IndexVerification {
  const embeddingCount = getEmbeddingCount(db);
  const vecAvailable = isVecAvailable(db);
  const embeddingProvider = getEmbeddingProvider(config.embedding);

  if (embeddableEntries === 0) {
    return {
      ok: true,
      message: "Index ready. No assets were found yet.",
      semanticSearchEnabled: config.semanticSearchMode === "auto",
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: config.semanticSearchMode === "off" ? "disabled" : "pending",
      embeddingProvider,
      entryCount: embeddableEntries,
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
      entryCount: embeddableEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  if (embeddingCount >= embeddableEntries) {
    return {
      ok: true,
      message: `Semantic search ready (${embeddingCount}/${embeddableEntries} embeddings, ${vecAvailable ? "sqlite-vec active" : "JS fallback active"}).`,
      semanticSearchEnabled: true,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: vecAvailable ? "ready-vec" : "ready-js",
      embeddingProvider,
      entryCount: embeddableEntries,
      embeddingCount,
      vecAvailable,
    };
  }

  return {
    ok: false,
    message:
      embeddingResult.message ??
      `Semantic search verification failed (${embeddingCount}/${embeddableEntries} embeddings available).`,
    guidance:
      embeddingProvider === "remote"
        ? "Check your embedding endpoint and credentials, then retry `akm index --full --verbose`."
        : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/configuration.md for local embedding dependency setup.",
    semanticSearchEnabled: true,
    semanticSearchMode: config.semanticSearchMode,
    semanticStatus: "blocked",
    embeddingProvider,
    entryCount: embeddableEntries,
    embeddingCount,
    vecAvailable,
  };
}

function buildIndexedDirCandidate(
  dirPath: string,
  indexableFiles: string[],
  generated: StashFile,
  legacyOverrides: StashFile | null,
): IndexedDirCandidate {
  const mergedEntries = legacyOverrides
    ? generated.entries.map((entry) => mergeLegacyEntry(entry, legacyOverrides.entries))
    : generated.entries;
  const stash = mergedEntries.length > 0 ? { entries: mergedEntries } : legacyOverrides;
  const staleFiles = stash ? resolveIndexedFiles(dirPath, indexableFiles, stash) : indexableFiles;
  return { stash, staleFiles };
}

function resolveIndexedFiles(dirPath: string, files: string[], stash: StashFile): string[] {
  const fileBasenameMap = buildFileBasenameMap(files);
  const resolved = new Set<string>();
  for (const entry of stash.entries) {
    const entryPath = entry.filename
      ? path.join(dirPath, entry.filename)
      : matchEntryToFile(entry.name, fileBasenameMap);
    if (entryPath) resolved.add(entryPath);
  }
  return resolved.size > 0 ? [...resolved] : files;
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
  db?: Database,
  entryKeys?: string[],
  reEnrich?: boolean,
  akmConfig?: AkmConfig,
  onEntryDone?: (event: { entryName: string; outcome: "cache-hit" | "llm" | "failed" }) => void,
): Promise<StashFile> {
  const { enhanceMetadata } = await import("../llm/metadata-enhance");
  const { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry } = await import("./db/db.js");

  const results = await concurrentMap(
    stash.entries,
    async (entry, idx) => {
      if (signal?.aborted) return entry;
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
            warn(`Could not read file for LLM enrichment: ${entry.filename ?? entry.name}`);
          }
        }

        // Incremental cache: skip LLM call when file body is unchanged and
        // --re-enrich was not requested. The cache key is the entry_key
        // (stashDir:type:name) which is stable across index runs.
        const cacheBody = fileContent ?? `${entry.name}\n${entry.description ?? ""}`;
        const bodyHash = computeBodyHash(cacheBody);
        const cacheKey = entryKeys?.[idx] ?? `${entry.type}:${entry.name}`;

        if (db && !reEnrich) {
          const cached = getLlmCacheEntry(db, cacheKey, bodyHash);
          if (cached) {
            try {
              const parsed = JSON.parse(cached.resultJson) as {
                description?: string;
                searchHints?: string[];
                tags?: string[];
              };
              const updated = { ...entry };
              if (parsed.description) updated.description = parsed.description;
              if (parsed.searchHints?.length) updated.searchHints = parsed.searchHints;
              if (parsed.tags?.length) updated.tags = parsed.tags;
              updated.quality = "enriched";
              summary.succeeded++;
              onEntryDone?.({ entryName: entry.name, outcome: "cache-hit" });
              return updated;
            } catch {
              warn(`LLM enrichment cache entry corrupt for ${entry.name}; re-running enrichment`);
            }
          }
        }

        const improvements = await enhanceMetadata(llmConfig, entry, fileContent, signal, akmConfig);
        const updated = { ...entry };
        if (improvements.description) updated.description = improvements.description;
        if (improvements.searchHints?.length) updated.searchHints = improvements.searchHints;
        if (improvements.tags?.length) updated.tags = improvements.tags;
        // Mark as enriched so subsequent index runs skip re-enrichment (P2)
        updated.quality = "enriched";

        // Persist to cache so the next run can skip the LLM call when the
        // file body has not changed.
        if (db) {
          upsertLlmCacheEntry(
            db,
            cacheKey,
            bodyHash,
            JSON.stringify({
              description: improvements.description,
              searchHints: improvements.searchHints,
              tags: improvements.tags,
            }),
          );
        }

        summary.succeeded++;
        onEntryDone?.({ entryName: entry.name, outcome: "llm" });
        return updated;
      } catch (err) {
        const msg = toErrorMessage(err);
        // failureSamples is bounded to 3 items, so a linear scan is cheaper
        // than maintaining a parallel Set for membership checks (#177 review).
        if (summary.failureSamples.length < 3 && !summary.failureSamples.includes(msg)) {
          summary.failureSamples.push(msg);
        }
        onEntryDone?.({ entryName: entry.name, outcome: "failed" });
        return entry;
      }
    },
    // Default concurrency of 4 works well for cloud LLM APIs. Set
    // `llm.concurrency: 1` in config.json for local model servers.
    getDefaultLlmConcurrency(llmConfig),
  );

  // concurrentMap returns Array<T | undefined>; filter out undefined slots
  // (which can only occur if the callback itself returned undefined, which
  // it never does above — but TypeScript needs the filter for type safety).
  const enhanced: StashEntry[] = results.map((r, i) => r ?? stash.entries[i]);
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
export function matchEntryToFile(entryName: string, fileMap: Map<string, string>): string | null {
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

import type { AssetRef } from "../core/asset/asset-ref";

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
  const { loadConfig } = await import("../core/config/config.js");
  const { resolveSourceEntries } = await import("./search/search-source.js");
  const config = loadConfig();
  const sources = resolveSourceEntries(undefined, config);
  if (sources.length === 0) return null;

  const dbPath = getDbPath();
  const db = openExistingDatabase(dbPath);
  try {
    const escapeLike = (value: string): string =>
      value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

    // Canonical names strip .md for markdown assets, but users often pass
    // refs with .md (e.g. command:release.md). Normalize by trying both.
    const nameVariants = [ref.name];
    if (ref.name.endsWith(".md")) {
      nameVariants.push(ref.name.slice(0, -3));
    }

    const candidateDirs: string[] = (() => {
      if (!ref.origin) return sources.map((s) => s.path);
      if (ref.origin === "local") return [sources[0].path];
      const named = sources.find((s) => s.registryId === ref.origin);
      return named ? [named.path] : [];
    })();

    if (candidateDirs.length === 0) return null;

    for (const name of nameVariants) {
      const suffix = `:${ref.type}:${name}`;
      const escapedSuffix = escapeLike(suffix);
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
  // Only processes entries that actually have usage events AND still exist
  // in `entries`. The latter check is critical: usage_events has no FK to
  // entries, so its entry_id can become stale (entry deleted, re-keyed,
  // moved between sources). Without the JOIN, writing the derived row to
  // utility_scores (which DOES have an FK) raises "FOREIGN KEY constraint
  // failed" and rolls back the whole finalize transaction — failing every
  // index run.
  const usageRows = db
    .prepare(`
      SELECT u.entry_id,
             SUM(CASE WHEN u.event_type = 'search' THEN 1 ELSE 0 END) AS search_count,
             SUM(CASE WHEN u.event_type = 'show'   THEN 1 ELSE 0 END) AS show_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
             MAX(u.created_at) AS last_used_at
      FROM usage_events u
      JOIN entries e ON e.id = u.entry_id
      WHERE u.entry_id IS NOT NULL
      GROUP BY u.entry_id
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
  const existingScores = new Map<number, { utility: number; lastUsedAt: string | undefined }>();
  const scoreRows = db.prepare("SELECT entry_id, utility, last_used_at FROM utility_scores").all() as Array<{
    entry_id: number;
    utility: number;
    last_used_at: string | null;
  }>;
  for (const row of scoreRows) {
    existingScores.set(row.entry_id, { utility: row.utility, lastUsedAt: row.last_used_at ?? undefined });
  }

  const now = new Date().toISOString();

  for (const row of usageRows) {
    const selectRate = row.search_count > 0 ? Math.min(1, row.show_count / row.search_count) : 0;
    const feedbackTotal = row.positive_feedback_count + row.negative_feedback_count;
    const feedbackRate =
      feedbackTotal > 0 ? Math.max(0, row.positive_feedback_count - row.negative_feedback_count) / feedbackTotal : 0;
    const effectiveRate = Math.max(selectRate, feedbackRate);
    const existing = existingScores.get(row.entry_id);
    const prevUtility = existing?.utility ?? 0;
    const utility = prevUtility * emaDecay + effectiveRate * emaNew;
    const lastUsedAt = effectiveRate > 0.5 ? now : (existing?.lastUsedAt ?? undefined);

    upsertUtilityScore(db, row.entry_id, {
      utility,
      showCount: row.show_count,
      searchCount: row.search_count,
      selectRate,
      lastUsedAt,
    });
  }

  setMeta(db, "last_utility_computed_at", new Date().toISOString());
}
