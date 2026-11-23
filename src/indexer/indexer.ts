// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter, BundleListing } from "../core/adapter/bundle-adapter";
import { adapterIdOf, detectAdapterId } from "../core/adapter/detect-adapter";
import { requireAdapter } from "../core/adapter/registry";
import type { Bundle } from "../core/adapter/types";
import { type Asset, findAsset } from "../core/assets/read";
import { isHttpUrl, safeRealpath, toErrorMessage } from "../core/common";
import type { AkmConfig } from "../core/config/config";
import { appendEvent } from "../core/events";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { withStateDb } from "../core/state-db";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { localEmbeddingRuntime } from "../llm/embedder";
import { effectiveEmbedding } from "../llm/embedders/connection";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
/**
 * Index consistency.
 *
 * AKM keeps three derived populations per stash in index.db: the `entries`
 * rows (metadata + `document_json`), the FTS5 index over them, and the
 * embedding vectors. Each pass keeps its own cursor, so a change to one
 * pass's inputs re-runs only that pass:
 *
 *   - entries / FTS: `entries.content_hash` per file plus the per-directory
 *     walk fingerprint (`index_dir_state`); the FTS rows are written in the
 *     same transaction as the entries row (`upsertEntry`), never separately.
 *   - embeddings: `embeddings.model` per row; a row whose search text changed
 *     is deleted by `upsertEntry`, a row whose model differs from the
 *     configured one is re-embedded by the next pass.
 *
 * A full run (`--full`) re-drains every directory through the same
 * diff-persist path as an incremental one — `entries.id` is preserved on
 * conflict, so embeddings, utility scores and usage links stay attached to
 * unchanged rows. Nothing is wiped to be rebuilt.
 */
