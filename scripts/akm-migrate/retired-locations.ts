// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` is the one reader of the retired `AKM_BUNDLE_DIR`: how `apply` learns which bundle an installation
 * that used it worked in. akm itself no longer reads it (and refuses to start when it names a bundle other than the
 * one akm resolves without it, see `src/core/paths.ts`), so this runs first and moves it out of the environment: it
 * becomes the working bundle this run registers as `defaultBundle` when the file does not already name it as its
 * default (see `registerWorkingBundle`). `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR` and `AKM_CACHE_DIR` are
 * ordinary overrides and need no carrying over.
 */

import path from "node:path";
import { RETIRED_BUNDLE_VARIABLE } from "../../src/core/paths";

/** What the host must change in its own environment: the plan says it. */
export interface RetiredEnvironment {
  /** The retired variables that were set. */
  readonly unset: string[];
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
  const value = env[RETIRED_BUNDLE_VARIABLE]?.trim();
  delete env[RETIRED_BUNDLE_VARIABLE];
  carriedBundle = value ? path.resolve(value) : undefined;
  carriedEnvironment = value ? { unset: [RETIRED_BUNDLE_VARIABLE] } : undefined;
}
