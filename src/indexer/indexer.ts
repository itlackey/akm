// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../core/adapter/bundle-adapter";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { adapterForId } from "../core/adapter/registry";
import type { BundleComponent } from "../core/adapter/types";
import { isHttpUrl, toErrorMessage } from "../core/common";
import { concurrentMap } from "../core/concurrent";
import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { defaultConcurrencyForEndpoint } from "../core/loopback";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { SCRIPT_EXTENSIONS } from "../core/recognition-util";
import { withStateDb } from "../core/state-db";
import { isVerbose, warn, warnOnce, warnVerbose } from "../core/warn";
import type { LoweringNotice } from "../execution/resolved-request";
import {
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
} from "../integrations/agent/execution-lowering";
import { isLlmFeatureEnabled } from "../llm/feature-gate";
import { type ResolvedIndexPassExecution, resolveIndexPassExecution } from "../llm/index-passes";
import { preflightStructuredLlmRunner, type StructuredLlmRunner } from "../llm/structured-call";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
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
 * See the index-consistency ADR (2026-06) for the full analysis.
 */
import type { Database } from "../storage/database";
import { salvageEmbeddingsBeforeDiscard } from "../storage/repositories/embedding-salvage-repository";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import {
  deleteAllEntries,
  deleteEntriesByBundle,
  deleteEntriesByDirAndBundle,
  deleteEntriesByDirExceptRefs,
  deleteEntriesByIds,
  deleteUsageEventsByEntryIds,
  findEntryIdByRef,
  getAllEntries,
  getEmbeddableEntryCount,
  getEntryCount,
  getIndexedBundleIdsByDir,
  getIndexedDirPathsByBundleId,
  relinkUsageEvents,
  upsertEntry,
} from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import {
  clearStaleCacheEntries,
  computeBodyHash,
  getLlmCacheEntry,
} from "../storage/repositories/index-llm-cache-repository";
import {
  deleteIndexDirState,
  getMeta,
  setMeta,
  upsertIndexDirState,
} from "../storage/repositories/index-meta-repository";
import { upsertUtilityScore } from "../storage/repositories/index-utility-repository";
import {
  getEmbeddingCount,
  isVecAvailable,
  isVecFastPathReady,
  warnIfVecMissing,
} from "../storage/repositories/index-vec-repository";
import { assertIndexedWorkflowSourceIdentity, WorkflowSourceIdentityError } from "../workflows/source-files";
import { deleteStoredGraph } from "./db/graph-db";
import { reclassifyIndexDbContention } from "./index-db-contention";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import {
  type AdapterConceptOwner,
  indexedPathMatchesOwner,
  resolveAdapterConceptOwner,
} from "./lookup/adapter-concept-owner";
import { type EmbeddingGenerationResult, generateEmbeddingsForDb } from "./materialize-embeddings";
import {
  canUseIncrementalSkip,
  computeDirFingerprint,
  type DirFingerprint,
  getCachedDirState,
  getDirIndexState,
  inferZeroRowReason,
} from "./passes/dir-staleness";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
  isEnrichmentComplete,
  isWorkflowSkipWarning,
  type StashFile,
  setMarkdownFragmentContent,
} from "./passes/metadata";
import { drainDirDocuments } from "./scan/drain-dir";
import { buildSearchText } from "./search/search-fields";
import type { SearchSource } from "./search/search-source";
import { purgeOldUsageEvents } from "./usage/usage-events";
import type { FileContext } from "./walk/file-context";
import type { IndexRunContext, IndexVerification } from "./walk/index-context";
import { walkStashFlatWithStatus } from "./walk/walker";

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
  /** False when any configured source could not be scanned and LKG rows were preserved. */
  scanComplete: boolean;
  warnings?: string[];
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
  verification: IndexVerification;
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
    sourceCacheMs: number;
    endToEndMs: number;
  };
  /** Present when --clean was passed: stale-entry purge results. */
  clean?: IndexCleanResult;
  /**
   * Present when this run auto-detected a bundle's adapter and persisted it
   * to config.json (`bundles.<id>.components.<component>.adapter`) — a
   * maintenance-command config write that would otherwise be invisible
   * (R-056). Keyed by bundle id, valued by the detected adapter id.
   */
  configUpdated?: { detectedAdapters: Record<string, string> };
}

function collectLoweringNotices(
  target: Array<Readonly<LoweringNotice>>,
  notices: readonly Readonly<LoweringNotice>[],
): void {
  const keys = new Set(target.map((notice) => JSON.stringify(notice)));
  for (const notice of notices) {
    const key = JSON.stringify(notice);
    if (keys.has(key)) continue;
    keys.add(key);
    target.push(notice);
  }
}

export interface IndexProgressEvent {
  phase: "summary" | "preflight" | "scan" | "llm" | "embeddings" | "fts" | "finalize" | "verify";
  message: string;
  processed?: number;
  total?: number;
}

export interface DeferredUpdateIndexTransaction {
  /** Canonical index.db handle already inside the coordinator-owned transaction. */
  db: Database;
  /** Attached schema name for the canonical state.db on the same connection. */
  stateSchema: string;
}

interface IndexOptions {
  /**
   * The stash directory to index. Resolved once at each command boundary
   * (WI-9.10 CLI-wide sweep) and threaded in — the indexer no longer reads the
   * ambient stash-dir resolver. Every caller (source add, wiki, workflow,
   * setup, ensure-index, tests) already passes it.
   */
  stashDir: string;
  full?: boolean;
  /**
   * When true, reconcile entries whose source file no longer exists before
   * embeddings and final verification. Remote entries (empty file_path) are skipped.
   */
  clean?: boolean;
  /**
   * When true (and `clean` is also true), report which entries would be removed
   * without actually deleting them.
   */
  dryRun?: boolean;
  /**
   * When true (`akm index --reembed`), force a full purge + re-embed of
   * every entry regardless of the embedding-fingerprint canary (#955) — an
   * explicit operator override for when its verdict should not be trusted.
   */
  reembed?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
  /**
   * Whether this run may materialize (clone/pull/fetch) cache-backed sources.
   * Default `true` — the sanctioned materialization callers (`akm index`,
   * source add/update/sync, improve's blocking preflight). A READ command's
   * inline auto-index passes `false` so query time never touches the network
   * (spec §14.3 / D11): absent source caches are skipped with a warning instead
   * of cloned.
   */
  hydrateSources?: boolean;
  /**
   * Whether adapter auto-detection may persist into config.json. Source-update
   * transactions disable this so a failed publication can restore lock/content/
   * index without also having to compensate an unrelated config write.
   */
  persistDetectedAdapters?: boolean;
  /**
   * Borrow the source-update coordinator's canonical index.db handle. The
   * handle already has state.db attached and one outer transaction spanning
   * both schemas; indexer writes remain pending until the coordinator's final
   * commit point. Internal lifecycle seam; ordinary callers omit it.
   */
  deferredUpdateTransaction?: DeferredUpdateIndexTransaction;
  /**
   * Whether this run was triggered implicitly by another command's inline
   * auto-index rather than by an explicit `akm index`.
   *
   * Only affects DISCLOSURE, never behavior. The adapter-detection config
   * write (R-056) is always reported in the result envelope, but its stderr
   * notice is suppressed for implicit runs: a read command's stderr carries
   * its JSON error envelope, so an extra human-readable line there makes the
   * envelope unparseable for callers doing `JSON.parse(stderr)` — and would
   * also leak past `--quiet`, which a read command is entitled to honor.
   */
  implicit?: boolean;
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

export function getDefaultLlmConcurrency(llmConfig?: LlmConnectionConfig): number {
  if (typeof llmConfig?.concurrency === "number") return llmConfig.concurrency;
  // ONE classifier decides the local-vs-remote default (`core/loopback.ts`'s
  // `defaultConcurrencyForEndpoint`), shared with the embedding pool
  // (`resolveEmbeddingConcurrency`, `src/llm/embedders/remote.ts`) and the
  // workflow engine's frozen concurrency default.
  //
  // The explicit-override branch above only fires for callers that put
  // `concurrency` on the connection themselves — `engines.<name>.concurrency`
  // is a valid schema field but `resolveLlmEngineUse` does NOT copy it into
  // the resolved connection, so on the enrichment path the auto-derived 1/2
  // is what runs (see docs/architecture/internals/indexing.md).
  return defaultConcurrencyForEndpoint(llmConfig?.endpoint);
}

// ── Phase functions ──────────────────────────────────────────────────────────

interface IndexSourceOwner {
  bundleId: string;
  sourceRoot: string;
}

function sourceOwners(sources: readonly SearchSource[]): IndexSourceOwner[] {
  const installations = deriveInstallations([...sources]);
  return sources.flatMap((source, index) => {
    const installation = installations[index];
    return installation ? [{ bundleId: installation.id, sourceRoot: path.resolve(source.path) }] : [];
  });
}

function parseStoredSourceOwners(raw: string | undefined): IndexSourceOwner[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (owner) =>
          typeof owner !== "object" ||
          owner === null ||
          typeof (owner as Record<string, unknown>).bundleId !== "string" ||
          typeof (owner as Record<string, unknown>).sourceRoot !== "string",
      )
    ) {
      warn("index_meta sourceOwners value is invalid — treating as empty");
      return [];
    }
    return parsed.map((owner) => {
      const stored = owner as { bundleId: string; sourceRoot: string };
      return { bundleId: stored.bundleId, sourceRoot: path.resolve(stored.sourceRoot) };
    });
  } catch {
    warn("index_meta sourceOwners value is corrupt JSON — treating as empty");
    return [];
  }
}

/**
 * Source cache phase: ensure git stash caches are up to date and purge orphaned
 * entries from removed sources (incremental only).
 */
async function runSourceCachePhase(ctx: IndexRunContext): Promise<void> {
  const { db, isIncremental, full, sources } = ctx;

  if (isIncremental && !full) {
    const currentByBundle = new Map(sourceOwners(sources).map((owner) => [owner.bundleId, owner]));
    for (const previous of parseStoredSourceOwners(getMeta(db, "sourceOwners"))) {
      const current = currentByBundle.get(previous.bundleId);
      if (!current || current.sourceRoot !== previous.sourceRoot) {
        ctx.hadRemovedSources = true;
        ctx.removedSources.push({
          ...previous,
          removeBundleEntries: current === undefined,
        });
      }
    }
  }
  // Source caches are hydrated before akmIndex() calls this phase; nothing
  // further to do here. The flag is exposed on ctx for runWalkPhase().
}

function applyRemovedSources(ctx: IndexRunContext): void {
  if (!ctx.scanComplete) return;
  const currentRoots = new Set(sourceOwners(ctx.sources).map((owner) => owner.sourceRoot));
  for (const removed of ctx.removedSources) {
    if (removed.removeBundleEntries) deleteEntriesByBundle(ctx.db, removed.bundleId);
    if (!currentRoots.has(removed.sourceRoot)) deleteStoredGraph(ctx.db, removed.sourceRoot);
  }
}

/**
 * Walk phase: scan the filesystem, generate metadata, and persist entries to
 * the database. Also kicks off LLM enrichment for directories that need it.
 *
 * Writes `ctx.scannedDirs`, `ctx.skippedDirs`, `ctx.generatedCount`,
 * `ctx.walkWarnings`, and `ctx.dirsNeedingLlm` for downstream phases.
 */
