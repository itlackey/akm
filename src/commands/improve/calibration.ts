// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auto-accept gate calibration (#612).
 *
 * The auto-accept confidence gate (src/commands/improve/improve-auto-accept.ts)
 * stamps every proposal it touches with a `gateDecision` — the predicted
 * confidence plus the realized outcome (`auto-accepted` / `deferred` /
 * `auto-rejected`). This module turns that per-proposal ledger into a
 * CALIBRATED predictor: over a rolling window it joins predicted confidence to
 * the realized accept/reject outcome and computes a deterministic reliability
 * summary (accept-rate per confidence bucket + an aggregate calibration gap).
 *
 * "Realized outcome" for a gated proposal is the gate's own verdict on the
 * accept decision:
 *   - `auto-accepted`  → realized SUCCESS (the gate promoted it).
 *   - `auto-rejected`  → realized FAILURE (it passed the confidence threshold
 *                        but failed validation during promotion).
 *
 * `deferred` decisions carry no realized accept/reject signal from the gate
 * (the proposal was simply left pending), so they are excluded from the
 * reliability join — calibration measures "when the gate ACTS on confidence,
 * how often is it right?".
 *
 * Everything here is a pure function of the decision list, so it is trivially
 * testable and deterministic (no clock / RNG in any sorted/rendered output).
 */

import type { ProposalGateDecision } from "../proposal/validators/proposals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single decision the calibration join consumes. */
export interface CalibrationSample {
  /** Predicted confidence in [0, 1] the gate computed. */
  confidence: number;
  /** Realized accept/reject outcome of the gate's action. */
  outcome: "auto-accepted" | "auto-rejected";
}

/** Reliability stats for one confidence bucket. */
export interface CalibrationBucket {
  /** Lower bound of the bucket (inclusive), in [0, 1]. */
  lower: number;
  /** Upper bound of the bucket (exclusive, except the final bucket which is inclusive of 1). */
  upper: number;
  /** Number of acted-on decisions whose predicted confidence fell in this bucket. */
  count: number;
  /** Number of those that were realized as accepted (auto-accepted). */
  accepted: number;
  /** accepted / count, 4dp; 0 when count === 0. */
  acceptRate: number;
  /** Mean predicted confidence of the decisions in this bucket, 4dp; 0 when empty. */
  meanConfidence: number;
}

/** Window-level calibration summary surfaced on the health result. */
export interface CalibrationSummary {
  /** Total acted-on (auto-accepted + auto-rejected) decisions in the window. */
  samples: number;
  /** Total realized accepted. */
  accepted: number;
  /** Total realized rejected. */
  rejected: number;
  /** Overall realized accept rate (accepted / samples), 4dp; 0 when no samples. */
  overallAcceptRate: number;
  /** Mean predicted confidence across acted-on decisions, 4dp; 0 when none. */
  meanConfidence: number;
  /**
   * Aggregate calibration gap = meanConfidence − overallAcceptRate, 4dp.
   * Positive ⇒ the gate is OVER-confident (predicts higher than realized
   * acceptance); negative ⇒ under-confident. 0 when no samples.
   */
  calibrationGap: number;
  /** Reliability table: accept-rate per fixed confidence bucket. */
  buckets: CalibrationBucket[];
}

// ---------------------------------------------------------------------------
// Reliability computation
// ---------------------------------------------------------------------------

/** Number of fixed-width reliability buckets over [0, 1]. */
export const CALIBRATION_BUCKET_COUNT = 10;

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Assign a confidence in [0, 1] to one of {@link CALIBRATION_BUCKET_COUNT}
 * fixed-width buckets. The final bucket is closed on the right so confidence
 * === 1 lands in the top bucket rather than overflowing.
 */
function bucketIndex(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  const idx = Math.floor(clamped * CALIBRATION_BUCKET_COUNT);
  return Math.min(CALIBRATION_BUCKET_COUNT - 1, idx);
}

/**
 * Compute a deterministic calibration summary from a list of acted-on gate
 * decisions. Pure: identical input always yields identical output, with no
 * dependency on wall-clock time or randomness.
 */
export function summarizeCalibration(samples: CalibrationSample[]): CalibrationSummary {
  const buckets: CalibrationBucket[] = [];
  const bucketCounts: number[] = new Array(CALIBRATION_BUCKET_COUNT).fill(0);
  const bucketAccepted: number[] = new Array(CALIBRATION_BUCKET_COUNT).fill(0);
  const bucketConfSum: number[] = new Array(CALIBRATION_BUCKET_COUNT).fill(0);

  let accepted = 0;
  let confSum = 0;
  for (const sample of samples) {
    const idx = bucketIndex(sample.confidence);
    bucketCounts[idx] = (bucketCounts[idx] ?? 0) + 1;
    bucketConfSum[idx] = (bucketConfSum[idx] ?? 0) + sample.confidence;
    confSum += sample.confidence;
    if (sample.outcome === "auto-accepted") {
      accepted += 1;
      bucketAccepted[idx] = (bucketAccepted[idx] ?? 0) + 1;
    }
  }

  const total = samples.length;
  const width = 1 / CALIBRATION_BUCKET_COUNT;
  for (let i = 0; i < CALIBRATION_BUCKET_COUNT; i += 1) {
    const count = bucketCounts[i] ?? 0;
    const acc = bucketAccepted[i] ?? 0;
    buckets.push({
      lower: roundRate(i * width),
      upper: roundRate((i + 1) * width),
      count,
      accepted: acc,
      acceptRate: count > 0 ? roundRate(acc / count) : 0,
      meanConfidence: count > 0 ? roundRate((bucketConfSum[i] ?? 0) / count) : 0,
    });
  }

  const overallAcceptRate = total > 0 ? roundRate(accepted / total) : 0;
  const meanConfidence = total > 0 ? roundRate(confSum / total) : 0;
  return {
    samples: total,
    accepted,
    rejected: total - accepted,
    overallAcceptRate,
    meanConfidence,
    calibrationGap: total > 0 ? roundRate(meanConfidence - overallAcceptRate) : 0,
    buckets,
  };
}

