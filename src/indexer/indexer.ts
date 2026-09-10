// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import type { IndexDocument } from "../core/adapter/types";
import { type BundleRef, makeBundleRef } from "../core/asset/asset-ref";
import type { AssetRef } from "../core/asset/resolve-ref";
import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { isHttpUrl } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { AkmError, TransientError } from "../core/errors";
import { defaultConcurrencyForEndpoint } from "../core/loopback";
import { getDbPath } from "../core/paths";
import { isSqliteContentionError, withStateDb } from "../core/state-db";
import { warn } from "../core/warn";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
/**
 * M-4 / #395 — Index Consistency Architecture Decision Record
 *
 * AKM maintains four indexes per stash:
 *   1. Frontmatter index (SQLite `entries` table) — asset metadata.
 *   2. FTS5 full-text search index (SQLite `units_fts` virtual table).
 *   3. Vector (embedding) index (SQLite `units_vec` table).
 *   4. Graph index (SQLite `graph_nodes`, `graph_edges` tables).
 *
 * Decision (2026-05-16): No transactional boundary spans all four indexes.
 * Each step is individually crash-tolerant; cross-step consistency is
 * **opportunistic recovery** — subsequent index runs detect and heal drift.
 *
 * index-redesign update (docs/plans/index-redesign.md, module B5): `akmIndex`
 * is no longer a phase pipeline (source cache / walk / clean / embed /
 * finalize) over directory-fingerprint change detection. It is now
 * `reconcileRoots` (a flat, content-addressed file diff — `reconcile.ts`)
 * followed by `drainEmbeddingQueue` (a content-addressed embedding queue —
 * `drain.ts`), plus the meta/utility bookkeeping every consumer of the
 * `IndexResponse` envelope and `index_meta` needs. Every write either engine
 * makes is a short, idempotent, content-addressed insert or re-point under
 * SQLite's own busy timeout — no rebuild lock, no writer lock on the index
 * path, no per-command background reindex spawn. See the ADR above for why
 * the four indexes still do not share one transactional boundary; that
 * decision is unaffected by this rewrite.
 */
