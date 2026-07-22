// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `search` config section (graph-boost tuning). Extracted verbatim from the
 * former `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { nonEmptyString, nonNegativeNumber, positiveInt } from "./primitives";

// ── Search ──────────────────────────────────────────────────────────────────

const SearchGraphBoostSchema = z
  .object({
    directBoostPerEntity: nonNegativeNumber.optional(),
    directBoostCap: nonNegativeNumber.optional(),
    hopBoostPerEntity: nonNegativeNumber.optional(),
    hopBoostCap: nonNegativeNumber.optional(),
    /** Hard-capped at 3; values > 3 hard-error so users see the typo. */
    maxHops: positiveInt.max(3).optional(),
    confidenceMode: z.enum(["off", "blend", "multiply"]).default("blend").optional(),
    /** Range [0, 1]; values > 1 hard-error (no silent clamp). */
    confidenceWeight: z.number().finite().min(0).max(1).default(0.2).optional(),
  })
  .passthrough();

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    defaultExcludeTypes: z.array(nonEmptyString).optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
  })
  .passthrough();
