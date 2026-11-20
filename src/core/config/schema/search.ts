// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `search` config section: default type exclusion. */
import { z } from "zod";
import { nonEmptyString } from "./primitives";

// ── Search ──────────────────────────────────────────────────────────────────

export const SearchConfigSchema = z
  .object({
    defaultExcludeTypes: z.array(nonEmptyString).optional(),
  })
  .passthrough();

/** Types left out of an untyped search unless asked for: the configured list, `["session"]` when the config sets none (an empty list leaves nothing out). */
export function defaultExcludedTypes(config: { search?: { defaultExcludeTypes?: string[] } }): string[] {
  return config.search?.defaultExcludeTypes ?? ["session"];
}
