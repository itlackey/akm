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
import { getDataDir } from "../../../core/paths";

function xdgRoot(name: string, fallback: readonly string[], env: NodeJS.ProcessEnv): string {
  const set = env[name]?.trim();
  if (set) return path.join(set, "opencode");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ...fallback, "opencode");
}

/** `$XDG_DATA_HOME/opencode`: the user's `opencode.db`. */
function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return xdgRoot("XDG_DATA_HOME", [".local", "share"], env);
}

/** `$XDG_CACHE_HOME/opencode`: the plugin packages it installed. */
export function opencodeCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return xdgRoot("XDG_CACHE_HOME", [".cache"], env);
}

/** `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`: `opencode.json`, agents and plugins. */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_CONFIG_DIR?.trim() || xdgRoot("XDG_CONFIG_HOME", [".config"], env);
}

/** OpenCode's SQLite session store, in OpenCode's data directory and in akm's. */
export function databaseIn(directory: string): string {
  return path.join(directory, "opencode.db");
}

/**
 * Everything akm's own OpenCode runtime keeps, under akm's data directory: the
 * four XDG roots it is started with (`config`, `data`, `cache`, `state`) and its
 * `tmp`. Nothing of the user's OpenCode is in it.
 */
export function akmRuntimeDir(): string {
  return path.join(getDataDir(), "opencode-runtime");
}

/** The user's OpenCode database. */
export function opencodeDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return databaseIn(opencodeDataDir(env));
}

/** Where akm's own runtime keeps its sessions: the `opencode/opencode.db` OpenCode makes under the runtime's `XDG_DATA_HOME`. */
export function akmOpencodeDatabasePath(): string {
  return databaseIn(path.join(akmRuntimeDir(), "data", "opencode"));
}
