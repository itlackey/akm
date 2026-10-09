// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `improve` config section (salience, state GC, strategies). Retired
 * keys (`salience.replayBudget`, `collapseDetector`, `utilityDecay`) are
 * tolerated as unknown keys.
 */
import { z } from "zod";
import { ImproveProfileConfigSchema } from "./improve-processes";
import { engineName, nonNegativeNumber } from "./primitives";

// ── Improve top-level (event retention, salience, state GC) ────────────────

const ImproveSalienceSchema = z
  .object({
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
    eventRetentionDays: nonNegativeNumber.optional(),
    salience: ImproveSalienceSchema.optional(),
    stateGc: ImproveStateGcSchema.optional(),
  })
  .passthrough();
