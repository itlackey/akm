// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where the user's OpenCode keeps its files: the XDG base directories on every
 * platform (OpenCode's own `global-roots` does not special-case macOS or
 * Windows), each with an `opencode` folder. The one place akm computes them.
 */

import os from "node:os";
import path from "node:path";

function xdgRoot(name: string, fallback: readonly string[], env: NodeJS.ProcessEnv): string {
  const set = env[name]?.trim();
  if (set) return path.join(set, "opencode");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ...fallback, "opencode");
}

/** `$XDG_DATA_HOME/opencode`: the user's `opencode.db` and logins. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return xdgRoot("XDG_DATA_HOME", [".local", "share"], env);
}

/** `$XDG_CACHE_HOME/opencode`: the plugin packages it installed. */
export function opencodeCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return xdgRoot("XDG_CACHE_HOME", [".cache"], env);
}

/** `$XDG_CONFIG_HOME/opencode`: `opencode.json`, agents and plugins. */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return xdgRoot("XDG_CONFIG_HOME", [".config"], env);
}
