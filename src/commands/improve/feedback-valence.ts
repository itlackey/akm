// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Symmetric valence weighting for the improve eligibility sort (#614).
 *
 * BACKGROUND. The improve attention/eligibility ranking historically combined
 * utility with a NEGATIVE-ONLY feedback term: `negative / (positive + negative)`.
 * Under that formula a strong-positive asset contributes a feedback ratio of
 * `0` — i.e. positive feedback never drives attention. Only complaints could
 * lift an asset up the ranking, so a heavily-praised, heavily-used asset that
 * deserves REINFORCEMENT (distill / promote the win) is treated identically to
 * a never-rated one.
 *
 * FIX (gated, default-off). When symmetric valence is enabled we replace the
 * negative-only ratio with a |valence| MAGNITUDE term so that BOTH strong
 * positive and strong negative feedback drive attention. Utility remains the
 * dominant ordering factor — valence is a secondary attention nudge with a
 * small fixed weight, never a utility override.
 *
 * This module is intentionally pure and storage-free: it takes pre-aggregated
 * positive/negative counts plus a utility lookup and returns a deterministic
 * score and lane. All DB access stays in the caller.
 */

/** Weight on utility in the combined eligibility score. Utility is dominant. */
export const UTILITY_WEIGHT = 0.7;

/** Weight on the feedback attention term in the combined eligibility score. */
export const FEEDBACK_WEIGHT = 0.3;

/**
 * Minimum |valence| magnitude for an item to be ROUTED to the fix / reinforce
 * lane. Below this the feedback is too weak/mixed to be a confident signal and
 * the item carries no attention lane (`null`). Pure magnitude in [0, 1].
 */
export const STRONG_VALENCE_THRESHOLD = 0.5;

/** Attention lane an asset is routed to based on the SIGN of its valence. */
export type FeedbackLane = "fix" | "reinforce" | null;

export interface FeedbackCounts {
  positive: number;
  negative: number;
}

export interface ValenceScore {
  /**
   * Net valence in [-1, 1]: `(positive - negative) / (positive + negative)`.
   * `0` when there is no feedback. Positive = net praise, negative = net
   * complaint.
   */
  valence: number;
  /** `|valence|` in [0, 1] — the symmetric attention magnitude. */
  magnitude: number;
  /**
   * The attention term folded into the eligibility sort. Symmetric in the
   * sign of feedback: equal-magnitude strong-positive and strong-negative
   * assets contribute the SAME attention, so neither is ignored.
   */
  attention: number;
  /**
   * Lane routing by valence sign once `magnitude >= STRONG_VALENCE_THRESHOLD`:
   * high-negative → `"fix"`, high-positive → `"reinforce"`, otherwise `null`.
   */
  lane: FeedbackLane;
}

/**
 * Compute the symmetric-valence attention score for one asset's feedback.
 *
 * Deterministic: depends only on the integer counts. No clock, no randomness.
 */
export function computeValenceScore(counts: FeedbackCounts): ValenceScore {
  const positive = Math.max(0, counts.positive);
  const negative = Math.max(0, counts.negative);
  const total = positive + negative;

  if (total === 0) {
    return { valence: 0, magnitude: 0, attention: 0, lane: null };
  }

  const valence = (positive - negative) / total;
  const magnitude = Math.abs(valence);

  let lane: FeedbackLane = null;
  if (magnitude >= STRONG_VALENCE_THRESHOLD) {
    lane = valence < 0 ? "fix" : "reinforce";
  }

  return { valence, magnitude, attention: magnitude, lane };
}
