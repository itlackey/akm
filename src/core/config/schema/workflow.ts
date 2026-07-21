// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `workflow` engine settings. Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { positiveInt } from "./primitives";

// ── Workflow engine ─────────────────────────────────────────────────────────

/**
 * Workflow-engine settings (`workflow`).
 *
 * `maxConcurrency` is the engine-wide ceiling on concurrent units for native
 * fan-out (`akm workflow run`). It replaces the hard-coded `min(16, cores−2)`
 * cap (which matched Claude Code) with a user knob:
 *   - UNSET  → the CPU-derived default `min(16, max(1, cores−2))`.
 *   - SET    → the explicit positive integer, CLAMPED at read time to
 *     `[1, WORKFLOW_MAX_CONCURRENCY_CEILING]` (64). Values above the ceiling
 *     are clamped, not rejected, so a config shared across machines with wildly
 *     different core counts never hard-fails validation.
 * The R3 brief/report driver surface does NOT consult this — drivers own their
 * own parallelism (the engine only caps native dispatch).
 */
export const WorkflowConfigSchema = z
  .object({
    maxConcurrency: positiveInt.optional(),
  })
  .passthrough();
