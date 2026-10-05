// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `feedback` config section. The retired `allowedFailureModes` key (it went
 * with `akm feedback --failure-mode`) is tolerated as an unknown key.
 */
import { z } from "zod";

// ── Feedback ────────────────────────────────────────────────────────────────

export const FeedbackConfigSchema = z
  .object({
    requireReason: z.boolean().optional(),
  })
  .passthrough();