import type { Database } from "../storage/database";
import {
  closeDatabase,
  deleteIndexDatabase,
  indexDbIsDamaged,
  isCorruptionError,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import {
  type DeletedEntry,
  deleteEntriesByBundle,
  deleteEntriesByDirAndBundle,
  deleteEntriesByDirExceptRefs,
  deleteEntriesByIds,
  deleteEntriesOutsideLibrary,
  deleteUsageEventsForEntries,
  findEntryIdByRef,
  getAllEntries,
  getEmbeddableEntryCount,
  getEntryCount,
  getIndexedBundleIdsByDir,
  getIndexedDirPathsByBundleId,
  getStoredEntriesInDirectory,
  relinkUsageEvents,
  upsertEntry,
} from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { rebuildFtsIfTotalsStale } from "../storage/repositories/index-fts-repository";
import { storeLayout } from "../storage/repositories/index-layout-repository";
import { clearStaleCacheEntries, rekeyLlmCache } from "../storage/repositories/index-llm-cache-repository";
import {
  deleteIndexDirState,
  deleteMeta,
  getIndexDirState,
  getMeta,
  setMeta,
  upsertIndexDirState,
} from "../storage/repositories/index-meta-repository";
import { VACUUM_PENDING_META } from "../storage/repositories/index-schema";
import { upsertUtilityScore } from "../storage/repositories/index-utility-repository";
import { getEmbeddingCount } from "../storage/repositories/index-vec-repository";
import { withImmediateTransaction } from "../storage/sqlite-transaction";
import { INDEX_DB_VACUUMED_EVENT, readFreelistInfo, vacuumIfReclaimable } from "../storage/state-db-integrity";
import {
  assertIndexedWorkflowSourceIdentity,
  isUsableWorkflowSource,
  WorkflowSourceIdentityError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import { reclassifyIndexDbContention } from "./index-db-contention";
import { deriveEntryProvenance, deriveInstallations, sourceOfBundle } from "./installations";
import { legacyRefMove, rekeyLegacyEntry } from "./legacy-refs";
import { entryOnMiss, indexedPathMatchesOwner, indexedPathOf } from "./lookup/indexed-owner";
import { type EmbeddingGenerationResult, embeddingInputCap, generateEmbeddingsForDb } from "./materialize-embeddings";
import {
  computeDirFingerprint,
  type DirFingerprint,
  type DirStaleReason,
  getCachedDirState,
  getDirIndexState,
  inferZeroRowReason,
} from "./passes/dir-staleness";
import {
  CONTENT_PROJECTION_VERSION,
  type IndexDocument,
  isWorkflowSkipWarning,
  type StashFile,
  withFileSize,
} from "./passes/metadata";
import {
  type MovePairing,
  type NewEntry,
  pairMovedFiles,
  type RefMove,
  rekeyStateRefs,
  repointEntry,
  type StoredEntry,
} from "./ref-moves";
import { drainDirDocuments } from "./scan/drain-dir";
import type { SearchSource } from "./search/search-source";
import { purgeOldUsageEvents, USAGE_EVENT_RETENTION_DAYS } from "./usage/usage-events";
import { type FileContext, fileContextOfEntry } from "./walk/file-context";
import {
  INCOMPLETE_SOURCES_META_KEY,
  type IncompleteIndexSource,
  type IndexVerification,
  type RemovedIndexSource,
  SEMANTIC_SEARCH_META_KEY,
  type SemanticSearchRecord,
} from "./walk/index-context";
import type { WalkStashFlatResult } from "./walk/walker";

// ── Types ───────────────────────────────────────────────────────────────────

/** `--clean` did not run: removing rows for files that cannot be listed would delete rows for files that exist. */
interface IndexCleanSkipped {
  skipped: { reason: "incomplete-scan"; sources: IncompleteIndexSource[] };
}

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
  /** Each source that could not be scanned completely; empty when every source was. */
  incompleteSources: IncompleteIndexSource[];
  warnings?: string[];
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
  /** Present when --clean was passed: stale-entry purge results, or why the purge did not run. */
  clean?: IndexCleanResult | IndexCleanSkipped;
  /**
   * Present when files were renamed or moved since the last run: each moved asset's old and new ref (its history
   * went with it), and the number of vanished files whose identical-content matches could not be paired and were
   * indexed as new.
   */
  moves?: IndexMoves;
  /**
   * Present when this run auto-detected a bundle's adapter and persisted it
   * to config.json (`bundles.<id>.adapter`) — a
   * maintenance-command config write that would otherwise be invisible.
   * Keyed by bundle id, valued by the detected adapter id.
   */
  configUpdated?: { detectedAdapters: Record<string, string> };
}

/** Files renamed or moved on disk that the index paired with their old entry (same content), and how many it could not. */
export interface IndexMoves {
  moved: Array<{ from: string; to: string }>;
  unpaired: number;
}

export interface IndexProgressEvent {
  phase: "summary" | "preflight" | "scan" | "embeddings" | "fts" | "finalize" | "verify";
  message: string;
  processed?: number;
  total?: number;
}

export interface IndexOptions {
  /**
   * The stash directory to index. Resolved once at each command boundary
   * and threaded in — the indexer does not read the
   * ambient stash-dir resolver. Every caller (source add, wiki, workflow,
   * setup, improve, tests) already passes it.
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
   * When true (`akm index --reembed`), purge every stored vector and re-embed
   * all entries — the one explicit override; a model change without it keeps
   * the stored vectors and re-embeds incrementally.
   */
  reembed?: boolean;
  /** `akm index --import-vectors <file>`: vectors consulted before the embedder (see `vector-file.ts`). */
  importVectors?: string;
  onProgress?: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
  /**
   * Whether this run may materialize (clone/pull/fetch) cache-backed sources.
   * Default `true` — the sanctioned materialization callers (`akm index`,
   * source add/sync, improve's pre-run index). `bundle update` passes `false`
   * because it has just fetched; absent source caches are then skipped with a
   * warning instead of cloned.
   */
  hydrateSources?: boolean;
  /**
   * Whether adapter auto-detection may persist into config.json. `akm bundle
   * update` disables this: an update leaves config alone, and the next
   * `akm index` records the detected adapters.
   */
  persistDetectedAdapters?: boolean;
  /**
   * Whether this run was triggered implicitly by another command (improve's
   * pre-run index) rather than by an explicit `akm index`.
   *
   * Only affects DISCLOSURE, never behavior. The adapter-detection config
   * write is always reported in the result envelope, but its stderr
   * notice is suppressed for implicit runs: a read command's stderr carries
   * its JSON error envelope, so an extra human-readable line there makes the
   * envelope unparseable for callers doing `JSON.parse(stderr)` — and would
   * also leak past `--quiet`, which a read command is entitled to honor.
   */
  implicit?: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

// ── Source ownership ─────────────────────────────────────────────────────────

interface IndexSourceOwner {
  bundleId: string;
  sourceRoot: string;
}

function sourceOwners(sources: readonly SearchSource[]): IndexSourceOwner[] {
  return deriveInstallations([...sources]).map((bundle, index) => ({
    bundleId: bundle.id,
    sourceRoot: path.resolve((sources[index] as SearchSource).path),
  }));
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
 * Sources removed (or moved) since the last complete run. Their entries are
 * purged by {@link applyRemovedSources} once the walk completes.
 */
function findRemovedSources(db: Database, sources: readonly SearchSource[]): RemovedIndexSource[] {
  const currentByBundle = new Map(sourceOwners(sources).map((owner) => [owner.bundleId, owner]));
  return parseStoredSourceOwners(getMeta(db, "sourceOwners")).flatMap((previous) => {
    const current = currentByBundle.get(previous.bundleId);
    if (current && current.sourceRoot === previous.sourceRoot) return [];
    return [{ ...previous, removeBundleEntries: current === undefined }];
  });
}

function applyRemovedSources(
  db: Database,
  sources: readonly SearchSource[],
  removedSources: readonly RemovedIndexSource[],
  isIncremental: boolean,
): void {
  const owners = sourceOwners(sources);
  for (const removed of removedSources) {
    if (removed.removeBundleEntries) deleteEntriesByBundle(db, removed.bundleId);
  }
  // A full run re-drains every configured source, so any other bundle's rows
  // are stale even when no stored owner names them.
  if (isIncremental) return;
  const currentBundles = new Set(owners.map((owner) => owner.bundleId));
  const indexed = db.prepare("SELECT DISTINCT bundle_id AS bundleId FROM entries").all() as Array<{
    bundleId: string;
  }>;
  for (const { bundleId } of indexed) {
    if (!currentBundles.has(bundleId)) deleteEntriesByBundle(db, bundleId);
  }
}

/** Result of the shared embedding pass — see {@link runEmbeddingPass}. */
export interface EmbeddingPassResult {
  embeddingResult: EmbeddingGenerationResult;
  verification: IndexVerification;
}

/**
 * The embedding phase (#954): generate and store vectors for every entry
 * missing one, then compute the `hasEmbeddings` fact and the semantic-search
 * verification off the result, and record it for `akm health`. `db` must have no ambient transaction open —
 * each per-batch commit is its own durable write.
 */
export async function runEmbeddingPass(params: {
  db: Database;
  config: AkmConfig;
  onProgress: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
  reembed?: boolean;
  importVectorsFile?: string;
}): Promise<EmbeddingPassResult> {
  const { db, config, onProgress, signal, reembed, importVectorsFile } = params;
  const embeddingResult = await generateEmbeddingsForDb(db, config, onProgress, signal, undefined, {
    forceReembed: reembed,
    importVectorsFile,
  });
  setMeta(db, "hasEmbeddings", embeddingResult.success ? "1" : "0");
  const semanticEntryCount = getEmbeddableEntryCount(db);
  onProgress({ phase: "finalize", message: "Verifying semantic search state." });
  const verification = verifyIndexState(db, config, semanticEntryCount, embeddingResult);
  const unavailable = verification.semanticStatus === "blocked" ? embeddingResult.runtimeUnavailable : undefined;
  const record: SemanticSearchRecord = {
    status: unavailable ? "unavailable" : verification.semanticStatus,
    ...(unavailable ? { unavailable } : {}),
    provider: verification.embeddingProvider,
    ...(verification.embeddingRuntime ? { runtime: verification.embeddingRuntime } : {}),
    ...(verification.ok ? {} : { reason: verification.message }),
  };
  setMeta(db, SEMANTIC_SEARCH_META_KEY, JSON.stringify(record));
  onProgress({ phase: "verify", message: verification.message });
  return { embeddingResult, verification };
}

/**
 * Finalize: re-link usage events, recompute utility scores, clear stale LLM
 * cache rows and record this run's freshness metadata. `upsertEntry` and every
 * canonical delete own their FTS projection, so the "fts" event is an
 * observation point, not a second materialization pass.
 */
function finalizeIndex(args: {
  db: Database;
  sources: SearchSource[];
  scanComplete: boolean;
  incompleteSources: IncompleteIndexSource[];
  signal: AbortSignal | undefined;
  onProgress: (event: IndexProgressEvent) => void;
}): { tFtsEnd: number } {
  const { db, sources, signal, onProgress } = args;
  // Rows replaced or removed since its BM25 totals were taken leave them off; recompute them (#1048).
  const rebuilt = rebuildFtsIfTotalsStale(db);
  onProgress({
    phase: "fts",
    message: rebuilt
      ? "Rebuilt the full-text search index to recompute its totals."
      : "Full-text search index is current.",
  });
  const tFtsEnd = Date.now();

  // Re-link state.db usage events to the regenerated index and recompute the
  // derived utility cache. Stored refs already use the current item-ref grammar,
  // so this idempotent pass only restores derived entry ids.
  withStateDb((stateDb) => {
    onProgress({ phase: "finalize", message: "Relinking usage events." });
    relinkUsageEvents(db, stateDb);
    onProgress({ phase: "finalize", message: "Recomputing utility scores." });
    recomputeUtilityScores(db, stateDb);
  });

  // Purge LLM cache entries for assets that no longer exist in the index.
  try {
    onProgress({ phase: "finalize", message: "Clearing stale LLM cache entries." });
    clearStaleCacheEntries(db);
  } catch {
    /* ignore */
  }

  throwIfAborted(signal);

  // The incremental watermark, written only when the whole build completed. An
  // incomplete run preserves the prior one: advancing it could make a recovered
  // source look unchanged even though this run never persisted its files.
  // (Which library the index serves is recorded when the entries are persisted.)
  if (args.scanComplete) {
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "sourceOwners", JSON.stringify(sourceOwners(sources)));
  }
  // The sources the index holds last-known-good rows for: what `akm doctor` reads. Empty once every source scanned.
  setMeta(db, INCOMPLETE_SOURCES_META_KEY, JSON.stringify(args.incompleteSources));

  return { tFtsEnd };
}

/**
 * Compact index.db once a layout migration has left tables and columns'
 * pages free, or whenever more than half its pages are free (the same
 * threshold improve applies to state.db). Nothing else ever VACUUMs this
 * file, and a delete-heavy history leaves it mostly free pages.
 */
function vacuumIndexDb(db: Database, onProgress: (event: IndexProgressEvent) => void): void {
  const migrated = getMeta(db, VACUUM_PENDING_META) === "1";
  const outcome = vacuumIfReclaimable(db, readFreelistInfo(db), {
    eventType: INDEX_DB_VACUUMED_EVENT,
    force: migrated,
  });
  if (!outcome.ran) return;
  if (migrated) deleteMeta(db, VACUUM_PENDING_META);
  onProgress({
    phase: "finalize",
    message: `Compacted index.db with VACUUM: ${outcome.pagesBefore} → ${outcome.pagesAfter} pages.`,
  });
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

export async function akmIndex(options: IndexOptions): Promise<IndexResponse> {
  try {
    const override = akmIndexOverride;
    return override ? await override(options) : await akmIndexRecoveringCorruption(options);
  } catch (error) {
    throw reclassifyIndexDbContention(error);
  }
}

/**
 * index.db is a derived cache, fully regenerable from the library, and the
 * build holds the rebuild lock: damage to index.db found anywhere in a build
 * (the header, the schema, an interior page hit mid-walk) deletes the file and
 * builds again once. A corruption error from another database leaves it alone. An older layout is migrated in place, never dropped.
 */
async function akmIndexRecoveringCorruption(options: IndexOptions): Promise<IndexResponse> {
  try {
    return await akmIndexReal(options);
  } catch (error) {
    const dbPath = getDbPath();
    if (!isCorruptionError(error) || !indexDbIsDamaged(dbPath)) throw error;
    warn(`Index database is corrupt at ${dbPath} — rebuilding.`);
    deleteIndexDatabase(dbPath);
    return await akmIndexReal(options);
  }
}

/**
 * Named observation point fired from INSIDE the reindex write transaction
 * (see {@link persistDirRecords}). TEST-ONLY.
 *
 *  - `records-persisted` — every directory's rows are upserted and pruned,
 *    but the transaction has not committed yet, so the new generation is
 *    still invisible outside.
 */
export type IndexTransactionPoint = "records-persisted";

let indexTransactionHookForTests: ((point: IndexTransactionPoint) => void) | undefined;

/**
 * TEST-ONLY. Observe the in-flight reindex transaction; `undefined` restores.
 *
 * Exists because the persist transaction's atomicity is, by construction,
 * invisible from outside it: by the time `akmIndex()` resolves, the commit
 * has already collapsed both generations into one observable state.
 * Concurrency tests install a hook that opens a SECOND connection at this
 * point and asserts it still sees the previous complete generation. Inert in
 * production (one `undefined?.()` per reindex).
 */
export function _setIndexTransactionHookForTests(hook?: (point: IndexTransactionPoint) => void): void {
  indexTransactionHookForTests = hook;
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

/** Whether `root` is a directory whose listing can be read (adapter detection only probes such roots). */
function isReadableDirectory(root: string): boolean {
  try {
    // asset-io: bundle-root root probe
    if (!fs.statSync(root).isDirectory()) return false;
    fs.readdirSync(root); // probe readability, not just existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect an adapter for every resolvable source that does not declare one, and
 * persist each detection into `config.json`.
 *
 * This config write is disclosed: the returned `persistedAdapters` records
 * exactly which bundle→adapter pairs the mutate callback actually applied, so
 * the caller can surface them in the result envelope; a stderr notice is
 * emitted here. The map is cleared at the top of every callback invocation
 * because `mutateConfig` may retry optimistically, and a retry must not report
 * a superseded attempt.
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
    if (isReadableDirectory(source.path)) {
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
        if (bundle.adapter) continue;
        bundles[bundleId] = { ...bundle, adapter };
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
        "(bundles.<id>.adapter).",
    );
  }
  return { config: nextConfig, persistedAdapters };
}

async function akmIndexReal(options: IndexOptions): Promise<IndexResponse> {
  // `dryRun` only gates the `--clean` stale-entry removal pass
  // (see `runCleanPass` below) — every other phase (walk, embeddings, FTS,
  // the adapter-detection config write) runs for real regardless, so
  // `akm index --dry-run` alone would silently perform a full,
  // real index. The flag's own docs (`IndexOptions.dryRun` above, and the
  // CLI help in stash-cli.ts) scope it to `--clean`; reject the
  // unsupported combination instead of quietly doing
  // something other than what "dry run" promises. Checked before the writer
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
  const { stashDir, signal } = options;
  const onProgress = options.onProgress ?? (() => {});
  const full = options.full === true;
  const clean = options.clean === true;
  const dryRun = options.dryRun === true;

  // Load config and resolve all stash sources
  const { loadConfig, mutateConfig } = await import("../core/config/config.js");
  let config = loadConfig();

  // Durable state must be runtime-compatible before source hydration,
  // adapter persistence, or index.db creation can mutate the installation.
  onProgress({ phase: "preflight", message: "Validating durable state." });
  withStateDb(() => undefined);

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
    materialize: options.hydrateSources !== false,
    secrets: storeSecretResolver,
    // Same progress channel as every other phase (#954) — a
    // stalled clone/fetch here runs BEFORE index.db is even opened, so
    // without this it looked identical to "no database open, nothing
    // written".
    onProgress: (message) => onProgress({ phase: "preflight", message }),
  });
  const sourceCacheEnd = Date.now();
  const sources = resolveSourceEntries(stashDir, config);
  const detected = detectAndPersistBundleAdapters(sources, config, mutateConfig, {
    announce: options.implicit !== true,
    persist: options.persistDetectedAdapters !== false,
  });
  config = detected.config;
  const { persistedAdapters } = detected;
  const sourceDirs = sources.map((s) => s.path);
  onProgress({
    phase: "preflight",
    message: `Resolved ${sourceDirs.length} stash source${sourceDirs.length === 1 ? "" : "s"}.`,
  });

  const t0 = Date.now();

  const dbPath = getDbPath();
  const db = openIndexDatabase(dbPath);

  try {
    // `--full` folds into `isIncremental`: a full run drains every directory
    // through the same diff-persist path as an incremental one.
    canonicalizeStoredPaths(db);
    const prevStashDir = getMeta(db, "stashDir");
    const prevBuiltAt = getMeta(db, "builtAt");
    const isIncremental = !full && servesLibrary(prevStashDir, stashDir) && !!prevBuiltAt;
    const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;
    const mode = isIncremental ? "incremental" : "full";

    onProgress({
      phase: "summary",
      message: buildIndexSummaryMessage({
        mode,
        sourcesCount: sourceDirs.length,
        semanticSearchMode: config.semanticSearchMode,
        embeddingProvider: getEmbeddingProvider(effectiveEmbedding(config)),
      }),
    });

    const removedSources = findRemovedSources(db, sources);

    // ── Walk: scan the filesystem, generate metadata, persist entries ─────
    throwIfAborted(signal);
    const tWalkStart = Date.now();
    // Walk every source and pre-generate all metadata outside any transaction…
    const { dirRecords, scannedDirs, skippedDirs, generatedCount, warnings, complete, incompleteSources } =
      await scanSourceDirs(db, sources, isIncremental, builtAtMs, config, onProgress, !clean);
    // …then write it in one transaction: `item_ref = <bundle>//<conceptId>`
    // plus canonical bundle/adapter provenance per source root.
    const bundleByRoot = buildIndexedSourceOwners(sources);
    // A source that did not resolve this run keeps its last-known-good rows through a library switch.
    const unresolvedBundleIds = new Set(
      sources.flatMap((source) => (source.unresolved ? [bundleByRoot.get(path.resolve(source.path))?.bundleId] : [])),
    );
    const moves = persistDirRecords(db, dirRecords, warnings, bundleByRoot, embeddingInputCap(config), {
      stashDir,
      sourceDirs,
      unresolvedBundleIds,
    });
    onProgress({
      phase: "scan",
      message: `Scanned ${scannedDirs} ${scannedDirs === 1 ? "directory" : "directories"} and skipped ${skippedDirs}.`,
    });

    // Workflow validation noise gate (issue #273): suppress per-spec stderr
    // lines at default verbosity and emit a single summary instead. In verbose
    // mode the per-spec lines are already printed by buildMetadataSkipWarning.
    if (!isVerbose()) {
      const skippedWorkflowCount = warnings.filter(isWorkflowSkipWarning).length;
      if (skippedWorkflowCount > 0) {
        const noun = skippedWorkflowCount === 1 ? "workflow spec" : "workflow specs";
        warn(
          `${skippedWorkflowCount} ${noun} skipped due to validation errors; ` + "rerun with --verbose to see details.",
        );
      }
    }
    const tWalkEnd = Date.now();

    // There is no LLM metadata-enhancement pass. `timing.llmMs` stays (always
    // ~0) so the JSON shape is unchanged.
    const tLlmEnd = Date.now();

    if (complete) applyRemovedSources(db, sources, removedSources, isIncremental);

    // Reconcile explicit missing-file cleanup before embeddings, totals, or
    // verification describe this generation. Dry-run intentionally leaves
    // the generation unchanged while still returning the previewed refs.
    let cleanResult: IndexCleanResult | IndexCleanSkipped | undefined;
    const cleanStart = Date.now();
    if (clean) {
      onProgress({
        phase: "finalize",
        message: dryRun ? "Scanning for stale index entries (dry run)." : "Removing stale index entries.",
      });
      if (complete) {
        cleanResult = runCleanPass(db, dryRun);
      } else {
        warn("[index] --clean skipped because one or more configured sources were not scanned completely.");
        cleanResult = { skipped: { reason: "incomplete-scan", sources: incompleteSources } };
      }
    }
    const cleanEnd = Date.now();

    // ── Embeddings ─────────────────────────────────────────────────────────
    throwIfAborted(signal);
    const { verification } = await runEmbeddingPass({
      db,
      config,
      onProgress,
      signal,
      reembed: options.reembed === true,
      importVectorsFile: options.importVectors,
    });
    // The library's layout by meaning and its near-duplicates, from the vectors, when they changed.
    throwIfAborted(signal);
    onProgress({ phase: "finalize", message: "Grouping assets by meaning." });
    await storeLayout(db);
    const tEmbedEnd = Date.now();

    // ── Finalize ──────────────────────────────────────────────────────────
    const tFinalizeStart = Date.now();
    const { tFtsEnd } = finalizeIndex({
      db,
      sources,
      scanComplete: complete,
      incompleteSources,
      signal,
      onProgress,
    });
    vacuumIndexDb(db, onProgress);
    const totalEntries = getEntryCount(db);
    const tFinalizeEnd = Date.now();

    const timing = {
      totalMs: Date.now() - t0,
      walkMs: tWalkEnd - tWalkStart,
      llmMs: tLlmEnd - tWalkEnd,
      embedMs: tEmbedEnd - tLlmEnd,
      ftsMs: tFtsEnd - tEmbedEnd,
      finalizeMs: tFinalizeEnd - tFinalizeStart,
      cleanMs: clean ? cleanEnd - cleanStart : 0,
      preflightMs: t0 - requestedAt,
      sourceCacheMs: sourceCacheEnd - sourceCacheStart,
      endToEndMs: Date.now() - requestedAt,
    };
    // Persist the phase timings so `akm metrics` can report index latency
    // after the command output is gone. Best-effort, like every appendEvent.
    appendEvent({
      eventType: "index_completed",
      metadata: {
        mode,
        totalMs: timing.totalMs,
        walkMs: timing.walkMs,
        llmMs: timing.llmMs,
        embedMs: timing.embedMs,
        ftsMs: timing.ftsMs,
        finalizeMs: timing.finalizeMs,
        totalEntries,
      },
    });

    return {
      stashDir,
      totalEntries,
      generatedMetadata: generatedCount,
      indexPath: dbPath,
      mode,
      directoriesScanned: scannedDirs,
      directoriesSkipped: skippedDirs,
      scanComplete: complete,
      incompleteSources,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(Object.keys(persistedAdapters).length > 0 ? { configUpdated: { detectedAdapters: persistedAdapters } } : {}),
      verification,
      timing,
      ...(cleanResult !== undefined ? { clean: cleanResult } : {}),
      ...(moves ? { moves } : {}),
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Extracted helpers for indexing ────────────────────────────────────────────

type DirScanReason =
  | DirStaleReason
  | { kind: "duplicate-dir" | "no-indexable-files" | "full-rebuild" | "not-in-source-snapshot"; detail?: string };

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
   * `doc.hash` keyed by recognized-file absolute path, produced by
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
};

type IndexedSourceOwner = Pick<EntryProvenance, "bundleId" | "adapterId">;

function buildIndexedSourceOwners(sources: readonly SearchSource[]): Map<string, IndexedSourceOwner> {
  const bundles = deriveInstallations([...sources]);
  return new Map(
    sources.map((source, index) => [
      path.resolve(source.path),
      { bundleId: (bundles[index] as Bundle).id, adapterId: adapterIdOf(source) },
    ]),
  );
}

type SourceScanPlan = {
  currentStashDir: string;
  bundle: Bundle;
  adapter?: BundleAdapter;
  dirGroups: Map<string, FileContext[]>;
  removals: Array<DirRecord & { reason: DirScanReason }>;
  walkComplete: boolean;
  /** When the scan of this source is incomplete: the error that stopped it. */
  incompleteReason?: string;
  /** For a source that did not resolve: its real directory, or `unknown`. */
  incompletePath?: string;
};

type SourceScanResult = {
  dirRecords: DirRecord[];
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  complete: boolean;
  incompleteSources: IncompleteIndexSource[];
};

function removalsFirst(records: DirRecord[]): DirRecord[] {
  return [...records.filter((record) => record.remove), ...records.filter((record) => !record.remove)];
}

function addDeletedEntries(target: Map<number, DeletedEntry>, entries: DeletedEntry[]): void {
  for (const entry of entries) target.set(entry.id, entry);
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

/** The bundle's listing; a store that cannot be listed (unreachable or failing) is an incomplete one: one bundle never stops the index, which keeps the rows it had. */
function listOrKeep(adapter: BundleAdapter, bundle: Bundle): BundleListing {
  try {
    return adapter.list(bundle);
  } catch (error) {
    if (adapter.addressedBy !== "location") throw error;
    // Any failure, not only BUNDLE_UNREACHABLE: a store that errors (a bad `az` reply) must not stop the whole index,
    // and a failed listing is the same "keep last-known-good rows" case as an unreachable one.
    return { assets: [], complete: false, incompleteReason: toErrorMessage(error) };
  }
}

/** A bundle's listing as the walk's result: every entry a `FileContext` keyed under the bundle's root. */
function walkResultOf(listing: BundleListing, root: string): WalkStashFlatResult {
  return {
    files: listing.assets.map(({ entry }) => fileContextOfEntry(root, entry)),
    complete: listing.complete,
    ...(listing.incompleteReason !== undefined ? { incompleteReason: listing.incompleteReason } : {}),
  };
}

function buildSourceScanPlans(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  reconcileMissingDirs: boolean,
): { plans: SourceScanPlan[]; handoffDirs: Set<string> } {
  // Each source root → its durable `Bundle`; the per-dir document drain dispatches
  // its adapter's `recognize` for it.
  const bundles = deriveInstallations(allSourceEntries);
  const bundleBySource = new Map(allSourceEntries.map((source, index) => [source.path, bundles[index] as Bundle]));
  const handoffDirs = new Set<string>();
  const plans = allSourceEntries.map((sourceAdded): SourceScanPlan => {
    const currentStashDir = sourceAdded.path;
    const bundle = bundleBySource.get(currentStashDir) as Bundle;
    if (sourceAdded.unresolved) {
      return {
        currentStashDir,
        bundle,
        adapter: undefined,
        dirGroups: new Map(),
        removals: [],
        walkComplete: false,
        incompleteReason: sourceAdded.unresolved.reason,
        incompletePath: sourceAdded.unresolved.path ?? "unknown",
      };
    }
    // A bundle that names an adapter akm does not have stops the index before it changes anything.
    const adapter = requireAdapter(bundle.id, adapterIdOf(sourceAdded), { location: bundle.location !== undefined });
    const walked = walkResultOf(listOrKeep(adapter, bundle), currentStashDir);
    const dirGroups = groupFileContextsByDir(walked.files);
    return {
      currentStashDir,
      bundle,
      adapter,
      dirGroups,
      removals: [],
      walkComplete: walked.complete,
      ...(walked.incompleteReason ? { incompleteReason: walked.incompleteReason } : {}),
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

  // Reconcile departed directories for every source that produced a
  // trustworthy snapshot; a source that was not walked completely keeps its
  // last-known-good rows.
  if (reconcileMissingDirs) {
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
        plan.bundle.id,
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
  const sourcePathByBundle = new Map(plans.map((plan) => [plan.bundle.id, plan.currentStashDir] as const));
  for (const plan of plans) {
    for (const dirPath of plan.dirGroups.keys()) {
      const resolvedDir = path.resolve(dirPath);
      if (claimedDirs.has(resolvedDir)) continue;
      claimedDirs.add(resolvedDir);
      for (const priorOwnerBundle of getIndexedBundleIdsByDir(db, dirPath)) {
        if (priorOwnerBundle !== plan.bundle.id) {
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
 * The per-dir document drain (`drainDirDocuments` × the bundle's dispatched
 * `adapter.recognize`) is synchronous, but the walk still runs
 * outside `db.transaction()` so the persist pass can be a single synchronous
 * transaction.
 */
async function scanSourceDirs(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  config: AkmConfig,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
): Promise<SourceScanResult> {
  let scannedDirs = 0;
  let skippedDirs = 0;
  let generatedCount = 0;
  const warnings: string[] = [];
  const incompleteSources: IncompleteIndexSource[] = [];
  const seenPaths = new Set<string>();
  const { plans, handoffDirs } = buildSourceScanPlans(db, allSourceEntries, isIncremental, reconcileMissingDirs);

  const dirRecords: DirRecord[] = [];
  let processedDirs = 0;

  const reportScanProgress = (message: string) =>
    onProgress?.({ phase: "scan", message, processed: processedDirs, total: allSourceEntries.length });

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

  for (const plan of plans) {
    const { currentStashDir, bundle, adapter, dirGroups, removals, walkComplete } = plan;
    processedDirs++;
    reportScanProgress(
      `Processed ${processedDirs}/${allSourceEntries.length} source${allSourceEntries.length === 1 ? "" : "s"}.`,
    );

    if (!walkComplete || adapter === undefined) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      const reason = plan.incompleteReason ?? "the scan did not complete";
      incompleteSources.push({
        bundle: bundle.id,
        path: plan.incompletePath ?? currentStashDir,
        reason,
      });
      warn(`[index] source "${bundle.id}" was not scanned completely; preserving its last-known-good rows. ${reason}`);
      continue;
    }

    // Dispatch each bundle's DETECTED adapter.
    // The content projection's version is part of the variant: a change to what Markdown bodies index re-projects
    // every directory once instead of keeping the old text for unchanged files.
    const indexVariant = `${adapter.id}@${adapter.version}+content${CONTENT_PROJECTION_VERSION}`;

    for (const removal of removals) {
      dirRecords.push(removal);
      scannedDirs++;
      reportDirDecision("scan", removal.dirPath, currentStashDir, removal.reason);
    }

    for (const [dirPath, ctxs] of dirGroups) {
      // Adapter-owned filtering: the drain does not pre-filter with AKM-stash policy — each adapter's `recognize` claims or
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
        getCachedDirState(db, dirPath, indexableFiles, builtAtMs, indexVariant, fingerprint);
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

      // Drain the dir's `IndexDocument` stream via the
      // bundle's dispatched `adapter.recognize` (broken workflows dropped-with-
      // warning at the drain layer) and reconstruct the durable `IndexDocument`s.
      drainObserverForTests?.(dirPath, ctxs.length);
      const drained = drainDirDocuments(adapter, bundle, ctxs);
      if (drained.warnings.length) warnings.push(...drained.warnings);
      generatedCount += drained.entries.length;
      const stash = drained.entries.length > 0 ? { entries: drained.entries } : null;
      // Freshness is judged over the files the entries came from (every walked
      // file when none was recognized).
      const entryFiles = new Set(
        drained.entries.flatMap((entry) => (entry.filename ? [path.join(dirPath, entry.filename)] : [])),
      );
      const staleFiles = entryFiles.size > 0 ? [...entryFiles] : indexableFiles;

      // Incremental freshness gate: consult the persisted dir state and record
      // either a skip (unchanged + eligible) or a scan carrying the drained stash.
      const previousState = getDirIndexState(db, dirPath, staleFiles, builtAtMs, indexVariant, fingerprint);
      const { persistedRowCount } = previousState;
      if (isIncremental && !forceScan && !previousState.stale) {
        skippedDirs++;
        const reason = previousState.reason;
        dirRecords.push({
          dirPath,
          currentStashDir,
          files: staleFiles,
          fingerprint,
          stash: null,
          skip: true,
          reason,
          persistedRowCount,
          indexVariant,
        });
        reportDirDecision("skip", dirPath, currentStashDir, reason, persistedRowCount);
        continue;
      }
      scannedDirs++;
      const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
      dirRecords.push({
        dirPath,
        currentStashDir,
        files: staleFiles,
        fingerprint,
        stash,
        skip: false,
        reason,
        persistedRowCount,
        hashByFile: drained.hashByFile,
        conceptIdByFile: drained.conceptIdByFile,
        indexVariant,
      });
      reportDirDecision("scan", dirPath, currentStashDir, reason, persistedRowCount);
    }
  }

  return {
    dirRecords: removalsFirst(dirRecords),
    scannedDirs,
    skippedDirs,
    generatedCount,
    warnings,
    complete: plans.every((plan) => plan.walkComplete && plan.adapter !== undefined),
    incompleteSources,
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

/** The stored row a drained entry is compared against before it is re-persisted. */
interface PersistedEntryRow {
  id: number;
  content_hash: string | null;
  file_path: string;
  adapter_id: string;
}

/**
 * An index built before sources were keyed by real path stores the library under another spelling of
 * its directories. Rewriting those paths in place keeps its rows, and with them their embeddings,
 * which a delete and re-insert under the real spelling would drop.
 */
function canonicalizeStoredPaths(db: Database): void {
  const stored = [getMeta(db, "stashDir"), ...(JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[])];
  const moves = [...new Set(stored.filter((dir): dir is string => dir !== undefined))]
    .map((dir) => ({ from: dir, to: safeRealpath(dir) }))
    .filter(({ from, to }) => from !== to);
  if (moves.length === 0) return;
  const rewrite = (table: string, column: string, exact: boolean) =>
    db.prepare(
      `UPDATE OR IGNORE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?${
        exact ? ` OR ${column} = ?` : ""
      }`,
    );
  db.transaction(() => {
    for (const { from, to } of moves) {
      const prefix = `${from}${path.sep}`;
      rewrite("entries", "file_path", false).run(to, from.length + 1, prefix.length, prefix);
      rewrite("index_dir_state", "dir_path", true).run(to, from.length + 1, prefix.length, prefix, from);
    }
    setMeta(db, "stashDirs", JSON.stringify(JSON.parse(getMeta(db, "stashDirs") ?? "[]").map(safeRealpath)));
    const stashDir = getMeta(db, "stashDir");
    if (stashDir !== undefined) setMeta(db, "stashDir", safeRealpath(stashDir));
  })();
}

/** Whether the stored library marker names `stashDir`: the same directory, however either is spelled. */
function servesLibrary(stored: string | undefined, stashDir: string): boolean {
  return stored !== undefined && safeRealpath(stored) === safeRealpath(stashDir);
}

/**
 * Phase 2 (sync): write all pre-generated scan records inside a single transaction.
 *
 * The same transaction records which library the persisted keyword data is for
 * (`stashDir` / `stashDirs`). That is the "usable index" marker readers test
 * (`index-readiness.ts`), so it commits atomically with the entries and FTS rows
 * it describes, however the rest of the build goes.
 *
 * It takes the write lock up front (`BEGIN IMMEDIATE`): a writer that overlaps
 * it waits out the busy timeout instead of failing at once on a stale snapshot.
 */
function persistDirRecords(
  db: Database,
  dirRecords: DirRecord[],
  warnings: string[],
  bundleByRoot: ReadonlyMap<string, { bundleId: string; adapterId: string }>,
  maxInputTokens: number,
  library: { stashDir: string; sourceDirs: string[]; unresolvedBundleIds: ReadonlySet<string | undefined> },
): IndexMoves | undefined {
  const deletedEntries = new Map<number, DeletedEntry>();
  const legacyMoves: RefMove[] = [];
  const findPersisted = db.prepare("SELECT id, content_hash, file_path, adapter_id FROM entries WHERE item_ref = ?");
  // Files renamed or moved on disk since the last run: each vanished entry whose content is now at another path.
  let pairing: MovePairing = { pairs: [], unpaired: [] };
  const movedRefs = new Set<string>();

  const pairMoves = (): MovePairing => {
    const stored: StoredEntry[] = [];
    const fresh: NewEntry[] = [];
    for (const record of dirRecords) {
      const bundle = bundleByRoot.get(path.resolve(record.currentStashDir));
      if (record.skip || !bundle) continue;
      const kept = new Set<string>();
      for (const entry of record.remove ? [] : (record.stash?.entries ?? [])) {
        const found = identifyEntry(record.dirPath, bundle, entry, record.conceptIdByFile);
        if ("problem" in found) continue;
        kept.add(found.provenance.itemRef);
        const contentHash = record.hashByFile?.get(found.entryPath);
        if (contentHash !== undefined && !findPersisted.get(found.provenance.itemRef))
          fresh.push({ filePath: found.entryPath, provenance: found.provenance, contentHash });
      }
      stored.push(
        ...getStoredEntriesInDirectory(db, record.dirPath, bundle.bundleId).filter((row) => !kept.has(row.itemRef)),
      );
    }
    return pairMovedFiles(stored, fresh);
  };

  const persist = (): void => {
    // Entries are about to describe another library: the old watermark is not theirs, and neither are rows outside
    // its directories. They go in this transaction, so the marker never names a library whose index serves another's.
    if (!servesLibrary(getMeta(db, "stashDir"), library.stashDir)) {
      deleteMeta(db, "builtAt");
      addDeletedEntries(
        deletedEntries,
        deleteEntriesOutsideLibrary(db, library.sourceDirs, library.unresolvedBundleIds),
      );
    }
    setMeta(db, "stashDir", safeRealpath(library.stashDir));
    setMeta(db, "stashDirs", JSON.stringify(library.sourceDirs));
    pairing = pairMoves();
    for (const pair of pairing.pairs) {
      repointEntry(db, pair.id, pair.entry);
      rekeyLlmCache(db, pair.oldFilePath, pair.entry.filePath);
      movedRefs.add(pair.entry.provenance.itemRef);
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
    } of dirRecords) {
      const bundle = bundleByRoot.get(path.resolve(currentStashDir));
      if (!bundle) throw new Error(`Missing bundle provenance for indexed source ${currentStashDir}`);
      if (remove) {
        const removed = deleteEntriesByDirAndBundle(db, dirPath, bundle.bundleId, {
          cleanupUsageEvents: false,
        });
        addDeletedEntries(deletedEntries, removed);
        deleteIndexDirState(db, dirPath);
        continue;
      }
      if (skip) {
        // "unchanged" is the post-drain verdict: re-persist so the row carries
        // row_count and the gate skips this directory before draining next
        // time. "unchanged-precheck" already matched the stored row.
        if (reason?.kind === "unchanged" && fingerprint) {
          upsertIndexDirState(db, {
            dirPath,
            ...fingerprint,
            reason: reason.kind,
            rowCount: persistedRowCount,
            indexVariant,
          });
        }
        continue;
      }

      // Diff-persist: upsert the current file set
      // FIRST (ON CONFLICT preserving `entries.id` so embeddings / utility /
      // usage stay attached to unchanged rows), tracking every upserted
      // durable `item_ref`, then prune only the departed rows below. Replaces the old
      // `deleteEntriesByDir` truncate-and-reinsert (which discarded ids).
      const keptItemRefs = new Set<string>();

      // Per-file cursor: a directory is drained whole (one changed file
      // re-reads its siblings), but on an incremental run a sibling whose
      // content hash, path and adapter are unchanged since the last drain
      // under the same adapter variant is already persisted exactly as this
      // drain would persist it — including any metadata layered onto its row
      // — so it is neither rewritten nor re-persisted. `--full` re-persists
      // every entry.
      const sameVariant =
        reason?.kind !== "full-rebuild" &&
        indexVariant !== undefined &&
        getIndexDirState(db, dirPath)?.indexVariant === indexVariant;

      let persistedRows = 0;

      if (stash) {
        for (const entry of stash.entries) {
          const found = identifyEntry(dirPath, bundle, entry, conceptIdByFile);
          if ("problem" in found) {
            warn(found.problem);
            continue;
          }
          const { entryPath, provenance } = found;
          // content_hash = doc.hash from the drain, keyed by the recognized
          // file's path. A missing hash preserves the existing value on upsert.
          const contentHash = hashByFile?.get(entryPath);

          // The adapter lists one entry per ref (the spelling it reads wins), so the ref has one holder.
          const holder = (findPersisted.get(provenance.itemRef) as PersistedEntryRow | null) ?? undefined;
          keptItemRefs.add(provenance.itemRef);
          persistedRows++;

          const previous = sameVariant ? holder : undefined;
          const moved = movedRefs.has(provenance.itemRef);
          const unchanged =
            !moved &&
            previous !== undefined &&
            contentHash !== undefined &&
            previous.content_hash === contentHash &&
            previous.file_path === entryPath &&
            previous.adapter_id === bundle.adapterId;
          if (unchanged) {
            continue;
          }

          const legacy = legacyRefMove(bundle.bundleId, entry.type, provenance.conceptId);
          if (legacy) {
            rekeyLegacyEntry(db, legacy, provenance.conceptId, entryPath);
            legacyMoves.push(legacy);
          }
          upsertEntry(db, entryPath, withFileSize(entry, entryPath), provenance, contentHash, maxInputTokens, moved);
        }
      }

      // Prune the departed rows: everything under this dir NOT re-upserted above
      // (files deleted, deduped away, or abstained on by the adapter). With
      // an empty kept-set this deletes every row for the dir — the exact net
      // effect of the old unconditional `deleteEntriesByDir`, minus the id churn.
      // (A source whose walk was incomplete never reaches this point.)
      addDeletedEntries(
        deletedEntries,
        deleteEntriesByDirExceptRefs(db, dirPath, bundle.bundleId, keptItemRefs, { cleanupUsageEvents: false }),
      );

      const persistedFingerprint = fingerprint ?? computeDirFingerprint(dirPath, files, indexVariant);
      const persistedReason =
        persistedRows === 0
          ? inferZeroRowReason(stash, reason, warnings, dirPath)
          : reason?.kind === "full-rebuild"
            ? "full-rebuild"
            : (reason?.kind ?? "updated");
      upsertIndexDirState(db, {
        dirPath,
        ...persistedFingerprint,
        reason: persistedReason,
        rowCount: persistedRows,
        indexVariant,
      });
      if (persistedRows === 0) warnVerbose(`[index] zero-row ${dirPath}: ${persistedReason}`);
    }
    // Atomicity observation point: the new generation is fully written but
    // uncommitted, so it must still be invisible to other connections.
    indexTransactionHookForTests?.("records-persisted");
  };

  withImmediateTransaction(db, persist, reclassifyIndexDbContention);
  // A ref deleted from one directory may have been re-inserted by another in
  // this same run: only refs that no longer exist lose their events.
  const refStillIndexed = db.prepare("SELECT 1 FROM entries WHERE item_ref = ?");
  deleteUsageEventsForEntries(
    [...deletedEntries.values()].filter((entry) => refStillIndexed.get(entry.itemRef) == null),
  );
  const movedAssets = pairing.pairs.map((pair) => ({ from: pair.oldItemRef, to: pair.entry.provenance.itemRef }));
  try {
    rekeyStateRefs([...legacyMoves, ...movedAssets.map(({ from, to }) => ({ oldItemRef: from, newItemRef: to }))]);
  } catch (error) {
    warnings.push(
      `[index] could not carry over the history of ${legacyMoves.length + movedAssets.length} re-keyed asset(s): ${String(error)}`,
    );
  }
  // Each move is recorded on the asset's new ref, which later moves re-key with the rest of its history.
  for (const { from, to } of movedAssets) appendEvent({ eventType: "moved", ref: to, metadata: { from } });
  if (pairing.unpaired.length > 0) {
    warnings.push(
      `[index] ${pairing.unpaired.length} moved file(s) not paired: other files with identical content appeared, so ` +
        `each is indexed as a new asset and its history stays with the old ref (${pairing.unpaired.map((entry) => entry.itemRef).join(", ")}).`,
    );
  }
  return movedAssets.length > 0 || pairing.unpaired.length > 0
    ? { moved: movedAssets, unpaired: pairing.unpaired.length }
    : undefined;
}

/** The path and durable identity of a drained entry, or why it has none. */
function identifyEntry(
  dirPath: string,
  bundle: { bundleId: string; adapterId: string },
  entry: IndexDocument,
  conceptIdByFile: Map<string, string> | undefined,
): { entryPath: string; provenance: EntryProvenance } | { problem: string } {
  const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
  if (!entryPath) return { problem: `Skipping entry with no resolvable path in ${dirPath}` };
  const adapterConceptId = conceptIdByFile?.get(entryPath);
  if (!adapterConceptId) return { problem: `Skipping entry without adapter-owned concept identity: ${entryPath}` };
  // Adapter-owned concept identity is path-based and cannot be replaced by presentation fields such as type/title.
  return { entryPath, provenance: deriveEntryProvenance(bundle, entry.type, entry.name, adapterConceptId) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildIndexSummaryMessage(options: {
  mode: "full" | "incremental";
  sourcesCount: number;
  semanticSearchMode: AkmConfig["semanticSearchMode"];
  embeddingProvider: "local" | "remote";
}): string {
  const stashSourceLabel = options.sourcesCount === 1 ? "stash source" : "stash sources";
  const semanticDetail = options.semanticSearchMode === "off" ? "disabled" : `${options.embeddingProvider} embeddings`;
  return `Starting ${options.mode} index (${options.sourcesCount} ${stashSourceLabel}, semantic search: ${semanticDetail}).`;
}

function getEmbeddingProvider(
  embedding?: import("../core/config/config").EmbeddingConnectionConfig,
): "local" | "remote" {
  return isHttpUrl(embedding?.endpoint) ? "remote" : "local";
}

function verifyIndexState(
  db: Database,
  config: AkmConfig,
  embeddableEntries: number,
  embeddingResult: EmbeddingGenerationResult,
): IndexVerification {
  const embeddingCount = getEmbeddingCount(db);
  const embeddingProvider = getEmbeddingProvider(effectiveEmbedding(config));
  const embeddingRuntime = embeddingProvider === "local" ? localEmbeddingRuntime() : undefined;
  const verification = (
    ok: boolean,
    message: string,
    semanticSearchEnabled: boolean,
    semanticStatus: IndexVerification["semanticStatus"],
    guidance?: string,
  ): IndexVerification => ({
    ok,
    message,
    ...(guidance !== undefined ? { guidance } : {}),
    semanticSearchEnabled,
    semanticSearchMode: config.semanticSearchMode,
    semanticStatus,
    embeddingProvider,
    ...(embeddingRuntime !== undefined ? { embeddingRuntime } : {}),
    entryCount: embeddableEntries,
    embeddingCount,
  });
  const pendingStatus = config.semanticSearchMode === "off" ? "disabled" : "pending";

  if (embeddableEntries === 0) {
    return verification(
      true,
      "Index ready. No assets were found yet.",
      config.semanticSearchMode === "auto",
      pendingStatus,
    );
  }
  if (config.semanticSearchMode === "off") {
    return verification(true, "Keyword index ready. Semantic search is disabled.", false, "disabled");
  }
  if (embeddingCount >= embeddableEntries) {
    return verification(
      true,
      `Semantic search ready (${embeddingCount}/${embeddableEntries} embeddings).`,
      true,
      "ready-js",
    );
  }
  return verification(
    false,
    embeddingResult.message ??
      `Semantic search verification failed (${embeddingCount}/${embeddableEntries} embeddings available).`,
    true,
    "blocked",
    embeddingProvider === "remote"
      ? "Check your embedding endpoint and credentials, then retry `akm index --full --verbose`."
      : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/reference/configuration.md for local embedding dependency setup.",
  );
}

// ── lookup ─────────────────────────────────────────────────────────────────

import { type BundleRef, makeBundleRef } from "../core/asset/asset-ref";

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
  /** The indexed row, when the index has one for the physical owner. */
  entry: IndexEntry | null;
  /** The first asset the ref names, retained even when its index row is absent/stale. */
  asset?: Asset;
  /**
   * What the owning file and its adapter give without the index, set when `entry` is null and
   * a file owns the ref. `show` serves it, so no read depends on a build; it has no links,
   * usage or indexed fragments.
   */
  fileEntry?: IndexEntry;
  /** Deferred index failure for callers (such as show) that can use the asset. */
  indexError?: unknown;
}

async function resolveLookupSources(): Promise<SearchSource[]> {
  const { loadConfig } = await import("../core/config/config.js");
  const { resolveSourceEntries } = await import("./search/search-source.js");
  return resolveSourceEntries(undefined, loadConfig());
}

/**
 * Resolve index and physical ownership together. Ownership preserves
 * installation-priority arbitration even when a row is missing or stale.
 */
type LookupDatabaseOpener = (dbPath: string) => Database | undefined;

async function lookupBundleRefWithResolutionUsing(
  ref: BundleRef,
  openLookupDatabase: LookupDatabaseOpener,
  /** The opener hands out a handle the caller owns and closes. */
  borrowed = false,
  /** Record the row an asset the index lacks (a file added outside akm); otherwise the index is left as it is. */
  persist = false,
): Promise<BundleRefLookupResolution> {
  const sources = await resolveLookupSources();
  if (sources.length === 0) return { entry: null };
  const qualified = Boolean(ref.bundle);
  if ((ref.bundle ? resolveSourcesForOrigin(ref.bundle, sources) : sources).length === 0) return { entry: null };

  let db: Database | undefined;
  let indexError: unknown;
  try {
    db = openLookupDatabase(getDbPath());
  } catch (error) {
    indexError = error;
  }
  /** `absent`: the index holds no row for the asset at all, so a read-write lookup records one; a stale row is `akm index`'s. */
  const resolved = (entry: IndexEntry | null, asset?: Asset, absent = false): BundleRefLookupResolution => {
    const fileEntry =
      !entry && asset ? entryOnMiss(asset, sourceOfBundle(sources, asset.bundle), persist && absent) : undefined;
    return {
      entry,
      ...(asset ? { asset } : {}),
      ...(fileEntry ? { fileEntry } : {}),
      ...(indexError === undefined ? {} : { indexError }),
    };
  };
  try {
    // An asset the walk does not reach is not in the bundle: `findAsset` does not find it.
    const asset = findAsset(ref, { sources });
    if (!asset) return resolved(null);
    const bundleId = asset.bundle;
    const source = sourceOfBundle(sources, bundleId);
    const adapterId = adapterIdOf(source);
    const ownerPath = indexedPathOf(asset, source);
    // A workflow source that is a symlink to a file of another extension is warned about once, as before.
    if (workflowNameForSourcePath(source.path, adapterId, ownerPath) !== undefined) {
      isUsableWorkflowSource(source.path, ownerPath);
    }
    const inputRef = makeBundleRef(qualified ? ref.bundle : undefined, asset.conceptId);
    let entry: IndexEntry | null | undefined;
    try {
      const id = db ? findEntryIdByRef(db, inputRef, bundleId) : undefined;
      entry = id !== undefined && db ? readLookupEntry(db, id, ref.conceptId, source.path) : undefined;
    } catch (error) {
      // An index a build is still creating or rewriting cannot answer; the owner's file can.
      indexError = error;
      return resolved(null, asset);
    }
    if (entry) {
      if (entry.type === "workflow") {
        try {
          assertIndexedWorkflowSourceIdentity(inputRef, entry.filePath, {
            path: ownerPath,
            realPath: safeRealpath(ownerPath),
            relativePath: asset.entry.relPath,
            canonicalName: asset.conceptId,
          });
          if (entry.adapterId !== adapterId) {
            throw new WorkflowSourceIdentityError(inputRef, entry.filePath, ownerPath);
          }
        } catch (error) {
          if (!(error instanceof WorkflowSourceIdentityError)) throw error;
          warn(`${error.message} Falling back to the physical owner.`);
          return resolved(null, asset);
        }
      } else if (entry.adapterId !== adapterId || !indexedPathMatchesOwner(entry.filePath, asset, source)) {
        return resolved(null, asset);
      }
      return resolved(entry, asset);
    }
    // A physical owner with a missing/incomplete index row still owns this
    // concept: no later source can retarget it.
    return resolved(null, asset, true);
  } finally {
    if (db && !borrowed) closeDatabase(db);
  }
}

/**
 * Resolve index and physical ownership together. With `persist` (`akm show`), an asset the index has no row for is
 * indexed as it is found: one `recognize`, one upsert.
 */
export async function lookupBundleRefWithResolution(
  ref: BundleRef,
  persist = false,
): Promise<BundleRefLookupResolution> {
  return lookupBundleRefWithResolutionUsing(ref, openExistingDatabase, false, persist);
}

/**
 * {@link lookupBundleRefWithResolution} on a plain read-only connection (the workspace): a read-write one can checkpoint
 * the WAL into the main file when it closes, changing the file although nothing was written.
 */
export async function lookupBundleRefWithResolutionReadonly(ref: BundleRef): Promise<BundleRefLookupResolution> {
  return lookupBundleRefWithResolutionUsing(ref, (dbPath) => {
    const db = openReadonlyExistingDatabase(dbPath);
    if (!db) throw new Error(`Index database not found at ${dbPath}. Run 'akm index' to build it.`);
    return db;
  });
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

/**
 * {@link lookupBundleRefReadonly} for many refs through one snapshot of the
 * index, which is copied once rather than once per ref. A ref that does not
 * resolve, or an index that cannot be read, gives `null` for that ref.
 */
export async function lookupBundleRefsReadonly(
  refs: readonly BundleRef[],
  options: { isolatedSnapshot?: boolean } = {},
): Promise<Array<IndexEntry | null>> {
  if (refs.length === 0) return [];
  let db: Database | undefined;
  try {
    db = openReadonlyExistingDatabase(getDbPath(), { isolatedSnapshot: options.isolatedSnapshot ?? true });
  } catch {
    // Unreadable index: every ref stays unresolved.
  }
  try {
    const entries: Array<IndexEntry | null> = [];
    for (const ref of refs) {
      try {
        entries.push((await lookupBundleRefWithResolutionUsing(ref, () => db, true)).entry);
      } catch {
        entries.push(null);
      }
    }
    return entries;
  } finally {
    if (db) closeDatabase(db);
  }
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

// ── Utility score recomputation ──────────────────────────────────────────────

/**
 * Recompute utility scores based on usage_events data: every entry by default,
 * or just `onlyEntryId` (what `akm feedback` passes so the value it stores is
 * the one `akm index` would compute, not a second formula). A one-entry call
 * leaves the retention purge alone.
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
export function recomputeUtilityScores(db: Database, stateDb: Database, onlyEntryId?: number): void {
  const EMA_DECAY = 0.7;
  const scoped = onlyEntryId !== undefined;

  // Purge stale usage events (90-day retention). usage_events lives in state.db;
  // its table is created by state migration 020.
  if (!scoped) purgeOldUsageEvents(stateDb, USAGE_EVENT_RETENTION_DAYS);

  // Aggregate explicit user demand per `entry_ref` from state.db's usage_events
  // (the stable identity every event carries; search and curate telemetry hold
  // only the ref, not the index row id), then map each ref to its CURRENT entry
  // id in index.db's `entries` (the former in-SQL JOIN is now a cross-DB
  // lookup). Refs naming no current entry are dropped: usage_events has no FK
  // to entries, so a ref can go stale (entry deleted, re-keyed, moved between
  // sources), and writing the derived row to utility_scores (which DOES have an
  // FK) would raise "FOREIGN KEY constraint failed" and roll back the whole
  // finalize transaction — failing every index run.
  const scopedRef = scoped
    ? (
        db.prepare("SELECT item_ref FROM entries WHERE id = ?").get(onlyEntryId) as
          | { item_ref: string | null }
          | undefined
      )?.item_ref
    : undefined;
  const aggregatedRows =
    scoped && !scopedRef
      ? []
      : (stateDb
          .prepare(`
      SELECT u.entry_ref,
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
      FROM usage_events u
      WHERE u.entry_ref IS NOT NULL
        AND u.source = 'user'
        ${scoped ? "AND u.entry_ref = ?" : ""}
      GROUP BY u.entry_ref
    `)
          .all(...(scoped ? [scopedRef ?? null] : [])) as Array<{
          entry_ref: string;
          search_count: number;
          show_count: number;
          positive_feedback_count: number;
          negative_feedback_count: number;
          last_used_at: string | null;
        }>);
  const entryIdByRef = db.prepare("SELECT id FROM entries WHERE item_ref = ?");
  const usageByEntry = new Map<number, (typeof aggregatedRows)[number] & { entry_id: number }>();
  for (const row of aggregatedRows) {
    const entry = entryIdByRef.get(row.entry_ref) as { id: number } | undefined;
    if (entry) usageByEntry.set(entry.id, { ...row, entry_id: entry.id });
  }

  // Batch-load existing utility scores
  const existingScores = new Map<number, { utility: number; updatedAt: string | null }>();
  const scoreRows = db
    .prepare(`SELECT entry_id, utility, updated_at FROM utility_scores${scoped ? " WHERE entry_id = ?" : ""}`)
    .all(...(scoped ? [onlyEntryId] : [])) as Array<{
    entry_id: number;
    utility: number;
    updated_at: string | null;
  }>;
  for (const row of scoreRows) {
    existingScores.set(row.entry_id, { utility: row.utility, updatedAt: row.updated_at });
  }

  const now = Date.now();
  const entryIds = new Set([...existingScores.keys(), ...usageByEntry.keys()]);
  // One transaction for every row: per-row autocommits cost one WAL sync each (~43 s of a 45 s finalize on a
  // 20,900-entry library). The reads above stay outside, so state.db is held no longer than before.
  db.transaction(() => {
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
      // Decay by the time since this row was last written, so any number of builds
      // in a day apply about one day of decay in total. A new row starts at its rate.
      let utility = effectiveRate;
      if (existing) {
        const updatedMs = existing.updatedAt ? Date.parse(`${existing.updatedAt.replace(" ", "T")}Z`) : Number.NaN;
        const elapsedDays = Number.isFinite(updatedMs) ? Math.max(0, (now - updatedMs) / 86_400_000) : 1;
        const decay = EMA_DECAY ** elapsedDays;
        utility = existing.utility * decay + effectiveRate * (1 - decay);
      }
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
  })();
}
