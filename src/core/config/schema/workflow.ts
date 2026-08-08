// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `workflow` engine settings. Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { engineName, positiveInt } from "./primitives";

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
 *
 * `defaultMapConcurrency` is the width a `map` step freezes when it declares no
 * `concurrency:` of its own:
 *   - UNSET  → `DEFAULT_MAP_CONCURRENCY` (4) from
 *     `src/workflows/concurrency-policy.ts`.
 *   - SET    → the explicit positive integer, CLAMPED to `[1, 64]`. Setting it
 *     to `1` restores the pre-0.9.1 serial-by-default fan-out for every
 *     workflow on this install. It is a floor for authoring only: it never
 *     raises a step above `maxConcurrency`, the engine's concurrency, or the
 *     host CPU cap, and it never overrides an authored `map.concurrency`.
 */
export const WorkflowConfigSchema = z
  .object({
    maxConcurrency: positiveInt.optional(),
    defaultMapConcurrency: positiveInt.optional(),
    /** Named LLM or agent engine frozen into every criteria-bearing gate. */
    judgeEngine: engineName.optional(),
  })
  .passthrough();
