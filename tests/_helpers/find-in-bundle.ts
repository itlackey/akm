// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type Asset, type FindOptions, findAsset } from "../../src/core/assets/read";

/**
 * The asset `conceptId` names in the one bundle at `bundle.path`, read by `adapterId`.
 */
export function findInBundle(
  bundle: { name: string; path: string },
  adapterId: string,
  conceptId: string,
  options?: Pick<FindOptions, "mode" | "unlisted">,
): Asset | undefined {
  return findAsset({ conceptId }, { sources: [{ path: bundle.path, registryId: bundle.name, adapterId }], ...options });
}
