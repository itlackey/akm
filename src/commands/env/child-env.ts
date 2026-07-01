// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
] as const;

export interface ChildEnvOptions {
  clean: boolean;
  inherit: string[];
}

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: ChildEnvOptions,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = options.clean ? {} : { ...parentEnv };

  if (options.clean) {
    for (const key of CLEAN_ENV_ALLOWLIST) {
      if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
    }
  }

  for (const key of options.inherit) {
    if (parentEnv[key] !== undefined) base[key] = parentEnv[key];
  }

  return base;
}
