// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` is the one reader of the retired location variables: how `apply` learns where an installation that
 * used them keeps its config, data, state and cache, and which bundle it worked in. akm itself no longer reads them (and refuses to start with one
 * set, see `src/core/paths.ts`), so this runs first and moves them out of the environment:
 *
 *   - `AKM_CONFIG_DIR` becomes `AKM_CONFIG_FILE=<dir>/config.json`, so the migrator finds the file the host used;
 *   - `AKM_DATA_DIR`, `AKM_STATE_DIR` and `AKM_CACHE_DIR` become the locations this run uses and `apply` writes into
 *     the file's `paths` (see `registerEnvironmentPaths`);
 *   - `AKM_BUNDLE_DIR` becomes the working bundle this run registers as `defaultBundle` when the file does not already
 *     name it as its default (see `registerWorkingBundle`).
 */

import path from "node:path";
import { carryLocations, RETIRED_BUNDLE_VARIABLE, RETIRED_LOCATION_VARIABLES } from "../../src/core/paths";

/** What the host must change in its own environment once the file names its locations: the plan says it. */
export interface RetiredEnvironment {
  /** The retired variables that were set (`AKM_BUNDLE_DIR` among them). */
  readonly unset: string[];
  /** `AKM_CONFIG_FILE`, when `AKM_CONFIG_DIR` was what located the file. */
  readonly set?: { readonly AKM_CONFIG_FILE: string };
}

let carriedEnvironment: RetiredEnvironment | undefined;
let carriedBundle: string | undefined;

/** The directory `AKM_BUNDLE_DIR` named, absolute, once {@link carryOverRetiredLocations} has run. */
export function carriedBundleDir(): string | undefined {
  return carriedBundle;
}

export function retiredEnvironment(): RetiredEnvironment | undefined {
  return carriedEnvironment;
}

export function carryOverRetiredLocations(env: NodeJS.ProcessEnv = process.env): void {
  const unset: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    delete env[name];
    if (value) unset.push(name);
    return value ? path.resolve(value) : undefined;
  };
  const configDir = read(RETIRED_LOCATION_VARIABLES.config);
  const carried = {
    data: read(RETIRED_LOCATION_VARIABLES.data),
    state: read(RETIRED_LOCATION_VARIABLES.state),
    cache: read(RETIRED_LOCATION_VARIABLES.cache),
  };
  carriedBundle = read(RETIRED_BUNDLE_VARIABLE);
  let configFile: string | undefined;
  if (configDir && !env.AKM_CONFIG_FILE?.trim()) {
    configFile = path.join(configDir, "config.json");
    env.AKM_CONFIG_FILE = configFile;
  }
  carriedEnvironment = unset.length > 0 ? { unset, ...(configFile ? { set: { AKM_CONFIG_FILE: configFile } } : {}) } : undefined;
  carryLocations(Object.fromEntries(Object.entries(carried).filter(([, value]) => value !== undefined)));
}
