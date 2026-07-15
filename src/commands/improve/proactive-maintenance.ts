// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Layer 2 of the `akm improve` redesign — the PROACTIVE MAINTENANCE SELECTOR.
 *
 * The signal-delta gate (Layer 1) only surfaces assets that have *fresh*
 * feedback. It never revisits a stable, useful asset on a schedule. On a quiet
 * stash with no new feedback the improve loop can therefore go indefinitely
 * without touching high-value assets that have simply gone stale.
 *
 * This selector is a SECOND eligibility SOURCE. It runs only on whole-stash /
 * type scope, enumerates the eligible asset population, computes a composite
 * maintenance priority per asset, gates on staleness (the "due" gate), bounds
 * the result to top-N by priority, and feeds the winners into the SAME
 * reflect/distill candidate set as the signal-delta gate — so they flow through
 * the existing #580 empty-diff/cosmetic suppression and additive-distill gates.
 * It adds NO new mutation or suppression logic of its own.
 *
 * The selector is intentionally pure: it takes pre-built staleness maps and
 * retrieval counts (the planner already builds these for the signal-delta gate)
 * plus an injectable `now`, and returns a deterministic selection.
 * All DB access happens in the caller through the existing storage abstractions;
 * this module never opens a database.
 */

import type { ImproveEligibleRef } from "../../core/improve-types";
import { computeSalience } from "./salience";

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/** Default staleness gate: an asset is due when last reflected > this many days ago (or never). */
export const DEFAULT_DUE_DAYS = 30;

/** Default bound on how many assets the selector surfaces per run. */
export const DEFAULT_MAX_PER_RUN = 25;

/** Lower bound on size used in the cost denominator so tiny files don't divide by ~0. */
const SIZE_FLOOR_BYTES = 200;

export interface ProactiveSelectorParams {
  /**
   * Candidate population to consider. Every entry should already be confined to
   * the improve-eligible, writable, validated set (the planner passes the
   * no-feedback / non-signal pool). Each ref must parse as `type:name`.
   */
  candidates: ImproveEligibleRef[];
  /**
   * Last reflect-invoked timestamp (ISO string) per ref, keyed by the SAME ref
   * strings as `candidates`. Absent => never reflected. Built by the planner's
   * `buildLatestProposalTsMap(refs, "reflect")`.
   */
  lastReflectTs: Map<string, string>;
  /**
   * Last distill-invoked timestamp (ISO string) per ref. Absent => never
   * distilled. Built by `buildLatestProposalTsMap(refs, "distill")`. Used
   * alongside reflect so an asset that was recently distilled is not treated as
   * stale just because reflect alone hasn't touched it.
   */
  lastDistillTs: Map<string, string>;
  /** Retrieval frequency per ref (Layer-1 `getRetrievalCounts`, normalization-aware). */
  retrievalCounts: Map<string, number>;
  /** Most-recent retrieval timestamp (ms) per ref, for the recency-decay term. Absent => treated as long ago. */
  lastUseMs?: Map<string, number>;
  /** Resolve an asset's size in bytes. Defaults applied when omitted or returns falsy. */
  sizeBytesOf?: (ref: ImproveEligibleRef) => number | undefined;
  /** Staleness gate in days. Default {@link DEFAULT_DUE_DAYS}. */
  dueDays?: number;
  /** Top-N bound. Default {@link DEFAULT_MAX_PER_RUN}. */
  maxPerRun?: number;
  /** Injectable clock (ms). Defaults to `Date.now()`. */
  now?: number;
}

export interface ProactiveScoredRef {
  ref: ImproveEligibleRef;
  type: string;
  /** Days since last reflect/distill; `Infinity` when never touched. */
  staleDays: number;
  neverReflected: boolean;
  retrievalFreq: number;
  sizeBytes: number;
  priority: number;
  due: boolean;
}

export interface ProactiveSelectionResult {
  /** Top-N due refs in descending priority order, ready to fold into the candidate set. */
  selected: ImproveEligibleRef[];
  /** Total number of due assets in the population (before the top-N bound). */
  dueTotal: number;
  /** Number of due assets that have never been reflected. */
  neverReflected: number;
  /** Full scored view (all candidates), exposed for telemetry / tests. */
  scored: ProactiveScoredRef[];
}

/** Parse the bare asset type out of a `type:name` ref. Returns "" when unparseable. */
function refType(ref: string): string {
  const i = ref.indexOf(":");
  return i > 0 ? ref.slice(0, i) : "";
}