/**
 * Project a list of `gateDecision` records (read from the proposal store) into
 * the acted-on calibration samples within an optional `[since, until)` window.
 *
 * Only `auto-accepted` / `auto-rejected` decisions with a finite confidence in
 * [0, 1] contribute. `deferred` decisions and decisions missing a confidence
 * are excluded (no realized accept/reject signal). The window filter uses each
 * decision's `decidedAt` timestamp; decisions with an unparseable timestamp are
 * kept only when no window is supplied.
 */
export function gateDecisionsToSamples(
  decisions: Array<ProposalGateDecision | undefined>,
  window?: { since?: string; until?: string },
): CalibrationSample[] {
  const sinceMs = window?.since ? new Date(window.since).getTime() : undefined;
  const untilMs = window?.until ? new Date(window.until).getTime() : undefined;
  const samples: CalibrationSample[] = [];
  for (const decision of decisions) {
    if (!decision) continue;
    if (decision.outcome !== "auto-accepted" && decision.outcome !== "auto-rejected") continue;
    const confidence = decision.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = new Date(decision.decidedAt).getTime();
      if (!Number.isFinite(ts)) continue;
      if (sinceMs !== undefined && ts < sinceMs) continue;
      if (untilMs !== undefined && ts >= untilMs) continue;
    }
    samples.push({ confidence, outcome: decision.outcome });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Bounded, opt-in threshold auto-tune (#612)
// ---------------------------------------------------------------------------

/** Configuration for the bounded threshold auto-tune. Mirrors config.improve.calibration. */
export interface CalibrationTuneConfig {
  /** Master switch — when false/absent the tuner is a no-op (parity default). */
  autoTune: boolean;
  /** Lower bound (integer 0-100) the tuned threshold may never drop below. */
  minThreshold: number;
  /** Upper bound (integer 0-100) the tuned threshold may never rise above. */
  maxThreshold: number;
  /** Maximum adjustment magnitude (integer points) applied in one tune step. */
  maxStep: number;
  /** Minimum acted-on sample count required before any adjustment is made. */
  minSamples: number;
  /**
   * Target realized accept rate in [0, 1]. When the realized accept rate is
   * BELOW target the gate is letting through too many failures, so the
   * threshold is nudged UP; when ABOVE target it is too conservative, so the
   * threshold is nudged DOWN. Default 0.9.
   */
  targetAcceptRate: number;
}

/** Result of a bounded auto-tune computation. */
export interface CalibrationTuneResult {
  /** Whether the tuner ran and produced an adjustment. */
  adjusted: boolean;
  /** The threshold before tuning (integer 0-100). */
  previousThreshold: number;
  /** The threshold after tuning (integer 0-100). Equals previous when not adjusted. */
  newThreshold: number;
  /** Signed adjustment applied (newThreshold − previousThreshold). */
  delta: number;
  /** Machine-stable reason token explaining the decision. */
  reason:
    | "disabled"
    | "insufficient-samples"
    | "below-target-raise"
    | "above-target-lower"
    | "within-target"
    | "clamped-at-bound";
}

/**
 * Compute a bounded, opt-in threshold adjustment from a calibration summary.
 * PURE and deterministic — does not mutate config or read the clock. The
 * caller is responsible for persisting `newThreshold` and logging the result.
 *
 * Algorithm (deliberately simple and bounded):
 *   - When `autoTune` is false → no-op (`disabled`).
 *   - When samples < `minSamples` → no-op (`insufficient-samples`).
 *   - Otherwise nudge by at most `maxStep` toward `targetAcceptRate`, then
 *     clamp into `[minThreshold, maxThreshold]`. The step size scales with the
 *     gap from target but is capped, so a single run can never make a large
 *     swing.
 */
export function computeThresholdAutoTune(
  currentThreshold: number,
  summary: CalibrationSummary,
  config: CalibrationTuneConfig,
): CalibrationTuneResult {
  const previousThreshold = Math.round(currentThreshold);
  const noop = (reason: CalibrationTuneResult["reason"]): CalibrationTuneResult => ({
    adjusted: false,
    previousThreshold,
    newThreshold: previousThreshold,
    delta: 0,
    reason,
  });

  if (!config.autoTune) return noop("disabled");
  if (summary.samples < config.minSamples) return noop("insufficient-samples");

  const gap = config.targetAcceptRate - summary.overallAcceptRate;
  // A small dead-band so tiny noise doesn't churn the threshold every run.
  const DEAD_BAND = 0.01;
  if (Math.abs(gap) <= DEAD_BAND) return noop("within-target");

  // gap > 0 ⇒ realized below target ⇒ raise threshold (be stricter).
  // gap < 0 ⇒ realized above target ⇒ lower threshold (be more permissive).
  const direction = gap > 0 ? 1 : -1;
  // Scale the step with the gap magnitude (in points) but cap at maxStep.
  const desiredMagnitude = Math.min(config.maxStep, Math.max(1, Math.round(Math.abs(gap) * 100)));
  const proposed = previousThreshold + direction * desiredMagnitude;
  const clamped = Math.min(config.maxThreshold, Math.max(config.minThreshold, proposed));
  const delta = clamped - previousThreshold;

  if (delta === 0) return noop("clamped-at-bound");
  return {
    adjusted: true,
    previousThreshold,
    newThreshold: clamped,
    delta,
    reason: direction > 0 ? "below-target-raise" : "above-target-lower",
  };
}
