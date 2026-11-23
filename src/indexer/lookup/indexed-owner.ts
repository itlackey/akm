// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How an asset the facade found relates to the index: the path the index keys it under, whether an indexed row is
 * that asset's, and the row the asset's adapter gives without the index.
 */

import path from "node:path";
import type { Asset } from "../../core/assets/read";
import { indexAsset, indexedPathOf } from "../../core/assets/type";
import { safeRealpath } from "../../core/common";
import type { IndexEntry } from "../indexer";
import { deriveEntryProvenance } from "../installations";
import type { SearchSource } from "../search/search-source";

/**
 * The index entry of an asset whose bundle has no row for it (a file added outside akm): the asset's adapter recognizes
 * it once and, with `persist`, the row is recorded, so the next ask finds it in the index. Undefined when the adapter
 * does not recognize it. A row another ref holds for the file stays (nested bundles share files). Without `persist` (a read-only lookup) the entry is served and the index left as it is; it has
 * no links, usage or indexed fragments.
 */
export function entryOnMiss(asset: Asset, source: SearchSource, persist: boolean): IndexEntry | undefined {
  const bundleId = asset.bundle;
  try {
    const document = indexAsset(asset, { persist, supersede: false });
    const adapterId = document.adapterId as string;
    const { itemRef, conceptId } = deriveEntryProvenance(
      { bundleId, adapterId },
      document.type,
      document.name,
      document.conceptId as string,
    );
    return {
      filePath: indexedPathOf(asset, source),
      stashDir: source.path,
      type: document.type,
      name: document.name,
      adapterId,
      document,
      itemRef,
      bundleId,
      conceptId,
    };
  } catch {
    // An unreadable file is not found from files.
    return undefined;
  }
}

/** Whether `indexedPath` is where the index keys `asset`: the same path, and the same file behind it. */
export function indexedPathMatchesOwner(indexedPath: string, asset: Asset, source: SearchSource): boolean {
  const owner = indexedPathOf(asset, source);
  if (path.resolve(indexedPath) !== path.resolve(owner)) return false;
  // The asset was found, so its entry exists; an entry that is no file resolves to its own path.
  return safeRealpath(indexedPath) === path.resolve(safeRealpath(owner));
}
