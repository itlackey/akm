// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-2 — Unified OUTCOME loop (S2 seam).
 *
 * One per-asset "was this retrieval useful" signal, differential
 * (prediction-error-shaped), persisted in `state.db :: asset_outcome`.
 *
 * ## Signal formula (v2)
 *
 * ```
 * outcome_score =
 *   (retrieval_delta − expected_retrieval_delta)
 *   + valence
 * ```
 *
 * - `retrieval_delta`: retrievals gained since the last window.
 * - `expected_retrieval_delta`: rolling mean of per-cycle retrieval DELTA.
 * - `valence`: normalised net feedback valence in [−1, +1].
 *
 * The v1 "retrieved-but-never-improved" penalty term
 * (`PENALTY × retrieval_delta × (1 − accepted_change_rate)`) was DELETED (#691):
 * measured corr(outcome_score, accepted_change_rate) was 0.0069 across 5,601 live
 * rows (noise), and because the unclamped rate exceeds 1 whenever accepted
 * changes outnumber retrievals, the term paid a live *bonus* for churn —
 * an asset's score could rise by being rewritten under auto-accept.
 * `accepted_change_count` remains persisted as raw telemetry only; it must
 * never re-enter the score (pinned by tests/integration/commands/improve/outcome-invariance.test.ts).
 *
 * ## Eligibility-trace decay
 *
 * Only the last K improve cycles contribute — older retrievals decay out via
 * an EMA on the retrieval count (rather than a window log). This prevents
 * an asset popular 18 months ago from permanently occupying a high rank.
 *
 * ## Warm start
 *
 * On first row insert, `outcome_score` is seeded from the utility EMA (#386,
 * normalised to [0, WARM_START_CAP]) so `outcomeSalience` is non-zero at
 * launch. Real differential signal progressively replaces the seed.
 *
 * ## Diversity floor
 *
 * The converted `outcomeSalience` (used in the salience projection) is capped
 * at DIVERSITY_FLOOR_FRACTION of the maximum observed score, so rare-but-correct
 * assets cannot be permanently outcompeted by frequently-retrieved ones.
 *
 * Note: there is no `outcomeLoop.enabled` config flag. The WS-2 outcome-loop block
 * in `improve.ts` runs on every improve pass. Profile-level disabling of specific
 * processes (consolidate, reflect, etc.) is handled by those processes' own config
 * keys, not by this module.
 *
 * @module outcome-loop
 */

import type { Database } from "../../storage/database";
import {
  type AssetOutcomeRow,
  getAllAssetOutcomes,
  getAssetOutcome,
  getOutcomeScoresByRef,
  upsertAssetOutcome,
} from "../../storage/repositories/outcome-repository";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * EMA decay factor for the expected-retrieval rolling mean (α).
 * New expected = α × new_count + (1−α) × old_expected.
 * At α = 0.3 the window is ≈ 3 cycles.
 */
export const OUTCOME_EMA_ALPHA = 0.3;

/**
 * Warm-start cap: the maximum `outcome_score` a brand-new row can be seeded with
 * (from the utility EMA). Prevents a `[0,1]`-range utility value from generating
 * a score that the first negative delta could catastrophically invert. Clipped to
 * the maximum plausible first differential update: `max(0, 1 − 0) = 1`, so cap
 * at a modest 0.3 to avoid spurious rank-flip on first cycle.
 */
export const WARM_START_CAP = 0.3;

/**
 * Penalty cap: the minimum outcome_score is capped at this value so a single
 * very-negative run can't send the score to −∞.
 */
export const OUTCOME_SCORE_MIN = -1.0;

/**
 * Saturation ceiling: the maximum outcome_score. Biological RPE saturates —
 * a fully predicted reward produces zero response, not an ever-growing one —
 * so a long-lived popular asset must not accrue unbounded outcome mass that
 * would dominate ranking once the outcome weight is enabled (analysis G2).
 * 1.5 comfortably exceeds the max plausible single-cycle raw update while
 * keeping the normalised outcomeSalience spread meaningful.
 */
export const OUTCOME_SCORE_MAX = 1.5;

/**
 * Diversity floor: `outcomeSalience` for any asset is at least this fraction
 * of the maximum observed `outcome_score` in the table, so rare-but-correct
 * assets cannot be permanently outcompeted. 0 = disabled (pure competition).
 */
export const DIVERSITY_FLOOR_FRACTION = 0.1;

// ── Row shape ─────────────────────────────────────────────────────────────────
//
// AssetOutcomeRow moved verbatim to storage/repositories/outcome-repository.ts
// (#672 part 2) — re-exported here so existing importers of this module
// resolve unchanged (see that file's module-level note for why the row type
// lives there rather than here: it keeps the repository free of any import
// back into this file, avoiding a 2-node import cycle).

export type { AssetOutcomeRow };

// ── Writer ────────────────────────────────────────────────────────────────────

export interface OutcomeUpdateInputs {
  /** Asset ref. */
  ref: string;
  /**
   * Current total retrieval count from the index DB.
   * The difference from the stored count is `retrieval_delta`.
   */
  currentRetrievalCount: number;
  /** Timestamp of the most recent retrieval in ms (0 = never). */
  lastRetrievedAt: number;
  /**
   * Number of ACCEPTED proposals for this ref since inception.
   * Persisted as raw telemetry ONLY — it does not participate in the
   * outcome_score formula (#691: the derived rate rewarded churn).
   */
  acceptedChangeCount: number;
  /**
   * Cumulative negative-feedback count for this ref.
   * Sourced from the feedback event log (count of `feedback_negative` events).
   */
  negativeFeedbackCount: number;
  /**
   * Net valence in [−1, +1] from `computeValenceScore`. Used as the additive
   * valence term in the outcome formula. Optional — defaults to 0.
   */
  valence?: number;
  /**
   * Existing utility EMA score in [0,1] (#386). Only used for the warm-start
   * seed on new rows; ignored on updates.
   */
  utilityScore?: number;
  /** Injectable clock (ms). Defaults to Date.now(). */
  now?: number;
}

/**
 * Computed outcome fields after one writer update. Returned from
 * `updateAssetOutcome` so the caller can forward `outcome_score` to the
 * salience vector without a second DB read.
 */
export interface OutcomeUpdateResult {
  outcomeScore: number;
  isNewRow: boolean;
}

export interface OutcomeProjection extends OutcomeUpdateResult {
  expectedRetrievalRate: number;
}

/**
 * Project the next outcome values without touching storage. Dry planning and
 * the live writer both call this function, so rank inputs cannot drift merely
 * because one caller persists the projection and the other does not.
 */
export function projectAssetOutcome(
  existing: AssetOutcomeRow | undefined,
  inputs: OutcomeUpdateInputs,
): OutcomeProjection {
  const valence = inputs.valence ?? 0;
  const isNewRow = existing === undefined;

  let outcomeScore: number;
  let expectedRetrievalRate: number;

  if (isNewRow) {
    const seedScore = Math.min(WARM_START_CAP, Math.max(0, inputs.utilityScore ?? 0));
    outcomeScore = seedScore;
    expectedRetrievalRate = 0;
  } else {
    const retrievalDelta = Math.max(0, inputs.currentRetrievalCount - existing.retrieval_count);
    const expectedDelta = existing.expected_retrieval_rate;
    const predictionError = retrievalDelta - expectedDelta;
    expectedRetrievalRate =
      OUTCOME_EMA_ALPHA * retrievalDelta + (1 - OUTCOME_EMA_ALPHA) * existing.expected_retrieval_rate;
    const rawUpdate = predictionError + valence;
    const newScore = OUTCOME_EMA_ALPHA * rawUpdate + (1 - OUTCOME_EMA_ALPHA) * existing.outcome_score;
    outcomeScore = Math.min(OUTCOME_SCORE_MAX, Math.max(OUTCOME_SCORE_MIN, newScore));
  }

  return { outcomeScore, expectedRetrievalRate, isNewRow };
}

/**
 * Upsert one asset's outcome row.
 *
 * On first call for a ref (no prior row): warm-starts from `utilityScore`.
 * On subsequent calls: applies the differential update formula.
 *
 * Returns the resulting `outcome_score` so the caller can pass it to
 * `computeSalience` without a second read.
 */
export function updateAssetOutcome(db: Database, inputs: OutcomeUpdateInputs): OutcomeUpdateResult {
  const now = inputs.now ?? Date.now();
  const existing = getAssetOutcome(db, inputs.ref);
  const projection = projectAssetOutcome(existing, inputs);

  // Upsert the row. See `upsertAssetOutcome` in
  // storage/repositories/outcome-repository.ts (#672 part 2) for the SQL text
  // and the `review_pressure` omission rationale — this call site is
  // unchanged in intent, just no longer inline.
  upsertAssetOutcome(db, {
    ref: inputs.ref,
    lastRetrievedAt: inputs.lastRetrievedAt,
    retrievalCount: inputs.currentRetrievalCount,
    expectedRetrievalRate: projection.expectedRetrievalRate,
    negativeFeedbackCount: inputs.negativeFeedbackCount,
    acceptedChangeCount: inputs.acceptedChangeCount,
    outcomeScore: projection.outcomeScore,
    updatedAt: now,
  });

  return { outcomeScore: projection.outcomeScore, isNewRow: projection.isNewRow };
}

// ── Reader ────────────────────────────────────────────────────────────────────
//
// getAssetOutcome / getAllAssetOutcomes / getOutcomeScoresByRef moved verbatim
// to storage/repositories/outcome-repository.ts (#672 part 2) — re-exported
// here so existing importers of this module resolve unchanged.

export { getAllAssetOutcomes, getAssetOutcome, getOutcomeScoresByRef };

// ── outcomeSalience projection ────────────────────────────────────────────────

/**
 * Convert a raw `outcome_score` (differential, may be negative) to a
 * `outcomeSalience` value in [0, 1] suitable for use in the salience projection.
 *
 * Approach:
 *   1. Clip negative scores to 0 (a negative outcome just means "below expected",
 *      not "irrelevant"; it should not harm the base retrieval/encoding ranking).
 *   2. Apply the diversity floor so rare-but-correct assets always retain a
 *      minimum `outcomeSalience` relative to the stash-wide maximum.
 *   3. Normalise by `maxScore` (the stash-wide max outcome_score) so the term
 *      lives in [0, 1]. When maxScore ≤ 0 (all seeds, nothing observed yet),
 *      return the floor (or 0 if DIVERSITY_FLOOR_FRACTION = 0).
 *
 * @param outcomeScore - Raw outcome_score from asset_outcome.
 * @param maxScore     - Maximum outcome_score across ALL rows (≥ 0 after clip).
 *                       Callers must compute this once per batch and pass it in.
 */
export function outcomeScoreToSalience(outcomeScore: number, maxScore: number): number {
  const clipped = Math.max(0, outcomeScore);
  if (maxScore <= 0) {
    // No positive scores observed yet — return diversity floor.
    return DIVERSITY_FLOOR_FRACTION;
  }
  const normalised = clipped / maxScore;
  // Apply diversity floor.
  return Math.max(DIVERSITY_FLOOR_FRACTION, normalised);
}
