// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";

/**
 * Shared subprocess wrapper for `git` invocations. Disables git's interactive
 * terminal prompt so a missing credential never hangs the process.
 */
export function runGit(
  args: string[],
  options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    encoding: "utf8",
    ...options,
    env: { ...process.env, ...options?.env, GIT_TERMINAL_PROMPT: "0" },
  });
}
