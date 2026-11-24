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
import { holdMaterialised, materialisedBundles, materialisedIdOf, materialisedIdTaken } from "./materialised-bundles";

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
 * The id of the bundle at `dir`, for the facade, which takes bundle ids (`bundleFor`). The one function that makes a
 * directory addressable by an id; a command calls it where it holds a directory it was handed, once per directory (a
 * repeat answers the same id). Config is read first and never shadowed:
 *  - `as.name` (a name a stored record gave the directory) naming a configured bundle is that bundle;
 *  - a configured bundle at `dir`, enabled or not, is that bundle;
 *  - any other directory (a `--dir`, the implicit working bundle, `AKM_BUNDLE_DIR`) is materialised, in memory only,
 *    under `as.name`, else `bundleIdForDir`: its basename slug, or `<slug>-<8-hex of the path>` when a configured
 *    bundle or another directory that is still there has that id. A materialised directory takes the id of the implicit
 *    working bundle (which is one too); it never takes a configured bundle's.
 */
export function materialiseBundleDir(
  dir: string,
  config: AkmConfig = loadConfig(),
  as: { name?: string; adapterId?: string } = {},
): string {
  const configuredNames = Object.keys(config.bundles ?? {});
  const configured = as.name !== undefined && configuredNames.includes(as.name) ? as.name : bundleAtDir(config, dir);
  if (configured !== undefined) return configured;
  const existing = materialisedIdOf(dir, config);
  if (existing !== undefined) return existing;
  const taken = new Set([...configuredNames, ...materialisedBundles(config).map((held) => held.name)]);
  let id = as.name ?? bundleIdForDir(dir, taken);
  if (materialisedIdTaken(id, dir, config)) id = bundleIdForDir(dir, new Set([...taken, id]));
  holdMaterialised({ name: id, path: dir, adapterId: as.adapterId ?? detectBundleAdapter(dir) }, config);
  return id;
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
