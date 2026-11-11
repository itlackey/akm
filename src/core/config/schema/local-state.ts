// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `usage` config section: how akm treats its own local data. Read before the
 * config load, from the file itself (see `./peek.ts`).
 */
import { z } from "zod";

/** `usage.capture`: record local-only CLI usage counts in `metrics.db`. Default `true`. */
export const UsageConfigSchema = z
  .object({
    capture: z.boolean().optional(),
  })
  .passthrough();
