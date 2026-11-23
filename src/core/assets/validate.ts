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

import type { AssetEntry } from "../adapter/bundle-adapter";
import type { AssetEdit, Diagnostic, ValidateContext } from "../adapter/types";
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
