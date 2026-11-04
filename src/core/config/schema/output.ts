// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `output` config section. Extracted verbatim from the former `config-schema.ts`
 * monolith — no behavior change.
 */
import { z } from "zod";

// ── Output ──────────────────────────────────────────────────────────────────

export const OutputConfigSchema = z
  .object({
    // D7 — every `--format` value is a valid default. Kept in step with OUTPUT_FORMATS
    // (`src/output/context.ts`). The retired `html` is dropped with a warning before validation.
    format: z.enum(["json", "yaml", "text", "jsonl", "md"]).optional(),
    detail: z.enum(["brief", "normal", "full"]).optional(),
  })
  .passthrough();
