// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode config content of akm's internal runtime: only the switch that
 * turns off OpenCode's own `opencode` provider (its free models, present in the
 * model snapshot even when nothing is fetched), so the runtime runs on the
 * connections its runs bring (`./runner-models.ts`) or on nothing. The key and
 * the request fields of a call differ per session and are laid over each
 * session's requests by the akm plugin (`./plugin.ts`).
 */

export function runtimeConfigContent(): Record<string, unknown> {
  return { disabled_providers: ["opencode"] };
}
