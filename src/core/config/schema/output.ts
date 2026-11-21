// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `output` config section. Extracted verbatim from the former `config-schema.ts`
 * monolith — no behavior change.
 */
import { z } from "zod";
import { DETAIL_LEVELS, OUTPUT_FORMATS } from "../../../output/context";

// ── Output ──────────────────────────────────────────────────────────────────

export const OutputConfigSchema = z
  .object({
    // D7 — every `--format` value is a valid default. The retired `html` is dropped with a warning before validation.
    format: z.enum(OUTPUT_FORMATS).optional(),
    detail: z.enum(DETAIL_LEVELS).optional(),
  })
  .passthrough();
