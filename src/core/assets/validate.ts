// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Checking assets: the one validate side of the asset facade. The bundle's adapter says what is wrong with its
 * assets, which it is asked about by concept id (`AssetBundle.validate`); nothing here writes. A caller with pending
 * edits gets its function here when it exists (the proposal accept lint is still the base checks over the stamped
 * content: `validate` would also honour `lint.skip` and moved refs and add findings, a visible change that needs its
 * own §0.2 row, and it is async where the accept preflight is not).
 */

import type { SearchSource } from "../../indexer/search/search-source";
import type { AssetEntry } from "../adapter/bundle-adapter";
import type { AssetEdit, Diagnostic, ValidateContext } from "../adapter/types";
import { deriveBundleIds } from "../bundle-id";
import { type Asset, assetOf } from "./asset";
import { assetBundleOf } from "./bundle";

/**
 * What the bundle's adapter reports for the assets it lists, each checked as an `update` in the adapter's listing
 * order; `keep` narrows them by their entries. This is `akm lint`'s scan of a bundle as it stands.
 */
export function validateBundleAssets(
  bundle: { name: string; path: string; location?: string; adapterId?: string },
  options: { keep?: (entry: AssetEntry) => boolean; ctx?: ValidateContext } = {},
): Promise<Diagnostic[]> {
  const held = assetBundleOf(bundle);
  const edits: AssetEdit[] = held
    .list()
    .assets.filter(({ entry }) => options.keep === undefined || options.keep(entry))
    .map(({ conceptId }) => ({ conceptId, op: "update" }));
  return held.validate(edits, options.ctx ?? {});
}

/**
 * What the keyrings and vaults among `sources` report about their stores, as the last `akm index` recorded it: the
 * entries their adapters cannot list, and the names more than one entry holds. A bundle kept in files has none, and a
 * store that cannot be reached, or fails, has nothing to report.
 */
export async function storeFindings(sources: readonly SearchSource[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const ids = deriveBundleIds([...sources]);
  const found: Diagnostic[] = [];
  for (const [index, source] of sources.entries()) {
    if (source.unresolved) continue;
    try {
      const held = assetBundleOf({
        name: ids[index] as string,
        path: source.path,
        ...(source.location !== undefined ? { location: source.location } : {}),
        ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
      });
      if (!held.isStore) continue;
      const edits = held.list().assets.map(({ conceptId }): AssetEdit => ({ conceptId, op: "update" }));
      found.push(...(await held.validate(edits, ctx)));
    } catch {
      // A store that cannot be reached or fails has nothing to check: lint skips it silently, as in hooks and CI.
    }
  }
  return found;
}

/** Every asset the bundle's adapter lists, one per concept, in the adapter's listing order. */
export function listBundleAssets(bundle: {
  name: string;
  path: string;
  location?: string;
  adapterId?: string;
}): Asset[] {
  const held = assetBundleOf(bundle);
  return held.list().assets.map((found) => assetOf(held, found));
}

/** The asset the bundle holds at the stored `key`, when it holds one there. */
export function assetAtStoredKey(
  bundle: { name: string; path: string; location?: string; adapterId?: string },
  key: string,
): Asset | undefined {
  const held = assetBundleOf(bundle);
  const conceptId = held.identifyKey(key);
  const found = conceptId === null ? undefined : held.read(conceptId);
  return found?.entry.key === key ? assetOf(held, found) : undefined;
}