async function runWalkPhase(ctx: IndexRunContext): Promise<void> {
  const { db, sources, isIncremental, builtAtMs, hadRemovedSources, full, clean, signal, onProgress, config } = ctx;

  throwIfAborted(signal);

  ctx.timing.tWalkStart = Date.now();

  const doFullDelete = full || !isIncremental;
  const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm, warnings, complete } = await indexEntries(
    db,
    sources,
    isIncremental,
    builtAtMs,
    hadRemovedSources,
    doFullDelete,
    onProgress,
    !clean,
    async (dirRecords, ownersByRoot) => {
      const runner = ctx.enrichmentExecution.runner;
      if (
        runner &&
        isLlmFeatureEnabled(config, "metadata_enhance") &&
        dirRecordsNeedMetadataDispatch(db, dirRecords, ownersByRoot)
      ) {
        ctx.enrichmentLease = await preflightStructuredLlmRunner(runner);
      }
    },
  );

  ctx.scannedDirs = scannedDirs;
  ctx.skippedDirs = skippedDirs;
  ctx.generatedCount = generatedCount;
  ctx.walkWarnings = warnings;
  ctx.dirsNeedingLlm = dirsNeedingLlm;
  ctx.scanComplete = complete;

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
  await enhanceDirsWithLlm(
    db,
    config,
    ctx.enrichmentExecution,
    dirsNeedingLlm,
    onProgress,
    signal,
    (notices) => collectLoweringNotices(ctx.loweringNotices, notices),
    ctx.enrichmentLease,
  );
  onProgress({
    phase: "llm",
    message: ctx.enrichmentExecution.runner
      ? `LLM enhancement reviewed ${dirsNeedingLlm.length} ${dirsNeedingLlm.length === 1 ? "directory" : "directories"}.`
      : "LLM enhancement disabled.",
  });

  ctx.timing.tLlmEnd = Date.now();
}

/** Result of the shared embedding pass — see {@link runEmbeddingPass}. */
export interface EmbeddingPassResult {
  embeddingResult: EmbeddingGenerationResult;
  verification: IndexVerification;
}

/**
 * The ONE embedding-phase implementation (#954): generate and
 * store vectors for every entry missing one, then compute the `hasEmbeddings`
 * fact and the semantic-search verification off the result. `akmIndex`'s own
 * (non-deferred) run calls this from {@link runEmbeddingPhase} below; `akm
 * bundle update`'s coordinator calls it directly on its own connection AFTER
 * its unified update transaction commits, since the ambient-transaction drift
 * guard (and the whole point of per-batch commit, #954) requires `db` to have
 * no ambient transaction open.
 */
export async function runEmbeddingPass(params: {
  db: Database;
  config: AkmConfig;
  onProgress: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
  reembed?: boolean;
}): Promise<EmbeddingPassResult> {
  const { db, config, onProgress, signal, reembed } = params;
  const embeddingResult = await generateEmbeddingsForDb(db, config, onProgress, signal, undefined, {
    forceReembed: reembed,
  });
  setMeta(db, "hasEmbeddings", embeddingResult.success ? "1" : "0");
  const semanticEntryCount = getEmbeddableEntryCount(db);
  onProgress({ phase: "finalize", message: "Verifying semantic search state." });
  const verification = verifyIndexState(db, config, semanticEntryCount, embeddingResult);
  onProgress({ phase: "verify", message: verification.message });
  return { embeddingResult, verification };
}

/**
 * Embedding phase: generate and store vector embeddings for all unembedded
 * entries. Writes `ctx.embeddingResult` and `ctx.verification` for the
 * finalize phase / caller.
 */
async function runEmbeddingPhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, signal, onProgress, reembed, deferredUpdateTransaction } = ctx;

  throwIfAborted(signal);

  if (deferredUpdateTransaction) {
    // `akm bundle update`'s deferred pass (#954): the embedding
    // phase runs AFTER the coordinator's own commit, on its own connection,
    // via the coordinator's direct `runEmbeddingPass` call — never here,
    // inside the borrowed transaction (the ambient-transaction drift guard
    // would reject it anyway). `runFinalizePhase` records semantic state as
    // "pending".
    ctx.timing.tEmbedEnd = Date.now();
    return;
  }

  // Forward the signal. Without it generateEmbeddingsForDb's abort machinery was
  // inert — its throwIfAborted checks and the signal it threads into embedBatch
  // (which RemoteEmbedder passes to every fetch and LocalEmbedder honours between
  // chunks) never saw a controller. Ctrl-C and the improve budget abort could not
  // stop the embedding phase, the longest phase of an index run.
  const { embeddingResult, verification } = await runEmbeddingPass({ db, config, onProgress, signal, reembed });
  ctx.embeddingResult = embeddingResult;
  ctx.verification = verification;
  ctx.timing.tEmbedEnd = Date.now();
}

/**
 * Finalize phase: confirm transactionally materialized FTS state, re-link
 * usage events, recompute utility scores, update index metadata, and emit the
 * verify event.
 */
async function runFinalizePhase(ctx: IndexRunContext): Promise<void> {
  const { db, config, sources, sourceDirs, stashDir, signal, onProgress, deferredUpdateTransaction } = ctx;
  ctx.timing.tFinalizeStart = Date.now();

  // `upsertEntry` and every canonical delete own their FTS projection. This is
  // an observation point, not a second materialization pass.
  onProgress({
    phase: "fts",
    message: "Full-text search index is current.",
  });
  ctx.timing.tFtsEnd = Date.now();

  // Re-link state.db usage events to the regenerated index and recompute the
  // derived utility cache. Stored refs already use the current item-ref grammar,
  // so this idempotent pass only restores derived entry ids.
  const mutateState = (stateDb: Database, stateSchema?: string): void => {
    onProgress({ phase: "finalize", message: "Relinking usage events." });
    relinkUsageEvents(db, stateDb, { sources, defaultStashDir: stashDir, stateSchema });
    onProgress({ phase: "finalize", message: "Recomputing utility scores." });
    recomputeUtilityScores(db, stateDb, { stateSchema });
  };
  if (deferredUpdateTransaction) {
    if (deferredUpdateTransaction.db !== db || !db.inTransaction) {
      throw new Error("Source update index finalization requires its borrowed unified transaction.");
    }
    // state.db is ATTACHed to this same index connection before the outer
    // BEGIN IMMEDIATE. Index and state mutations therefore share one SQLite
    // commit/rollback decision rather than an unsafe two-connection ordering.
    mutateState(db, deferredUpdateTransaction.stateSchema);
  } else {
    withStateDb(mutateState);
  }

  // Purge LLM cache entries for assets that no longer exist in the index.
  try {
    onProgress({ phase: "finalize", message: "Clearing stale LLM cache entries." });
    clearStaleCacheEntries(db);
  } catch {
    /* ignore */
  }

  throwIfAborted(signal);

  // An incomplete run preserves the prior freshness watermark. Advancing it
  // could make a recovered source look unchanged even though this run never
  // persisted its files.
  if (ctx.scanComplete) {
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "stashDirs", JSON.stringify(sourceDirs));
    setMeta(db, "sourceOwners", JSON.stringify(sourceOwners(sources)));
  }

  warnIfVecMissing(db);

  const totalEntries = getEntryCount(db);

  if (deferredUpdateTransaction) {
    // #954: the embedding phase was skipped for this borrowed
    // transaction — record semantic state as pending, never ready, until the
    // coordinator's own post-commit `runEmbeddingPass` call reports the
    // truth on a fresh connection.
    setMeta(db, "hasEmbeddings", "0");
    const semanticEntryCount = getEmbeddableEntryCount(db);
    const message = "Semantic index update deferred until after the source-update commit.";
    onProgress({ phase: "verify", message });
    ctx.verification = {
      ok: true,
      message,
      semanticSearchEnabled: config.semanticSearchMode === "auto",
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: config.semanticSearchMode === "off" ? "disabled" : "pending",
      embeddingProvider: getEmbeddingProvider(config.embedding),
      entryCount: semanticEntryCount,
      embeddingCount: getEmbeddingCount(db),
      vecAvailable: isVecAvailable(db),
    };
  }
  // Non-deferred: ctx.verification was already populated by runEmbeddingPhase
  // (via the shared runEmbeddingPass).

  ctx.totalEntries = totalEntries;
  ctx.timing.tFinalizeEnd = Date.now();

  // suppress unused warning — sources was previously used inline
  void sources;
}

// ── Clean pass ───────────────────────────────────────────────────────────────

/**
 * Missing-file reconciliation: scan the `entries` table for rows whose source
 * file no longer exists on disk and remove them (unless `dryRun` is true).
 *
 * Only rows with a non-empty `file_path` are checked — remote/virtual entries
 * that have no local path are always skipped.
 *
 * "No longer exists" means ABSENT, never merely unreadable (#791). This pass
 * DELETES rows, and `fs.existsSync` reported `false` for a file akm lacked
 * permission to look at exactly as for one that had been removed — so a
 * bundle temporarily mounted read-restricted (a uid mismatch, a tightened
 * parent directory) had its whole index wiped, and the run reported the
 * deletions as a clean success. Unreadable files keep their rows and are
 * reported instead.
 */
