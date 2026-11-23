// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Finding and listing assets: the one read side of the asset facade. An asset is found in the bundles' adapters,
 * in source order, and comes back as an {@link Asset} whatever adapter holds it. Synchronous and index-free: finding
 * and listing read no database and no file content, so a caller may use it at dispatch. Only `listAssets({ type })`
 * asks the index, because a type is index metadata.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { deriveBundleIds } from "../bundle-id";
import { compareCodePoints } from "../common";
import { loadConfig } from "../config/config";
import { NotFoundError } from "../errors";
import { warn } from "../warn";
import { type Asset, assetOf } from "./asset";
import { type AssetBundle, assetBundleOf } from "./bundle";
import { assetTypes } from "./type";

export type { Asset } from "./asset";

export interface FindOptions {
  /** The ordered sources to look in. Default: every configured source, default bundle first. */
  sources?: readonly SearchSource[];
}

function defaultSources(options?: { sources?: readonly SearchSource[] }): readonly SearchSource[] {
  return options?.sources ?? resolveSourceEntries(undefined, loadConfig());
}

/** The bundle a search source is, under the id refs use. */
function bundleOfSource(source: SearchSource, id: string): AssetBundle {
  return assetBundleOf({
    name: id,
    path: source.path,
    ...(source.location !== undefined ? { location: source.location } : {}),
    ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
  });
}

/** The asset `conceptId` names in one source, as its adapter reads it. */
export function readFrom(source: SearchSource, bundle: string, conceptId: string): Asset | undefined {
  const found = bundleOfSource(source, bundle).read(conceptId);
  return found ? assetOf(bundle, source, found) : undefined;
}

function findAmong(ref: BundleRef, sources: readonly SearchSource[]): Asset | undefined {
  const installations = deriveInstallations([...sources]);
  for (const [index, source] of sources.entries()) {
    const bundle = installations[index]?.id;
    if (!bundle || (ref.bundle !== undefined && bundle !== ref.bundle)) continue;
    const found = readFrom(source, bundle, ref.conceptId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The one "where is asset X right now?" lookup. The first source that holds the ref ends it; a qualified ref only
 * considers its own bundle. The asset comes back under its canonical ref, whichever spelling the adapter read.
 */
export function findAsset(ref: string | BundleRef, options: FindOptions = {}): Asset | undefined {
  return findAmong(typeof ref === "string" ? parseBundleRef(ref) : ref, defaultSources(options));
}

/** {@link findAsset}, refused with a `NotFoundError` when no bundle holds the ref. */
export function requireAsset(ref: string | BundleRef, options: FindOptions = {}): Asset {
  const found = findAsset(ref, options);
  if (!found) {
    const parsed = typeof ref === "string" ? parseBundleRef(ref) : ref;
    throw new NotFoundError(`Asset not found: ${makeBundleRef(parsed.bundle, parsed.conceptId)}`, "ASSET_NOT_FOUND");
  }
  return found;
}

/** The asset an index row names, read from the source that holds it: the row's bundle, else the row's root. */
export function assetOfEntry(
  entry: { bundleId: string; conceptId: string; stashDir: string },
  options: FindOptions = {},
): Asset | undefined {
  const sources = defaultSources(options);
  const installations = deriveInstallations([...sources]);
  let index = installations.findIndex((bundle) => bundle.id === entry.bundleId);
  if (index < 0) index = sources.findIndex((source) => path.resolve(source.path) === path.resolve(entry.stashDir));
  const source = sources[index];
  const bundle = installations[index]?.id;
  return source && bundle ? readFrom(source, bundle, entry.conceptId) : undefined;
}

/**
 * Every asset across the sources, one per concept as each bundle's adapter lists it, sorted by the file it is held
 * in. With `type`, the ones the index says are of that type. A bundle that cannot be listed completely is reported
 * with a warning naming it.
 */
export function listAssets(
  options: { sources?: readonly SearchSource[]; bundle?: string; type?: string } = {},
): Asset[] {
  const sources = defaultSources(options);
  const ids = deriveBundleIds([...sources]);
  const found: Asset[] = [];
  for (const [index, source] of sources.entries()) {
    const bundle = ids[index] as string;
    if (source.unresolved || (options.bundle !== undefined && bundle !== options.bundle)) continue;
    const listing = bundleOfSource(source, bundle).list();
    if (!listing.complete && listing.incompleteReason) {
      warn(`Bundle "${source.registryId ?? source.path}" was not listed completely: ${listing.incompleteReason}`);
    }
    for (const asset of listing.assets) found.push(assetOf(bundle, source, asset));
  }
  const types = options.type === undefined ? undefined : assetTypes(found);
  return found
    .filter((asset) => types === undefined || types.get(asset) === options.type)
    .sort((left, right) => compareCodePoints(sortKey(left), sortKey(right)));
}

/** Where an asset sorts: its file, else its path inside its bundle. */
function sortKey({ entry }: Asset): string {
  return entry.file ?? entry.relPath;
}

/**
 * The conceptId `ref` names now, for a lookup of stored rows: the holding asset's, so an old spelling maps to the
 * asset's ref with one warning; as written when no asset holds it.
 */
export function currentConceptId(ref: BundleRef, sources: readonly SearchSource[]): string {
  return findAsset(ref, { sources })?.conceptId ?? ref.conceptId;
}

/** Whether a bundle holds a retirement of the asset `ref` names: it was retired recoverably, not deleted. */
export function isRetired(ref: BundleRef, sources: readonly SearchSource[] = defaultSources()): boolean {
  const installations = deriveInstallations([...sources]);
  return sources.some((source, index) => {
    const bundle = installations[index]?.id;
    if (!bundle || (ref.bundle !== undefined && bundle !== ref.bundle)) return false;
    return bundleOfSource(source, bundle)
      .retired()
      .some((retirement) => retirement.conceptId === ref.conceptId);
  });
}

/** An asset's revision: the SHA-256 of its content. */
export function assetRevision(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
