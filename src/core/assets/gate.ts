// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a bundle's adapter writes, for callers that decide before they write. `bundle.ts` itself stays inside the facade. */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
import { akmAdapter } from "../adapter/adapters/akm-adapter";
import { lintByValidateAndEnvSweep } from "../adapter/adapters/akm-lint-run";
import { lintAkmFile, lintAkmText } from "../adapter/adapters/akm-sweep";
import type { AssetEntry } from "../adapter/bundle-adapter";
import { bundleAdapterId, detectAdapterId } from "../adapter/detect-adapter";
import {
  adapterForId,
  adapterIds,
  clearAdapterCaches as clearRegistryCaches,
  getAdapters,
  requireAdapter,
} from "../adapter/registry";
import type { Bundle } from "../adapter/types";
import type { AkmConfig } from "../config/config";
import { ConfigError, UsageError, type UsageErrorCode } from "../errors";
import type { AkmLintOptions, LintFindings, LintRun } from "../lint/types";
import { assetBundleOf, type BundleAddress, bundleFor } from "./bundle";

export { activeSources, type BundleAddress, bundleNameOf } from "./bundle";

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(bundle: BundleAddress, type?: string): void {
  bundleFor(bundle).assertWrites(type);
}

/** A bundle as a source or config record names it: its adapter is the one it records (`akm` when it records none). */
interface BundleRecord {
  adapterId?: string;
}

/**
 * Whether the bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. `bundle` is a
 * configured bundle's id, or the record of a source a caller holds (an adapter akm does not have writes nothing).
 */
export function adapterWrites(bundle: string | BundleRecord, type: string): boolean {
  if (typeof bundle === "string") return bundleFor(bundle).writes(type);
  return adapterForId(bundleAdapterId(bundle))?.writes.includes(type) === true;
}

/** What the bundle's adapter puts before an asset's name in the concept id a create of `type` gives (`tasks/`), or "". */
export function placedPrefixOf(bundle: BundleAddress, type: string): string {
  return bundleFor(bundle).prefixOf(type);
}

/** The id of the adapter that reads the bundle, for a message that names it. */
export function adapterNameOf(bundle: BundleAddress): string {
  return bundleFor(bundle).adapterId;
}

/** Refuse with a message naming the bundle and its adapter: `Bundle "x" uses adapter "y", which <what>.` */
export function refuseByAdapter(bundle: BundleAddress, what: string, code: UsageErrorCode): never {
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
 * `akm lint` of a bundle, or of one file of it (`run.file`), by its adapter: what the adapter finds, fixes written as
 * asset writes. An adapter without a `lint` of its own is checked by its `validate` and the cross-bundle `.env` sweep.
 */
export function lintBundle(run: LintRun): Promise<LintFindings> {
  const adapter = adapterForId(bundleAdapterId(run.bundle));
  return adapter?.lint ? adapter.lint(run) : lintByValidateAndEnvSweep(run);
}

/** `akm lint <file>` for a file no bundle holds: it is read as the akm document type `--type` names. */
export function lintLooseFile(
  file: { given: string; real: string },
  cfg: AkmConfig,
  options: AkmLintOptions,
): LintFindings {
  return lintAkmFile(file, undefined, [], cfg, options);
}

/** What `akm lint` would find in `content` as the text of the akm asset at `relPath` of the bundle at `root`. Nothing is read from or written to the file. */
export function lintAssetText(input: Parameters<typeof lintAkmText>[0]): LintFindings {
  return lintAkmText(input);
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

/**
 * The command or persona `entry` holds, as the adapter that indexed it renders it for `akm run`: `row.adapterId` is the
 * adapter the index row records, so a bundle whose config names another one since is rendered as it was indexed. Null:
 * the adapter does not render the entry as either. Refused for an adapter akm does not have, and for one that renders
 * no command or persona.
 */
export function renderIndexedExecutionSource(
  row: { adapterId: string },
  bundle: Bundle,
  entry: AssetEntry,
): AdapterRenderedExecutionSource | null {
  const adapter = adapterForId(row.adapterId);
  if (!adapter) {
    throw new ConfigError(
      `Execution source adapter ${JSON.stringify(row.adapterId)} is not registered.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!adapter.renderExecutionSource) {
    throw new UsageError(
      `Bundle adapter ${JSON.stringify(row.adapterId)} does not support command or persona execution.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return adapter.renderExecutionSource(bundle, entry);
}