function runCleanPass(db: Database, dryRun: boolean): IndexCleanResult {
  const allEntries = db.prepare("SELECT id, item_ref AS ref, file_path AS path FROM entries").all() as {
    id: number;
    ref: string;
    path: string;
  }[];

  // Only check entries that have a non-empty local path (skip remote/virtual).
  const localEntries = allEntries.filter((e) => typeof e.path === "string" && e.path.trim() !== "");

  const missing: typeof localEntries = [];
  const unreadable: Array<{ path: string; code?: string }> = [];
  for (const entry of localEntries) {
    const { access, code } = classifyPathAccess(entry.path);
    if (access === "absent") missing.push(entry);
    else if (access === "inaccessible") unreadable.push({ path: entry.path, ...(code ? { code } : {}) });
  }
  if (unreadable.length > 0) {
    const shown = unreadable.slice(0, 5).map((u) => describeInaccessiblePath(u.path, u.code));
    warn(
      `Index clean pass kept ${unreadable.length} entr${unreadable.length === 1 ? "y" : "ies"} whose file akm cannot ` +
        `read (unreadable is not deleted): ${shown.join("; ")}${unreadable.length > shown.length ? "; …" : ""}`,
    );
  }

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

// Moved to its own module (field follow-up to #956) so
// `generateEmbeddingsForDb` (materialize-embeddings.ts) can reuse the same
// classifier without an indexer.ts <-> materialize-embeddings.ts import
// cycle. Re-exported here for back-compat with existing call sites/tests
// that import it from `./indexer`. See index-db-contention.ts for the full
// rationale.
export { reclassifyIndexDbContention };

export async function akmIndex(options: IndexOptions): Promise<IndexResponse> {
  try {
    const override = akmIndexOverride;
    return override ? await override(options) : await akmIndexReal(options);
  } catch (error) {
    const updateDb = options.deferredUpdateTransaction?.db;
    if (updateDb?.inTransaction) {
      try {
        updateDb.exec("ROLLBACK");
      } catch {
        // Preserve the indexing error. The update coordinator will retry
        // rollback before closing its borrowed unified handle.
      }
    }
    throw reclassifyIndexDbContention(error);
  }
}

/**
 * Named observation points fired from INSIDE the reindex write transaction
 * (see {@link persistDirRecords}). TEST-ONLY.
 *
 *  - `full-delete-applied` — every `DELETE` of the full-rebuild wipe has run,
 *    but the re-insert has not started. This is the instant at which a
 *    non-atomic implementation would expose an empty database.
 *  - `records-persisted` — all rows are re-inserted, but the transaction has
 *    not committed yet, so the new generation is still invisible outside.
 */
export type IndexTransactionPoint = "full-delete-applied" | "records-persisted";

let indexTransactionHookForTests: ((point: IndexTransactionPoint) => void) | undefined;

/**
 * TEST-ONLY. Observe the in-flight reindex transaction; `undefined` restores.
 *
 * Exists because the delete-then-reinsert atomicity guarantee is, by
 * construction, invisible from outside the transaction: by the time
 * `akmIndex()` resolves, the commit has already collapsed both generations
 * into one observable state. Concurrency tests install a hook that opens a
 * SECOND connection at these points and asserts it still sees the previous
 * complete generation. Inert in production (one `undefined?.()` per reindex).
 */
export function _setIndexTransactionHookForTests(hook?: (point: IndexTransactionPoint) => void): void {
  indexTransactionHookForTests = hook;
}

/** Fire a named in-transaction observation point (no-op outside tests). */
function indexTransactionHook(point: IndexTransactionPoint): void {
  indexTransactionHookForTests?.(point);
}

let drainObserverForTests: ((dirPath: string, fileCount: number) => void) | undefined;

/**
 * TEST-ONLY. Observe every directory that actually reaches
 * `drainDirDocuments` — the per-file read/sha256-hash/frontmatter-parse step
 * (#900) — with the directory path and its walked file count. `undefined`
 * restores. A directory the pre-drain gate (`getCachedDirState`) skips never
 * fires this observer, so it is the
 * seam #900's own tests use to assert an unchanged directory's files are
 * never read on a no-op incremental run.
 */
export function _setDrainObserverForTests(observer?: (dirPath: string, fileCount: number) => void): void {
  drainObserverForTests = observer;
}

/**
 * Detect an adapter for every resolvable source that does not declare one, and
 * persist each detection into `config.json`.
 *
 * R-056: this config write previously had zero disclosure — it appeared in no
 * result, on no stream, and in no doc. The returned `persistedAdapters` records
 * exactly which bundle→adapter pairs the mutate callback actually applied, so
 * the caller can surface them in the result envelope; a stderr notice is
 * emitted here. The map is cleared at the top of every callback invocation
 * because `mutateConfig` may retry optimistically, and a retry must not report
 * a superseded attempt.
 *
 * Extracted from `akmIndexReal` as one self-contained named pass, both to keep
 * that function under the src-wide function-size bar and because the detection
 * and its disclosure belong together.
 */
function detectAndPersistBundleAdapters(
  allSourceEntries: SearchSource[],
  config: AkmConfig,
  mutateConfig: typeof import("../core/config/config.js").mutateConfig,
  opts: { announce: boolean; persist: boolean },
): { config: AkmConfig; persistedAdapters: Record<string, string> } {
  const detectedByBundle = new Map<string, string>();
  for (const source of allSourceEntries) {
    if (source.adapterId || source.unresolved) continue;
    if (allSourceRootsReadable([source.path])) {
      source.adapterId = detectAdapterId(source.path);
      if (source.registryId) detectedByBundle.set(source.registryId, source.adapterId);
    }
  }

  const persistedAdapters: Record<string, string> = {};
  if (detectedByBundle.size === 0 || !opts.persist) return { config, persistedAdapters };

  const nextConfig = mutateConfig(
    (current) => {
      if (!current.bundles) return current;
      let changed = false;
      const bundles = { ...current.bundles };
      for (const key of Object.keys(persistedAdapters)) delete persistedAdapters[key];
      for (const [bundleId, adapter] of detectedByBundle) {
        const bundle = bundles[bundleId];
        if (!bundle) continue;
        const componentEntries = Object.entries(bundle.components ?? {});
        const [componentId, component] = componentEntries[0] ?? ["main", {}];
        if (component.adapter) continue;
        bundles[bundleId] = { ...bundle, components: { [componentId]: { ...component, adapter } } };
        changed = true;
        persistedAdapters[bundleId] = adapter;
      }
      return changed ? { ...current, bundles } : current;
    },
    { absentNoop: true },
  ).config;

  const persistedCount = Object.keys(persistedAdapters).length;
  if (persistedCount > 0 && opts.announce) {
    const summary = Object.entries(persistedAdapters)
      .map(([bundleId, adapter]) => `${bundleId} → ${adapter}`)
      .join(", ");
    warn(
      `[index] Detected adapter${persistedCount === 1 ? "" : "s"} for ${summary}; persisted to config.json ` +
        "(bundles.<id>.components.<component>.adapter).",
    );
  }
  return { config: nextConfig, persistedAdapters };
}

interface CreateIndexRunContextOptions {
  db: Database;
  config: AkmConfig;
  enrichmentExecution: ResolvedIndexPassExecution;
  sources: SearchSource[];
  sourceDirs: string[];
  full: boolean;
  clean: boolean;
  reembed: boolean;
  stashDir: string;
  onProgress: (event: IndexProgressEvent) => void;
  signal: AbortSignal | undefined;
  t0: number;
  deferredUpdateTransaction?: DeferredUpdateIndexTransaction;
}

function createIndexRunContext(options: CreateIndexRunContextOptions): IndexRunContext {
  const prevStashDir = getMeta(options.db, "stashDir");
  const prevBuiltAt = getMeta(options.db, "builtAt");
  const isIncremental = !options.full && prevStashDir === options.stashDir && !!prevBuiltAt;
  const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;
  const { t0, ...context } = options;
  return {
    ...context,
    loweringNotices: [...options.enrichmentExecution.notices],
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
    removedSources: [],
    scanComplete: true,
    scannedDirs: 0,
    skippedDirs: 0,
    generatedCount: 0,
    walkWarnings: [],
    dirsNeedingLlm: [],
    embeddingResult: null,
  };
}

async function akmIndexReal(options: IndexOptions): Promise<IndexResponse> {
  // R-022: `dryRun` only ever gated the `--clean` stale-entry removal pass
  // (see `runCleanPass` below) — every other phase (walk, LLM enrichment,
  // embeddings, FTS, the adapter-detection config write) ran for real
  // regardless, so `akm index --dry-run` alone silently performed a full,
  // real index. The flag's own docs (`IndexOptions.dryRun` above, and the
  // CLI help in stash-cli.ts) already scope it to `--clean`; reject the
  // combination that was never implemented instead of quietly doing
  // something other than what "dry run" promised. Checked before the writer
  // lease is even requested so a bad invocation fails instantly.
  if (options?.dryRun === true && options?.clean !== true) {
    const { UsageError } = await import("../core/errors.js");
    throw new UsageError(
      "`--dry-run` only applies together with `--clean` (it previews which stale entries `--clean` would remove). " +
        "Pass `akm index --clean --dry-run`, or drop `--dry-run` to run a real index.",
      "INVALID_FLAG_VALUE",
      "Run `akm index --clean --dry-run` to preview, or `akm index --clean` to apply.",
    );
  }
  const requestedAt = Date.now();
  return (async () => {
    const stashDir = options.stashDir;
    const onProgress = options?.onProgress ?? (() => {});
    const signal = options?.signal;
    const full = options?.full === true;
    const clean = options?.clean === true;
    const dryRun = options?.dryRun === true;
    const reembed = options?.reembed === true;

    // Load config and resolve all stash sources
    const { loadConfig, mutateConfig } = await import("../core/config/config.js");
    let config = loadConfig();

    // Durable state must be runtime-compatible before source hydration,
    // adapter persistence, or index.db creation can mutate the installation.
    onProgress({ phase: "preflight", message: "Validating durable state." });
    if (!options.deferredUpdateTransaction) withStateDb(() => undefined);

    // Ensure git stash caches are extracted before resolving stash dirs,
    // so their content directories exist on disk for the walker to discover.
    const sourceCacheStart = Date.now();
    onProgress({ phase: "preflight", message: "Hydrating source caches." });
    const { ensureSourceCaches, resolveSourceEntries } = await import("./search/search-source.js");
    // Inject the store-backed secret resolver from here — a composition root
    // ABOVE the provider/fetcher import cycle (this module reaches
    // search-source only via dynamic import). This is what lets a website
    // source's X fetcher resolve `secrets/x-bearer-token` during
    // bundle-update / hydrate, not just from the command-layer URL-ingest
    // path. `secret-seam` is imported here, never from inside the cycle.
    const { storeSecretResolver } = await import("../sources/snapshot-fetchers/secret-seam.js");
    await ensureSourceCaches(config, {
      force: full,
      materialize: options.hydrateSources !== false,
      secrets: storeSecretResolver,
      // Same progress channel as every other phase (#954) — a
      // stalled clone/fetch here runs BEFORE index.db is even opened, so
      // without this it looked identical to "no database open, nothing
      // written".
      onProgress: (message) => onProgress({ phase: "preflight", message }),
    });
    const sourceCacheEnd = Date.now();
    const allSourceEntries = resolveSourceEntries(stashDir, config);
    const detected = detectAndPersistBundleAdapters(allSourceEntries, config, mutateConfig, {
      announce: options.implicit !== true,
      persist: options.persistDetectedAdapters !== false,
    });
    config = detected.config;
    const persistedAdapters = detected.persistedAdapters;
    const allSourceDirs = allSourceEntries.map((s) => s.path);
    onProgress({
      phase: "preflight",
      message: `Resolved ${allSourceDirs.length} stash source${allSourceDirs.length === 1 ? "" : "s"}.`,
    });

    const t0 = Date.now();
    const enrichmentExecution = resolveIndexPassExecution("enrichment", config);

    // Open database — pass embedding dimension from config if available
    const dbPath = getDbPath();
    const embeddingDim = config.embedding?.dimension;
    const borrowedUpdateDb = options.deferredUpdateTransaction?.db;
    const db = borrowedUpdateDb ?? openIndexDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);
    if (borrowedUpdateDb && !borrowedUpdateDb.inTransaction) {
      throw new Error("Source update index requires an active borrowed index transaction.");
    }

    let indexRunContext: IndexRunContext | undefined;
    try {
      // Assemble the run context
      const ctx = createIndexRunContext({
        db,
        config,
        enrichmentExecution,
        sources: allSourceEntries,
        sourceDirs: allSourceDirs,
        full,
        clean,
        reembed,
        stashDir,
        onProgress,
        signal,
        t0,
        deferredUpdateTransaction: options.deferredUpdateTransaction,
      });
      indexRunContext = ctx;

      onProgress({
        phase: "summary",
        message: buildIndexSummaryMessage({
          mode: ctx.isIncremental ? "incremental" : "full",
          sourcesCount: allSourceDirs.length,
          semanticSearchMode: config.semanticSearchMode,
          embeddingProvider: getEmbeddingProvider(config.embedding),
          llmEnabled: !!enrichmentExecution.runner,
          vecAvailable: isVecAvailable(db),
        }),
      });

      let cleanResult: IndexCleanResult | undefined;
      let cleanStart = Date.now();
      let cleanEnd = cleanStart;

      // ── Phase sequence ───────────────────────────────────────────────────────
      await runSourceCachePhase(ctx);
      await runWalkPhase(ctx);
      applyRemovedSources(ctx);

      // Reconcile explicit missing-file cleanup before embeddings, totals, or
      // verification describe this generation. Dry-run intentionally leaves
      // the generation unchanged while still returning the previewed refs.
      cleanStart = Date.now();
      if (clean) {
        onProgress({
          phase: "finalize",
          message: dryRun ? "Scanning for stale index entries (dry run)." : "Removing stale index entries.",
        });
        if (ctx.scanComplete) {
          cleanResult = runCleanPass(db, dryRun);
        } else {
          warn("[index] --clean skipped because one or more configured sources were not scanned completely.");
          cleanResult = { checked: 0, removed: 0, removedRefs: [], dryRun };
        }
      }
      cleanEnd = Date.now();

      await runEmbeddingPhase(ctx);
      await runFinalizePhase(ctx);
      // ────────────────────────────────────────────────────────────────────────

      // runFinalizePhase always populates these before returning.
      const verification = ctx.verification as IndexVerification;
      const totalEntries = ctx.totalEntries as number;
      const { timing } = ctx;

      return {
        stashDir,
        totalEntries,
        generatedMetadata: ctx.generatedCount,
        indexPath: dbPath,
        mode: ctx.isIncremental ? "incremental" : "full",
        directoriesScanned: ctx.scannedDirs,
        directoriesSkipped: ctx.skippedDirs,
        scanComplete: ctx.scanComplete,
        ...(ctx.walkWarnings.length > 0 ? { warnings: ctx.walkWarnings } : {}),
        ...(ctx.loweringNotices.length > 0 ? { notices: Object.freeze([...ctx.loweringNotices]) } : {}),
        ...(Object.keys(persistedAdapters).length > 0
          ? { configUpdated: { detectedAdapters: persistedAdapters } }
          : {}),
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
          sourceCacheMs: sourceCacheEnd - sourceCacheStart,
          endToEndMs: Date.now() - requestedAt,
        },
        ...(cleanResult !== undefined ? { clean: cleanResult } : {}),
      };
    } finally {
      if (indexRunContext?.enrichmentLease) {
        disposeLoweredExecutionDispatchLease(indexRunContext.enrichmentLease);
      }
      if (!borrowedUpdateDb) closeDatabase(db);
    }
  })();
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

