// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A bundle as the asset facade sees it: its adapter, and the bundle value the adapter is called with. The one
 * mapping from a source or write target to its adapter; nothing outside `src/core/adapter/` and `src/core/assets/`
 * asks the registry for one.
 */

import type { BundleAdapter } from "../adapter/bundle-adapter";
import { adapterIdOf } from "../adapter/detect-adapter";
import { bundleOf, requireAdapter } from "../adapter/registry";
import type { Bundle } from "../adapter/types";
import { UsageError } from "../errors";

export interface AssetBundle {
  readonly adapter: BundleAdapter;
  /** What every adapter member is called with; `bundle.id` is the id refs use. */
  readonly bundle: Bundle;
}

/** The adapter and bundle of a source: the adapter it is configured with, else the one its root's probe finds. */
export function assetBundleOf(source: {
  name: string;
  path: string;
  location?: string;
  adapterId?: string;
}): AssetBundle {
  return { adapter: requireAdapter(source.name, adapterIdOf(source)), bundle: bundleOf(source) };
}

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(
  source: { name: string; path: string; location?: string; adapterId?: string },
  type?: string,
): void {
  const { adapter } = assetBundleOf(source);
  const { writes } = adapter;
  if (writes.length > 0 && (type === undefined || writes.includes(type))) return;
  throw new UsageError(
    writes.length === 0
      ? `Bundle "${source.name}" uses adapter "${adapter.id}", which does not support AKM asset writes.`
      : `Bundle "${source.name}" uses adapter "${adapter.id}", which does not write ${type} assets.`,
    "INVALID_FLAG_VALUE",
  );
}
