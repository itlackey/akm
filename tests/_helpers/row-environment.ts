// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";

/**
 * The environment a scheduler row written from an isolated sandbox sets inline: the working stash, and the config,
 * data, cache and state directories the sandbox's `XDG_*_HOME` variables put somewhere other than the default.
 */
export function sandboxRowEnvironment(stashDir: string): Record<string, string> {
  const xdg = (name: string): string => path.join(process.env[name] as string, "akm");
  return {
    AKM_BUNDLE_DIR: path.resolve(stashDir),
    AKM_CONFIG_DIR: xdg("XDG_CONFIG_HOME"),
    AKM_DATA_DIR: xdg("XDG_DATA_HOME"),
    AKM_CACHE_DIR: xdg("XDG_CACHE_HOME"),
    AKM_STATE_DIR: xdg("XDG_STATE_HOME"),
  };
}

/** {@link sandboxRowEnvironment} as a cron row writes it inline: `NAME=value NAME=value`. */
export function sandboxRowEnvironmentInline(stashDir: string): string {
  return Object.entries(sandboxRowEnvironment(stashDir))
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}