type DirScanReason = {
  kind:
    | "duplicate-dir"
    | "no-indexable-files"
    | "unchanged"
    | "unchanged-precheck"
    | "index-context-changed"
    | "full-rebuild"
    | "no-previous-rows"
    | "cached-zero-row-state"
    | "mtime-changed"
    | "file-set-changed"
    | "missing-file"
    | "not-in-source-snapshot";
  detail?: string;
};

type DirRecord = {
  dirPath: string;
  currentStashDir: string;
  files: string[];
  stash: StashFile | null;
  skip: boolean;
  reason?: DirScanReason;
  persistedRowCount?: number;
  /** Walked-set fingerprint taken at scan time (#900); persisted as-is for scanned and unchanged dirs. */
  fingerprint?: DirFingerprint;
  /**
   * F4a M-core-2: `doc.hash` keyed by recognized-file absolute path, produced by
   * the per-dir document drain. Read by the persist layer to populate
   * `content_hash`. Absent on skipped dirs (nothing drained).
   */
  hashByFile?: Map<string, string>;
  /**
   * `doc.conceptId` keyed by recognized-file absolute path — the OWNING
   * adapter's identity, preferred by the persist layer over akm's
   * `stashDirFor` re-derivation (D-R3 identity fidelity for non-akm adapters).
   */
  conceptIdByFile?: Map<string, string>;
  /** Adapter id/version folded into incremental directory freshness. */
  indexVariant?: string;
  /** Persisted directory omitted by the current successful adapter walk. */
  remove?: boolean;
  /** False when traversal uncertainty makes absent-file pruning unsafe. */
  pruneMissing?: boolean;
};

type DirNeedingLlm = {
  dirPath: string;
  files: string[];
  currentStashDir: string;
  stash: StashFile;
};

type IndexedSourceOwner = Pick<EntryProvenance, "bundleId" | "componentId" | "adapterId">;

function buildIndexedSourceOwners(sources: readonly SearchSource[]): Map<string, IndexedSourceOwner> {
  const installations = deriveInstallations([...sources]);
  const owners = new Map<string, IndexedSourceOwner>();
  sources.forEach((source, index) => {
    const installation = installations[index];
    if (!installation) return;
    const component = installation.components[0];
    owners.set(path.resolve(source.path), {
      bundleId: installation.id,
      componentId: component?.id ?? installation.id,
      adapterId: component?.adapter ?? "akm",
    });
  });
  return owners;
}

/** Read-only mirror of the enrichment cache gate used before entry persistence. */
function dirRecordsNeedMetadataDispatch(
  db: Database,
  records: readonly DirRecord[],
  ownersByRoot: ReadonlyMap<string, IndexedSourceOwner>,
): boolean {
  for (const record of records) {
    if (record.skip || record.remove || !record.stash) continue;
    const owner = ownersByRoot.get(path.resolve(record.currentStashDir));
    if (!owner) throw new Error(`Missing bundle provenance for indexed source ${record.currentStashDir}`);
    for (const entry of record.stash.entries) {
      if (entry.quality !== "generated" || isEnrichmentComplete(entry)) continue;
      const entryFile = entry.filename ? path.join(record.dirPath, entry.filename) : undefined;
      if (!entryFile) continue;
      const adapterConceptId = record.conceptIdByFile?.get(entryFile);
      if (!adapterConceptId) continue;
      let fileContent: string | undefined;
      try {
        fileContent = fs.readFileSync(entryFile, "utf8");
      } catch {
        // The dispatch path uses the same deterministic metadata fallback.
      }
      const bodyHash = computeBodyHash(fileContent ?? `${entry.name}\n${entry.description ?? ""}`);
      const cacheKey = deriveEntryProvenance(owner, entry.type, entry.name, adapterConceptId).itemRef;
      const cached = getLlmCacheEntry(db, cacheKey, bodyHash);
      if (!cached) return true;
      try {
        JSON.parse(cached.resultJson);
      } catch {
        return true;
      }
    }
  }
  return false;
}

type SourceScanPlan = {
  currentStashDir: string;
  component: BundleComponent;
  adapter?: BundleAdapter;
  indexVariant?: string;
  dirGroups: Map<string, FileContext[]>;
  removals: Array<DirRecord & { reason: DirScanReason }>;
  walkComplete: boolean;
};

type SourceScanResult = {
  dirRecords: DirRecord[];
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  complete: boolean;
};

function removalsFirst(records: DirRecord[]): DirRecord[] {
  return [...records.filter((record) => record.remove), ...records.filter((record) => !record.remove)];
}

function addEntryIds(target: Set<number>, ids: number[]): void {
  for (const id of ids) target.add(id);
}

/**
 * Map each source root → its durable `BundleComponent` (`deriveInstallations`,
 * batch-unique bundle ids, source order preserved). The per-dir document drain
 * dispatches `adapterForId(component.adapter).recognize` for this component. The
 * component id only surfaces on `IndexDocument.ref`, which the persist layer
 * re-derives independently — so a source missing from the map (never happens: the
 * map is built from the same sources) is harmless.
 */
function buildComponentBySource(sources: SearchSource[]): Map<string, BundleComponent> {
  const map = new Map<string, BundleComponent>();
  const installations = deriveInstallations(sources);
  sources.forEach((source, i) => {
    const component = installations[i]?.components[0];
    if (component) map.set(source.path, component);
  });
  return map;
}

function componentForSource(components: Map<string, BundleComponent>, sourcePath: string): BundleComponent {
  return (
    components.get(sourcePath) ?? {
      id: sourcePath,
      adapter: "akm",
      root: sourcePath,
      writable: false,
    }
  );
}

function groupFileContextsByDir(fileContexts: FileContext[]): Map<string, FileContext[]> {
  const groups = new Map<string, FileContext[]>();
  for (const ctx of fileContexts) {
    const group = groups.get(ctx.parentDirAbs);
    if (group) group.push(ctx);
    else groups.set(ctx.parentDirAbs, [ctx]);
  }
  return groups;
}

function sourceSnapshotRemovals(
  db: Database,
  currentStashDir: string,
  bundleId: string,
  currentDirs: ReadonlySet<string>,
  allIndexedDirsByBundle?: ReadonlyMap<string, ReadonlySet<string>>,
): Array<DirRecord & { reason: DirScanReason }> {
  const indexedDirs = allIndexedDirsByBundle?.get(bundleId) ?? getIndexedDirPathsByBundleId(db, bundleId);
  return [...indexedDirs]
    .map((dirPath) => path.resolve(dirPath))
    .filter((dirPath) => !currentDirs.has(dirPath))
    .map((dirPath) => ({
      dirPath,
      currentStashDir,
      files: [],
      stash: null,
      skip: false,
      remove: true,
      reason: { kind: "not-in-source-snapshot" },
    }));
}

/**
 * Warn ONCE per process (#908) when the chosen adapter for a component
 * entirely skips a top-level directory that holds files the `akm` adapter —
 * the format-neutral superset — would have indexed. `detectAdapterId` now
 * corrects this for AUTO-DETECTION (a mixed layout detects as `akm`); this
 * covers the case detection cannot see, an EXPLICITLY configured narrow
 * adapter (`components.<name>.adapter: "agent-skills"`, say) sitting next to
 * ordinary akm content. One line for the whole process — not one per bundle,
 * not one per directory — naming the count and the directories is enough to
 * point an operator at the fix.
 */
function warnIfAdapterSkipsAkmContent(
  component: BundleComponent,
  files: readonly FileContext[],
  adapter: BundleAdapter,
): void {
  if (adapter.id === "akm") return;
  const akm = adapterForId("akm");
  if (!akm) return;

  const byTopDir = new Map<string, FileContext[]>();
  for (const file of files) {
    const top = file.ancestorDirs[0];
    if (!top) continue; // a root-level file is not a "skipped directory" concern
    const group = byTopDir.get(top);
    if (group) group.push(file);
    else byTopDir.set(top, [file]);
  }

  const akmComponent: BundleComponent = { ...component, adapter: "akm" };
  let skippedCount = 0;
  const skippedDirs: string[] = [];
  for (const [dir, dirFiles] of byTopDir) {
    const chosenRecognizesAny = dirFiles.some((file) => {
      try {
        return adapter.recognize(component, file) !== null;
      } catch {
        return false;
      }
    });
    if (chosenRecognizesAny) continue; // the chosen adapter owns this dir; nothing skipped
    const akmCandidates = dirFiles.filter((file) => {
      try {
        return akm.recognize(akmComponent, file) !== null;
      } catch {
        return false;
      }
    });
    if (akmCandidates.length === 0) continue; // akm would drop it too — not a shadowing case
    skippedCount += akmCandidates.length;
    skippedDirs.push(dir);
  }
  if (skippedCount === 0) return;
  skippedDirs.sort();
  warnOnce(
    "adapter-skip-akm-content",
    `${adapter.id} adapter skipped ${skippedCount} file${skippedCount === 1 ? "" : "s"} in ` +
      `${skippedDirs.map((dir) => `${dir}/`).join(", ")} — set components.<name>.adapter to "akm" to index them`,
  );
}

