// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Barrel + registration helper for the concrete adapters under
 * `src/core/adapter/adapters/` — akm 0.9.0 chunk-2, WI-2.1 (skill/wiki/
 * script) + WI-2.2 (workflow/task).
 *
 * Mirrors `matchers.ts#registerBuiltinMatchers` / `output/renderers.ts
 * #registerBuiltinRenderers`'s "one function registers everything this
 * module owns" shape, applied to `registry.ts#registerAdapter` instead.
 *
 * NOT called from any production entry point yet (`src/cli.ts`,
 * `src/indexer/init.ts`) — additive only, per the chunk-2 brief ("The
 * adapters must not be wired into the production path yet"). Chunk 3 is
 * where a caller (analogous to `ensureBuiltinsRegistered`) invokes this.
 * Exercised today only by this chunk's own tests
 * (`tests/core/adapter/registry.test.ts`).
 *
 * Later WIs (2.3 dotenv, 2.4 the markdown family, 2.5 skill's §4.5
 * contract) extend `BUILTIN_ADAPTERS`/`registerBuiltinAdapters` the same way
 * WI-2.1/2.2 did: add the adapter's own file under this directory, import
 * it here, add one `registerAdapter(...)` call (with an explicit `types`
 * array for any multi-type adapter — see `registry.ts`'s header for why).
 */

import { registerAdapter } from "../registry";
import { scriptAdapter } from "./script-adapter";
import { skillAdapter } from "./skill-adapter";
import { taskAdapter } from "./task-adapter";
import { wikiAdapter } from "./wiki-adapter";
import { workflowAdapter } from "./workflow-adapter";

export { scriptAdapter, skillAdapter, taskAdapter, wikiAdapter, workflowAdapter };

/** The adapters minted so far (WI-2.1 + WI-2.2), in a stable order. */
export const BUILTIN_ADAPTERS = [skillAdapter, wikiAdapter, scriptAdapter, workflowAdapter, taskAdapter] as const;

/** Register every built-in adapter this module owns with `registry.ts`'s singleton. Idempotent (re-registering an id replaces it in place). */
export function registerBuiltinAdapters(): void {
  registerAdapter(skillAdapter); // types defaults to ["skill"]
  registerAdapter(wikiAdapter); // types defaults to ["wiki"]
  registerAdapter(scriptAdapter); // types defaults to ["script"]
  registerAdapter(workflowAdapter); // types defaults to ["workflow"]
  registerAdapter(taskAdapter); // types defaults to ["task"]
}
