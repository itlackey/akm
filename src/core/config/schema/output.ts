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
    // D7 — every `--format` value is a valid default, not just the three that
    // predated universal md/html rendering. Kept in step with OUTPUT_FORMATS
    // (`src/output/context.ts`).
    format: z.enum(["json", "yaml", "text", "jsonl", "md", "html"]).optional(),
    detail: z.enum(["brief", "normal", "full"]).optional(),
  })
  .passthrough();
