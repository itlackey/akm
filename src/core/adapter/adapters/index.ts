// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in `BundleAdapter` barrel — akm 0.9.0 chunk-2, WI-A.
 *
 * `registerBuiltinAdapters()` registers the concrete adapters onto the
 * `../registry` singleton. ADDITIVE: not called from any production
 * composition root yet (Chunk 3 wires it in when it repoints consumers off the
 * legacy globals). Later work-items add their adapters to the body of this
 * function the same way.
 */

import { registerAdapter } from "../registry";
import { akmAdapter } from "./akm-adapter";
import { llmWikiAdapter } from "./llm-wiki-adapter";
import { okfAdapter } from "./okf-adapter";

export { akmAdapter } from "./akm-adapter";
export { llmWikiAdapter } from "./llm-wiki-adapter";
export { okfAdapter } from "./okf-adapter";

/**
 * Register every built-in adapter onto the shared registry (idempotent —
 * re-registering an id replaces in place).
 *
 * `llm-wiki` is registered BEFORE `okf` so the §1.2 ordered probe prefers the
 * more-specific wiki probe (schema.md + pages/) over okf's loose root-`index.md`
 * probe — an LLM Wiki root also carries a root `index.md`, so the two probes
 * legitimately overlap and order (specific-first) resolves it.
 */
export function registerBuiltinAdapters(): void {
  registerAdapter(llmWikiAdapter);
  registerAdapter(okfAdapter);
  registerAdapter(akmAdapter);
}