function buildSourceScanPlans(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  reconcileMissingDirs: boolean,
): { plans: SourceScanPlan[]; handoffDirs: Set<string> } {
  const componentBySource = buildComponentBySource(allSourceEntries);
  const handoffDirs = new Set<string>();
  const plans = allSourceEntries.map((sourceAdded): SourceScanPlan => {
    const currentStashDir = sourceAdded.path;
    const component = componentForSource(componentBySource, currentStashDir);
    if (sourceAdded.unresolved) {
      return {
        currentStashDir,
        component,
        adapter: undefined,
        indexVariant: undefined,
        dirGroups: new Map(),
        removals: [],
        walkComplete: false,
      };
    }
    const walked = walkStashFlatWithStatus(currentStashDir, {
      includeAllDirectories: component.adapter === "okf",
      ...(component.adapter === "akm" || component.adapter === "akm-workflow"
        ? { workflowSymlinkAdapter: component.adapter }
        : {}),
    });
    const dirGroups = groupFileContextsByDir(walked.files);
    const adapter = adapterForId(component.adapter);
    if (adapter) warnIfAdapterSkipsAkmContent(component, walked.files, adapter);
    return {
      currentStashDir,
      component,
      adapter,
      indexVariant: adapter ? `${adapter.id}@${adapter.version}` : undefined,
      dirGroups,
      removals: [],
      walkComplete: walked.complete,
    };
  });

  const removalKeys = new Set<string>();
  const addRemoval = (plan: SourceScanPlan, dirPath: string, stashDir: string) => {
    const resolvedDir = path.resolve(dirPath);
    const key = `${resolvedDir}\0${path.resolve(stashDir)}`;
    if (removalKeys.has(key)) return;
    removalKeys.add(key);
    plan.removals.push({
      dirPath,
      currentStashDir: stashDir,
      files: [],
      stash: null,
      skip: false,
      remove: true,
      reason: { kind: "not-in-source-snapshot" },
    });
    handoffDirs.add(resolvedDir);
  };

  const allComplete = plans.every((plan) => plan.walkComplete && plan.adapter !== undefined);

  // A full, globally-complete run uses the atomic table wipe below. Every
  // other run reconciles only sources that produced trustworthy snapshots.
  if (reconcileMissingDirs && (isIncremental || !allComplete)) {
    const allIndexedDirsByBundle = !isIncremental ? new Map<string, Set<string>>() : undefined;
    if (allIndexedDirsByBundle) {
      for (const entry of getAllEntries(db)) {
        const dirs = allIndexedDirsByBundle.get(entry.bundleId) ?? new Set<string>();
        dirs.add(path.dirname(path.resolve(entry.filePath)));
        allIndexedDirsByBundle.set(entry.bundleId, dirs);
      }
    }
    for (const plan of plans) {
      if (!plan.walkComplete || !plan.adapter) continue;
      const currentDirs = new Set([...plan.dirGroups.keys()].map((dirPath) => path.resolve(dirPath)));
      for (const removal of sourceSnapshotRemovals(
        db,
        plan.currentStashDir,
        plan.component.id,
        currentDirs,
        allIndexedDirsByBundle,
      )) {
        addRemoval(plan, removal.dirPath, removal.currentStashDir);
      }
    }
  }

  // Cross-source ownership handoffs can delete another source's rows, so they
  // still require every possible owner to have completed its scan.
  if (!allComplete) return { plans, handoffDirs };

  // The first configured source that exposes a physical directory owns it.
  // Remove rows left by a prior owner even when both adapters are identical.
  const claimedDirs = new Set<string>();
  const sourcePathByBundle = new Map(plans.map((plan) => [plan.component.id, plan.currentStashDir] as const));
  for (const plan of plans) {
    for (const dirPath of plan.dirGroups.keys()) {
      const resolvedDir = path.resolve(dirPath);
      if (claimedDirs.has(resolvedDir)) continue;
      claimedDirs.add(resolvedDir);
      for (const priorOwnerBundle of getIndexedBundleIdsByDir(db, dirPath)) {
        if (priorOwnerBundle !== plan.component.id) {
          const priorOwnerPath = sourcePathByBundle.get(priorOwnerBundle);
          if (priorOwnerPath) addRemoval(plan, dirPath, priorOwnerPath);
        }
      }
    }
  }
  return { plans, handoffDirs };
}

/**
 * Phase 1 (async): walk every source directory and pre-generate all metadata
 * outside any transaction, producing the per-directory scan records that
 * {@link persistDirRecords} later writes.
 *
 * The per-dir document drain (`drainDirDocuments` × the component's dispatched
 * `adapter.recognize`, F4a M-core-2) is synchronous, but the walk still runs
 * outside `db.transaction()` so the persist pass can be a single synchronous
 * transaction.
 */
function reportSourceScanProgress(
  onProgress: ((event: IndexProgressEvent) => void) | undefined,
  processed: number,
  total: number,
  message: string,
): void {
  onProgress?.({ phase: "scan", message, processed, total });
}

async function scanSourceDirs(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  hadRemovedSources: boolean,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
): Promise<SourceScanResult> {
  let scannedDirs = 0;
  let skippedDirs = 0;
  let generatedCount = 0;
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const { plans, handoffDirs } = buildSourceScanPlans(db, allSourceEntries, isIncremental, reconcileMissingDirs);

  const dirRecords: DirRecord[] = [];
  let processedDirs = 0;
  let priorDirsChanged = hadRemovedSources;

  const reportScanProgress = (message: string) =>
    reportSourceScanProgress(onProgress, processedDirs, allSourceEntries.length, message);

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

  // Only the first source that exposes a physical directory may index it.
  const markSeenOrSkipDuplicate = (dirPath: string, currentStashDir: string, files: string[]): boolean => {
    const resolved = path.resolve(dirPath);
    if (seenPaths.has(resolved)) {
      const reason = { kind: "duplicate-dir" } satisfies DirScanReason;
      dirRecords.push({ dirPath, currentStashDir, files, stash: null, skip: true, reason });
      reportDirDecision("skip", dirPath, currentStashDir, reason);
      return true;
    }
    seenPaths.add(resolved);
    return false;
  };

  // Incremental freshness gate shared by both branches: consult the persisted
  // dir state and record either a skip (unchanged + eligible for incremental
  // skip) or a scan record carrying the candidate stash.
  const recordFreshnessDecision = (
    dirPath: string,
    currentStashDir: string,
    stateFiles: string[],
    fingerprint: DirFingerprint,
    stash: StashFile | null,
    hashByFile: Map<string, string>,
    conceptIdByFile: Map<string, string>,
    indexVariant: string,
    forceScan: boolean,
    pruneMissing: boolean,
  ): void => {
    const previousState = getDirIndexState(db, dirPath, stateFiles, builtAtMs, indexVariant, fingerprint);
    if (isIncremental && !forceScan && !previousState.stale && canUseIncrementalSkip(previousState, priorDirsChanged)) {
      skippedDirs++;
      dirRecords.push({
        dirPath,
        currentStashDir,
        files: stateFiles,
        fingerprint,
        stash: null,
        skip: true,
        reason: previousState.reason,
        persistedRowCount: previousState.persistedRowCount,
        indexVariant,
      });
      reportDirDecision("skip", dirPath, currentStashDir, previousState.reason, previousState.persistedRowCount);
      return;
    }

    scannedDirs++;
    priorDirsChanged = true;
    const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
    dirRecords.push({
      dirPath,
      currentStashDir,
      files: stateFiles,
      fingerprint,
      stash,
      skip: false,
      reason,
      persistedRowCount: previousState.persistedRowCount,
      hashByFile,
      conceptIdByFile,
      indexVariant,
      pruneMissing,
    });
    reportDirDecision("scan", dirPath, currentStashDir, reason, previousState.persistedRowCount);
  };

  for (const plan of plans) {
    const { currentStashDir, component, adapter, dirGroups, removals, walkComplete } = plan;
    processedDirs++;
    reportScanProgress(
      `Processed ${processedDirs}/${allSourceEntries.length} source${allSourceEntries.length === 1 ? "" : "s"}.`,
    );

    if (!walkComplete) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      warn(`[index] source "${component.id}" was not scanned completely; preserving its last-known-good rows.`);
      continue;
    }

    // Owner ruling 2026-07-21: dispatch each component's DETECTED adapter (§4).
    // An unknown adapter id has no `adapterForId` match → skip the whole
    // component with a warning (one bundle = one component = one adapter).
    if (!adapter) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      warn(`Skipping component "${component.id}": unknown adapter id "${component.adapter}".`);
      continue;
    }
    const indexVariant = plan.indexVariant ?? `${adapter.id}@${adapter.version}`;

    for (const removal of removals) {
      dirRecords.push(removal);
      scannedDirs++;
      priorDirsChanged = true;
      reportDirDecision("scan", removal.dirPath, currentStashDir, removal.reason);
    }

    for (const [dirPath, ctxs] of dirGroups) {
      // Adapter-owned filtering (owner ruling 2026-07-21): the drain no longer
      // pre-filters with AKM-stash policy — each adapter's `recognize` claims or
      // abstains on its own bundle's walked files. The core walk keeps only the
      // universal hygiene `walkStashFlat` already applies (.git/dot-dirs/etc.).
      const indexableFiles = ctxs.map((ctx) => ctx.absPath);
      const forceScan = handoffDirs.has(path.resolve(dirPath)) || requiresWorkflowSourcePreflight(ctxs);

      if (markSeenOrSkipDuplicate(dirPath, currentStashDir, indexableFiles)) continue;

      if (indexableFiles.length === 0) {
        skippedDirs++;
        const reason = { kind: "no-indexable-files" } satisfies DirScanReason;
        dirRecords.push({ dirPath, currentStashDir, files: indexableFiles, stash: null, skip: true, reason });
        reportDirDecision("skip", dirPath, currentStashDir, reason);
        continue;
      }

      // #900: decide from stat data alone whether the directory can be skipped,
      // before drainDirDocuments reads, hashes, and parses every file.
      const fingerprint = computeDirFingerprint(dirPath, indexableFiles, indexVariant);
      const cachedState =
        isIncremental &&
        !forceScan &&
        getCachedDirState(db, dirPath, indexableFiles, builtAtMs, priorDirsChanged, indexVariant, fingerprint);
      if (cachedState) {
        skippedDirs++;
        dirRecords.push({
          dirPath,
          currentStashDir,
          files: indexableFiles,
          stash: null,
          skip: true,
          reason: cachedState.reason,
          indexVariant,
        });
        reportDirDecision("skip", dirPath, currentStashDir, cachedState.reason, cachedState.persistedRowCount);
        continue;
      }

      // F4a M-core-2 (the flip): drain the dir's `IndexDocument` stream via the
      // component's dispatched `adapter.recognize` (broken workflows dropped-with-
      // warning at the drain layer) and reconstruct the durable `IndexDocument`s.
      drainObserverForTests?.(dirPath, ctxs.length);
      const drained = drainDirDocuments(adapter, component, ctxs);
      if (drained.warnings.length) warnings.push(...drained.warnings);
      const generated: StashFile = drained.warnings.length
        ? { entries: drained.entries, warnings: drained.warnings }
        : { entries: drained.entries };

      // `.stash.json` sidecar overrides retired (#39): the cutover's content
      // migration folded sidecar metadata into frontmatter and deleted the
      // files; the runtime no longer reads them.
      const { stash, staleFiles } = buildIndexedDirCandidate(dirPath, indexableFiles, generated);

      if (generated.entries.length > 0) {
        generatedCount += generated.entries.length;
      }

      recordFreshnessDecision(
        dirPath,
        currentStashDir,
        staleFiles,
        fingerprint,
        stash,
        drained.hashByFile,
        drained.conceptIdByFile,
        indexVariant,
        forceScan,
        walkComplete,
      );
    }
  }

  return {
    dirRecords: removalsFirst(dirRecords),
    scannedDirs,
    skippedDirs,
    generatedCount,
    warnings,
    complete: plans.every((plan) => plan.walkComplete && plan.adapter !== undefined),
  };
}

