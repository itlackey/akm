// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  getCacheDir,
  getConfigDir,
  getDataDir,
  getDbPath,
  getDefaultStashDir,
  getLockfileLockPath,
  getLockfilePath,
  getWorkflowDbPath,
} from "../core/paths";
import { getStateDbPath } from "../core/state-db";

/**
 * Single source of truth for "where akm stores things".
 *
 * Every field is an absolute on-disk path resolved from the existing
 * {@link ../core/paths} (and {@link ../core/state-db}) getters. This object is a
 * thin facade: it changes NO resolution logic and introduces NO new storage
 * locations — it only gathers the scattered path getters behind one typed seam
 * so that future moves (e.g. the XDG relocation in #489) touch one module
 * instead of every call-site.
 */
export interface StorageLocations {
  /** The index database file (`<dataDir>/index.db`). */
  readonly indexDb: string;
  /** The state database file (`<dataDir>/state.db`). */
  readonly stateDb: string;
  /** The workflow database file (`<dataDir>/workflow.db`). */
  readonly workflowDb: string;
  /** The advisory lockfile (`<dataDir>/akm.lock`). */
  readonly lockfile: string;
  /** The lockfile write-sentinel (`<dataDir>/akm.lock.lck`). */
  readonly lockfileSentinel: string;
  /** The data directory root (`AKM_DATA_DIR` / `XDG_DATA_HOME` aware). */
  readonly dataDir: string;
  /** The cache directory root. */
  readonly cacheDir: string;
  /** The config directory root. */
  readonly configDir: string;
  /** The default stash directory. */
  readonly stashDir: string;
}

/**
 * Resolve the current {@link StorageLocations} by delegating to the existing
 * path getters. Resolution honours the same environment overrides
 * (`AKM_DATA_DIR`, XDG variables, transient-stash isolation) as the underlying
 * getters, so this is safe to call at boot or per-operation — it carries no
 * cached state of its own.
 */
export function resolveStorageLocations(): StorageLocations {
  return {
    indexDb: getDbPath(),
    stateDb: getStateDbPath(),
    workflowDb: getWorkflowDbPath(),
    lockfile: getLockfilePath(),
    lockfileSentinel: getLockfileLockPath(),
    dataDir: getDataDir(),
    cacheDir: getCacheDir(),
    configDir: getConfigDir(),
    stashDir: getDefaultStashDir(),
  };
}
