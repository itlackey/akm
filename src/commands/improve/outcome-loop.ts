// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The per-asset outcome signal in `state.db :: asset_outcome`: a
 * prediction-error update, `outcome = EMA((retrieval_delta − expected_delta) + valence)`,
 * clamped to [OUTCOME_SCORE_MIN, OUTCOME_SCORE_MAX]. The expected delta is
 * itself an EMA, so old popularity decays out. A new row is seeded from the
 * utility EMA (capped) so the term is not zero at launch. `accepted_change_count`
 * is telemetry only — as a score term it rewarded churn (#691).
 */

import type { Database } from "../../storage/database";
import {
  type AssetOutcomeRow,
  getAllAssetOutcomes,
  getAssetOutcome,
  getOutcomeScoresByRef,
  upsertAssetOutcome,
} from "../../storage/repositories/outcome-repository";

/** EMA factor for both the score and the expected retrieval delta (≈ a 3-cycle window). */
export const OUTCOME_EMA_ALPHA = 0.3;
/** The most a new row can be seeded with, so the first negative delta cannot flip the rank. */
export const WARM_START_CAP = 0.3;
export const OUTCOME_SCORE_MIN = -1.0;
/** Saturation: a long-popular asset must not accrue unbounded outcome mass. */
export const OUTCOME_SCORE_MAX = 1.5;
/** `outcomeSalience` never drops below this fraction of the stash-wide maximum. */
export const DIVERSITY_FLOOR_FRACTION = 0.1;

export type { AssetOutcomeRow };
export { getAllAssetOutcomes, getAssetOutcome, getOutcomeScoresByRef };

export interface OutcomeUpdateInputs {
  ref: string;
  /** Current retrieval count; the change from the stored count is the delta. */
  currentRetrievalCount: number;
  /** Last retrieval (ms; 0 = never). */
  lastRetrievedAt: number;
  /** Stored as telemetry; never part of the score. */
  acceptedChangeCount: number;
  negativeFeedbackCount: number;
  /** Net feedback valence in [−1, +1]. */
  valence?: number;
  /** Utility EMA in [0, 1]; seeds a new row only. */
  utilityScore?: number;
  now?: number;
}

export interface OutcomeUpdateResult {
  outcomeScore: number;
  isNewRow: boolean;
}

export interface OutcomeProjection extends OutcomeUpdateResult {
  expectedRetrievalRate: number;
}

/** The next outcome values, without storage — dry planning and the writer share it. */
export function projectAssetOutcome(
  existing: AssetOutcomeRow | undefined,
  inputs: OutcomeUpdateInputs,
): OutcomeProjection {
  if (existing === undefined) {
    return {
      outcomeScore: Math.min(WARM_START_CAP, Math.max(0, inputs.utilityScore ?? 0)),
      expectedRetrievalRate: 0,
      isNewRow: true,
    };
  }
  const retrievalDelta = Math.max(0, inputs.currentRetrievalCount - existing.retrieval_count);
  const rawUpdate = retrievalDelta - existing.expected_retrieval_rate + (inputs.valence ?? 0);
  const newScore = OUTCOME_EMA_ALPHA * rawUpdate + (1 - OUTCOME_EMA_ALPHA) * existing.outcome_score;
  return {
    outcomeScore: Math.min(OUTCOME_SCORE_MAX, Math.max(OUTCOME_SCORE_MIN, newScore)),
    expectedRetrievalRate:
      OUTCOME_EMA_ALPHA * retrievalDelta + (1 - OUTCOME_EMA_ALPHA) * existing.expected_retrieval_rate,
    isNewRow: false,
  };
}

/** Upsert one asset's outcome row; returns the score for the salience vector. */
export function updateAssetOutcome(db: Database, inputs: OutcomeUpdateInputs): OutcomeUpdateResult {
  const projection = projectAssetOutcome(getAssetOutcome(db, inputs.ref), inputs);
  upsertAssetOutcome(db, {
    ref: inputs.ref,
    lastRetrievedAt: inputs.lastRetrievedAt,
    retrievalCount: inputs.currentRetrievalCount,
    expectedRetrievalRate: projection.expectedRetrievalRate,
    negativeFeedbackCount: inputs.negativeFeedbackCount,
    acceptedChangeCount: inputs.acceptedChangeCount,
    outcomeScore: projection.outcomeScore,
    updatedAt: inputs.now ?? Date.now(),
  });
  return { outcomeScore: projection.outcomeScore, isNewRow: projection.isNewRow };
}

/**
 * A raw outcome score as salience in [0, 1]: negatives clip to 0 (below
 * expected is not irrelevant), normalized by the stash-wide maximum, never
 * below the diversity floor.
 */
export function outcomeScoreToSalience(outcomeScore: number, maxScore: number): number {
  if (maxScore <= 0) return DIVERSITY_FLOOR_FRACTION;
  return Math.max(DIVERSITY_FLOOR_FRACTION, Math.max(0, outcomeScore) / maxScore);
}
