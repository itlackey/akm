// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How an asset the facade found relates to the index: the path the index keys it under, whether an indexed row is
 * that asset's, and the row the asset's adapter gives without the index.
 */

import path from "node:path";
import { adapterIdOf } from "../../core/adapter/detect-adapter";
import { assetBundleOf } from "../../core/assets/bundle";
import type { Asset } from "../../core/assets/read";
import { safeRealpath } from "../../core/common";
import { withMdVariants } from "../../storage/repositories/index-entries-repository";
import type { IndexEntry } from "../indexer";
import { deriveEntryProvenance } from "../installations";
import type { SearchSource } from "../search/search-source";

/**
 * The path the index keys an asset under: its file, else (for an asset no file holds) `<root>/<relPath>`, which is
 * not a path to anything.
 */
export function indexedPathOf(asset: Asset, source: SearchSource): string {
  return asset.entry.file ?? path.join(source.path, asset.entry.relPath);
}

/**
 * The index entry the holding file and its adapter give without the index: the adapter's own recognition of
 * the file, so `show` serves it though no row exists. Undefined when the walk would not list the file (a
 * skipped or ignored directory, a symlinked one, ...: it is not in the bundle as far as the index goes) or the
 * adapter does not recognise it, or when the ref is not the concept ID the index would key the file under, up to its
 * `.md` (a file-name spelling such as `tasks/nightly.yml`): an index miss refuses that spelling, so does this. It has
 * no links, usage or indexed fragments.
 */
export function entryFromFiles(asset: Asset, source: SearchSource): IndexEntry | undefined {
  const bundleId = asset.bundle;
  const adapterId = adapterIdOf(source);
  try {
    if (!asset.listed) return undefined;
    const document = assetBundleOf({
      name: bundleId,
      path: source.path,
      ...(source.location !== undefined ? { location: source.location } : {}),
      adapterId,
    }).recognize(asset.entry);
    if (!document?.conceptId || !withMdVariants(asset.conceptId).includes(document.conceptId)) return undefined;
    const { itemRef, conceptId } = deriveEntryProvenance(
      { bundleId, adapterId },
      document.type,
      document.name,
      document.conceptId,
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
