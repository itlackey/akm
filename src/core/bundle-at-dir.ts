// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which configured bundle a directory is, and the key `state.db` rows are filed under for it (§0.2 P8).
 *
 * A bundle is found by its resolved root, the one `resolveSourceEntries` gives every kind of bundle: a directory, a git
 * or npm checkout (the lock's root), a location bundle's synthetic root. A directory no configured bundle has keeps
 * its path as its key, as `state.db` always filed it: nothing is shared between two unconfigured directories, and a
 * bundle configured later at a different directory does not take the rows. The rows of an unconfigured directory are
 * rewritten to the bundle's id when a bundle is configured at it (`convertPathBundleIds`).
 */

import path from "node:path";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { safeRealpath } from "./common";
import { type AkmConfig, loadConfig } from "./config/config";
import { rethrowIfTestIsolationError } from "./errors";
import { registerBundleAtDir } from "./state-db";

const rootsOf = new WeakMap<AkmConfig, ReadonlyMap<string, string>>();

/** Real root -> bundle id for every configured bundle, the default first, then in configured order (the first on a root wins). Once per config. */
function configuredRoots(config: AkmConfig): ReadonlyMap<string, string> {
  const known = rootsOf.get(config);
  if (known) return known;
  const roots = new Map<string, string>();
  try {
    for (const source of resolveSourceEntries(undefined, config)) {
      const id = source.registryId;
      if (id === undefined || config.bundles?.[id] === undefined) continue;
      const root = safeRealpath(source.path);
      if (!roots.has(root)) roots.set(root, id);
    }
  } catch (error) {
    // A config whose sources cannot be resolved (a disabled working bundle) names no bundle by directory.
    rethrowIfTestIsolationError(error);
  }
  rootsOf.set(config, roots);
  return roots;
}

/** The configured bundle whose resolved root is `dir`, if there is one. */
export function bundleAtDir(config: AkmConfig, dir: string): string | undefined {
  return configuredRoots(config).get(safeRealpath(dir));
}

/** The key rows for the bundle at `dir` are filed under: its id, else (no configured bundle) the directory's own path. */
export function bundleKeyForDir(config: AkmConfig, dir: string): string {
  return bundleAtDir(config, dir) ?? path.resolve(dir);
}

registerBundleAtDir(bundleAtDir);

/**
 * The `bundle_id` state rows (proposals, improve runs, the improve ledger) are filed under for the bundle at `dir`:
 * its id, so rows follow a bundle by its name and not by where its directory is (§0.2 P8); the directory's own path
 * when no configured bundle is there. A command that has the bundle's directory (the working stash, `--dir`) asks
 * here, with the config it holds (the loaded one by default: `--config` sets the file `loadConfig` reads); everything
 * below takes the key.
 */
export function stateBundleId(dir: string, config: AkmConfig = loadConfig()): string {
  return bundleKeyForDir(config, dir);
}
