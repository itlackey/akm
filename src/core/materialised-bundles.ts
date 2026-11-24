// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The directories a command was handed that no configured bundle holds (§4.3). `materialiseBundleDir`
 * (`bundle-at-dir.ts`) is the only function that adds one; this module only holds them, for `bundleFor` and the
 * lookup.
 *
 * They live as long as the process (one CLI run, or Desktop's server while it runs), and each is read against the
 * config of the caller that reads it: config is read first and never shadowed. A directory whose id or path that config
 * names, a disabled entry included, is dropped the first time a config naming it is read, so a config reloaded in a
 * long-lived process ends the stand-in of every directory it now configures.
 */

import fs from "node:fs";
import { safeRealpath } from "./common";
import type { AkmConfig } from "./config/config";
import { bundleAtDir } from "./config/config-sources";

export type BundleSource = { name: string; path: string; location?: string; adapterId?: string };

const held = new Map<string, BundleSource>();
/** The config `held` was last checked against: a config object is only replaced when the file is read again. */
let checkedAgainst: AkmConfig | undefined;

/** The held directories `config` names neither by id nor by path. */
function heldUnder(config: AkmConfig): Map<string, BundleSource> {
  if (config === checkedAgainst) return held;
  for (const [id, source] of held) {
    if (config.bundles?.[id] !== undefined || bundleAtDir(config, source.path) !== undefined) held.delete(id);
  }
  checkedAgainst = config;
  return held;
}

/** The materialised bundle `id` names, whether or not its directory is still there (a path a command only addresses). */
export function materialisedBundle(id: string, config: AkmConfig): BundleSource | undefined {
  return heldUnder(config).get(id);
}

/** Every materialised bundle whose directory is still there, in the order they were materialised. */
export function materialisedBundles(config: AkmConfig): BundleSource[] {
  // asset-io: user-input a directory a command was handed
  return [...heldUnder(config).values()].filter((source) => fs.existsSync(source.path));
}

/** The id the directory was materialised under, if any. */
export function materialisedIdOf(dir: string, config: AkmConfig): string | undefined {
  const real = safeRealpath(dir);
  for (const source of heldUnder(config).values()) if (safeRealpath(source.path) === real) return source.name;
  return undefined;
}

/** Whether `id` is taken by a directory other than `dir` that is still there (an id whose directory is gone is free). */
export function materialisedIdTaken(id: string, dir: string, config: AkmConfig): boolean {
  const holder = heldUnder(config).get(id);
  // asset-io: user-input a directory a command was handed
  return holder !== undefined && safeRealpath(holder.path) !== safeRealpath(dir) && fs.existsSync(holder.path);
}

/** Hold a directory `config` does not name (the caller checked). */
export function holdMaterialised(source: BundleSource, config: AkmConfig): void {
  heldUnder(config).set(source.name, source);
}

/** For tests: each starts with no materialised directory. */
export function _resetMaterialisedBundlesForTests(): void {
  held.clear();
  checkedAgainst = undefined;
}
