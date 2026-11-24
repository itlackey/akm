// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** An asset as the facade hands it out: its identity and the entry that holds it. */

import type { AssetEntry, BundleAsset } from "../adapter/bundle-adapter";
import { withoutTypeHead } from "../asset/asset-placement";
import { heldAssetRef } from "../asset/asset-ref";
import { warnOnce } from "../warn";
import type { AssetBundle } from "./bundle";

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

/** The bundle each asset was found in, for `assetType` to index it on a miss. Not part of the asset: no caller gets a root. */
const bundleOfAsset = new WeakMap<Asset, AssetBundle>();

export function assetOf(bundle: AssetBundle, found: BundleAsset): Asset {
  const asset: Asset = {
    bundle: bundle.name,
    conceptId: found.conceptId,
    ref: heldAssetRef(bundle.name, found.conceptId),
    entry: found.entry,
  };
  bundleOfAsset.set(asset, bundle);
  return asset;
}

/** The bundle that holds `asset`, as it was found. */
export function bundleHolding(asset: Asset): AssetBundle {
  const bundle = bundleOfAsset.get(asset);
  if (!bundle) throw new Error(`Asset "${asset.ref}" was not found through the asset facade.`);
  return bundle;
}

/** The asset `conceptId` names in one bundle, as its adapter reads it, with no other spelling tried. */
export function readExact(bundle: AssetBundle, conceptId: string): Asset | undefined {
  const found = bundle.read(conceptId);
  return found ? assetOf(bundle, found) : undefined;
}

/**
 * Releases before path refs prefixed a loose file's ref with its type folder (`knowledge/reports/x` for
 * `reports/x.md`), and that spelling is still in links, memories, scripts and stored proposals. A ref nothing holds is
 * read once more without that head and the asset comes back under its current ref. Whatever adapter holds the bundle:
 * the spelling is akm's, not the format's. Only `qualifyRef` (the input boundary) warns, once, for a ref the user typed.
 */
export function readOutdated(
  conceptId: string,
  read: (conceptId: string) => Asset | undefined,
  warnUser = false,
): Asset | undefined {
  const current = withoutTypeHead(conceptId);
  const found = current === undefined ? undefined : read(current);
  if (found && warnUser) {
    warnOnce(
      `outdated-ref:${conceptId}`,
      `Ref "${conceptId}" is outdated: refs are the path inside the bundle, so it is now "${found.conceptId}". Resolved it to that asset.`,
    );
  }
  return found;
}

/** The asset `conceptId` names in a bundle already held (an outdated spelling of it too): `readAsset` without the id. */
export function readFrom(held: AssetBundle, conceptId: string): Asset | undefined {
  return readExact(held, conceptId) ?? readOutdated(conceptId, (current) => readExact(held, current));
}
