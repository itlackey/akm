// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a bundle's adapter writes, for callers that decide before they write. `bundle.ts` itself stays inside the facade. */

import { akmAdapter } from "../adapter/adapters/akm-adapter";
import { detectAdapterId } from "../adapter/detect-adapter";
import {
  adapterForId,
  clearAdapterCaches as clearRegistryCaches,
  getAdapters,
  requireAdapter,
} from "../adapter/registry";
import type { UsageErrorCode } from "../errors";
import { assetBundleOf } from "./bundle";

type GateSource = { name: string; path: string; location?: string; adapterId?: string };

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(source: GateSource, type?: string): void {
  assetBundleOf(source).assertWrites(type);
}

/** Whether the bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. */
export function adapterWrites(source: GateSource, type: string): boolean {
  return assetBundleOf(source).writes(type);
}

/** Refuse with a message naming the bundle and its adapter: `Bundle "x" uses adapter "y", which <what>.` */
export function refuseByAdapter(source: GateSource, what: string, code: UsageErrorCode): never {
  return assetBundleOf(source).refuse(what, code);
}

/** How config names the bundles of adapter `adapterId`: by a directory (`root`) or by a store's `location`. Undefined: akm has no such adapter. */
export function adapterAddressedBy(adapterId: string): "root" | "location" | undefined {
  return adapterForId(adapterId)?.addressedBy;
}

/**
 * The adapter that reads the directory `root`, found by the adapters' install-time probe. This is the one detection:
 * it runs when a bundle is added and when an entry without `adapter` is resolved (§4.3), never when an asset is read.
 * A root no adapter claims is read by `akm`.
 */
export function detectBundleAdapter(root: string): string {
  return detectAdapterId(root);
}

/** Refuse an adapter id akm does not have, naming the bundle. */
export function assertKnownAdapter(bundle: string, adapterId: string): void {
  requireAdapter(bundle, adapterId);
}

/** Whether some adapter's install-time probe claims `root` as the root of a bundle of its format. A probe that throws does not claim it. */
export function looksLikeBundleRoot(root: string): boolean {
  for (const adapter of getAdapters()) {
    try {
      if (adapter.looksLikeRoot?.(root) === true) return true;
    } catch {
      // a throwing probe does not claim the root: try the next adapter
    }
  }
  return false;
}

/** The directory names `akm` itself owns at the root of a bundle (one per asset type). */
export function akmOwnedDirNames(root: string): string[] {
  return akmAdapter.directoryList({ id: "akm", root });
}

/** Whether the bundle's storage is there: a directory exists, a keyring or vault answers. It reads no asset and never prompts. */
export function bundleStorageExists(source: GateSource): boolean {
  return assetBundleOf(source).exists();
}

/** Forget what the adapters read of their keyrings and vaults. The CLI calls it per command and Desktop per request: a store changes between them. */
export function clearAdapterCaches(): void {
  clearRegistryCaches();
}

export { bundleAdapterId } from "../adapter/detect-adapter";
export {
  allowPrompts as allowAdapterPrompts,
  withoutPrompts as withoutAdapterPrompts,
} from "../adapter/secret-manager-adapter";
