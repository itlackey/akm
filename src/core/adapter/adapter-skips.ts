// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a bundle's adapter skips (#908): top-level directories that hold files the `akm` adapter, the format-neutral
 * superset, would have held as assets. Auto-detection corrects this for a mixed layout (it detects as `akm`); this
 * covers what detection cannot see, an explicitly configured narrow adapter (`adapter: "agent-skills"`, say) sitting
 * next to ordinary akm content. `akm doctor` and `akm bundle add` report it, where adapters are compared.
 */

import { assetBundleOf } from "../assets/bundle";
import { adapterIdOf } from "./detect-adapter";

export interface AdapterSkip {
  adapter: string;
  count: number;
  dirs: string[];
}

type SkipSource = { name: string; path: string; location?: string; adapterId?: string };

/** What the adapter of `source` skips, or undefined: no skip, an incomplete listing, or a bundle that is no directory. */
export function adapterSkipOf(source: SkipSource): AdapterSkip | undefined {
  // A bundle a secret manager keeps is no directory: there is nothing akm could read in it.
  const adapter = adapterIdOf(source);
  if (adapter === "akm" || source.location !== undefined) return undefined;
  const chosen = assetBundleOf({ ...source, adapterId: adapter }).list();
  if (!chosen.complete) return undefined;

  // A top-level directory the chosen adapter holds no asset in, where akm would hold some: the chosen adapter skips it.
  const topDirOf = (relPath: string): string | undefined => (relPath.includes("/") ? relPath.split("/")[0] : undefined);
  const owned = new Set(chosen.assets.map(({ entry }) => topDirOf(entry.relPath)));
  const skipped = new Map<string, number>();
  for (const { entry } of assetBundleOf({ ...source, adapterId: "akm" }).list().assets) {
    const top = topDirOf(entry.relPath);
    if (top !== undefined && !owned.has(top)) skipped.set(top, (skipped.get(top) ?? 0) + 1);
  }
  const count = [...skipped.values()].reduce((sum, n) => sum + n, 0);
  return count === 0 ? undefined : { adapter, count, dirs: [...skipped.keys()].sort() };
}

export function adapterSkipMessage(bundle: string, { adapter, count, dirs }: AdapterSkip): string {
  return (
    `bundle "${bundle}": ${adapter} adapter skipped ${count} file${count === 1 ? "" : "s"} in ` +
    `${dirs.map((dir) => `${dir}/`).join(", ")} — set bundles.${bundle}.adapter to "akm" to index them`
  );
}
