// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import type { ImproveProfileConfig } from "../../core/config/config";
import { NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import type { ImproveEligibleRef } from "../../core/improve-types";
import { getWritableStashDirs, resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import type { Database } from "../../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import { isDistillRefusedInputType } from "./distill";
import { isStrategyFilteredForAllPasses } from "./improve-strategies";
import { parseMemoryRef } from "./memory/derived-ref";
import { improveStateReadRefs } from "./source-identity";

// Eligibility / candidate-selection predicates for improve. Free functions
// (no akmImprove closure state) extracted from improve.ts to shrink the
// orchestrator and make candidate selection independently testable.

export function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseRefInput(trimmed);
    return { mode: "ref", value: trimmed };
  } catch (err) {
    // Open type token (chunk 1.5, D1.5-1): a bare word with no `type:name`
    // shape (no colon) is a `--scope <type>` filter attempt, not a ref — ANY
    // such word is now accepted, including foreign/unknown type strings,
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
    if (!trimmed.includes(":")) {
      return { mode: "type", value: trimmed };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Invalid --scope "${trimmed}": ${message}`, "INVALID_FLAG_VALUE");
  }
}

/**
 * Dedupe a list of eligible refs by `ref`, preserving first-seen order. Used to
 * merge the eligibility sources (feedback-signal, Layer-2 proactive-maintenance,
 * high-salience) without admitting a ref into the loop twice.
 */
export function dedupeRefs(refs: ImproveEligibleRef[]): ImproveEligibleRef[] {
  const seen = new Set<string>();
  const out: ImproveEligibleRef[] = [];
  for (const r of refs) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    out.push(r);
  }
  return out;
}

export async function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
  /**
   * Refs that were considered for planning but excluded because EVERY per-ref
   * pass on the active profile (reflect + distill) would refuse them.
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
   * Empty when scope.mode === "ref" (user explicitly named the ref — intent
   * overrides profile-eligibility) or when no profile was passed (legacy
   * callers).
   */
  strategyFilteredRefs: ImproveEligibleRef[];
}> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, false);
}

/** Dry-run planner path: query an existing index without creating or mutating it. */
export async function collectEligibleRefsReadOnly(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
): ReturnType<typeof collectEligibleRefs> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, true);
}

async function collectEligibleRefsFromIndex(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir: string | undefined,
  improveProfile: ImproveProfileConfig | undefined,
  readOnly: boolean,
): ReturnType<typeof collectEligibleRefs> {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseRefInput(scope.value);
    const writableDirs = new Set(getWritableStashDirs(stashDir).map((dir) => path.resolve(dir)));
    const filePath = await findAssetFilePath(scope.value, stashDir, writableDirs);
    if (!filePath) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      };
    }
    return {
      plannedRefs: [{ ref: scope.value, reason: "scope-ref", filePath }],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
      strategyFilteredRefs: [],
    };
  }

  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
  }
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
  }

  // Only operate on writable sources — never mutate read-only registry caches
  // or remote stashes that the user did not mark writable.
  let writableDirs: string[];
  try {
    writableDirs = getWritableStashDirs(stashDir);
  } catch {
    writableDirs = sources.slice(0, 1).map((s) => s.path); // fallback: primary only
  }
  const writableDirSet = new Set(writableDirs.map((d) => path.resolve(d)));

  let db: Database | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase() : openExistingDatabase();
    if (!db) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
    }
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) => {
      // First apply the existing stashDir-scope filter (no-op when stashDir is unset).
      if (!isEntryInScope(indexed.stashDir, indexed.filePath, stashDir)) return false;
      // Then restrict to writable sources only.
      return isEntryInWritableSource(indexed.stashDir, indexed.filePath, writableDirSet);
    });
    const planned = new Map<string, ImproveEligibleRef>();
    const profileFiltered = new Map<string, ImproveEligibleRef>();
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
      // Chunk-5 flip F5d (Step 4): the durable `item_ref` (`<bundle>//<concept-id>`),
      // reconstructed from the mapper-unlocked provenance columns with ZERO extra
      // queries (D-R3 — derived from the resolved index entry, never raw input).
      // `undefined` for a NULL-provenance (pre-flip / write-back) row; the durable
      // writers then fall back to the legacy `type:name` key.
      const itemRef = indexed.bundleId && indexed.conceptId ? `${indexed.bundleId}//${indexed.conceptId}` : undefined;
      const isDerived = indexed.entry.name.endsWith(".derived");
      // `.derived` memories are LLM-inferred and intentionally skip reflect
      // (see the synthetic `derived-memory-reflect-skipped` branch in the
      // improve loop). Enqueueing them here just produced one synthetic skip
      // per derived memory per hour with no real work — pure churn observed
      // 2026-05-21: 11 derived refs re-planned every hour during idle periods.
      // The cleanup phase (analyzeMemoryCleanup) inspects derived memories
      // independently of `plannedRefs`, so dropping them here loses nothing.
      if (!isDerived && !planned.has(ref) && !profileFiltered.has(ref)) {
        // 2026-05-27: extend the .derived precedent to profile-incompatible
        // refs. If every per-ref pass (reflect + distill) on the active
        // profile would refuse this ref, drop it from `plannedRefs`. The
        // caller emits `improve_skipped { reason: strategy_filtered_all_passes }`
        // once `eventsCtx` is available so the audit trail is preserved in a
        // single event per ref instead of 2× synthetic actions per run.
        // Background: see /tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md
        if (improveProfile && isStrategyFilteredForAllPasses(ref, improveProfile)) {
          profileFiltered.set(ref, {
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
      strategyFilteredRefs: [...profileFiltered.values()],
    };
  } catch (error) {
    // Empty-stash setup paths can open index.db before its schema exists.
    rethrowIfTestIsolationError(error);
    if (error instanceof Error && /no such table:\s*entries/i.test(error.message)) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
    }
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

export function isEntryInScope(entryStashDir: string, filePath: string, stashDir?: string): boolean {
  if (!stashDir) return true;
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  const resolvedScopeStashDir = path.resolve(stashDir);
  return (
    resolvedEntryStashDir === resolvedScopeStashDir ||
    resolvedEntryStashDir.startsWith(`${resolvedScopeStashDir}${path.sep}`) ||
    resolvedFilePath.startsWith(`${resolvedScopeStashDir}${path.sep}`)
  );
}

/**
 * Return true when the indexed entry belongs to one of the writable source
 * directories. Entries from read-only registry caches or remote stashes that
 * the user has not marked writable must never enter the improve/distill loop.
 */
export function isEntryInWritableSource(entryStashDir: string, filePath: string, writableDirSet: Set<string>): boolean {
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  for (const writableDir of writableDirSet) {
    if (
      resolvedEntryStashDir === writableDir ||
      resolvedEntryStashDir.startsWith(`${writableDir}${path.sep}`) ||
      resolvedFilePath.startsWith(`${writableDir}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
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
    // The `source:` backref (the `derived_from` channel) is read through the
    // legacy-tolerant parseMemoryRef, whose NORMALISED output is now the 0.9.0
    // `memories/<name>` conceptId (Group-C item 2). That is exactly what
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
 * `tests/commands/improve-distill-planner-skip-lessons.test.ts`.
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

// ── Signal-delta eligibility helpers (0.8.0) ────────────────────────────────
//
// The 0.8.0 redesign replaced flat time-based cooldowns for reflect/distill
// with a *signal-delta* gate: a ref is re-eligible iff new feedback has
// landed since the last proposal was generated for it. These helpers build
// the two timestamp maps the gate needs in bulk, so the planner avoids
// N+1 queries across the full postCleanupRefs set.

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
  sourceName?: string,
  includeLegacyBare = false,
  itemRefByRef?: Map<string, string | undefined>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  // Chunk-5 flip F5e — dual-arm on [item_ref, durable, bare] so an item_ref-
  // keyed feedback event resolves once the writers emit it. // Chunk-8: [item_ref].
  const refByDurableKey = new Map(
    refs.flatMap((ref) =>
      improveStateReadRefs(ref, sourceName, includeLegacyBare, itemRefByRef?.get(ref)).map((key) => [key, ref]),
    ),
  );
  const { events } = readEvents({ type: "feedback", since: sinceIso });
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
 * Latest proposal timestamp per input-ref, filtered by source ('reflect' or
 * 'distill'). Reads the corresponding `*_invoked` events from state.db —
 * these events are emitted at proposal creation time and carry the *input*
 * asset ref (memory:foo, skill:bar, etc.) directly. We use them rather than
 * `listProposals` because distill proposals are keyed by the derived
 * lesson/knowledge ref, not the source memory — joining back through the
 * payload would be fragile.
 */
export function buildLatestProposalTsMap(
  refs: ReadonlyArray<string>,
  source: "reflect" | "distill",
  sourceName?: string,
  includeLegacyBare = false,
  itemRefByRef?: Map<string, string | undefined>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  // Chunk-5 flip F5e — dual-arm on [item_ref, durable, bare] so an item_ref-
  // keyed *_invoked event resolves once the writers emit it. // Chunk-8: [item_ref].
  const refByDurableKey = new Map(
    refs.flatMap((ref) =>
      improveStateReadRefs(ref, sourceName, includeLegacyBare, itemRefByRef?.get(ref)).map((key) => [key, ref]),
    ),
  );
  const eventType = source === "reflect" ? "reflect_invoked" : "distill_invoked";
  const { events } = readEvents({ type: eventType });
  for (const e of events) {
    const ref = e.ref ? refByDurableKey.get(e.ref) : undefined;
    if (!ref) continue;
    // For distill_invoked we only count attempts that produced (or attempted
    // to produce) a real proposal — config_disabled / parse-error outcomes
    // should not move the signal-delta cursor forward.
    if (eventType === "distill_invoked") {
      const outcome = (e.metadata as { outcome?: unknown } | undefined)?.outcome;
      if (outcome !== "queued" && outcome !== "skipped" && outcome !== "validation_failed") continue;
    }
    const ts = e.ts ?? "";
    if (ts > (out.get(ref) ?? "")) out.set(ref, ts);
  }
  return out;
}

/**
 * Signal-delta eligibility predicate.
 *
 * True iff `latestFeedback[ref]` is defined AND either no prior proposal
 * exists for this (ref, source) OR `latestFeedback[ref] > lastProposal[ref]`.
 *
 * Refs with no feedback signal at all are ineligible by definition — the
 * proactive-maintenance and high-salience fallback lanes (see
 * `noFeedbackCandidates` later in the planner) handle never-rated assets
 * separately.
 */
export function isSignalDeltaEligible(
  ref: string,
  latestFeedback: Map<string, string>,
  lastProposal: Map<string, string>,
): boolean {
  const fb = latestFeedback.get(ref);
  if (!fb) return false;
  const lp = lastProposal.get(ref);
  if (!lp) return true;
  return fb > lp;
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

export function buildUtilityMap(refs: ImproveEligibleRef[]): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  let db: Database | undefined;
  try {
    db = openExistingDatabase();
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
  writableDirSet?: Set<string>,
): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    writableDirSet,
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: false,
  });
}
