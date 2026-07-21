// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `improve` config section (utility decay, salience, collapse
 * detector, strategies). Extracted verbatim from the former `config-schema.ts`
 * monolith — no behavior change.
 */
import { z } from "zod";
import { ImproveProfileConfigSchema } from "./improve-processes";
import { engineName, nonNegativeNumber } from "./primitives";

// ── Improve top-level (utility decay, event retention) ─────────────────────

const ImproveUtilityDecaySchema = z
  .object({
    halfLifeDays: z.number().finite().min(0.1).optional(),
    feedbackStabilityBoost: z.number().finite().min(1).optional(),
  })
  .passthrough();

const ImproveSalienceSchema = z
  .object({
    /**
     * WS-2 Part-V gate: enable the outcome-weight term in the salience projection.
     * Default TRUE/absent (DEFAULT ON since the G2 saturation cap landed — see
     * salience.ts): uses the WS-2 weights (w_e=0.25, w_o=0.15, w_r=0.60) so the
     * prediction-error outcome signal shapes rankScore (the R1 loop-closure).
     * Set to `false` to opt out and restore the WS-1 parity weights
     * (w_e=0.30, w_r=0.70, w_o=0); the `outcome` sub-score is still computed
     * and stored for observability in that mode.
     */
    outcomeWeightEnabled: z.boolean().optional(),
    /**
     * Minimum encoding salience score [0, 1] for a zero-feedback asset to be
     * admitted to the high-salience improve lane (#608).
     * Default 0.75. Set to 1.0 to disable the lane entirely.
     */
    salienceThreshold: z.number().min(0).max(1).optional(),
    /**
     * Per-run additive replay budget (#610). Up to this many top-salience refs are
     * revisited even with no reactive signal and regardless of cooldown. Additive
     * on top of --limit. Default 0 = no replay.
     */
    replayBudget: z.number().int().min(0).optional(),
  })
  .passthrough();

// R5 — longitudinal collapse/churn detector (observe-only in v1; deterministic,
// fail-open, runs only on cycles where consolidate did work).
// Default ON; opt out via `improve.collapseDetector.enabled: false`.
// See docs/design/improve-collapse-churn-detector-design.md.
const ImproveCollapseDetectorSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Canary set size minted on first run (owner-approved 30–50 range; default 40).
    canaryCount: z.number().int().min(3).max(200).optional(),
    // Top-K cutoff for canary recall/nDCG (default 10).
    k: z.number().int().min(1).max(100).optional(),
    // Trend window in qualifying cycles (default 5).
    windowCycles: z.number().int().min(2).max(50).optional(),
    // Absolute mean-recall drop vs window median that fires collapse (default 0.15).
    recallDropThreshold: z.number().min(0).max(1).optional(),
    // distinct-content-ratio decline over the window that fires collapse (default 0.05).
    entropyDropThreshold: z.number().min(0).max(1).optional(),
    // Accepted-action volume over the window below which churn never fires (default 25).
    churnMinAcceptedActions: z.number().int().min(1).optional(),
    // improve_cycle_metrics retention (default 365 days, owner-approved).
    retentionDays: z.number().int().min(1).optional(),
  })
  .passthrough();

export const ImproveConfigSchema = z
  .object({
    strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
    utilityDecay: ImproveUtilityDecaySchema.optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
    salience: ImproveSalienceSchema.optional(),
    collapseDetector: ImproveCollapseDetectorSchema.optional(),
  })
  .passthrough();
