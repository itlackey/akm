// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, parseRefInput, resolveRef } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { type EventsContext, readEvents } from "../../core/events";
import type { ImproveEligibleRef, ImproveIndexSnapshot } from "../../core/improve-types";
import { isPathAbsent } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { deriveInstallations, deriveWritableBundleIds } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import type { Database } from "../../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { hasCurrentEntriesTable } from "../../storage/repositories/index-entry-schema";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import { SqliteReadSnapshotUnavailableError } from "../../storage/sqlite-read-snapshot";
import { isDistillRefusedInputType } from "./distill";
import { isStrategyFilteredForAllPasses } from "./improve-strategies";
import { parseMemoryRef } from "./memory/derived-ref";
import { improveStateReadRefs } from "./source-identity";

// Eligibility / candidate-selection predicates for improve. Free functions
// (no akmImprove closure state) extracted from improve.ts to shrink the
// orchestrator and make candidate selection independently testable.

/**
 * Open the index for eligibility queries, or `undefined` when no index exists
 * yet. `openExistingDatabase` refuses to create a missing `index.db` (see
 * index-connection.ts) — for eligibility, "no index" simply means nothing is
 * eligible, exactly like the readOnly arm's `undefined`.
 *
 * `undefined` is reserved for a genuinely ABSENT index. The readOnly arm has
 * refused to conflate that with an unreadable one since #791; this arm used
 * `fs.existsSync`, so the same run reported "nothing eligible to improve" at
 * exit 0 depending only on which branch it took. Both arms now raise.
 */
function openEligibilityDb(readOnly: boolean): Database | undefined {
  const db = readOnly
    ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true })
    : isPathAbsent(getDbPath())
      ? undefined
      : openExistingDatabase();
  if (db) assertEligibilityEntriesTable(db);
  return db;
}

/**
 * Readers open whatever index layout is on disk (`noteIndexLayout`,
 * index-connection.ts). Selecting candidates needs the `entries` table this
 * akm reads, so an index without one is named as needing a rebuild here rather
 * than failing later on a raw SQLite error.
 */
function assertEligibilityEntriesTable(db: Database): void {
  if (hasCurrentEntriesTable(db)) return;
  closeDatabase(db);
  throw new ConfigError(
    "index.db has no entries table this akm can read, so nothing can be selected for improvement.",
    "INDEX_SCHEMA_INCOMPATIBLE",
    "Run `akm index` to rebuild the derived index from the currently materialized sources.",
  );
}

function describeIndexSnapshot(readOnly: boolean, status: "ready" | "missing"): ImproveIndexSnapshot {
  if (status === "ready") {
    return {
      status,
      reason: readOnly ? "loaded a non-mutating point-in-time copy of the existing index" : "loaded the prepared index",
    };
  }
  return {
    status,
    reason: readOnly
      ? "index.db is missing; dry-run uses an empty snapshot and does not create it"
      : "index.db is missing after index preparation; the selector uses an empty snapshot",
  };
}

function describeUnavailableSnapshot(error: SqliteReadSnapshotUnavailableError): ImproveIndexSnapshot {
  return {
    status: "incompatible",
    reason: `index.db cannot provide a stable non-mutating snapshot (${error.message}); dry-run uses an empty snapshot`,
  };
}

/**
 * A dry-run is explicitly a non-mutating planning operation, so it may report
 * an index without a readable `entries` table ({@link assertEligibilityEntriesTable})
 * as an empty snapshot. This is deliberately a typed boundary mapping: we
 * must not turn an arbitrary SQLite error into a successful plan by matching
 * its text.
 */
function isIncompatibleIndexError(error: unknown): error is ConfigError {
  return error instanceof ConfigError && error.code === "INDEX_SCHEMA_INCOMPATIBLE";
}

function describeIncompatibleIndexSnapshot(error: ConfigError): ImproveIndexSnapshot {
  // `INDEX_SCHEMA_INCOMPATIBLE` establishes that this is the derived-index
  // boundary; its hint names the action (rebuild with `akm index`).
  const action = error.hint() ?? error.message;
  return {
    status: "incompatible",
    reason: `index.db is incompatible; ${action} Dry-run uses an empty snapshot and does not migrate it.`,
  };
}

