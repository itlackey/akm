// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup-derived recommendations (`setup`). Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";

// ── Setup-derived recommendations ──────────────────────────────────────────

/**
 * Cron-style schedule hints derived by `akm setup --reset-recommended`.
 *
 * These record the *recommended* cadence for the improve and index background
 * tasks. They are advisory metadata persisted into config so the value
 * survives a re-run; actual task scheduling lives in the tasks subsystem.
 */
export const SetupTaskSchedulesSchema = z
  .object({
    improve: z.string().min(1).optional(),
    index: z.string().min(1).optional(),
  })
  .passthrough();

export const SetupConfigSchema = z
  .object({
    taskSchedules: SetupTaskSchedulesSchema.optional(),
  })
  .passthrough();
