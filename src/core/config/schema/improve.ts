// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `improve` config section (utility decay, salience, state GC,
 * strategies). Retired keys (`salience.replayBudget`, `collapseDetector`) are
 * tolerated as unknown keys.
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
  })
  .passthrough();

// #733 — orphan-GC pass (Workstream C, lean by design: one config gate).
// The pass ALWAYS runs and ALWAYS reports counts (via the `asset_state_gc`
// event); this gate controls ONLY whether it actually deletes rows whose
// `missing_since` has been past the grace window (`STATE_GC_GRACE_MS`, 7
// days — a named constant, not configurable) for longer than that window.
const ImproveStateGcSchema = z
  .object({
    /**
     * Actually DELETE `asset_salience` / `asset_outcome` rows once they have
     * been unresolvable for longer than the grace window. Default false for
     * 0.9.0: live data (the event's `pending` counts) proves the report
     * clean before deletion is turned on.
     */
    collect: z.boolean().optional(),
  })
  .passthrough();

export const ImproveConfigSchema = z
  .object({
    strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
    utilityDecay: ImproveUtilityDecaySchema.optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
    salience: ImproveSalienceSchema.optional(),
    stateGc: ImproveStateGcSchema.optional(),
  })
  .passthrough();
