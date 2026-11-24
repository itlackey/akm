// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The directories a command was handed that no configured bundle is at (§4.3). `materialiseBundleDir`
 * (`bundle-at-dir.ts`) is the only function that adds one; this module only holds them, for `bundleFor` and the
 * lookup. The implicit working bundle and `AKM_BUNDLE_DIR` are never here, and a configured bundle only while the
 * configured sources cannot be resolved as a set: config and the sources it resolves to are read first, so nothing here
 * shadows them.
 */

import fs from "node:fs";
import { safeRealpath } from "./common";

export type BundleSource = { name: string; path: string; location?: string; adapterId?: string };

const held = new Map<string, BundleSource>();

/** The materialised bundle `id` names, whether or not its directory is still there (a path a command only addresses). */
export function materialisedBundle(id: string): BundleSource | undefined {
  return held.get(id);
}

/** Every materialised bundle whose directory is still there, in the order they were materialised. */
export function materialisedBundles(): BundleSource[] {
  // asset-io: user-input a directory a command was handed
  return [...held.values()].filter((source) => fs.existsSync(source.path));
}

/** The id the directory was materialised under, if any. */
export function materialisedIdOf(dir: string): string | undefined {
  const real = safeRealpath(dir);
  for (const source of held.values()) if (safeRealpath(source.path) === real) return source.name;
  return undefined;
}

/** Whether `id` is taken by a directory other than `dir` that is still there (an id whose directory is gone is free). */
export function materialisedIdTaken(id: string, dir: string): boolean {
  const holder = held.get(id);
  // asset-io: user-input a directory a command was handed
  return holder !== undefined && safeRealpath(holder.path) !== safeRealpath(dir) && fs.existsSync(holder.path);
}

export function holdMaterialised(source: BundleSource): void {
  held.set(source.name, source);
}

/** For tests: each starts with no materialised directory. */
export function _resetMaterialisedBundlesForTests(): void {
  held.clear();
}