function requiresWorkflowSourcePreflight(ctxs: readonly FileContext[]): boolean {
  return ctxs.some((ctx) => {
    try {
      return fs.lstatSync(ctx.absPath).isSymbolicLink();
    } catch {
      return true;
    }
  });
}

function preserveExistingIndex(
  doFullDelete: boolean,
  dirRecords: DirRecord[],
  sourceRoots: readonly string[],
): boolean {
  if (!doFullDelete) return false;
  const incomingDocCount = dirRecords.reduce(
    (n, record) => n + (record.skip ? 0 : (record.stash?.entries.length ?? 0)),
    0,
  );
  if (incomingDocCount > 0 || allSourceRootsReadable(sourceRoots)) return false;
  warn(
    "[index] --full produced zero documents while one or more source roots are missing or unreadable — " +
      "preserving the existing index (last-known-good) rather than wiping it. Re-run once the sources are available.",
  );
  return true;
}

/**
 * #624-P1 zero-document preflight probe. A source root counts as "readable"
 * when it exists on disk as a directory whose listing can be read. A root that
 * is missing or unreadable (a transient mount failure, a permission race, or a
 * source that vanished mid-run) makes a zero-document scan untrustworthy: the
 * walk saw nothing not because the stash is empty but because it could not be
 * read. Returns true only when EVERY root is readable, so a single unreadable
 * root blocks the full-rebuild wipe.
 */
function allSourceRootsReadable(roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) return false;
      fs.readdirSync(root); // probe readability, not just existence
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Phase 2 (sync): write all pre-generated scan records inside a single
 * transaction, returning the directories that still need LLM enrichment.
 */
