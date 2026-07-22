// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bundle-map config write helpers (0.9.0 config-shape cutover, spec §10.1).
 *
 * The `stashDir`/`sources[]`/`installed[]` trio is retired: every source is now
 * a `bundles.<slug>` entry, and the primary working stash is the `defaultBundle`.
 * These helpers give the source writers (`akm init`, `akm setup`, `akm add`,
 * `akm sources add/remove`) one place to derive slug-legal bundle keys (via the
 * shared {@link deriveBundleId} — D-R5), locate an existing bundle by its source
 * descriptor, and set/repoint the primary bundle — without duplicating the
 * keying rules across call sites.
 */

import path from "node:path";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config";
import { primaryBundlePath } from "../../core/config/config";
import { deriveBundleId } from "../../indexer/installations";

export { primaryBundlePath };

/**
 * Upsert the primary filesystem bundle (`{ path, writable: true }`) and point
 * `defaultBundle` at it. Reuses the current default key when it already names a
 * filesystem bundle (so re-pointing the primary keeps a stable id); otherwise
 * derives a fresh slug-legal key from the path.
 */
export function withPrimaryBundle(config: AkmConfig, stashDir: string): AkmConfig {
  const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
  let key = config.defaultBundle;
  if (!key || !(key in bundles) || typeof bundles[key]?.path !== "string") {
    key = deriveBundleId(undefined, stashDir, new Set(Object.keys(bundles)));
  }
  bundles[key] = { ...bundles[key], path: stashDir, writable: true };
  return { ...config, bundles, defaultBundle: key };
}

/** Existing bundle key whose filesystem descriptor resolves to `resolvedPath`, or `undefined`. */
export function bundleKeyForPath(config: AkmConfig, resolvedPath: string): string | undefined {
  for (const [key, bundle] of Object.entries(config.bundles ?? {})) {
    if (typeof bundle.path === "string" && path.resolve(bundle.path) === resolvedPath) return key;
  }
  return undefined;
}

/** Existing bundle key whose git/website/npm descriptor matches `url`, or `undefined`. */
export function bundleKeyForUrl(config: AkmConfig, url: string): string | undefined {
  for (const [key, bundle] of Object.entries(config.bundles ?? {})) {
    if (bundle.git === url || bundle.website?.url === url || bundle.npm === url) return key;
  }
  return undefined;
}

/**
 * Derive a slug-legal, batch-unique bundle key for a new source: prefer the
 * caller's `preferredName` when it is a legal slug, else slug the seed locator
 * (path/url) — the shared {@link deriveBundleId} rule (D-R5), made unique against
 * the currently-configured bundle keys.
 */
export function nextBundleKey(
  bundles: Record<string, BundleConfigEntry>,
  preferredName: string | undefined,
  seedLocator: string,
): string {
  return deriveBundleId(preferredName, seedLocator, new Set(Object.keys(bundles)));
}
