// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which installation owns the OS scheduler entry.
 *
 * The OS scheduler is one namespace per user, shared by every akm installation
 * and every sandbox on the machine. akm writes it for the user's default
 * installation only: the one whose locations come from HOME (and, on Windows,
 * the OS-set profile folders) alone. Any `AKM_*` location variable, or an XDG
 * variable that moves a location, makes an installation non-default; its
 * supervisor runs `akm task dispatch` itself.
 */

import { getCacheDir, getConfigDir, getDataDir, getStateDir } from "../core/paths";

const OS_SET_VARIABLES = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] as const;

/** The locations (config, data, cache, state, bundle) that `env` moves away from the HOME-only defaults. */
export function movedLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const home: NodeJS.ProcessEnv = {};
  for (const name of OS_SET_VARIABLES) if (env[name] !== undefined) home[name] = env[name];
  const moved: string[] = [];
  const locations = { config: getConfigDir, data: getDataDir, cache: getCacheDir, state: getStateDir } as const;
  for (const [name, resolve] of Object.entries(locations)) {
    try {
      if (resolve(env) !== resolve(home)) moved.push(name);
    } catch {
      // No home to resolve against: nothing default to compare with, and nothing moved it either.
    }
  }
  if (env.AKM_BUNDLE_DIR?.trim()) moved.push("bundle");
  return moved;
}
