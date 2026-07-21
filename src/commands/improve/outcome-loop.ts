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
 * never re-enter the score (pinned by tests/commands/improve/outcome-invariance.test.ts).
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
 * ## Proxy-adequacy tripwire (health) — two-tailed
 *
 * We monitor `corr(outcome_score, accepted_change_rate)` across all rows.
 * If it goes below −0.3, "popular assets" and "assets that need improvement"
 * are the same set — the proxy is inverted and surfaced in the health report.
 * If |corr| < 0.1 at n ≥ 500, the proxy is DEAD — outcome_score carries no
 * information about improvement need at all (the live 2026-07 state: +0.0104
 * at n=5,706 rendered as healthy under the old one-tailed check).
 *
 * Note: there is no `outcomeLoop.enabled` config flag. The WS-2 outcome-loop block
 * in `improve.ts` runs on every improve pass. Profile-level disabling of specific
 * processes (consolidate, reflect, etc.) is handled by those processes' own config
 * keys, not by this module.
 *
 * @module outcome-loop
 */

import type { Database } from "../../storage/database";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * EMA decay factor for the expected-retrieval rolling mean (α).
 * New expected = α × new_count + (1−α) × old_expected.
 * At α = 0.3 the window is ≈ 3 cycles.
 */
export const OUTCOME_EMA_ALPHA = 0.3;

/**
 * Maximum K improve cycles for the eligibility-trace window. Retrievals older
 * than K cycles contribute via the EMA decay naturally (they are already baked
 * into `expected_retrieval_rate`).
 */
export const OUTCOME_TRACE_CYCLES = 5;

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

export interface AssetOutcomeRow {
  asset_ref: string;
  last_retrieved_at: number;
  retrieval_count: number;
  expected_retrieval_rate: number;
  negative_feedback_count: number;
  accepted_change_count: number;
  outcome_score: number;
  updated_at: number;
}

// ── Writer ────────────────────────────────────────────────────────────────────

export interface OutcomeUpdateInputs {
  /** Asset ref (`type:name`). */
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
  const valence = inputs.valence ?? 0;

  // Fetch existing row (or undefined for first insert).
  const existing = getAssetOutcome(db, inputs.ref);
  const isNewRow = existing === undefined;

  let outcomeScore: number;
  let expectedRetrievalRate: number;

  if (isNewRow) {
    // ── Warm-start ─────────────────────────────────────────────────────────
    // Seed from utility EMA, clipped to [0, WARM_START_CAP].
    // The warm-start is a non-negative seed; the first real differential update
    // will adjust it up or down from there.
    const seedScore = Math.min(WARM_START_CAP, Math.max(0, inputs.utilityScore ?? 0));
    outcomeScore = seedScore;
    // Seed expected_retrieval_rate = 0 (no delta history yet).
    // Seeding with currentRetrievalCount would produce a large spurious negative
    // prediction error on the first real cycle (delta ≪ cumulative count).
    expectedRetrievalRate = 0;
  } else {
    // ── Differential update ────────────────────────────────────────────────
    //
    // retrieval_delta = current − stored (non-negative — we never go backwards)
    const retrievalDelta = Math.max(0, inputs.currentRetrievalCount - existing.retrieval_count);

    // Differential prediction-error term:
    // outcome = (retrieval_delta − expected_delta) + valence
    //
    // Prediction error is computed against the PRIOR stored EMA (before folding
    // in this cycle's observation), so the current delta cannot leak into its own
    // expectation. Negative values are intentional — they signal below-average cycles.
    const expectedDelta = existing.expected_retrieval_rate;
    const predictionError = retrievalDelta - expectedDelta;

    // Advance the EMA over the OBSERVED delta (not the cumulative count).
    // expected' = α × delta + (1−α) × prior_expected
    expectedRetrievalRate =
      OUTCOME_EMA_ALPHA * retrievalDelta + (1 - OUTCOME_EMA_ALPHA) * existing.expected_retrieval_rate;

    // Running sum (EMA approach): new score = α × update + (1−α) × old
    // so the score tracks the moving signal, not the cumulative sum.
    const rawUpdate = predictionError + valence;
    const newScore = OUTCOME_EMA_ALPHA * rawUpdate + (1 - OUTCOME_EMA_ALPHA) * existing.outcome_score;

    // Clip to [OUTCOME_SCORE_MIN, OUTCOME_SCORE_MAX] — the ceiling is the RPE
    // saturation analog (G2): without it, long-lived popular assets accumulate
    // unbounded positive mass (live max was 3.13) and would dominate rank_score
    // the moment the outcome weight is enabled. Stored legacy scores above the
    // ceiling converge back under it on their next differential update.
    outcomeScore = Math.min(OUTCOME_SCORE_MAX, Math.max(OUTCOME_SCORE_MIN, newScore));
  }

