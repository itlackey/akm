// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** An asset as the facade hands it out: its identity and the entry that holds it. */

import type { SearchSource } from "../../indexer/search/search-source";
import type { AssetEntry, BundleAsset } from "../adapter/bundle-adapter";
import { makeBundleRef } from "../asset/asset-ref";

/** One asset, found in its bundle. */
export interface Asset {
  /** The id of the bundle that holds it. */
  readonly bundle: string;
  readonly conceptId: string;
  /** `<bundle>//<conceptId>`. */
  readonly ref: string;
  /** `entry.file`, `entry.content()`, `entry.bytes()`, `entry.frontmatter()`. The asset's type is the index's: `assetType`. */
  readonly entry: AssetEntry;
}

/** Where each asset was found, for `assetType` to index it on a miss. Not part of the asset: no caller gets a root. */
const sourceOfAsset = new WeakMap<Asset, SearchSource>();

export function assetOf(bundle: string, source: SearchSource, found: BundleAsset): Asset {
  const asset: Asset = {
    bundle,
    conceptId: found.conceptId,
    ref: makeBundleRef(bundle, found.conceptId),
    entry: found.entry,
  };
  sourceOfAsset.set(asset, source);
  return asset;
}

/** The source that holds `asset`, as it was found. */
export function sourceOf(asset: Asset): SearchSource {
  const source = sourceOfAsset.get(asset);
  if (!source) throw new Error(`Asset "${asset.ref}" was not found through the asset facade.`);
  return source;
}
