// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a bundle's adapter writes, for callers that decide before they write. `bundle.ts` itself stays inside the facade. */

import { akmAdapter } from "../adapter/adapters/akm-adapter";
import type { BundleAdapter } from "../adapter/bundle-adapter";
import { detectAdapterId } from "../adapter/detect-adapter";
import {
  adapterForId,
  adapterIds,
  clearAdapterCaches as clearRegistryCaches,
  getAdapters,
  requireAdapter,
} from "../adapter/registry";
import type { UsageErrorCode } from "../errors";
import { assetBundleOf, bundleFor } from "./bundle";

export { activeSources } from "./bundle";

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(bundle: string, type?: string): void {
  bundleFor(bundle).assertWrites(type);
}

/** Whether the adapter with the registry id `adapterId` writes assets of `type`: for a caller that holds the id, not a bundle. */
export function adapterIdWrites(adapterId: string, type: string): boolean {
  return adapterForId(adapterId)?.writes.includes(type) === true;
}

/** Whether the bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. */
export function adapterWrites(bundle: string, type: string): boolean {
  return bundleFor(bundle).writes(type);
}

/** What the bundle's adapter puts before an asset's name in the concept id a create of `type` gives (`tasks/`), or "". */
export function placedPrefixOf(bundle: string, type: string): string {
  return bundleFor(bundle).prefixOf(type);
}

/** Refuse with a message naming the bundle and its adapter: `Bundle "x" uses adapter "y", which <what>.` */
export function refuseByAdapter(bundle: string, what: string, code: UsageErrorCode): never {
  return bundleFor(bundle).refuse(what, code);
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

/**
 * Refuse an adapter id akm does not have, naming the bundle. With `address` (whether the bundle is configured with a
 * `location`), also one the bundle is not addressed the way the adapter needs (`requireAdapter`).
 */
export function assertKnownAdapter(bundle: string, adapterId: string, address?: { location: boolean }): void {
  requireAdapter(bundle, adapterId, address);
}

/** The id of every adapter akm has, in probe order. */
export function knownAdapterIds(): string[] {
  return adapterIds();
}

/**
 * Whether the folders of the adapter's bundles declare the types of what they hold (an akm bundle's `memories/`):
 * `akm lint` sweeps such a bundle folder by folder, and its `--type` names a folder.
 */
export function adapterDeclaresTypes(adapterId: string): boolean {
  return adapterForId(adapterId)?.declaredType !== undefined;
}

/** Whether the adapter's own checks are the whole `akm lint` of a primary bundle it holds: no cross-bundle sweep runs. */
export function adapterLintsAlone(adapterId: string): boolean {
  return adapterForId(adapterId)?.lintsAlone === true;
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
export function bundleStorageExists(source: {
  name: string;
  path: string;
  location: string;
  adapterId: string;
}): boolean {
  // Not `bundleFor`: `akm bundle list` reports a bundle that is disabled, which no lookup resolves.
  return assetBundleOf(source).exists();
}

/** Forget what the adapters read of their keyrings and vaults. The CLI calls it per command and Desktop per request: a store changes between them. */
export function clearAdapterCaches(): void {
  clearRegistryCaches();
}

export { bundleAdapterId } from "../adapter/detect-adapter";
export { assertWritableFile } from "../adapter/directory-adapter";

/** What `akm run` asks of the adapter `adapterId`: to render a command or persona. Undefined: akm has no such adapter. */
export function executionAdapter(adapterId: string): Pick<BundleAdapter, "renderExecutionSource"> | undefined {
  return adapterForId(adapterId);
}