import type { Database } from "../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import {
  deleteEntriesByBundle,
  findEntryIdByRef,
  getEntryCount,
  relinkUsageEvents,
} from "../storage/repositories/index-entries-repository";
import { getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import { EMBEDDING_DIM } from "../storage/repositories/index-schema";
import { upsertUtilityScore } from "../storage/repositories/index-utility-repository";
import { isVecAvailable, warnIfVecMissing } from "../storage/repositories/index-vec-repository";
import { dropOtherIdentities, unitCoverage } from "../storage/repositories/units-repository";
import { assertIndexedWorkflowSourceIdentity, WorkflowSourceIdentityError } from "../workflows/source-files";
import { deleteStoredGraph } from "./db/graph-db";
import { type DrainCounts, drainEmbeddingQueue } from "./drain";
import { deriveInstallations } from "./installations";
import {
  type AdapterConceptOwner,
  indexedPathMatchesOwner,
  resolveAdapterConceptOwner,
} from "./lookup/adapter-concept-owner";
import { reconcileRoots } from "./reconcile";
import type { SearchSource } from "./search/search-source";
import { purgeOldUsageEvents } from "./usage/usage-events";
import type { IndexVerification } from "./walk/index-context";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexResponse {
  stashDir: string;
  totalEntries: number;
  /** Entries reconcile added or changed this run (`reconcile.added + reconcile.changed`). */
  generatedMetadata: number;
  indexPath: string;
  mode: "full" | "incremental";
  /** Configured roots reconcile.ts attempted this run. */
  directoriesScanned: number;
  /** Configured roots skipped (no adapter resolved for their bundle). */
  directoriesSkipped: number;
  /** False when any root's walk could not be trusted (see `ReconcileCounts.complete`). */
  scanComplete: boolean;
  warnings?: string[];
  verification: IndexVerification;
  /** Timing counters in milliseconds. */
  timing?: {
    totalMs: number;
    preflightMs: number;
    sourceCacheMs: number;
    reconcileMs: number;
    embedMs: number;
    finalizeMs: number;
    endToEndMs: number;
  };
  /**
   * Present when this run auto-detected a bundle's adapter and persisted it
   * to config.json (`bundles.<id>.components.<component>.adapter`) — a
   * maintenance-command config write that would otherwise be invisible
   * (R-056). Keyed by bundle id, valued by the detected adapter id.
   */
  configUpdated?: { detectedAdapters: Record<string, string> };
}

export interface IndexProgressEvent {
  phase: "summary" | "preflight" | "scan" | "embeddings" | "finalize" | "verify";
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
  /**
   * `akm index --full`: force every currently-walkable file through a fresh
   * parse and upsert, ignoring the stat-hint shortcut that ordinarily skips
   * an unchanged file (`reconcileRoots`'s `forceReparse`) — the escape hatch
   * for "re-derive everything even though nothing's stat moved" (a parsing-
   * logic change, an adapter fix). Deliberately NOT a wipe-then-rebuild:
   * `upsertEntry`'s item_ref-keyed upsert updates an existing row in place
   * (same id, so embeddings/utility/usage stay attached), and `units`/
   * `units_vec` are content-addressed and were never at risk from a wipe in
   * the first place (rule 2, docs/plans/index-redesign.md) — an earlier,
   * table-dropping version of `--full` here could destroy a root's rows
   * with no way to restore them when that same root's walk turned out to be
   * incomplete (a mid-walk stat failure on one file), since the drop ran
   * before reconcile could discover the walk could not be trusted. Gone-path
   * detection is unaffected either way (still compares against the real stat
   * cache), so a genuinely deleted file is still removed normally, and an
   * unreadable/incomplete root's existing rows are preserved untouched by
   * `reconcileRoots`'s own whole-root freeze.
   */
  full?: boolean;
  /**
   * `akm index --reembed`: drop the active embedding identity's vectors
   * (`units`/`units_vec` rows for `index_meta.embeddingIdentity`), then drain
   * re-embeds every unit from scratch under that same identity.
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
   * both schemas; reconcile's per-file `withImmediateTransaction` calls join
   * that outer transaction (it is already open) rather than opening their
   * own. The embedding drain is SKIPPED entirely while borrowed — draining
   * commits per provider batch, which must not nest inside the coordinator's
   * long-lived transaction — and is left "pending" for the coordinator's own
   * post-commit `runEmbeddingPass` call on a fresh connection.
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

/**
 * Bounded-pool width for the metadata-enrichment pass (`./enrich.ts`,
 * index-redesign B5e). An explicit `llmConfig.concurrency` wins (schema
 * field, though `resolveLlmEngineUse` never populates it on this path — see
 * AGENTS.md's LLM Defaults section — so this branch is effectively dead in
 * production but kept for direct callers/tests); otherwise it is
 * auto-derived from the endpoint via the ONE shared local-vs-remote
 * classifier (`defaultConcurrencyForEndpoint`, `core/loopback.ts`), also used
 * by the embedding pool (`resolveEmbeddingConcurrency`,
 * `src/llm/embedders/remote.ts`): 1 for a loopback endpoint (a local model
 * server serves one inference at a time; parallel requests cause "Model
 * reloaded" / HTTP 500 errors), 2 for a remote one. `./enrich.ts` calls
 * `defaultConcurrencyForEndpoint` directly rather than this wrapper to avoid
 * an indexer.ts → enrich.ts → indexer.ts import cycle (the same reason
 * `src/llm/embedders/remote.ts` cannot import this wrapper either); the two
 * stay behaviorally identical since the override branch never fires here.
 */
export function getDefaultLlmConcurrency(llmConfig?: LlmConnectionConfig): number {
  if (typeof llmConfig?.concurrency === "number") return llmConfig.concurrency;
  return defaultConcurrencyForEndpoint(llmConfig?.endpoint);
}

// ── Source ownership bookkeeping ────────────────────────────────────────────

interface IndexSourceOwner {
  bundleId: string;
  sourceRoot: string;
  /**
   * True when this source currently resolves to a quarantine directory
   * (`getUnresolvedSourcesDir`, search-source.ts) rather than its configured
   * content root — an escaping/invalid component root, held aside until a
   * human fixes the config. `removeStaleSourceOwners` still needs it in
   * `currentOwners` (still configured, so its rows must NOT be treated as
   * belonging to a removed bundle), but `reconcileRoots` must never walk the
   * quarantine directory AS the bundle's content: it has nothing to do with
   * the bundle's real files, and doing so would read "not present under this
   * unrelated empty directory" as "gone" and delete the prior good snapshot
   * reconcile has no way to know is only quarantined, not superseded.
   */
  unresolved?: boolean;
}

/** Every currently-configured source's bundle id + resolved root, in installation-priority order. */
function sourceOwners(sources: readonly SearchSource[]): IndexSourceOwner[] {
  const installations = deriveInstallations([...sources]);
  return sources.flatMap((source, index) => {
    const installation = installations[index];
    return installation
      ? [
          {
            bundleId: installation.id,
            sourceRoot: path.resolve(source.path),
            ...(source.unresolved ? { unresolved: true } : {}),
          },
        ]
      : [];
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
 * Delete entries (and their derived rows, via cascade) for any bundle that
 * was configured on the previous run and is not any more, or whose root
 * moved — `reconcileRoots` only walks CURRENT roots, so a removed bundle's
 * rows would otherwise never be revisited. Runs before `reconcileRoots` so
 * its own `pruneOrphanUnitTexts` sweep also collects any unit_texts this
 * orphans. A root no longer claimed by ANY current bundle also drops its
 * stored graph extraction (graph rows are keyed by root, not by entry, so
 * entry deletion above does not reach them).
 */
function removeStaleSourceOwners(db: Database, currentOwners: readonly IndexSourceOwner[]): void {
  const currentByBundle = new Map(currentOwners.map((owner) => [owner.bundleId, owner]));
  const currentRoots = new Set(currentOwners.map((owner) => owner.sourceRoot));
  for (const previous of parseStoredSourceOwners(getMeta(db, "sourceOwners"))) {
    const current = currentByBundle.get(previous.bundleId);
    if (current && current.sourceRoot === previous.sourceRoot) continue;
    if (!current) deleteEntriesByBundle(db, previous.bundleId);
    if (!currentRoots.has(previous.sourceRoot)) deleteStoredGraph(db, previous.sourceRoot);
  }
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

/**
 * `detectAndPersistBundleAdapters` only auto-detects an adapter for a source
 * root that exists and can be listed — an unreadable/missing root gets no
 * silent guess.
 */
function allSourceRootsReadable(roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) return false;
      fs.readdirSync(root);
    } catch {
      return false;
    }
  }
  return true;
}

// ── Indexer ──────────────────────────────────────────────────────────────────

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let akmIndexOverride: typeof akmIndexReal | undefined;

/** TEST-ONLY. Swap the implementation of `akmIndex`; pass undefined to restore. */
export function _setAkmIndexForTests(fake?: typeof akmIndexReal): void {
  akmIndexOverride = fake;
}

/**
 * Reclassify a contention-shaped error escaping reconcile or drain into a
 * retryable-shortly `TransientError` (field follow-up to #956): a concurrent
 * writer can make index.db busy, and the raw SQLite driver error ("database is
 * locked") used to escape as exit 70 (internal/unclassified) instead of the
 * "retry shortly" contract exit 75 gives a scheduler to branch on — mirroring
 * `STATE_DB_CONTENDED`'s precedent for state.db (`core/state-db.ts`). Reuses
 * the ONE shared classifier, `isSqliteContentionError`, rather than a second
 * one. An error that is already a classified akm error is never re-wrapped —
 * only a raw, unclassified error matching the shared contention shape is
 * reclassified. Every other error is rethrown unchanged.
 *
 * index-redesign note: under the new design (docs/plans/index-redesign.md,
 * rule 5) every index write is a short immediate transaction under WAL with
 * SQLite's own busy timeout — no rebuild lock, no writer lock on the index
 * path — so genuine contention is rarer, but still possible when two
 * processes race the same file, and the reclassification still matters when
 * it happens.
 */
export function reclassifyIndexDbContention(error: unknown): unknown {
  if (error instanceof AkmError || !isSqliteContentionError(error)) return error;
  const contended = new TransientError(
    "akm's index database is busy (another akm process is writing it); retry shortly.",
    "INDEX_DB_CONTENDED",
  );
  contended.cause = error;
  return contended;
}

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
 * The effective embedding vector width for this db: the config's explicit
 * `embedding.dimension` when set, else the width `index-schema.ts`'s
 * `ensureSchema` already stamped into `index_meta.embeddingDim` (every
 * `openIndexDatabase` call runs `ensureSchema` before this code ever runs),
 * else the static default. Mirrors `ensureSchema`'s own derivation so
 * `dropOtherIdentities` below never recreates `units_vec` at the wrong width.
 */
function effectiveEmbeddingDim(db: Database, config: AkmConfig): number {
  const configured = config.embedding?.dimension;
  if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) return configured;
  const stored = Number(getMeta(db, "embeddingDim"));
  return Number.isInteger(stored) && stored > 0 ? stored : EMBEDDING_DIM;
}

/**
 * `akm index --reembed`: drop the active embedding identity's vectors so
 * drain re-embeds every unit from scratch under that same identity. Reuses
 * A2's `dropOtherIdentities(db, keep, dim)` by asking it to keep an identity
 * string no real vector can ever carry — `""`, never produced by
 * `deriveObservedEmbeddingIdentity` — so every row under the real identity is
 * removed and none are spared. `index_meta.embeddingIdentity` is left as-is:
 * re-embedding the same unchanged provider/model reproduces the same identity
 * string, so there is nothing stale to clear.
 */
function dropActiveIdentityVectors(db: Database, config: AkmConfig): void {
  const identity = getMeta(db, "embeddingIdentity");
  if (!identity) return;
  dropOtherIdentities(db, "", effectiveEmbeddingDim(db, config));
}

function getEmbeddingProvider(embedding?: AkmConfig["embedding"]): "local" | "remote" {
  return isHttpUrl(embedding?.endpoint) ? "remote" : "local";
}

function buildIndexSummaryMessage(options: {
  mode: "full" | "incremental";
  sourcesCount: number;
  semanticSearchMode: AkmConfig["semanticSearchMode"];
  embeddingProvider: "local" | "remote";
  vecAvailable: boolean;
}): string {
  const stashSourceLabel = options.sourcesCount === 1 ? "stash source" : "stash sources";
  const semanticDetail =
    options.semanticSearchMode === "off"
      ? "disabled"
      : `${options.embeddingProvider} embeddings, ${options.vecAvailable ? "sqlite-vec" : "unavailable"}`;
  return `Starting ${options.mode} index (${options.sourcesCount} ${stashSourceLabel}, semantic search: ${semanticDetail}).`;
}

/**
 * Compute the `IndexResponse.verification` envelope from the current unit
 * coverage for the active embedding identity. `drain` is the just-completed
 * `DrainCounts`, when a drain ran this call (`null` when semantic search is
 * off, the embedding phase was deferred to `akm bundle update`'s post-commit
 * pass, or the drain call itself threw — see `drainFailed`).
 *
 * `drainFailed` is set when `drainEmbeddingQueue` threw outright (a genuine
 * interruption — an abort, a provider crash before its own per-batch
 * retry/circuit-breaker ever engaged) rather than returning normally with
 * some batches skipped. `drain` is `null` in that case too (the counts a
 * completed call would have returned were never produced), so this call
 * cannot tell "threw after embedding half of them" apart from "threw before
 * embedding any" by inspecting `drain` alone — `drainFailed` carries that
 * distinction forward explicitly: this run did not finish its embedding
 * phase, whatever partial progress the DB already durably committed
 * (`coverage.unitsPresent`, read fresh below) notwithstanding.
 */
function buildIndexVerification(
  db: Database,
  config: AkmConfig,
  drain: DrainCounts | null,
  drainFailed = false,
): IndexVerification {
  const embeddingProvider = getEmbeddingProvider(config.embedding);
  const vecAvailable = isVecAvailable(db);
  const totalEntries = getEntryCount(db);
  const semanticSearchEnabled = config.semanticSearchMode === "auto";

  if (totalEntries === 0) {
    return {
      ok: true,
      message: "Index ready. No assets were found yet.",
      semanticSearchEnabled,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: config.semanticSearchMode === "off" ? "disabled" : "pending",
      embeddingProvider,
      entryCount: 0,
      embeddingCount: 0,
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
      embeddingCount: 0,
      vecAvailable,
    };
  }

  const identity = getMeta(db, "embeddingIdentity");
  const coverage = identity
    ? unitCoverage(db, identity)
    : { entries: 0, entriesFullyCovered: 0, unitsTotal: 0, unitsPresent: 0 };

  if (coverage.entries > 0 && coverage.entriesFullyCovered >= coverage.entries && vecAvailable) {
    return {
      ok: true,
      message: `Semantic search ready (${coverage.unitsPresent}/${coverage.unitsTotal} unit embeddings, sqlite-vec active).`,
      semanticSearchEnabled: true,
      semanticSearchMode: config.semanticSearchMode,
      semanticStatus: "ready-vec",
      embeddingProvider,
      entryCount: totalEntries,
      embeddingCount: coverage.unitsPresent,
      vecAvailable,
    };
  }

  // Not fully covered: a fresh index whose queue is still draining ("pending",
  // not a failure) vs. a drain that ran and made no progress at all, OR
  // threw outright mid-run ("blocked" either way — matches the guidance the
  // old materialize-embeddings path gave for the same shape of failure).
  const madeNoProgress =
    drainFailed || (drain !== null && drain.pending > 0 && drain.embedded === 0 && drain.failed > 0);

  return {
    ok: !madeNoProgress,
    message: madeNoProgress
      ? `Semantic search verification failed (${coverage.unitsPresent}/${coverage.unitsTotal} unit embeddings available).`
      : `Semantic search embedding in progress (${coverage.unitsPresent}/${coverage.unitsTotal} unit embeddings).`,
    ...(madeNoProgress
      ? {
          guidance:
            embeddingProvider === "remote"
              ? "Check your embedding endpoint and credentials, then retry `akm index --full --verbose`."
              : "Retry `akm index --full --verbose`. If it still fails, confirm local model downloads are permitted and see docs/reference/configuration.md for local embedding dependency setup.",
        }
      : {}),
    semanticSearchEnabled: true,
    semanticSearchMode: config.semanticSearchMode,
    semanticStatus: madeNoProgress ? "blocked" : "pending",
    embeddingProvider,
    entryCount: totalEntries,
    embeddingCount: coverage.unitsPresent,
    vecAvailable,
  };
}

/** Result of the shared embedding pass — see {@link runEmbeddingPass}. */
export interface EmbeddingPassResult {
  drainCounts: DrainCounts;
  verification: IndexVerification;
}

/**
 * The ONE embedding-phase implementation: drain the content-addressed
 * embedding queue (B4's `drainEmbeddingQueue`) and compute the post-drain
 * `IndexVerification` from unit coverage. `akmIndex`'s own (non-deferred) run
 * calls this inline; `akm bundle update`'s coordinator calls it directly on
 * its own connection AFTER its unified update transaction commits, since
 * draining writes per-provider-batch transactions that must not nest inside
 * the coordinator's long-lived one.
 */
export async function runEmbeddingPass(params: {
  db: Database;
  config: AkmConfig;
  onProgress: (event: IndexProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<EmbeddingPassResult> {
  const { db, config, onProgress, signal } = params;
  const drainCounts = await drainEmbeddingQueue(db, config, {
    signal,
    onProgress: (line) => onProgress({ phase: "embeddings", message: line }),
  });
  const verification = buildIndexVerification(db, config, drainCounts);
  setMeta(db, "hasEmbeddings", verification.semanticStatus === "ready-vec" ? "1" : "0");
  onProgress({ phase: "verify", message: verification.message });
  return { drainCounts, verification };
}

async function akmIndexReal(options: IndexOptions): Promise<IndexResponse> {
  const requestedAt = Date.now();
  const stashDir = options.stashDir;
  const onProgress = options?.onProgress ?? (() => {});
  const signal = options?.signal;
  const full = options?.full === true;
  const reembed = options?.reembed === true;

  const { loadConfig, mutateConfig } = await import("../core/config/config.js");
  let config = loadConfig();

  // Durable state must be runtime-compatible before source hydration,
  // adapter persistence, or index.db creation can mutate the installation.
  onProgress({ phase: "preflight", message: "Validating durable state." });
  if (!options.deferredUpdateTransaction) withStateDb(() => undefined);

  // Source hydration: ensure git/website/npm caches are extracted before
  // resolving stash dirs, so their content directories exist on disk for
  // reconcile's walk to discover. This is NOT index derivation — it is what
  // makes derivation possible — so it stays even though the walk/derive
  // pipeline below it does not.
  const sourceCacheStart = Date.now();
  onProgress({ phase: "preflight", message: "Hydrating source caches." });
  const { ensureSourceCaches, resolveSourceEntries } = await import("./search/search-source.js");
  // Inject the store-backed secret resolver from here — a composition root
  // ABOVE the provider/fetcher import cycle (this module reaches
  // search-source only via dynamic import). This is what lets a website
  // source's fetcher resolve `secrets/x-bearer-token` during bundle-update /
  // hydrate, not just from the command-layer URL-ingest path.
  const { storeSecretResolver } = await import("../sources/snapshot-fetchers/secret-seam.js");
  await ensureSourceCaches(config, {
    force: full,
    materialize: options.hydrateSources !== false,
    secrets: storeSecretResolver,
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
  const dbPath = getDbPath();
  const embeddingDim = config.embedding?.dimension;
  const borrowedUpdateDb = options.deferredUpdateTransaction?.db;
  const db = borrowedUpdateDb ?? openIndexDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);
  if (borrowedUpdateDb && !borrowedUpdateDb.inTransaction) {
    throw new Error("Source update index requires an active borrowed index transaction.");
  }

  try {
    const owners = sourceOwners(allSourceEntries);

    if (full) {
      onProgress({ phase: "preflight", message: "Forcing full re-derivation for a full reindex." });
    }
    if (reembed) {
      onProgress({ phase: "preflight", message: "Dropping vectors for the active embedding identity." });
      dropActiveIdentityVectors(db, config);
    }

    onProgress({
      phase: "summary",
      message: buildIndexSummaryMessage({
        mode: full ? "full" : "incremental",
        sourcesCount: allSourceDirs.length,
        semanticSearchMode: config.semanticSearchMode,
        embeddingProvider: getEmbeddingProvider(config.embedding),
        vecAvailable: isVecAvailable(db),
      }),
    });

    removeStaleSourceOwners(db, owners);

    throwIfAborted(signal);
    const reconcileStart = Date.now();
    const reconcileCounts = await reconcileRoots(
      db,
      owners
        .filter((owner) => !owner.unresolved)
        .map((owner) => ({ path: owner.sourceRoot, bundleId: owner.bundleId })),
      { signal, onProgress: (line) => onProgress({ phase: "scan", message: line }), forceReparse: full },
    );
    onProgress({
      phase: "scan",
      message:
        `Reconciled ${reconcileCounts.scanned} file${reconcileCounts.scanned === 1 ? "" : "s"} ` +
        `(${reconcileCounts.added} added, ${reconcileCounts.changed} changed, ${reconcileCounts.removed} removed).`,
    });
    const reconcileEnd = Date.now();

    throwIfAborted(signal);
    const deferred = options.deferredUpdateTransaction;
    let drainCounts: DrainCounts | null = null;
    let drainFailed = false;
    if (deferred) {
      // #954-precedent: the embedding phase is SKIPPED entirely for a
      // borrowed transaction — draining commits per provider batch, which
      // must not nest inside the coordinator's long-lived transaction.
      // Finalize below records semantic state as "pending", never "ready",
      // until the coordinator's own post-commit `runEmbeddingPass` call
      // reports the truth on a fresh connection.
      setMeta(db, "hasEmbeddings", "0");
    } else if (config.semanticSearchMode !== "off") {
      try {
        drainCounts = await drainEmbeddingQueue(db, config, {
          signal,
          onProgress: (line) => onProgress({ phase: "embeddings", message: line }),
        });
      } catch (drainError) {
        // Best-effort, same contract as the write-path drain
        // (index-written-assets.ts): the provider can fail outright (a model
        // download blocked, DNS down, a bad endpoint) before it ever reaches
        // drainEmbeddingQueue's own per-batch retry/circuit-breaker — an
        // index run must still finish lexically searchable rather than
        // crash. The embedding queue is durable: the next run (or the
        // scheduler) computes the same "no vector yet" query and resumes.
        // `drainFailed` records that this run's embedding phase did not
        // finish (verification below reports `ok: false`), independent of
        // however many batches had already committed durably before the
        // throw — those are real, already reflected in the next read of
        // unit coverage, not undone by this catch.
        throwIfAborted(signal);
        drainFailed = true;
        warn(
          "[index] Embedding drain failed; the index is lexically searchable and vectors will be attempted on the next run:",
          drainError instanceof Error ? drainError.message : String(drainError),
        );
      }
    }
    const embedEnd = Date.now();

    // ── Finalize / meta bookkeeping ───────────────────────────────────────
    const finalizeStart = Date.now();
    const mutateState = (stateDb: Database, stateSchema?: string): void => {
      onProgress({ phase: "finalize", message: "Relinking usage events." });
      relinkUsageEvents(db, stateDb, { sources: allSourceEntries, defaultStashDir: stashDir, stateSchema });
      onProgress({ phase: "finalize", message: "Recomputing utility scores." });
      recomputeUtilityScores(db, stateDb, { stateSchema });
    };
    if (deferred) {
      if (deferred.db !== db || !db.inTransaction) {
        throw new Error("Source update index finalization requires its borrowed unified transaction.");
      }
      mutateState(db, deferred.stateSchema);
    } else {
      withStateDb(mutateState);
    }

    // An incomplete reconcile (a configured source that could not be walked
    // this run) preserves the prior freshness watermark. Advancing it could
    // make a source that came back look unchanged even though this run never
    // saw its files — the same #624-P1 preflight the old walk phase applied
    // to `builtAt`, now keyed off `reconcileCounts.complete`.
    if (reconcileCounts.complete) {
      const builtAt = new Date().toISOString();
      setMeta(db, "builtAt", builtAt);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "stashDirs", JSON.stringify(owners.map((owner) => owner.sourceRoot)));
      setMeta(db, "sourceOwners", JSON.stringify(owners));
      setMeta(db, "lastReconcileAt", builtAt);
    }

    if (!deferred && config.semanticSearchMode !== "off") warnIfVecMissing(db);

    const verification = deferred
      ? {
          ok: true,
          message: "Semantic index update deferred until after the source-update commit.",
          semanticSearchEnabled: config.semanticSearchMode === "auto",
          semanticSearchMode: config.semanticSearchMode,
          semanticStatus: config.semanticSearchMode === "off" ? ("disabled" as const) : ("pending" as const),
          embeddingProvider: getEmbeddingProvider(config.embedding),
          entryCount: getEntryCount(db),
          embeddingCount: 0,
          vecAvailable: isVecAvailable(db),
        }
      : buildIndexVerification(db, config, drainCounts, drainFailed);
    if (!deferred) setMeta(db, "hasEmbeddings", verification.semanticStatus === "ready-vec" ? "1" : "0");
    onProgress({ phase: "verify", message: verification.message });

    const totalEntries = getEntryCount(db);
    const finalizeEnd = Date.now();

    return {
      stashDir,
      totalEntries,
      generatedMetadata: reconcileCounts.added + reconcileCounts.changed,
      indexPath: dbPath,
      mode: full ? "full" : "incremental",
      directoriesScanned: owners.length,
      directoriesSkipped: 0,
      scanComplete: reconcileCounts.complete,
      ...(reconcileCounts.warnings.length > 0 ? { warnings: reconcileCounts.warnings } : {}),
      ...(Object.keys(persistedAdapters).length > 0 ? { configUpdated: { detectedAdapters: persistedAdapters } } : {}),
      verification,
      timing: {
        totalMs: Date.now() - t0,
        preflightMs: t0 - requestedAt,
        sourceCacheMs: sourceCacheEnd - sourceCacheStart,
        reconcileMs: reconcileEnd - reconcileStart,
        embedMs: embedEnd - reconcileEnd,
        finalizeMs: finalizeEnd - finalizeStart,
        endToEndMs: Date.now() - requestedAt,
      },
    };
  } finally {
    if (!borrowedUpdateDb) closeDatabase(db);
  }
}

// ── lookup ─────────────────────────────────────────────────────────────────

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
 * Called during `akm index` after reconcile.
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
