// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { type Asset, lookupAsset, scanBundle } from "../core/assets/read";
import { indexedPathOf } from "../core/assets/type";
import { isHttpUrl, safeRealpath } from "../core/common";
import type { AkmConfig } from "../core/config/config";
import { appendEvent } from "../core/events";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { withStateDb } from "../core/state-db";
import { isVerbose, warn } from "../core/warn";
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
  deleteEntriesByIds,
  findEntryIdByRef,
  getEmbeddableEntryCount,
  getEntryCount,
  relinkUsageEvents,
} from "../storage/repositories/index-entries-repository";
import { rebuildFtsIfTotalsStale } from "../storage/repositories/index-fts-repository";
import { storeLayout } from "../storage/repositories/index-layout-repository";
import { clearStaleCacheEntries } from "../storage/repositories/index-llm-cache-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import { VACUUM_PENDING_META } from "../storage/repositories/index-schema";
import { upsertUtilityScore } from "../storage/repositories/index-utility-repository";
import { getEmbeddingCount } from "../storage/repositories/index-vec-repository";
import { INDEX_DB_VACUUMED_EVENT, readFreelistInfo, vacuumIfReclaimable } from "../storage/state-db-integrity";
import {
  assertIndexedWorkflowSourceIdentity,
  isUsableWorkflowSource,
  WorkflowSourceIdentityError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import {
  applyRemovedSources,
  INCOMPLETE_SOURCES_META_KEY,
  type IncompleteIndexSource,
  type IndexVerification,
  readSourceOwners,
  recordSourceOwners,
  SEMANTIC_SEARCH_META_KEY,
  type SemanticSearchRecord,
} from "./index-context";
import { reclassifyIndexDbContention } from "./index-db-contention";
import { canonicalizeStoredPaths, type IndexLibrary, persistDirRecords, servesLibrary } from "./index-persist";
import { sourceOfBundle } from "./installations";
import { entryOnMiss, indexedPathMatchesOwner } from "./lookup/indexed-owner";
import { type EmbeddingGenerationResult, embeddingInputCap, generateEmbeddingsForDb } from "./materialize-embeddings";
import { type IndexDocument, isWorkflowSkipWarning } from "./passes/metadata";
import type { SearchSource } from "./search/search-source";
import { scanSourceDirs } from "./source-scan";
import { purgeOldUsageEvents, USAGE_EVENT_RETENTION_DAYS } from "./usage/usage-events";

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
  stashDir?: string;
  bundleId?: string;
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
   * The working library (a directory or a store's bundle id). Resolved at the command boundary
   * and threaded in — the indexer does not read the
   * ambient stash-dir resolver. Every caller (source add, wiki, workflow,
   * setup, improve, tests) already passes it.
   */
  stashDir: IndexLibrary;
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
    recordSourceOwners(db, sources);
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

/** Whether `root` is a directory whose listing can be read (adapter detection only probes such roots). */
function isReadableDirectory(root: string): boolean {
  try {
    // asset-io: bundle-root root probe
    if (!fs.statSync(root).isDirectory()) return false;
    // asset-io: bundle-root root probe
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
    // `resolveSourceEntries` found an adapter for every entry without one; this records it.
    if (source.registryId === undefined || source.unresolved || config.bundles?.[source.registryId]?.adapter) continue;
    if (source.adapterId !== undefined && source.path !== undefined && isReadableDirectory(source.path)) {
      detectedByBundle.set(source.registryId, source.adapterId);
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
  const sources = resolveSourceEntries(typeof stashDir === "string" ? stashDir : null, config);
  const detected = detectAndPersistBundleAdapters(sources, config, mutateConfig, {
    announce: options.implicit !== true,
    persist: options.persistDetectedAdapters !== false,
  });
  config = detected.config;
  const { persistedAdapters } = detected;
  const sourceDirs = sources.flatMap((source) => (source.path === undefined ? [] : [source.path]));
  onProgress({
    phase: "preflight",
    message: `Resolved ${sources.length} stash source${sources.length === 1 ? "" : "s"}.`,
  });

  const t0 = Date.now();

  const dbPath = getDbPath();
  const db = openIndexDatabase(dbPath);

  try {
    // `--full` folds into `isIncremental`: a full run drains every directory
    // through the same diff-persist path as an incremental one.
    canonicalizeStoredPaths(db);
    const prevBuiltAt = getMeta(db, "builtAt");
    const isIncremental =
      !full && servesLibrary(getMeta(db, "stashDir"), stashDir, getMeta(db, "stashBundle")) && !!prevBuiltAt;
    const builtAtMs = isIncremental && prevBuiltAt ? new Date(prevBuiltAt).getTime() : 0;
    const mode = isIncremental ? "incremental" : "full";

    onProgress({
      phase: "summary",
      message: buildIndexSummaryMessage({
        mode,
        sourcesCount: sources.length,
        semanticSearchMode: config.semanticSearchMode,
        embeddingProvider: getEmbeddingProvider(effectiveEmbedding(config)),
      }),
    });

    const previousOwners = readSourceOwners(db);

    // ── Walk: scan the filesystem, generate metadata, persist entries ─────
    throwIfAborted(signal);
    const tWalkStart = Date.now();
    // Walk every source and pre-generate all metadata outside any transaction…
    const {
      dirRecords,
      bundleOwners,
      storeBundleIds,
      variants,
      scannedDirs,
      skippedDirs,
      generatedCount,
      warnings,
      complete,
      incompleteSources,
    } = await scanSourceDirs(db, sources, isIncremental, builtAtMs, onProgress, !clean);
    // …then write it in one transaction: `item_ref = <bundle>//<conceptId>`
    // plus canonical bundle/adapter provenance.
    // A source that did not resolve this run keeps its last-known-good rows through a library switch.
    const unresolvedBundleIds = new Set(sources.filter((source) => source.unresolved).map((source) => source.bundleId));
    const moves = persistDirRecords(db, dirRecords, warnings, bundleOwners, embeddingInputCap(config), {
      stashDir,
      sourceDirs,
      storeBundleIds,
      unresolvedBundleIds,
      variants,
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
        warn(`${skippedWorkflowCount} ${noun} skipped due to validation errors; rerun with --verbose to see details.`);
      }
    }
    const tWalkEnd = Date.now();

    // There is no LLM metadata-enhancement pass. `timing.llmMs` stays (always
    // ~0) so the JSON shape is unchanged.
    const tLlmEnd = Date.now();

    if (complete) applyRemovedSources(db, sources, previousOwners, isIncremental);

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
      ...(typeof stashDir === "string" ? { stashDir } : stashDir),
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
  stashDir?: string;
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
    const asset = lookupAsset(makeBundleRef(ref.bundle, ref.conceptId));
    if (!asset) return resolved(null);
    const bundleId = asset.bundle;
    const source = sourceOfBundle(sources, bundleId);
    const adapterId = scanBundle(source, bundleId).adapterId;
    const ownerPath = indexedPathOf(asset);
    // A workflow source that is a symlink to a file of another extension is warned about once, as before.
    if (
      source.path !== undefined &&
      ownerPath !== "" &&
      workflowNameForSourcePath(source.path, adapterId, ownerPath) !== undefined
    ) {
      isUsableWorkflowSource(source.path, ownerPath);
    }
    const inputRef = makeBundleRef(qualified ? ref.bundle : undefined, asset.conceptId);
    let entry: IndexEntry | null | undefined;
    try {
      const id = db ? findEntryIdByRef(db, asset.ref) : undefined;
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
            relativePath: asset.entry.key,
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
      } else if (entry.adapterId !== adapterId || !indexedPathMatchesOwner(entry.filePath, asset)) {
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
export async function lookupBundleRefWithResolutionReadonly(
  ref: BundleRef,
  options?: { isolatedSnapshot: boolean },
): Promise<BundleRefLookupResolution> {
  return lookupBundleRefWithResolutionUsing(ref, (dbPath) => {
    const db = openReadonlyExistingDatabase(dbPath, options);
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
  const resolution = await lookupBundleRefWithResolutionReadonly(ref, { isolatedSnapshot: true });
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

function readLookupEntry(
  db: Database,
  id: number,
  fallbackConceptId: string,
  sourceRoot: string | undefined,
): IndexEntry | null {
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
  const scoreRows = db
    .prepare(`SELECT entry_id, utility, updated_at FROM utility_scores${scoped ? " WHERE entry_id = ?" : ""}`)
    .all(...(scoped ? [onlyEntryId] : [])) as Array<{
    entry_id: number;
    utility: number;
    updated_at: string | null;
  }>;
  const existingScores = new Map(
    scoreRows.map((row) => [row.entry_id, { utility: row.utility, updatedAt: row.updated_at }] as const),
  );

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