export function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseRefInput(trimmed);
    return { mode: "ref", value: trimmed };
  } catch (err) {
    // A bare word with no ref separator is a `--scope <type>` filter attempt,
    // not a ref. Any such word is accepted, including foreign/unknown type strings,
    // which simply match zero entries downstream (a read-only query filter,
    // not a data-acceptance gate, so no deny-list is needed here: an
    // unrecognized type just matches nothing, since nothing is ever indexed
    // with it). No test pinned the old "Unknown asset type" rejection for
    // this case (chunk-1.5 anchors §A.5 — 0 hits).
    //
    // A colon-shaped value that still fails `parseRefInput` is a genuinely
    // malformed ref attempt (bad name, path traversal, or a deny-listed
    // deliberately-removed type like tool/vault, D1.5-6) — that must still
    // surface as a real error, not be silently absorbed into a type filter
    // that will never match anything.
    if (!/[/:#]/.test(trimmed)) {
      return { mode: "type", value: trimmed };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Invalid --scope "${trimmed}": ${message}`, "INVALID_FLAG_VALUE");
  }
}

/**
 * Dedupe eligible refs by their durable item ref when available, preserving
 * the first candidate and its display ref. Used to
 * merge the eligibility sources (feedback-signal, Layer-2 proactive-maintenance,
 * high-salience) without admitting a ref into the loop twice.
 */
export function dedupeRefs(refs: ImproveEligibleRef[]): ImproveEligibleRef[] {
  const seen = new Set<string>();
  const out: ImproveEligibleRef[] = [];
  for (const r of refs) {
    const key = r.itemRef ?? r.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export async function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
  config?: AkmConfig,
): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
  /**
   * Refs that were considered for planning but excluded because EVERY per-ref
   * pass in the active strategy (reflect + distill) would refuse them.
   *
   * Mirrors the 2026-05-21 `.derived` precedent (improve.ts:447–467) which
   * pre-filters churn-only refs. The 2026-05-27 deep analysis
   * (`/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`)
   * showed 18 refs/run × 24 runs/day × 2 synthetic actions each were
   * dominating the metric stream (62 539 `distill-skipped` events in 7d;
   * 99.07% of `actions[]`). Excluding them at the planner moves the audit
   * trail to a single `improve_skipped` event per ref with reason
   * `strategy_filtered_all_passes`, emitted by the caller once `eventsCtx` is
   * available.
   *
   * Empty when scope.mode === "ref" (the user explicitly named the ref) or no
   * strategy configuration was supplied.
   */
  strategyFilteredRefs: ImproveEligibleRef[];
  /** Read-side index state observed by the selector. */
  indexSnapshot?: ImproveIndexSnapshot;
}> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, false, config);
}

/** Dry-run planner path: query an existing index without creating or mutating it. */
export async function collectEligibleRefsReadOnly(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
  config?: AkmConfig,
): ReturnType<typeof collectEligibleRefs> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, true, config);
}

async function collectEligibleRefsFromIndex(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir: string | undefined,
  improveProfile: ImproveProfileConfig | undefined,
  readOnly: boolean,
  configOverride?: AkmConfig,
): ReturnType<typeof collectEligibleRefs> {
  const config = configOverride ?? loadConfig();
  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir, config);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
  }
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
  }
  const installations = deriveInstallations(sources);
  const writableBundleIds = deriveWritableBundleIds(sources);

  if (scope.mode === "ref" && scope.value) {
    let db: Database | undefined;
    try {
      db = openEligibilityDb(readOnly);
      if (!db) {
        return {
          plannedRefs: [],
          memorySummary: { eligible: 0, derived: 0 },
          strategyFilteredRefs: [],
          indexSnapshot: describeIndexSnapshot(readOnly, "missing"),
        };
      }
      const indexSnapshot = describeIndexSnapshot(readOnly, "ready");
      const entries = getAllEntries(db);
      const entriesByItemRef = new Map(entries.map((entry) => [entry.itemRef, entry] as const));
      const resolved = resolveRef(scope.value, {
        defaultBundle: config.defaultBundle,
        bundles: installations.map((installation) => ({
          id: installation.id,
          hasConcept: (conceptId) => entriesByItemRef.has(`${installation.id}//${conceptId}`),
        })),
      });
      const indexed = entriesByItemRef.get(`${resolved.bundle}//${resolved.conceptId}`);
      if (!indexed?.bundleId || !indexed.conceptId || !fs.existsSync(indexed.filePath)) {
        if (await findAssetFilePath(scope.value, stashDir)) {
          return {
            plannedRefs: [],
            memorySummary: { eligible: 0, derived: 0 },
            strategyFilteredRefs: [],
            indexSnapshot,
          };
        }
        throw new NotFoundError(`Asset not found in the selected writable source: ${scope.value}`, "ASSET_NOT_FOUND");
      }
      if (!writableBundleIds.has(indexed.bundleId)) {
        return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [], indexSnapshot };
      }
      return {
        plannedRefs: [
          { ref: indexed.conceptId, itemRef: indexed.itemRef, reason: "scope-ref", filePath: indexed.filePath },
        ],
        memorySummary: {
          eligible: indexed.entry.type === "memory" ? 1 : 0,
          derived: indexed.entry.type === "memory" && indexed.entry.name.endsWith(".derived") ? 1 : 0,
        },
        strategyFilteredRefs: [],
        indexSnapshot,
      };
    } catch (error) {
      if (readOnly && error instanceof SqliteReadSnapshotUnavailableError) {
        return {
          plannedRefs: [],
          memorySummary: { eligible: 0, derived: 0 },
          strategyFilteredRefs: [],
          indexSnapshot: describeUnavailableSnapshot(error),
        };
      }
      if (readOnly && isIncompatibleIndexError(error)) {
        return {
          plannedRefs: [],
          memorySummary: { eligible: 0, derived: 0 },
          strategyFilteredRefs: [],
          indexSnapshot: describeIncompatibleIndexSnapshot(error),
        };
      }
      throw error;
    } finally {
      if (db) closeDatabase(db);
    }
  }

  let db: Database | undefined;
  try {
    db = openEligibilityDb(readOnly);
    if (!db) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
        indexSnapshot: describeIndexSnapshot(readOnly, "missing"),
      };
    }
    const indexSnapshot = describeIndexSnapshot(readOnly, "ready");
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) =>
      writableBundleIds.has(indexed.bundleId),
    );
    const planned = new Map<string, ImproveEligibleRef>();
    const strategyFiltered = new Map<string, ImproveEligibleRef>();
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      // Chunk-8 WI-8.5c: the candidate `ref` is the SHORT conceptId
      // (`<stash-subdir>/<name>`, D-R2) — it now matches the disk lookup,
      // xrefs, and `displayRef` output spelling. `.itemRef` below stays the
      // fully-qualified durable key.
      const ref = conceptIdFromTypeName(indexed.entry.type, indexed.entry.name);
      try {
        parseRefInput(ref);
      } catch (error) {
        if (error instanceof UsageError || error instanceof NotFoundError) continue;
        throw error;
      }
      // Derive the durable item_ref from indexed provenance without another query.
      // A provenance-free row uses the short conceptId ref for improve state.
      const itemRef = indexed.itemRef;
      const isDerived = indexed.entry.name.endsWith(".derived");
      // `.derived` memories are LLM-inferred and intentionally skip reflect
      // (see the synthetic `derived-memory-reflect-skipped` branch in the
      // improve loop). Enqueueing them here just produced one synthetic skip
      // per derived memory per hour with no real work — pure churn observed
      // 2026-05-21: 11 derived refs re-planned every hour during idle periods.
      // The cleanup phase (analyzeMemoryCleanup) inspects derived memories
      // independently of `plannedRefs`, so dropping them here loses nothing.
      if (!isDerived && !planned.has(ref) && !strategyFiltered.has(ref)) {
        // 2026-05-27: extend the .derived precedent to strategy-incompatible
        // refs. If every per-ref pass (reflect + distill) on the active
        // strategy would refuse this ref, drop it from `plannedRefs`. The
        // caller emits `improve_skipped { reason: strategy_filtered_all_passes }`
        // once `eventsCtx` is available so the audit trail is preserved in a
        // single event per ref instead of 2× synthetic actions per run.
        // Background: see /tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md
        if (improveProfile && isStrategyFilteredForAllPasses(ref, improveProfile)) {
          strategyFiltered.set(ref, {
            ref,
            reason: "strategy_filtered_all_passes",
            filePath: indexed.filePath,
            itemRef,
          });
        } else {
          planned.set(ref, {
            ref,
            reason:
              scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
            filePath: indexed.filePath,
            itemRef,
          });
        }
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (isDerived) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
      strategyFilteredRefs: [...strategyFiltered.values()],
      indexSnapshot,
    };
  } catch (error) {
    // Empty-stash setup paths can open index.db before its schema exists.
    rethrowIfTestIsolationError(error);
    if (readOnly && error instanceof SqliteReadSnapshotUnavailableError) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
        indexSnapshot: describeUnavailableSnapshot(error),
      };
    }
    if (readOnly && isIncompatibleIndexError(error)) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
        indexSnapshot: describeIncompatibleIndexSnapshot(error),
      };
    }
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