  // Upsert the row. `review_pressure` is intentionally omitted from both the
  // INSERT column list and the ON CONFLICT SET clause: the column's DEFAULT 0
  // seeds fresh rows, and omitting it from SET leaves an existing row's value
  // untouched on update (never written going forward). The column itself is
  // dropped in migration 018.
  db.prepare(
    `INSERT INTO asset_outcome
       (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
        negative_feedback_count, accepted_change_count,
        outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_ref) DO UPDATE SET
       last_retrieved_at      = excluded.last_retrieved_at,
       retrieval_count        = excluded.retrieval_count,
       expected_retrieval_rate= excluded.expected_retrieval_rate,
       negative_feedback_count= excluded.negative_feedback_count,
       accepted_change_count  = excluded.accepted_change_count,
       outcome_score          = excluded.outcome_score,
       updated_at             = excluded.updated_at`,
  ).run(
    inputs.ref,
    inputs.lastRetrievedAt,
    inputs.currentRetrievalCount,
    expectedRetrievalRate,
    inputs.negativeFeedbackCount,
    inputs.acceptedChangeCount,
    outcomeScore,
    now,
  );

  return { outcomeScore, isNewRow };
}

// ── Reader ────────────────────────────────────────────────────────────────────

/**
 * Load the outcome row for one asset, or `undefined` if not yet written.
 */
export function getAssetOutcome(db: Database, ref: string): AssetOutcomeRow | undefined {
  const row = db
    .prepare(
      `SELECT asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
              negative_feedback_count, accepted_change_count,
              outcome_score, updated_at
       FROM asset_outcome WHERE asset_ref = ?`,
    )
    .get(ref);
  return row == null ? undefined : (row as AssetOutcomeRow);
}

/**
 * Load ALL asset_outcome rows. Used for the proxy-adequacy tripwire computation.
 */
export function getAllAssetOutcomes(db: Database): AssetOutcomeRow[] {
  return db
    .prepare(
      `SELECT asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
              negative_feedback_count, accepted_change_count,
              outcome_score, updated_at
       FROM asset_outcome ORDER BY asset_ref`,
    )
    .all() as AssetOutcomeRow[];
}

/**
 * Build a Map<ref, outcome_score> for a set of refs in one query.
 * Used by `salience.ts` to populate `outcomeSalience`.
 */
export function getOutcomeScoresByRef(db: Database, refs: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (refs.length === 0) return result;
  const CHUNK = 500;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT asset_ref, outcome_score FROM asset_outcome WHERE asset_ref IN (${placeholders})`)
      .all(...chunk) as Array<{ asset_ref: string; outcome_score: number }>;
    for (const row of rows) {
      result.set(row.asset_ref, row.outcome_score);
    }
  }
  return result;
}

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

// ── Proxy-adequacy tripwire ───────────────────────────────────────────────────

/**
 * Dead-proxy threshold: |corr| below this means outcome_score carries no
 * information about improvement need (pure noise).
 */
export const PROXY_DEAD_CORR_THRESHOLD = 0.1;

/**
 * Minimum sample size before the dead-proxy check fires. Below this, a
 * near-zero correlation is indistinguishable from small-sample noise.
 */
export const PROXY_DEAD_MIN_N = 500;

export interface ProxyAdequacyResult {
  /**
   * Pearson correlation between outcome_score and accepted_change_rate.
   * NaN when fewer than 3 rows or zero variance.
   */
  correlation: number;
  /** Number of rows used in the computation. */
  n: number;
  /**
   * When `true`, the proxy is inverted (popular = high-need): a 0.10+ rich
   * signal is no longer deferrable, and the health report should warn.
   */
  isInverted: boolean;
  /**
   * When `true`, the proxy is DEAD: |correlation| < PROXY_DEAD_CORR_THRESHOLD
   * at n ≥ PROXY_DEAD_MIN_N — outcome_score is statistically unrelated to
   * improvement outcomes and must not be treated as a health signal. The old
   * one-tailed check (inverted only) let the proxy decay from informative to
   * random without ever alarming.
   */
  isDead: boolean;
}

/**
 * Compute `corr(outcome_score, accepted_change_rate)` across all asset_outcome
 * rows. Returns `{correlation: NaN, n, isInverted: false}` when there is
 * insufficient data (fewer than 3 rows or zero variance in either variable).
 *
 * A NEGATIVE correlation means: assets with a HIGH outcome_score have a LOW
 * accepted_change_rate — i.e. the assets the proxy rates as "doing well"
 * (frequently retrieved) are precisely the ones that rarely yield an accepted
 * improvement. That inverts the proxy: high outcome_score ≠ "doing well", so the
 * coarse retrieval-delta signal is no longer trustworthy and the 0.10+ rich
 * signal is due. (`isInverted = correlation < -0.3`.)
 */
export function computeProxyAdequacy(rows: AssetOutcomeRow[]): ProxyAdequacyResult {
  const n = rows.length;
  if (n < 3) return { correlation: Number.NaN, n, isInverted: false, isDead: false };

  // accepted_change_rate per row.
  const xs = rows.map((r) => r.outcome_score);
  const ys = rows.map((r) => r.accepted_change_count / Math.max(1, r.retrieval_count));

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  covXY /= n;
  varX /= n;
  varY /= n;

  const denom = Math.sqrt(varX) * Math.sqrt(varY);
  if (denom < 1e-12) return { correlation: Number.NaN, n, isInverted: false, isDead: false };

  const correlation = covXY / denom;
  // Inverted proxy: negative correlation between outcome and accepted_change_rate
  // means high-outcome assets are also high-need — the opposite of "useful".
  const isInverted = correlation < -0.3;
  // Dead proxy: near-zero correlation at scale — the score is noise.
  const isDead = n >= PROXY_DEAD_MIN_N && Math.abs(correlation) < PROXY_DEAD_CORR_THRESHOLD;
  return { correlation, n, isInverted, isDead };
}
