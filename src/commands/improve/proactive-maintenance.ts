// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proactive maintenance: a second eligibility source that revisits stale,
 * useful assets with no fresh feedback. Whole-stash/type scope only; the
 * winners join the same reflect/distill candidate set as the signal-delta gate.
 * Pure: the caller supplies the ledger timestamps, retrieval counts and clock.
 */

import type { ImproveEligibleRef } from "../../core/improve-types";
import { assetTypeOf } from "./eligibility";
import { computeSalience } from "./salience";

const DAY_MS = 86_400_000;

/** An asset is due when last reflected/distilled more than this many days ago (or never). */
export const DEFAULT_DUE_DAYS = 30;

/** Default bound on how many assets the selector surfaces per run. */
export const DEFAULT_MAX_PER_RUN = 25;

/** Size floor for the cost term, so tiny files don't divide by ~0. */
const SIZE_FLOOR_BYTES = 200;

export interface ProactiveSelectorParams {
  /** The improve-eligible pool with no fresh feedback. */
  candidates: ImproveEligibleRef[];
  /** Last reflect attempt (ISO) per ref; absent means never. */
  lastReflectTs: Map<string, string>;
  /** Last distill attempt (ISO) per ref; either attempt resets the maintenance clock. */
  lastDistillTs: Map<string, string>;
  retrievalCounts: Map<string, number>;
  /** Most recent retrieval (ms) per ref; absent means long ago. */
  lastUseMs?: Map<string, number>;
  sizeBytesOf?: (ref: ImproveEligibleRef) => number | undefined;
  dueDays?: number;
  maxPerRun?: number;
  now?: number;
}

export interface ProactiveScoredRef {
  ref: ImproveEligibleRef;
  type: string;
  /** Days since the last reflect/distill; `Infinity` when never touched. */
  staleDays: number;
  neverReflected: boolean;
  retrievalFreq: number;
  sizeBytes: number;
  priority: number;
  due: boolean;
}

export interface ProactiveSelectionResult {
  /** Top-N due refs, highest priority first. */
  selected: ImproveEligibleRef[];
  dueTotal: number;
  neverReflected: number;
  scored: ProactiveScoredRef[];
}

/**
 * The due gate, shared by selection and the post-lock re-filter: never touched,
 * or last touched more than `dueDays` ago. It doubles as the rotation cooldown.
 */
function staleness(
  ref: string,
  lastReflectTs: Map<string, string>,
  lastDistillTs: Map<string, string>,
  dueDays: number,
  now: number,
): { staleDays: number; neverReflected: boolean; due: boolean } {
  const lastTouchMs = Math.max(
    0,
    Date.parse(lastReflectTs.get(ref) ?? "") || 0,
    Date.parse(lastDistillTs.get(ref) ?? "") || 0,
  );
  const neverReflected = lastTouchMs === 0;
  const staleDays = neverReflected ? Number.POSITIVE_INFINITY : (now - lastTouchMs) / DAY_MS;
  return { staleDays, neverReflected, due: neverReflected || staleDays > dueDays };
}

/** Rank due assets by salience (then staleness, then ref) and keep the top N. */
export function selectProactiveMaintenanceRefs(params: ProactiveSelectorParams): ProactiveSelectionResult {
  const now = params.now ?? Date.now();
  const dueDays = params.dueDays ?? DEFAULT_DUE_DAYS;
  const maxPerRun = params.maxPerRun ?? DEFAULT_MAX_PER_RUN;

  const scored: ProactiveScoredRef[] = params.candidates.map((candidate) => {
    const ref = candidate.ref;
    const type = assetTypeOf(ref);
    const retrievalFreq = params.retrievalCounts.get(ref) ?? 0;
    let sizeBytes = params.sizeBytesOf?.(candidate) ?? 0;
    if (!sizeBytes || sizeBytes < 0) sizeBytes = SIZE_FLOOR_BYTES;
    const priority = computeSalience({
      ref,
      type,
      retrievalFreq,
      lastUseMs: params.lastUseMs?.get(ref) ?? 0,
      sizeBytes,
      now,
    }).rankScore;
    return {
      ref: candidate,
      type,
      ...staleness(ref, params.lastReflectTs, params.lastDistillTs, dueDays, now),
      retrievalFreq,
      sizeBytes,
      priority,
    };
  });

  const dueScored = scored.filter((s) => s.due);
  const ranked = dueScored.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.staleDays !== a.staleDays) return b.staleDays - a.staleDays;
    return a.ref.ref < b.ref.ref ? -1 : a.ref.ref > b.ref.ref ? 1 : 0;
  });

  return {
    selected: ranked.slice(0, Math.max(0, maxPerRun)).map((s) => s.ref),
    dueTotal: dueScored.length,
    neverReflected: dueScored.filter((s) => s.neverReflected).length,
    scored,
  };
}

/**
 * Re-apply the due gate under the run lock with fresh timestamps, dropping refs
 * another run attempted after this one planned.
 */
export function filterProactiveDue(
  selected: ImproveEligibleRef[],
  lastReflectTs: Map<string, string>,
  lastDistillTs: Map<string, string>,
  dueDays: number,
  now: number,
): ImproveEligibleRef[] {
  return selected.filter((c) => staleness(c.ref, lastReflectTs, lastDistillTs, dueDays, now).due);
}
