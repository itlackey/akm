// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  getCacheDir,
  getConfigDir,
  getConfigPath,
  getDataDir,
  getStateDir,
  withoutLauncherVars,
} from "../../core/paths";

/**
 * What `env run --clean` / `secret run --clean` keeps of the parent environment. The user typed
 * the flag to get a minimal one; without the last eight names Windows cannot create the process.
 */
const CLEAN_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
  "NO_COLOR",
  "COLORTERM",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

export interface ChildEnvOptions {
  clean: boolean;
  inherit: string[];
}

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: ChildEnvOptions,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = options.clean ? {} : { ...withoutLauncherVars(parentEnv) };

  if (options.clean) {
    for (const key of CLEAN_ENV_ALLOWLIST) {
      if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
    }
    // The child that runs `akm` must find this installation: its config file and the directories this process resolved.
    base.AKM_CONFIG_FILE = getConfigPath();
    base.AKM_CONFIG_DIR = getConfigDir();
    base.AKM_DATA_DIR = getDataDir();
    base.AKM_CACHE_DIR = getCacheDir();
    base.AKM_STATE_DIR = getStateDir();
  }

  for (const key of options.inherit) {
    if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
  }

  return base;
}

/** The child environment for `--clean` and `--inherit <VAR,...>`; `--inherit` alone starts clean. */
export function childEnvFromFlags(
  parentEnv: NodeJS.ProcessEnv,
  flags: { clean: boolean; inherit: string | undefined },
): Record<string, string | undefined> {
  const inherit = (flags.inherit ?? "").split(/[,\s]+/).filter(Boolean);
  return buildChildEnv(parentEnv, { clean: flags.clean || flags.inherit !== undefined, inherit });
}
