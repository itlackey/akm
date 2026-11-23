// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The improve passes iterate index rows (a snapshot: its membership and order) and read each row's asset through the
 * facade. A row whose asset no bundle holds any more, or whose bytes cannot be read, is a stale row: it reads as absent.
 */

import path from "node:path";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { type Asset, findAsset } from "../../core/assets/read";
import { resolveSourceEntries } from "../../indexer/search/search-source";

/** The asset an index row names, or undefined when no bundle holds it. A stored row is not the caller's to fix, so an outdated spelling resolves quietly. */
export function indexedAsset(bundleId: string | undefined, conceptId: string): Asset | undefined {
  try {
    return findAsset(makeBundleRef(bundleId, conceptId), { quiet: true });
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
 * qualified spelling no bundle holds any more falls back to it), in the bundles of `stashDir` when given.
 */
export function plannedAsset(planned: { ref: string; itemRef?: string }, stashDir?: string): Asset | undefined {
  try {
    const options = {
      quiet: true,
      ...(stashDir !== undefined ? { sources: resolveSourceEntries(stashDir) } : {}),
    };
    return (
      (planned.itemRef !== undefined ? findAsset(planned.itemRef, options) : undefined) ??
      findAsset(planned.ref, options)
    );
  } catch {
    return undefined;
  }
}

/** The asset `ref` names in the bundle at `stashDir` (else in the bundles of `stashDir`, when none is configured at it). */
export function assetInStash(stashDir: string, ref: string): Asset | undefined {
  const root = path.resolve(stashDir);
  const sources = resolveSourceEntries(stashDir);
  const own = sources.filter((source) => path.resolve(source.path) === root);
  try {
    return findAsset(ref, { quiet: true, sources: own.length > 0 ? own : sources });
  } catch {
    return undefined;
  }
}
