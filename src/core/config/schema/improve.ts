// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `improve` config section (salience, state GC, strategies). Retired
 * keys (`salience.replayBudget`, `salienceThreshold`, `collapseDetector`, `utilityDecay`) are
 * tolerated as unknown keys.
 */
import { z } from "zod";
import { ImproveProfileConfigSchema } from "./improve-processes";
import { engineName, LlmInvocationOverridesSchema, nonEmptyString, nonNegativeNumber, positiveInt } from "./primitives";

// ── Improve top-level (event retention, salience, state GC) ────────────────

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

/**
 * Where one improve call runs: a connection or a harness, the model (an alias or
 * a name), inference settings and a timeout. Strategies say which processes run;
 * this says where, whichever strategy is selected.
 */
export const ImproveWhereSchema = z
  .object({
    connection: nonEmptyString.optional(),
    harness: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    llm: LlmInvocationOverridesSchema.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
  })
  .passthrough();

/** The improve processes that make a model call; `proactiveMaintenance` makes none, so it has no place to run. */
const ImproveProcessesSchema = z
  .object({
    reflect: ImproveWhereSchema.optional(),
    distill: ImproveWhereSchema.optional(),
    consolidate: ImproveWhereSchema.optional(),
    memoryInference: ImproveWhereSchema.optional(),
    extract: ImproveWhereSchema.optional(),
    validation: ImproveWhereSchema.optional(),
    triage: ImproveWhereSchema.optional(),
  })
  .passthrough();

export const ImproveConfigSchema = z
  .object({
    /**
     * `false`: background learning is off on this host. `akm improve` and `akm proposal extract` do nothing, whoever
     * runs them. `akm setup --learning off` writes it and `on` removes it. Absent means on.
     */
    enabled: z.boolean().optional(),
    /** The strategy `akm improve` runs when `--strategy` names none. */
    strategy: engineName.optional(),
    /**
     * The base for all of akm's own model work, not only `akm improve`: improve's processes, the judges, enrich,
     * extract and the proposal drain. A connection, or a harness, over the default, with the model (an alias or a
     * name), inference settings and a timeout every call under it starts from. `processes` and `qualityGate` below
     * are nearer; the run's `--connection`, `--harness` and `--model` are nearest.
     */
    connection: nonEmptyString.optional(),
    harness: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    llm: LlmInvocationOverridesSchema.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    /** Where each improve process runs, over `connection` / `harness` above. */
    processes: ImproveProcessesSchema.optional(),
    /** Where the judge of the reflect and distill quality gates runs, over `connection` / `harness` above (not over the process's own settings, which are the writer's). */
    qualityGate: ImproveWhereSchema.optional(),
    strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
    stateGc: ImproveStateGcSchema.optional(),
  })
  .passthrough();