/**
 * Score and select due assets for proactive maintenance.
 *
 * Priority: delegates to `computeSalience(...).rankScore` (WS-1 unified salience
 * vector). The ranking key is therefore identical to every other selector that
 * uses salience — a single formula governs attention across the whole improve loop.
 *
 * DUE gate: an asset is eligible only if it was never reflected OR last
 * reflected/distilled more than `dueDays` ago. The same gate doubles as the
 * ROTATION cooldown — a freshly-reflected asset is excluded until it ages back
 * past `dueDays`, so successive runs rotate through the due pool rather than
 * re-selecting the same heads. Non-due assets never enter the selection.
 */
export function selectProactiveMaintenanceRefs(params: ProactiveSelectorParams): ProactiveSelectionResult {
  const now = params.now ?? Date.now();
  const dueDays = params.dueDays ?? DEFAULT_DUE_DAYS;
  const maxPerRun = params.maxPerRun ?? DEFAULT_MAX_PER_RUN;

  const scored: ProactiveScoredRef[] = [];

  for (const candidate of params.candidates) {
    const ref = candidate.ref;
    const type = refType(ref);

    // Staleness from the most recent of reflect/distill — either one touching
    // the asset resets its maintenance clock.
    const reflectIso = params.lastReflectTs.get(ref);
    const distillIso = params.lastDistillTs.get(ref);
    let lastTouchMs = 0;
    if (reflectIso) lastTouchMs = Math.max(lastTouchMs, Date.parse(reflectIso) || 0);
    if (distillIso) lastTouchMs = Math.max(lastTouchMs, Date.parse(distillIso) || 0);
    const neverReflected = lastTouchMs === 0;
    const staleDays = neverReflected ? Number.POSITIVE_INFINITY : (now - lastTouchMs) / DAY_MS;

    // DUE / rotation gate.
    const due = neverReflected || staleDays > dueDays;

    // Retrieval frequency (for salience inputs).
    const retrievalFreq = params.retrievalCounts.get(ref) ?? 0;
    const lastUse = params.lastUseMs?.get(ref) ?? 0;

    // Size proxy (cost): kept for salience input — computeSalience applies
    // the log10 denominator internally.
    let sizeBytes = params.sizeBytesOf?.(candidate) ?? 0;
    if (!sizeBytes || sizeBytes < 0) sizeBytes = SIZE_FLOOR_BYTES;

    // Unified priority via WS-1 salience vector (replaces the old inline formula).
    const priority = computeSalience({ ref, type, retrievalFreq, lastUseMs: lastUse, sizeBytes, now }).rankScore;

    scored.push({
      ref: candidate,
      type,
      staleDays,
      neverReflected,
      retrievalFreq,
      sizeBytes,
      priority,
      due,
    });
  }

  const dueScored = scored.filter((s) => s.due);
  const dueTotal = dueScored.length;
  const neverReflected = dueScored.filter((s) => s.neverReflected).length;

  // Rank due assets by composite priority (desc). Ties broken by staleness
  // (older first) then ref string for deterministic ordering.
  const ranked = dueScored.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.staleDays !== a.staleDays) return b.staleDays - a.staleDays;
    return a.ref.ref < b.ref.ref ? -1 : a.ref.ref > b.ref.ref ? 1 : 0;
  });

  const selected = ranked.slice(0, Math.max(0, maxPerRun)).map((s) => s.ref);

  return { selected, dueTotal, neverReflected, scored };
}

/**
 * Pre-execution re-filter for proactive refs.
 *
 * Called under the whole-run lock with freshly-read timestamp maps. Refs that
 * became non-due before this run acquired the lock are dropped before execution,
 * closing the SELECT-time cooldown race.
 *
 * The logic mirrors the DUE gate in `selectProactiveMaintenanceRefs` — an
 * asset is due only when never touched OR last touched more than `dueDays`
 * ago. The selector and this filter must always agree on the gate predicate.
 */
export function filterProactiveDue(
  selected: ImproveEligibleRef[],
  lastReflectTs: Map<string, string>,
  lastDistillTs: Map<string, string>,
  dueDays: number,
  now: number,
): ImproveEligibleRef[] {
  return selected.filter((candidate) => {
    const ref = candidate.ref;
    const reflectIso = lastReflectTs.get(ref);
    const distillIso = lastDistillTs.get(ref);
    let lastTouchMs = 0;
    if (reflectIso) lastTouchMs = Math.max(lastTouchMs, Date.parse(reflectIso) || 0);
    if (distillIso) lastTouchMs = Math.max(lastTouchMs, Date.parse(distillIso) || 0);
    const neverReflected = lastTouchMs === 0;
    const staleDays = neverReflected ? Number.POSITIVE_INFINITY : (now - lastTouchMs) / DAY_MS;
    return neverReflected || staleDays > dueDays;
  });
}
