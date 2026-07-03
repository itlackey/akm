// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MemRL feedback → utility policy, extracted from indexer/db/db.ts.
 *
 * This is the domain/policy math (arXiv:2601.03192) that decides how a batch of
 * positive/negative feedback signals moves an asset's utility score. It is pure
 * — no database access — so the bounded-step behaviour is unit-testable in
 * isolation; the DB read/write stays with `applyFeedbackToUtilityScore` in db.ts.
 */

/**
 * MemRL learning rate for feedback-driven utility updates (F-5 / #386).
 *
 * Follows the bounded-step formula from MemRL (arXiv:2601.03192):
 *   next = clamp(current + lr × (reward − current), 0, 1)
 *
 * This replaces the unbounded `-0.03 × negativeCount` delta that could
 * silently remove high-utility assets from the improvement loop.
 */
export const FEEDBACK_LR = 0.1;

/**
 * Positive reward signal for a single positive feedback event.
 * Reward 1.0 means "fully correct / helpful".
 */
const FEEDBACK_REWARD_POSITIVE = 1.0;

/**
 * Negative reward signal for a single negative feedback event.
 * Reward 0.0 means "not helpful" (lowest MemRL signal).
 */
const FEEDBACK_REWARD_NEGATIVE = 0.0;

/**
 * Maximum total negative utility delta allowed in a single
 * `applyFeedbackToUtilityScore` call regardless of negativeCount.
 *
 * This caps the per-day negative impact (the function is called once per
 * feedback event — spamming 10 negatives in one session can move utility
 * at most `MAX_NEG_DELTA_PER_CALL`). The cap prevents a noisy negative-
 * feedback stream from silently destroying a high-utility asset's ranking.
 */
export const MAX_NEG_DELTA_PER_CALL = 0.15;

/**
 * Utility threshold below which a review-needed escalation is triggered.
 * When a previously high-utility asset (≥ HIGH_UTILITY_THRESHOLD) drops
 * below this value, the caller should create an escalation proposal.
 */
export const UTILITY_REVIEW_THRESHOLD = 0.5;

/**
 * Utility level considered "high" — assets above this are tracked for
 * threshold-crossing escalation.
 */
export const HIGH_UTILITY_THRESHOLD = 0.5;

/**
 * Result returned by {@link computeNextUtility} / `applyFeedbackToUtilityScore`
 * (F-5 / #386).
 *
 * When `crossedReviewThreshold` is true the asset was previously at or above
 * {@link HIGH_UTILITY_THRESHOLD} and is now below {@link UTILITY_REVIEW_THRESHOLD}.
 * The caller should create a review-needed escalation proposal.
 */
export interface FeedbackUtilityResult {
  /** Utility value before the update. */
  previousUtility: number;
  /** Utility value after the update. */
  nextUtility: number;
  /** True when the update caused a high-utility asset to cross below the review threshold. */
  crossedReviewThreshold: boolean;
}

/**
 * Compute the next utility from accumulated feedback counts using the MemRL
 * bounded-step EMA formula (F-5 / #386, arXiv:2601.03192):
 *
 *   reward   = weighted average of positive and negative signals
 *   nextUtil = clamp(currentUtil + lr × (reward − currentUtil), 0, 1)
 *
 * The negative impact is additionally capped at {@link MAX_NEG_DELTA_PER_CALL}
 * to prevent a noisy feedback stream from silently erasing a high-utility asset.
 *
 * Pure: no DB access. When both counts are zero, utility is unchanged.
 */
export function computeNextUtility(
  previousUtility: number,
  positiveCount: number,
  negativeCount: number,
): FeedbackUtilityResult {
  if (positiveCount === 0 && negativeCount === 0) {
    return { previousUtility, nextUtility: previousUtility, crossedReviewThreshold: false };
  }

  const total = positiveCount + negativeCount;
  // Weighted reward: proportion of positive signals.
  const reward =
    positiveCount > 0 && negativeCount === 0
      ? FEEDBACK_REWARD_POSITIVE
      : negativeCount > 0 && positiveCount === 0
        ? FEEDBACK_REWARD_NEGATIVE
        : (positiveCount * FEEDBACK_REWARD_POSITIVE + negativeCount * FEEDBACK_REWARD_NEGATIVE) / total;

  // MemRL bounded-step EMA: lr × (reward − current)
  let delta = FEEDBACK_LR * (reward - previousUtility);

  // Per-call negative cap: if delta is negative (net negative feedback), cap it.
  if (delta < 0) {
    delta = Math.max(delta, -MAX_NEG_DELTA_PER_CALL);
  }

  const nextUtility = Math.max(0, Math.min(1, previousUtility + delta));

  const crossedReviewThreshold = previousUtility >= HIGH_UTILITY_THRESHOLD && nextUtility < UTILITY_REVIEW_THRESHOLD;
  return { previousUtility, nextUtility, crossedReviewThreshold };
}
