// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The key `state.db` rows are filed under for a directory (§0.2 P8), and the source a directory is addressed as.
 *
 * The bundle at a directory is `bundleAtDir` (config-sources.ts), the one root-to-bundle lookup. A directory no
 * configured bundle has keeps its path as its key (a named exception to "ids are names": base filed rows by path, and a
 * bundle configured later at that directory takes them, which a derived id could not). The rows of an unconfigured
 * directory are rewritten to the bundle's id when a bundle is configured at it (`convertPathBundleIds`).
 */

import path from "node:path";
import { detectBundleAdapter } from "./assets/gate";
import { bundleIdForDir } from "./bundle-id";
import { type AkmConfig, loadConfig } from "./config/config";
import { bundleAtDir } from "./config/config-sources";

/** The key rows for the bundle at `dir` are filed under: its id, else (no configured bundle) the directory's own path. */
export function bundleKeyForDir(config: AkmConfig, dir: string): string {
  return bundleAtDir(config, dir) ?? path.resolve(dir);
}

/**
 * The bundle at `dir` as a source an asset is addressed in: the configured bundle's id and adapter, else (a directory no
 * configured bundle has) its derived id and the adapter its root's probe finds.
 */
export function bundleSourceAt(
  dir: string,
  config: AkmConfig = loadConfig(),
): { name: string; path: string; adapterId: string } {
  const id = bundleAtDir(config, dir);
  const configured = id === undefined ? undefined : config.bundles?.[id];
  return {
    name: id ?? bundleIdForDir(dir, new Set(Object.keys(config.bundles ?? {}))),
    path: dir,
    adapterId: configured?.adapter ?? detectBundleAdapter(dir),
  };
}

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
