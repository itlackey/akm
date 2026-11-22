// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup-derived recommendations (`setup`). Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";

// ── Setup-derived recommendations ──────────────────────────────────────────
//
// The `setup` namespace is kept (passthrough) for setup-derived config; it
// has no defined keys.
export const SetupConfigSchema = z.object({}).passthrough();
