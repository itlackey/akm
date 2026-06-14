// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Layer 2 of the `akm improve` redesign — the PROACTIVE MAINTENANCE SELECTOR.
 *
 * The signal-delta gate (Layer 1) only surfaces assets that have *fresh*
 * feedback, and the P0-A high-retrieval fallback only rescues never-rated assets
 * that have crossed a raw retrieval threshold. Neither path ever revisits a
 * stable, useful asset on a schedule. On a quiet stash with no new feedback the
 * improve loop can therefore go indefinitely without touching high-value assets
 * that have simply gone stale.
 *
 * This selector is a THIRD eligibility SOURCE. It runs only on whole-stash /
 * type scope, enumerates the eligible asset population, computes a composite
 * maintenance priority per asset, gates on staleness (the "due" gate), bounds
 * the result to top-N by priority, and feeds the winners into the SAME
 * reflect/distill candidate set as the other two sources — so they flow through
 * the existing #580 empty-diff/cosmetic suppression and additive-distill gates.
 * It adds NO new mutation or suppression logic of its own.
 *
 * The selector is intentionally pure: it takes pre-built staleness maps and
 * retrieval counts (the planner already builds these for the signal-delta gate
 * and P0-A) plus an injectable `now`, and returns a deterministic selection.
 * All DB access happens in the caller through the existing storage abstractions;
 * this module never opens a database.
 */

import type { ImproveEligibleRef } from "../../core/improve-types";

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Importance multipliers by asset type. Higher = more worth maintaining. These
 * are the design defaults; callers may override any subset via config.
 */
export const DEFAULT_IMPORTANCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  skill: 1.5,
  agent: 1.5,
  command: 1.3,
  workflow: 1.3,
  lesson: 1.2,
  knowledge: 1.0,
  script: 0.9,
  memory: 0.7,
});

/** Default staleness gate: an asset is due when last reflected > this many days ago (or never). */
export const DEFAULT_DUE_DAYS = 30;

/** Default bound on how many assets the selector surfaces per run. */
export const DEFAULT_MAX_PER_RUN = 25;

/**
 * Half-life (days) for the recency-of-use decay term. An asset used today
 * contributes a full recency multiplier; one unused for one half-life
 * contributes half. Mirrors the validated prototype (21 days).
 */
const RECENCY_HALFLIFE_DAYS = 21;

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
  /** Importance weights by type; merged over {@link DEFAULT_IMPORTANCE_WEIGHTS}. */
  importanceWeights?: Record<string, number>;
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
  recencyDecay: number;
  sizeBytes: number;
  importance: number;
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
 * Priority formula (mirrors the validated prototype):
 *
 *   priority = (importance × log(1 + retrievalFreq) × (0.1 + 0.5^(useAgeDays/21)))
 *              / log10(max(size, 200))
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
  const weights: Record<string, number> = { ...DEFAULT_IMPORTANCE_WEIGHTS, ...(params.importanceWeights ?? {}) };

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

    // Retrieval frequency + recency decay.
    const retrievalFreq = params.retrievalCounts.get(ref) ?? 0;
    const lastUse = params.lastUseMs?.get(ref) ?? 0;
    const useAgeDays = lastUse > 0 ? (now - lastUse) / DAY_MS : 9999;
    const recencyDecay = 0.1 + 0.5 ** (useAgeDays / RECENCY_HALFLIFE_DAYS);

    // Size proxy (cost): larger assets are slightly deprioritized, but only by
    // log10 so a big-but-hot asset is never starved.
    let sizeBytes = params.sizeBytesOf?.(candidate) ?? 0;
    if (!sizeBytes || sizeBytes < 0) sizeBytes = SIZE_FLOOR_BYTES;
    const sizeProxy = Math.max(SIZE_FLOOR_BYTES, sizeBytes);

    const importance = weights[type] ?? 1.0;

    const priority = (importance * Math.log(1 + retrievalFreq) * recencyDecay) / Math.log10(sizeProxy);

    scored.push({
      ref: candidate,
      type,
      staleDays,
      neverReflected,
      retrievalFreq,
      recencyDecay,
      sizeBytes,
      importance,
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