export function memoryCleanupParentRef(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): string | undefined {
  if (scope.mode !== "ref" || !scope.value) return undefined;
  const parsed = parseRefInput(scope.value);
  if (parsed.type !== "memory") return undefined;
  // Non-derived parent scope: emit the canonical `memories/<name>` conceptId so
  // it matches `resolveParentRef`'s output in analyzeMemoryCleanup's parentRef
  // filter (Group-C item 2 — the reader and every comparison site flipped
  // together; emitting the raw scope value would re-open the mismatch the
  // chunk-8 history warns about).
  if (!parsed.name.endsWith(".derived")) return conceptIdFromTypeName(parsed.type, parsed.name);

  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = path.join(source.path, "memories", `${parsed.name}.md`);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    // The `source:` backref is normalized to the `memories/<name>` conceptId.
    // That is exactly what
    // analyzeMemoryCleanup's parentRef filter compares against — resolveParentRef
    // emits the same conceptId — so the two sites stay in lockstep.
    const parent = parseMemoryRef(typeof fm.source === "string" ? fm.source : undefined);
    if (parent) return parent;
  }

  return conceptIdFromTypeName("memory", parsed.name.slice(0, -".derived".length));
}

export function isLessonCandidate(ref: string): boolean {
  // Only lesson assets need lesson-schema validation (description + when_to_use).
  // Memories have their own distill path via shouldDistillMemoryRef.
  // All other types go through reflect, not distill.
  return parseRefInput(ref).type === "lesson";
}