function persistDirRecords(
  db: Database,
  dirRecords: DirRecord[],
  doFullDelete: boolean,
  warnings: string[],
  sourceRoots: readonly string[],
  scanComplete: boolean,
  bundleByRoot: ReadonlyMap<string, { bundleId: string; componentId: string; adapterId: string }>,
): { dirsNeedingLlm: DirNeedingLlm[] } {
  const dirsNeedingLlm: DirNeedingLlm[] = [];
  const fullDelete = doFullDelete && scanComplete;

  // #624-P1 zero-document preflight (spec §4). A full-rebuild wipe is a
  // legitimate mass-delete ONLY when the scan legitimately found nothing. If
  // the walk produced zero documents AND any configured source root is missing
  // or unreadable, the empty result is almost certainly a transient scan
  // failure, not an emptied stash — wiping here would cascade-destroy the
  // last-known-good index (entries + embeddings + utility/usage). Preserve it
  // and warn instead; the next successful run reconciles. A genuinely empty
  // stash whose roots ARE readable still wipes, as before.
  if (preserveExistingIndex(fullDelete, dirRecords, sourceRoots)) return { dirsNeedingLlm };

  // Per-source dedup: the same logical asset can appear more than once within
  // one owning source, where source order still makes the first occurrence win.
  // The owner is part of the key so identical concepts in different bundles
  // remain distinct indexed rows.
  const indexedAssetIdentities = new Set<string>();
  const deletedUsageEntryIds = new Set<number>();

  const insertTransaction = db.transaction(() => {
    // Perform the full-rebuild wipe as the FIRST step of the insert
    // transaction so delete and re-insert are atomic — a concurrent reader
    // never observes an empty database between the two operations.
    if (fullDelete) {
      // #955: copy every (search_text hash, embedding) pair about to be
      // discarded wholesale into `embedding_salvage`, tagged with the
      // fingerprint the discarded vectors were generated under, BEFORE the
      // wipe below — inside the SAME transaction so the copy and the
      // discard commit or roll back together. The embedding phase later in
      // this run hands salvaged vectors back to unchanged content instead
      // of re-embedding the whole corpus.
      salvageEmbeddingsBeforeDiscard(db);
      // Entries and every child materialization share one deletion authority.
      // Usage events live in state.db and survive so finalize can relink them
      // to the replacement generation's row ids.
      deleteAllEntries(db, { cleanupUsageEvents: false });
      db.exec("DELETE FROM index_dir_state");
      // Chunk-8 WI-8.3: usage_events lives in state.db now (not index.db), so the
      // wipe no longer detaches it here. The finalize pass's relinkUsageEvents
      // (cross-DB) nulls entry_ids that no longer resolve to a rebuilt entry and
      // re-resolves the rest by entry_ref — subsuming the old detach.
      // Atomicity observation point: inside the transaction the tables are now
      // empty, but no other connection may observe that. See
      // tests/integration/indexer/reindex-generation-atomicity.test.ts.
      indexTransactionHook("full-delete-applied");
    }

    for (const {
      dirPath,
      currentStashDir,
      files,
      fingerprint,
      stash,
      skip,
      reason,
      persistedRowCount,
      hashByFile,
      conceptIdByFile,
      indexVariant,
      remove,
      pruneMissing,
    } of dirRecords) {
      const bundle = bundleByRoot.get(path.resolve(currentStashDir));
      if (!bundle) throw new Error(`Missing bundle provenance for indexed source ${currentStashDir}`);
      if (remove) {
        const removedIds = deleteEntriesByDirAndBundle(db, dirPath, bundle.bundleId, {
          cleanupUsageEvents: false,
        });
        addEntryIds(deletedUsageEntryIds, removedIds);
        deleteIndexDirState(db, dirPath);
        continue;
      }
      if (skip) {
        // "unchanged" is the post-drain verdict: re-persist so the row carries
        // row_count and the gate skips this directory before draining next
        // time. "unchanged-precheck" already matched the stored row.
        if (reason?.kind === "unchanged" && fingerprint) {
          upsertIndexDirState(db, { dirPath, ...fingerprint, reason: reason.kind, rowCount: persistedRowCount });
        }
        continue;
      }

      // Diff-persist (F4a M-core-2, spec §14.2): upsert the current file set
      // FIRST (ON CONFLICT preserving `entries.id` so embeddings / utility /
      // usage stay attached to unchanged rows), tracking every upserted
      // durable `item_ref`, then prune only the departed rows below. Replaces the old
      // `deleteEntriesByDir` truncate-and-reinsert (which discarded ids).
      const keptItemRefs = new Set<string>();

      let persistedRows = 0;
      let dedupedRows = 0;

      if (stash) {
        const ownerIdentity = bundle.bundleId;
        for (const entry of stash.entries) {
          const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
          if (!entryPath) {
            warn(`Skipping entry with no resolvable path in ${dirPath}`);
            continue;
          }

          const adapterConceptId = conceptIdByFile?.get(entryPath);
          if (!adapterConceptId) {
            warn(`Skipping entry without adapter-owned concept identity: ${entryPath}`);
            continue;
          }
          // Adapter-owned concept identity is path-based and cannot be replaced
          // by presentation fields such as type/title.
          const identityKey = `${ownerIdentity}\0${adapterConceptId}`;
          if (indexedAssetIdentities.has(identityKey)) {
            dedupedRows++;
            continue;
          }
          indexedAssetIdentities.add(identityKey);

          const searchText = buildSearchText(entry);
          const entryWithSize = attachFileSize(entry, entryPath);
          // content_hash = doc.hash from the drain, keyed by the recognized
          // file's path. A missing hash preserves the existing value on upsert.
          const contentHash = hashByFile?.get(entryPath);

          const provenance = deriveEntryProvenance(bundle, entry.type, entry.name, adapterConceptId);
          keptItemRefs.add(provenance.itemRef);

          upsertEntry(db, entryPath, entryWithSize, searchText, provenance, contentHash);
          persistedRows++;
        }

        // Collect dirs needing LLM enhancement during the first walk.
        // Only dirs with "generated" entries need enrichment.
        if (stash.entries.some((e) => e.quality === "generated")) {
          dirsNeedingLlm.push({ dirPath, files, currentStashDir, stash });
        }
      }

      // Prune the departed rows: everything under this dir NOT re-upserted above
      // (files deleted, deduped away, or abstained on by the adapter). With
      // an empty kept-set this deletes every row for the dir — the exact net
      // effect of the old unconditional `deleteEntriesByDir`, minus the id churn.
      if (pruneMissing !== false) {
        addEntryIds(
          deletedUsageEntryIds,
          deleteEntriesByDirExceptRefs(db, dirPath, bundle.bundleId, keptItemRefs, { cleanupUsageEvents: false }),
        );
      }

      const persistedFingerprint = fingerprint ?? computeDirFingerprint(dirPath, files, indexVariant);
      const persistedReason =
        persistedRows === 0
          ? inferZeroRowReason(stash, reason, warnings, dirPath, dedupedRows)
          : reason?.kind === "full-rebuild"
            ? "full-rebuild"
            : (reason?.kind ?? "updated");
      upsertIndexDirState(db, {
        dirPath,
        ...persistedFingerprint,
        reason: persistedReason,
        // A directory that lost rows to per-source dedup depends on the
        // directories persisted before it, not only on its own files, so it
        // must keep draining every run (as it did before the gate) until a
        // drain persists it without dedup. NULL keeps the gate closed.
        rowCount: dedupedRows === 0 ? persistedRows : undefined,
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
    // Atomicity observation point: the new generation is fully written but
    // uncommitted, so it must still be invisible to other connections.
    indexTransactionHook("records-persisted");
  });

  insertTransaction();
  deleteUsageEventsByEntryIds([...deletedUsageEntryIds]);

  return { dirsNeedingLlm };
}

async function indexEntries(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  hadRemovedSources: boolean,
  doFullDelete = false,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
  beforePersist?: (
    dirRecords: readonly DirRecord[],
    ownersByRoot: ReadonlyMap<string, IndexedSourceOwner>,
  ) => Promise<void>,
): Promise<{
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  dirsNeedingLlm: DirNeedingLlm[];
  complete: boolean;
}> {
  // Phase 1 (async): walk directories and pre-generate all metadata outside the
  // transaction.
  const { dirRecords, scannedDirs, skippedDirs, generatedCount, warnings, complete } = await scanSourceDirs(
    db,
    allSourceEntries,
    isIncremental,
    builtAtMs,
    hadRemovedSources,
    onProgress,
    reconcileMissingDirs,
  );

  const bundleByRoot = buildIndexedSourceOwners(allSourceEntries);
  await beforePersist?.(dirRecords, bundleByRoot);

  // Phase 2 (sync): write all pre-generated metadata inside a single transaction.
  // Source roots feed the #624-P1 zero-document preflight (a full-rebuild wipe
  // is suppressed when the scan is empty because roots are unreadable).
  const sourceRoots = allSourceEntries.map((s) => s.path);
  // Map each source root → its durable bundle id so the writer can persist
  // `item_ref = <bundle>//<conceptId>` and canonical component/adapter
  // provenance. `deriveInstallations`
  // preserves source order, so a positional zip yields the SAME bundle id the
  // dispatched `adapter.recognize` emits as `IndexDocument.ref` for that root.
  const { dirsNeedingLlm } = persistDirRecords(
    db,
    dirRecords,
    doFullDelete,
    warnings,
    sourceRoots,
    complete,
    bundleByRoot,
  );

  return { scannedDirs, skippedDirs, generatedCount, warnings, dirsNeedingLlm, complete };
}

function indexedProvenanceForFile(db: Database, filePath: string): EntryProvenance {
  const row = db
    .prepare(
      "SELECT item_ref AS itemRef, bundle_id AS bundleId, component_id AS componentId, " +
        "concept_id AS conceptId, adapter_id AS adapterId FROM entries WHERE file_path = ? LIMIT 1",
    )
    .get(filePath) as
    | {
        itemRef: string | null;
        bundleId: string | null;
        componentId: string | null;
        conceptId: string | null;
        adapterId: string | null;
      }
    | undefined;
  if (!row?.itemRef || !row.bundleId || !row.componentId || !row.conceptId || !row.adapterId) {
    throw new Error(`Missing indexed provenance for ${filePath}`);
  }
  return {
    itemRef: row.itemRef,
    bundleId: row.bundleId,
    componentId: row.componentId,
    conceptId: row.conceptId,
    adapterId: row.adapterId,
  };
}

async function enhanceDirsWithLlm(
  db: Database,
  config: import("../core/config/config").AkmConfig,
  execution: ResolvedIndexPassExecution,
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: StashFile;
  }>,
  onProgress?: (event: IndexProgressEvent) => void,
  signal?: AbortSignal,
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void,
  lease?: LoweredExecutionDispatchLease,
): Promise<void> {
  // The invocation owns one frozen symbolic selection. Summary reporting and
  // every enrichment dispatch consume this same snapshot.
  const llmRunner = execution.runner;
  if (!llmRunner || dirsNeedingLlm.length === 0) return;

  // Aggregate per-entry failures so a misconfigured LLM endpoint surfaces
  // as a single visible warning instead of silently degrading every entry
  // and leaving the user wondering why nothing got enhanced.
  const summary: LlmEnhancementSummary = { attempted: 0, succeeded: 0, skipped: 0, failureSamples: [] };
  let completedDirs = 0;
  let completedEntries = 0;
  const totalDirs = dirsNeedingLlm.length;
  const totalEntries = dirsNeedingLlm.reduce((sum, { stash }) => {
    const entriesToEnhance = stash.entries.filter((e) => {
      if (e.quality !== "generated") return false;
      if (isEnrichmentComplete(e)) return false;
      return true;
    });
    return sum + entriesToEnhance.length;
  }, 0);

  // P3 — wall-clock budget for the enrichment pass. Defaults to the resolved
  // engine's timeoutMs (or 10 minutes if not set). Users can extend it via
  // `index.enrichment.timeoutMs` (or `index.defaults.timeoutMs`, or the
  // engine's own `engines.<name>.timeoutMs`) — no separate knob needed.
  const enrichDeadline = createEnrichmentDeadline(llmRunner.timeoutMs, totalEntries);
  let deadlineHit = false;
  const enrichSignal: AbortSignal = (() => {
    if (!enrichDeadline) return signal ?? new AbortController().signal;
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
        `across ${totalDirs} director${totalDirs === 1 ? "y" : "ies"} (concurrency ${getDefaultLlmConcurrency(llmRunner.connection)}).`,
      processed: 0,
      total: totalEntries,
    });
  }

  let currentDirLabel: string | undefined;
  let configFailure: ConfigError | undefined;
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
        // Only enhance generated entries; user-provided overrides should not
        // be overwritten. Skip entries that are already fully enriched
        // (description + tags + searchHints).
        const entriesToEnhance = originalStash.entries.filter((e) => {
          if (e.quality !== "generated") return false;
          if (isEnrichmentComplete(e)) {
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
        const itemRefs = entriesToEnhance.map((entry) => {
          const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
          return indexedProvenanceForFile(db, entryPath).itemRef;
        });
        let enhanced: StashFile;
        try {
          enhanced = await enhanceStashWithLlm(
            llmRunner,
            targetStash,
            files,
            summary,
            enrichSignal,
            db,
            itemRefs,
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
            onNotices,
            lease,
          );
        } catch (err) {
          if (err instanceof ConfigError) {
            configFailure ??= err;
            return undefined;
          }
          throw err;
        }

        // Re-upsert the enhanced entries in a single transaction so a crash
        // cannot leave half the entries updated and the rest stale.
        db.transaction(() => {
          for (const entry of enhanced.entries) {
            const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
            const searchText = buildSearchText(entry);
            const provenance = indexedProvenanceForFile(db, entryPath);
            upsertEntry(db, entryPath, attachFileSize(entry, entryPath), searchText, provenance);
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
      // Defaults: 2 for remote LLM APIs, 1 for local model servers (LM
      // Studio, Ollama run one inference at a time — parallel requests cause
      // "Model reloaded" / 500 errors). No config override reaches this path:
      // `resolveLlmEngineUse` does not forward `engines.<name>.concurrency`.
      getDefaultLlmConcurrency(llmRunner.connection),
    );
    if (configFailure) throw configFailure;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  if (deadlineHit) {
    warn(
      "[akm] LLM enrichment budget exceeded. Re-run `akm index` to continue. Increase index.enrichment.timeoutMs for a larger budget.",
    );
  }

  // Gate-closed (`skipped`) entries are not failures — exclude them so a
  // deliberately disabled feature never surfaces as an enrichment error.
  const failed = summary.attempted - summary.succeeded - summary.skipped;
  if (failed > 0 && summary.succeeded === 0) {
    const sample = summary.failureSamples.length ? ` Example: ${summary.failureSamples[0]}` : "";
    warn(
      `LLM enhancement failed for all ${failed} attempted entries — index built without LLM enrichment.` +
        ` Check llm.endpoint and llm.model in your config.${sample}`,
    );
  } else if (failed > 0) {
    const sample = summary.failureSamples.length ? ` Examples: ${summary.failureSamples.join("; ")}` : "";
    warn(`LLM enhancement failed for ${failed}/${summary.attempted} entries — they were left un-enhanced.${sample}`);
  }
}

export function createEnrichmentDeadline(
  timeoutMs: number | null | undefined,
  totalEntries: number,
): AbortSignal | undefined {
  const perEntryTimeoutMs = timeoutMs === undefined ? 10 * 60 * 1000 : timeoutMs;
  return perEntryTimeoutMs === null ? undefined : AbortSignal.timeout(perEntryTimeoutMs * Math.max(totalEntries, 1));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function attachFileSize(entry: IndexDocument, entryPath: string): IndexDocument {
  try {
    const sized = { ...entry, fileSize: fs.statSync(entryPath).size };
    if (hasMarkdownFragmentContent(entry)) setMarkdownFragmentContent(sized, getMarkdownFragmentContent(entry));
    return sized;
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
    // "ready-vec" must reflect the path search will ACTUALLY take: the vec
    // extension being loaded is not enough when the embedding phase recorded
    // fast-path insert failures (searchVec then routes to the JS-cosine
    // fallback via isVecFastPathReady). Reporting vec health from
    // isVecAvailable alone overstated `akm info` after partial vec failures
    // (§24.2 "Semantic" gate — truthful ready-vec).
    const vecActive = vecAvailable && isVecFastPathReady(db);
    return {
      ok: true,
      message: `Semantic search ready (${embeddingCount}/${embeddableEntries} embeddings, ${
        vecActive
          ? "sqlite-vec active"
          : vecAvailable
            ? "JS fallback active — vec fast path degraded, run 'akm index --full' to restore"
            : "JS fallback active"
      }).`,
      semanticSearchEnabled: true,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: vecActive ? "ready-vec" : "ready-js",
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
        : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/reference/configuration.md for local embedding dependency setup.",
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
): IndexedDirCandidate {
  const stash = generated.entries.length > 0 ? { entries: generated.entries } : null;
  const staleFiles = stash ? resolveIndexedFiles(dirPath, indexableFiles, stash) : indexableFiles;
  return { stash, staleFiles };
}

function resolveIndexedFiles(dirPath: string, files: string[], stash: StashFile): string[] {
  const resolved = new Set<string>();
  for (const entry of stash.entries) {
    if (entry.filename) resolved.add(path.join(dirPath, entry.filename));
  }
  return resolved.size > 0 ? [...resolved] : files;
}

interface LlmEnhancementSummary {
  attempted: number;
  succeeded: number;
  /**
   * Entries the LLM never enhanced because the `metadata_enhance` gate was
   * closed. Not a failure — excluded from the failed count so a deliberately
   * disabled feature does not surface as an enrichment error.
   */
  skipped: number;
  /** Sample of error messages from failed entries (first 3, deduped). */
  failureSamples: string[];
}

async function enhanceStashWithLlm(
  llmRunner: StructuredLlmRunner,
  stash: StashFile,
  files: string[],
  summary: LlmEnhancementSummary,
  signal?: AbortSignal,
  db?: Database,
  itemRefs?: string[],
  akmConfig?: AkmConfig,
  onEntryDone?: (event: { entryName: string; outcome: "cache-hit" | "llm" | "failed" | "skipped" }) => void,
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void,
  lease?: LoweredExecutionDispatchLease,
): Promise<StashFile> {
  const { enhanceMetadata } = await import("../llm/metadata-enhance");
  const { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry } = await import(
    "../storage/repositories/index-llm-cache-repository"
  );

  let configFailure: ConfigError | undefined;
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

        // Incremental cache: skip LLM call when file body is unchanged. The
        // Cache metadata enrichment by the canonical durable item ref.
        const cacheBody = fileContent ?? `${entry.name}\n${entry.description ?? ""}`;
        const bodyHash = computeBodyHash(cacheBody);
        const cacheKey = itemRefs?.[idx];

        if (!cacheKey) throw new Error(`Missing canonical item ref for enrichment entry ${entry.name}.`);

        if (db) {
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

        const outcome = await enhanceMetadata(llmRunner, entry, fileContent, signal, akmConfig, onNotices, lease);

        if (outcome.status !== "enriched") {
          // Not a genuine LLM success: the gate was closed (`skipped`) or the
          // call errored/timed out (`failed`). Do NOT mark the entry enriched
          // and do NOT write the LLM cache — caching here would poison the
          // entry into a permanent enrichment skip even though nothing was
          // enhanced. Surface failures honestly; stay silent on gated-off skips.
          if (outcome.status === "failed") {
            const msg = outcome.error ?? "metadata enrichment failed";
            if (summary.failureSamples.length < 3 && !summary.failureSamples.includes(msg)) {
              summary.failureSamples.push(msg);
            }
            onEntryDone?.({ entryName: entry.name, outcome: "failed" });
          } else {
            summary.skipped++;
            onEntryDone?.({ entryName: entry.name, outcome: "skipped" });
          }
          return entry;
        }

        const improvements = outcome.metadata;
        const updated = { ...entry };
        if (improvements.description) updated.description = improvements.description;
        if (improvements.searchHints?.length) updated.searchHints = improvements.searchHints;
        if (improvements.tags?.length) updated.tags = improvements.tags;
        // Mark as enriched so subsequent index runs skip re-enrichment (P2).
        // An empty-but-successful response is still cached: the LLM was paid
        // for this body_hash and produced no improvements, so re-running would
        // only re-pay for the same no-op. (The cache protects against re-paying
        // for the LLM call when the file body is unchanged.)
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
        if (err instanceof ConfigError) {
          configFailure ??= err;
          return entry;
        }
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
    // Defaults: 2 for remote LLM APIs, 1 for local model servers. No config
    // override reaches this path (see getDefaultLlmConcurrency).
    getDefaultLlmConcurrency(llmRunner.connection),
  );
  if (configFailure) throw configFailure;

  // concurrentMap returns Array<T | undefined>; filter out undefined slots
  // (which can only occur if the callback itself returned undefined, which
  // it never does above — but TypeScript needs the filter for type safety).
  const enhanced: IndexDocument[] = results.map((r, i) => r ?? stash.entries[i]!);
  return { entries: enhanced };
}

// ── lookup ─────────────────────────────────────────────────────────────────

import { type BundleRef, makeBundleRef } from "../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName } from "../core/asset/resolve-ref";

export interface IndexEntry {
  /** Absolute path of the indexed file on disk. */
  filePath: string;
  /** Source root (the directory the walker rooted at). */
  stashDir: string;
  /** Asset type (skill, command, knowledge, ...). */
  type: string;
  /** Asset name as recorded by the indexer. */
  name: string;
  /** Adapter that owns recognition and progressive behavior for this entry. */
  adapterId: string;
  /** Persisted format-neutral projection for generic presentation. */
  document?: IndexDocument;
  /** Canonical durable identity from `entries.item_ref`. */
  itemRef: string;
  bundleId: string;
  conceptId: string;
}

export interface BundleRefLookupResolution {
  entry: IndexEntry | null;
  /** First physical owner, retained even when its index row is absent/stale. */
  owner?: AdapterConceptOwner;
  /** Deferred index failure for callers (such as show) that can use owner.path. */
  indexError?: unknown;
}

async function resolveLookupSources(): Promise<SearchSource[]> {
  const { loadConfig } = await import("../core/config/config.js");
  const { resolveSourceEntries } = await import("./search/search-source.js");
  return resolveSourceEntries(undefined, loadConfig());
}

function resolveLookupScope(
  bundle: string | undefined,
  sources: SearchSource[],
): { candidateSources: SearchSource[]; qualified: boolean } {
  if (!bundle) return { candidateSources: sources, qualified: false };
  return { candidateSources: resolveSourcesForOrigin(bundle, sources), qualified: true };
}

/**
 * Resolve index and physical ownership together. Ownership preserves
 * installation-priority arbitration even when a row is missing or stale.
 */
type LookupDatabaseOpener = (dbPath: string) => Database | undefined;

async function lookupBundleRefWithResolutionUsing(
  ref: BundleRef,
  openLookupDatabase: LookupDatabaseOpener,
): Promise<BundleRefLookupResolution> {
  const sources = await resolveLookupSources();
  if (sources.length === 0) return { entry: null };
  const bundleBySourcePath = new Map(
    deriveInstallations(sources).map((installation, index) => [path.resolve(sources[index]!.path), installation.id]),
  );

  const { candidateSources, qualified } = resolveLookupScope(ref.bundle, sources);
  if (candidateSources.length === 0) return { entry: null };

  let db: Database | undefined;
  let indexError: unknown;
  try {
    db = openLookupDatabase(getDbPath());
  } catch (error) {
    indexError = error;
  }
  try {
    for (const source of candidateSources) {
      const adapterId = source.adapterId ?? detectAdapterId(source.path);
      const owner = resolveAdapterConceptOwner(source.path, adapterId, ref.conceptId);
      const lookupConceptId = owner?.conceptId ?? ref.conceptId;
      const inputRef = makeBundleRef(qualified ? ref.bundle : undefined, lookupConceptId);
      const sourceBundleId = bundleBySourcePath.get(path.resolve(source.path));
      const id = db && sourceBundleId ? findEntryIdByRef(db, inputRef, sourceBundleId) : undefined;
      if (id !== undefined && owner && db) {
        const entry = readLookupEntry(db, id, ref.conceptId, source.path);
        if (entry) {
          if (owner.workflowSource) {
            try {
              assertIndexedWorkflowSourceIdentity(inputRef, entry.filePath, owner.workflowSource);
              if (entry.adapterId !== adapterId) {
                throw new WorkflowSourceIdentityError(inputRef, entry.filePath, owner.path);
              }
            } catch (error) {
              if (!(error instanceof WorkflowSourceIdentityError)) throw error;
              warn(`${error.message} Falling back to the physical owner.`);
              return { entry: null, owner, ...(indexError === undefined ? {} : { indexError }) };
            }
          } else if (entry.adapterId !== adapterId || !indexedPathMatchesOwner(entry.filePath, owner)) {
            return { entry: null, owner, ...(indexError === undefined ? {} : { indexError }) };
          }
          return { entry, owner, ...(indexError === undefined ? {} : { indexError }) };
        }
      }

      // A physical owner with a missing/incomplete index row still owns this
      // unqualified concept. Stop here so a later source cannot retarget it.
      if (owner) return { entry: null, owner, ...(indexError === undefined ? {} : { indexError }) };
    }
    return { entry: null, ...(indexError === undefined ? {} : { indexError }) };
  } finally {
    if (db) closeDatabase(db);
  }
}

export async function lookupBundleRefWithResolution(ref: BundleRef): Promise<BundleRefLookupResolution> {
  return lookupBundleRefWithResolutionUsing(ref, openExistingDatabase);
}

/** Resolve an adapter-owned `[bundle//]conceptId` without interpreting its path as an AKM type. */
export async function lookupBundleRef(ref: BundleRef): Promise<IndexEntry | null> {
  const resolution = await lookupBundleRefWithResolution(ref);
  if (resolution.indexError !== undefined) throw resolution.indexError;
  return resolution.entry;
}

/**
 * Resolve one execution source without opening the live index database for
 * write or allowing SQLite read-lock bookkeeping to touch its SHM file.
 */
export async function lookupBundleRefReadonly(ref: BundleRef): Promise<IndexEntry | null> {
  const resolution = await lookupBundleRefWithResolutionUsing(ref, (dbPath) => {
    const db = openReadonlyExistingDatabase(dbPath, { isolatedSnapshot: true });
    if (!db) throw new Error(`Index database not found at ${dbPath}. Run 'akm index' to build it.`);
    return db;
  });
  if (resolution.indexError !== undefined) throw resolution.indexError;
  return resolution.entry;
}

function readLookupEntry(db: Database, id: number, fallbackConceptId: string, sourceRoot: string): IndexEntry | null {
  const row = db
    .prepare(
      "SELECT file_path AS filePath, type, document_json AS documentJson, " +
        "item_ref AS itemRef, bundle_id AS bundleId, concept_id AS conceptId, " +
        "adapter_id AS adapterId FROM entries WHERE id = ?",
    )
    .get(id) as
    | {
        filePath: string;
        type: string;
        documentJson: string;
        itemRef: string;
        bundleId: string;
        conceptId: string;
        adapterId: string;
      }
    | undefined;
  if (!row) return null;
  let document: IndexDocument | undefined;
  try {
    document = JSON.parse(row.documentJson) as IndexDocument;
  } catch {
    // Corrupt optional projection does not erase the durable path identity.
  }
  return {
    filePath: row.filePath,
    stashDir: sourceRoot,
    type: row.type,
    name: document?.name ?? fallbackConceptId.split("/").pop() ?? fallbackConceptId,
    adapterId: row.adapterId,
    document,
    itemRef: row.itemRef,
    bundleId: row.bundleId,
    conceptId: row.conceptId,
  };
}

/**
 * Look up a single asset by ref. Spec §6.2 — `akm show` queries this and
 * reads the file from disk. The index is the source of truth for which
 * file corresponds to which ref; the indexer walks `provider.path()` for
 * every configured source, so this query covers all source kinds.
 *
 * Returns `null` when no row matches — callers translate that into a
 * `NotFoundError` with their own messaging.
 */
export async function lookup(ref: AssetRef): Promise<IndexEntry | null> {
  return lookupBundleRef({ bundle: ref.origin, conceptId: conceptIdFromTypeName(ref.type, ref.name) });
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
export function recomputeUtilityScores(db: Database, stateDb: Database, options?: { stateSchema?: string }): void {
  const EMA_DECAY = 0.7;
  const stateSchema = options?.stateSchema;
  if (stateSchema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(stateSchema)) {
    throw new Error("Invalid attached state schema name.");
  }
  const usageEvents = stateSchema === undefined ? "usage_events" : `"${stateSchema}".usage_events`;

  // Purge stale usage events (90-day retention). usage_events lives in state.db
  // (Chunk-8 WI-8.3); its table is created by state migration 020.
  purgeOldUsageEvents(stateDb, USAGE_EVENT_RETENTION_DAYS, { stateSchema });

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

  // Aggregate explicit user demand per entry_id from state.db's usage_events, then keep only entries
  // that STILL EXIST in index.db's `entries` (the former in-SQL JOIN is now a
  // cross-DB filter). This latter check is critical: usage_events has no FK to
  // entries, so its entry_id can become stale (entry deleted, re-keyed, moved
  // between sources). Without it, writing the derived row to utility_scores
  // (which DOES have an FK) raises "FOREIGN KEY constraint failed" and rolls
  // back the whole finalize transaction — failing every index run.
  const aggregatedRows = stateDb
    .prepare(`
      SELECT u.entry_id,
             SUM(CASE WHEN u.event_type = 'search' THEN 1 ELSE 0 END) AS search_count,
             SUM(CASE WHEN u.event_type = 'show'   THEN 1 ELSE 0 END) AS show_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
             SUM(CASE WHEN u.event_type = 'feedback' AND u.signal = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
             MAX(
               CASE
                 WHEN u.event_type IN ('search', 'show', 'curate') THEN u.created_at
                 ELSE NULL
               END
             ) AS last_used_at
      FROM ${usageEvents} u
      WHERE u.entry_id IS NOT NULL
        AND u.source = 'user'
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
  const entryExists = db.prepare("SELECT 1 FROM entries WHERE id = ?");
  const usageByEntry = new Map(
    aggregatedRows.filter((row) => entryExists.get(row.entry_id) != null).map((row) => [row.entry_id, row]),
  );

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

  const entryIds = new Set([...existingScores.keys(), ...usageByEntry.keys()]);
  for (const entryId of entryIds) {
    const row = usageByEntry.get(entryId) ?? {
      entry_id: entryId,
      search_count: 0,
      show_count: 0,
      positive_feedback_count: 0,
      negative_feedback_count: 0,
      last_used_at: null,
    };
    const selectRate = row.search_count > 0 ? Math.min(1, row.show_count / row.search_count) : 0;
    const feedbackTotal = row.positive_feedback_count + row.negative_feedback_count;
    const feedbackRate =
      feedbackTotal > 0 ? Math.max(0, row.positive_feedback_count - row.negative_feedback_count) / feedbackTotal : 0;
    const effectiveRate = Math.max(selectRate, feedbackRate);
    const existing = existingScores.get(row.entry_id);
    const prevUtility = existing?.utility ?? 0;
    const utility = prevUtility * emaDecay + effectiveRate * emaNew;
    // `utility_scores.last_used_at` is consumed by salience as the timestamp of
    // the most-recent retrieval. Preserve that meaning by carrying the event's
    // timestamp through verbatim. The former `effectiveRate > 0.5 ? now : ...`
    // branch stamped every high-select-rate entry with the index run time,
    // making unrelated assets look simultaneously fresh and flattening the
    // recency component of retrieval salience.
    //
    // `usage_events` is the source of truth within its retention window. A
    // missing row therefore clears legacy/index-time stamps on the next index
    // pass; salience already treats an absent timestamp as long ago.
    const lastUsedAt = row.last_used_at ?? undefined;

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
