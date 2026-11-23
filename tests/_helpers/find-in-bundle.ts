// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { makeBundleRef } from "../../src/core/asset/asset-ref";
import { type Asset, findAsset } from "../../src/core/assets/read";
import { configureBundles } from "./bundle-config";

/**
 * The asset `conceptId` names in the one bundle at `bundle.path`, read by `adapterId`.
 */
export function findInBundle(
  bundle: { name: string; path: string },
  adapterId: string,
  conceptId: string,
): Asset | undefined {
  const [id] = configureBundles([{ path: bundle.path, registryId: bundle.name, adapterId }]);
  return findAsset(makeBundleRef(id, conceptId));
}
