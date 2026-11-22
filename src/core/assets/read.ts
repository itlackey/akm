// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Finding and listing assets: the one read side of the asset facade. An asset is found in the bundles' adapters,
 * in source order, and comes back as an {@link Asset} whatever adapter holds it. Synchronous and index-free: it
 * never opens a database, so a caller may use it at dispatch.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import type { AssetEntry, BundleAsset } from "../adapter/bundle-adapter";
import { stashDirNames } from "../asset/asset-placement";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { deriveBundleIds } from "../bundle-id";
import { compareCodePoints } from "../common";
import { loadConfig } from "../config/config";
import { NotFoundError } from "../errors";
import { warn, warnOnce } from "../warn";
import { type AssetBundle, assetBundleOf } from "./bundle";

/** One asset, found in its bundle. */
export interface Asset {
  /** The id of the bundle that holds it. */
  readonly bundle: string;
  readonly conceptId: string;
  /** `<bundle>//<conceptId>`. */
  readonly ref: string;
  /** The asset's type, as its adapter knows it. Asked for, not copied: it can cost a read of the file. */
  readonly type: string;
  /** `entry.file`, `entry.content()`, `entry.bytes()`, `entry.frontmatter()`. */
  readonly entry: AssetEntry;
  /** Whether `listAssets` lists it. False for an env file or secret kept out of listings (`.sensitive`). */
  readonly listed: boolean;
}

export interface FindOptions {
  /** The ordered sources to look in. Default: every configured source, default bundle first. */
  sources?: readonly SearchSource[];
}

function defaultSources(options?: { sources?: readonly SearchSource[] }): readonly SearchSource[] {
  return options?.sources ?? resolveSourceEntries(undefined, loadConfig());
}

function assetOf(bundle: string, found: BundleAsset): Asset {
  return {
    bundle,
    conceptId: found.conceptId,
    ref: makeBundleRef(bundle, found.conceptId),
    type: found.type,
    entry: found.entry,
    listed: found.listed,
  };
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
  return found ? assetOf(bundle, found) : undefined;
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
 * considers its own bundle. A ref in the outdated type-folder spelling is retried once without it, with a warning.
 */
export function findAsset(ref: string | BundleRef, options: FindOptions = {}): Asset | undefined {
  const parsed = typeof ref === "string" ? parseBundleRef(ref) : ref;
  const sources = defaultSources(options);
  const found = findAmong(parsed, sources);
  if (found) return found;
  const current = withoutTypeHead(parsed.conceptId);
  const legacy = current === undefined ? undefined : findAmong({ ...parsed, conceptId: current }, sources);
  if (legacy) warnOutdatedRef(parsed.conceptId, current as string);
  return legacy;
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
 * Every listed asset across the sources, as each bundle's adapter lists and recognizes it, sorted by the file
 * it is held in. An asset a `.sensitive` marker hides is not listed. A bundle that cannot be listed completely is
 * reported with a warning naming it.
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
    const held = bundleOfSource(source, bundle);
    const listing = held.list();
    if (!listing.complete && listing.incompleteReason) {
      warn(`Bundle "${source.registryId ?? source.path}" was not listed completely: ${listing.incompleteReason}`);
    }
    for (const entry of listing.entries) {
      const document = held.recognize(entry);
      if (!document?.conceptId || (options.type !== undefined && document.type !== options.type)) continue;
      found.push(assetOf(bundle, { conceptId: document.conceptId, type: document.type, entry, listed: true }));
    }
  }
  return found.sort((left, right) => compareCodePoints(sortKey(left), sortKey(right)));
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

/**
 * Releases before path refs prefixed a loose file's ref with its type folder
 * (`knowledge/reports/x` for `reports/x.md`), and that spelling is still in
 * links, memories, scripts and stored proposals. A ref that misses is retried
 * without that head: this is the head-less ref, or undefined when it has none.
 */
export function withoutTypeHead(conceptId: string): string | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0 || !stashDirNames().includes(conceptId.slice(0, slash))) return undefined;
  return conceptId.slice(slash + 1);
}

/** Warn that a ref is in the outdated type-folder spelling and was resolved to `current`. */
export function warnOutdatedRef(outdated: string, current: string): void {
  warnOnce(
    `outdated-ref:${outdated}`,
    `Ref "${outdated}" is outdated: refs are the path inside the bundle, so it is now "${current}". Resolved it to that asset.`,
  );
}
