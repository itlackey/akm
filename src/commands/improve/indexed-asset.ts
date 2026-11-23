// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The improve passes iterate index rows (a snapshot: its membership and order) and read each row's asset through the
 * facade. A row whose asset no bundle holds any more, or whose bytes cannot be read, is a stale row: it reads as absent.
 */

import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type Asset, findAsset, lookupAsset } from "../../core/assets/read";
import { bundleIdAt } from "../../core/bundle-at-dir";

/** The asset an index row names, or undefined when no bundle holds it. A stored row is not the caller's to fix, so an outdated spelling resolves quietly. */
export function indexedAsset(bundleId: string | undefined, conceptId: string): Asset | undefined {
  try {
    const ref = makeBundleRef(bundleId, conceptId);
    return bundleId === undefined ? lookupAsset(ref) : findAsset(ref);
  } catch {
    return undefined;
  }
}

/** The text of the asset an index row names; undefined when it is gone or cannot be read. */
export function indexedContent(bundleId: string | undefined, conceptId: string): string | undefined {
  try {
    return indexedAsset(bundleId, conceptId)?.entry.content();
  } catch {
    return undefined;
  }
}

/**
 * The asset a planned ref names: its qualified spelling when the planner recorded one, else the ref as written (a
 * qualified spelling no bundle holds any more is gone, not another bundle's copy), in the bundles of `stashDir` when given.
 */
export function plannedAsset(planned: { ref: string; itemRef?: string }, stashDir?: string): Asset | undefined {
  try {
    const ref = planned.itemRef ?? planned.ref;
    if (parseBundleRef(ref).bundle !== undefined) return findAsset(ref);
    return lookupAsset(ref, stashDir === undefined ? undefined : { bundle: bundleIdAt(stashDir) });
  } catch {
    return undefined;
  }
}

/** The asset `ref` names in the bundle at `stashDir` (a ref that names another bundle is not found here). */
export function assetInStash(stashDir: string, ref: string): Asset | undefined {
  try {
    const bundle = bundleIdAt(stashDir);
    const parsed = parseBundleRef(ref);
    if (parsed.bundle !== undefined && parsed.bundle !== bundle) return undefined;
    return findAsset(makeBundleRef(bundle, parsed.conceptId));
  } catch {
    return undefined;
  }
}
