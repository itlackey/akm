// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental` config section — explicit opt-ins for behaviour that is not
 * covered by the stability contract (D8).
 *
 * An entry here exists so a user can turn something ON deliberately. Every key
 * defaults to OFF, and the runtime must treat "absent" and "false" identically:
 * autonomy is never inferred from a partially-written config.
 */
import { z } from "zod";
import { ImproveWhereSchema } from "./improve";
import { ImproveProfileConfigSchema } from "./improve-processes";
import { engineName } from "./primitives";

export const ExperimentalConfigSchema = z
  .object({
    /**
     * Allow `akm improve` to mutate assets without review.
     *
     * OFF by default. Gates memory-cleanup, memory-inference writes, and triage
     * `applyMode: "promote"`. Consolidation stays enabled because destructive
     * operations are advisory and promotion emits a reviewable proposal.
     * `akm improve` itself stays on either way — what this gates is autonomy,
     * not the feature.
     *
     * `sync.push` is deliberately NOT gated by this key: it publishes
     * already-committed content to a remote the user configured for that
     * purpose, and it has its own `sync.push: false` / `--no-push` controls.
     */
    improveAutonomy: z.boolean().optional(),
    /**
     * The research learning controls, under the paths `improve.*` has for them. `strategies` is
     * `improve.strategies` (custom strategies, process `enabled`, `allowedTypes`, quality-gate toggles, reflect
     * `defectFilter`, extract triage and session indexing, triage `applyMode` and `judgment`, the CLS knobs and the
     * rest of a strategy); `qualityGate` is `improve.qualityGate` (where the judge runs). Each reads as the same key
     * under `improve`; when both are set to different values this one wins, with a warning.
     */
    learning: z
      .object({
        strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
        qualityGate: ImproveWhereSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