/**
 * Planner-side check: should this ref enter the distill queue?
 *
 * Distill produces lessons from non-lesson sources. Two cases are eligible:
 *
 *   1. Memory refs that pass {@link shouldDistillMemoryRef} (the existing
 *      memory→lesson/knowledge promotion path).
 *
 * Refs whose `type` is in {@link DISTILL_REFUSED_INPUT_TYPES} (currently
 * `lesson:*`) are explicitly excluded — distill refuses them at runtime and
 * queuing them just produces a no-op `skipped` outcome per ref per hour. That
 * planner waste was the bug fixed in commit
 * fix(improve): drop distill-refused types from planner.
 *
 * Note: prior to this fix the gate used `isLessonCandidate(ref)` directly,
 * which was true *only* for `lesson:*` refs — exactly the set distill refuses.
 * The result: every hourly run re-queued the same lesson refs, the same skip
 * message returned, and no work was ever done. See
 * `tests/integration/commands/improve-distill-planner-skip-lessons.test.ts`.
 */
export function isDistillCandidateRef(ref: string, stashDir?: string): boolean {
  const parsed = parseRefInput(ref);
  if (isDistillRefusedInputType(parsed.type)) return false;
  return shouldDistillMemoryRef(ref, stashDir);
}

export function shouldDistillMemoryRef(ref: string, stashDir?: string): boolean {
  const parsed = parseRefInput(ref);
  if (parsed.type !== "memory") return false;
  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = `${source.path}/memories/${parsed.name}.md`;
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const quality = typeof fm.quality === "string" ? fm.quality : undefined;
    if (quality === "proposed") return false;
    return !parsed.name.endsWith(".derived");
  }
  return !parsed.name.endsWith(".derived");
}

// ── Signal-delta eligibility helper ──────────────────────────────────────────
//
// A ref is re-eligible for reflect/distill iff new feedback has landed since
// its last attempt (the improve ledger's `last_attempt_at` — see
// `preparation.ts` `partitionBySignalDelta`). This builds the feedback half in
// bulk, so the planner avoids N+1 queries across the full postCleanupRefs set.

