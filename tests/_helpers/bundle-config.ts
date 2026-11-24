// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { deriveBundleIds } from "../../src/core/bundle-id";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";

/** A bundle a test makes: a directory (or a store's `location`) and the adapter that reads it. */
export interface TestBundle {
  path: string;
  registryId?: string;
  adapterId?: string;
  location?: string;
  writable?: boolean;
}

/**
 * Make `bundles` the config's bundles, in order, the first the default: the facade takes bundle ids, and a bundle is
 * one config names. Returns the id of each. Other config keys are left as they are.
 */
export function configureBundles(bundles: readonly TestBundle[]): string[] {
  const ids = deriveBundleIds(bundles.map(({ path, registryId }) => ({ path, registryId })));
  const config = loadConfig();
  const entries = Object.fromEntries(
    bundles.map((bundle, index) => [
      ids[index] as string,
      bundle.location !== undefined
        ? { location: bundle.location, ...(bundle.adapterId ? { adapter: bundle.adapterId } : {}) }
        : {
            path: bundle.path,
            ...(bundle.adapterId ? { adapter: bundle.adapterId } : {}),
            writable: bundle.writable ?? true,
          },
    ]),
  );
  const { defaultBundle: _drop, ...rest } = config;
  saveConfig({ ...rest, bundles: entries, ...(ids[0] ? { defaultBundle: ids[0] } : {}) });
  resetConfigCache();
  return ids;
}