/**
 * Latest feedback event timestamp per ref in the active window. Reads all
 * `feedback` events newer than `sinceIso` in one query and indexes by ref,
 * keeping the maximum `ts` per ref.
 *
 * Only events with a meaningful payload count as "signal" — `metadata.signal`
 * (positive/negative) OR `metadata.note` (a free-form annotation). Empty
 * metadata events are ignored so a stray `akm feedback <ref>` invocation
 * without a flag doesn't trigger downstream re-processing.
 */
export function buildLatestFeedbackTsMap(
  refs: ReadonlyArray<string>,
  sinceIso: string,
  itemRefByRef?: Map<string, string | undefined>,
  eventsCtx?: EventsContext,
): Map<string, string> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  // Correlate item_ref-keyed events and conceptId-keyed direct invocations.
  const refByDurableKey = new Map(
    refs.flatMap((ref) => improveStateReadRefs(ref, itemRefByRef?.get(ref)).map((key) => [key, ref])),
  );
  const { events } = readEvents({ type: "feedback", since: sinceIso }, eventsCtx);
  for (const e of events) {
    const ref = e.ref ? refByDurableKey.get(e.ref) : undefined;
    if (!ref) continue;
    const meta = e.metadata as { signal?: unknown; note?: unknown } | undefined;
    const hasSignal = meta !== undefined && (typeof meta.signal === "string" || typeof meta.note === "string");
    if (!hasSignal) continue;
    const ts = e.ts ?? "";
    if (ts > (out.get(ref) ?? "")) out.set(ref, ts);
  }
  return out;
}

/**
 * H7 (#566): cooperative budget watchdog with a captured, RAII-cleared hard-kill.
 *
 * When the wall-clock budget expires, `onExhausted` (normally an
 * `AbortController.abort`) signals cooperative cancellation so the run can drain
 * its in-flight log/`state.db` flush and unwind naturally. A second hard-kill
 * timer is then armed as a watchdog: it only `exit(0)`s if the drain itself
 * overruns `hardKillGraceMs`, preventing the process from outliving the task
 * timeout window (lock-cascade fix).
 *
 * Both timers are captured; the returned dispose() clears whichever is still
 * pending. Callers invoke it from a `finally`, so a *clean* drain reaches the
 * `finally` and cancels the pending hard-kill before it can fire — the previous
 * detached `setTimeout(() => process.exit(0), 5000)` always fired, truncating a
 * clean flush. The hard-kill timer is `unref()`-ed so it never keeps the event
 * loop alive on its own: once the run drains it exits with its own code, not the
 * forced 0.
 *
 * Dependencies are injectable purely so the concurrency-sensitive timing
 * contract can be exercised deterministically in unit tests.
 */

export function shouldAnalyzeMemoryCleanup(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  eligibleMemories: number,
  primaryStashDir: string | undefined,
): boolean {
  if (!primaryStashDir || eligibleMemories === 0) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "type") return scope.value === "memory";
  if (!scope.value) return false;
  return parseRefInput(scope.value).type === "memory";
}

export function buildUtilityMap(refs: ImproveEligibleRef[], readOnly = false): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  let db: Database | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) return map;
    const allDbEntries = getAllEntries(db);
    const idToRef = new Map<number, string>();
    for (const indexed of allDbEntries) {
      // Chunk-8 WI-8.5c: correlate on the SHORT conceptId to match the
      // `ImproveEligibleRef.ref` set built in collectEligibleRefsFromIndex.
      const ref = conceptIdFromTypeName(indexed.entry.type, indexed.entry.name);
      if (refSet.has(ref)) idToRef.set(indexed.id, ref);
    }
    const ids = [...idToRef.keys()];
    if (ids.length > 0) {
      const { global: scores } = getUtilityScoresByIds(db, ids);
      for (const [id, score] of scores) {
        const ref = idToRef.get(id);
        if (ref) map.set(ref, score.utility);
      }
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, all utilities default to 0
  } finally {
    if (db) closeDatabase(db);
  }
  return map;
}

export async function findAssetFilePath(
  ref: string,
  stashDir?: string,
  writableBundleIds?: Set<string>,
): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    writableBundleIds,
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: true,
  });
}
