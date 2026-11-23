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
import fs from "node:fs";
import path from "node:path";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import type { BundleListing } from "../adapter/bundle-adapter";
import { stashDirFor, withoutTypeHead } from "../asset/asset-placement";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { deriveBundleIds } from "../bundle-id";
import { compareCodePoints, toErrorMessage } from "../common";
import { loadConfig } from "../config/config";
import { assetNotFound, ConfigError } from "../errors";
import { warn, warnOnce } from "../warn";
import { type Asset, assetOf } from "./asset";
import { type AssetBundle, assetBundleOf } from "./bundle";
import { assetTypes } from "./type";

export type { Asset } from "./asset";

export interface FindOptions {
  /** The ordered sources to look in. Default: every configured source, default bundle first. */
  sources?: readonly SearchSource[];
  /** Resolve an outdated spelling without the warning: for a lookup of stored refs, which are not the caller's to fix. */
  quiet?: boolean;
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

/** The asset `conceptId` names in one source, as its adapter reads it, with no other spelling tried. */
function readExact(source: SearchSource, bundle: string, conceptId: string): Asset | undefined {
  const found = bundleOfSource(source, bundle).read(conceptId);
  return found ? assetOf(bundle, source, found) : undefined;
}

/**
 * Releases before path refs prefixed a loose file's ref with its type folder (`knowledge/reports/x` for
 * `reports/x.md`), and that spelling is still in links, memories, scripts and stored proposals. A ref nothing holds is
 * read once more without that head, with a warning, and the asset comes back under its current ref. Whatever
 * adapter holds the bundle: the spelling is akm's, not the format's.
 */
function readOutdated(
  conceptId: string,
  read: (conceptId: string) => Asset | undefined,
  quiet = false,
): Asset | undefined {
  const current = withoutTypeHead(conceptId);
  const found = current === undefined ? undefined : read(current);
  if (found && !quiet) {
    warnOnce(
      `outdated-ref:${conceptId}`,
      `Ref "${conceptId}" is outdated: refs are the path inside the bundle, so it is now "${found.conceptId}". Resolved it to that asset.`,
    );
  }
  return found;
}

/** The asset `conceptId` names in one source, as its adapter reads it; an outdated spelling of it too. */
export function readFrom(source: SearchSource, bundle: string, conceptId: string): Asset | undefined {
  return (
    readExact(source, bundle, conceptId) ?? readOutdated(conceptId, (current) => readExact(source, bundle, current))
  );
}

function findAmong(ref: BundleRef, sources: readonly SearchSource[], quiet = false): Asset | undefined {
  const installations = deriveInstallations([...sources]);
  const find = (conceptId: string): Asset | undefined => {
    for (const [index, source] of sources.entries()) {
      const bundle = installations[index]?.id;
      if (!bundle || (ref.bundle !== undefined && bundle !== ref.bundle)) continue;
      const found = readExact(source, bundle, conceptId);
      if (found) return found;
    }
    return undefined;
  };
  // The ref as written, in every source, before the outdated spelling is tried in any.
  return find(ref.conceptId) ?? readOutdated(ref.conceptId, find, quiet);
}

/**
 * The one "where is asset X right now?" lookup. The first source that holds the ref ends it; a qualified ref only
 * considers its own bundle. The asset comes back under its canonical ref, whichever spelling the adapter read.
 */
export function findAsset(ref: string | BundleRef, options: FindOptions = {}): Asset | undefined {
  return findAmong(typeof ref === "string" ? parseBundleRef(ref) : ref, defaultSources(options), options.quiet);
}

/** {@link findAsset}, refused with a `NotFoundError` when no bundle holds the ref. */
export function requireAsset(ref: string | BundleRef, options: FindOptions = {}): Asset {
  const found = findAsset(ref, options);
  if (!found) {
    const parsed = typeof ref === "string" ? parseBundleRef(ref) : ref;
    throw assetNotFound(makeBundleRef(parsed.bundle, parsed.conceptId));
  }
  return found;
}

/**
 * Every asset across the sources, one per concept as each bundle's adapter lists it, in the order of the bundles and
 * then by concept id within each. With `type`, the ones the index says are of that type. A bundle that cannot be listed
 * completely is reported with a warning naming it; one that cannot be reached at all fails the listing with
 * `BUNDLE_UNREACHABLE` when it holds what is asked for.
 */
export function listAssets(
  options: {
    sources?: readonly SearchSource[];
    bundle?: string;
    type?: string;
    /**
     * For a caller that acts on what is not there (a scheduler removes the rows of a task that is gone): with `type`,
     * a bundle whose folder for that type exists and is not a directory fails with `BUNDLE_UNREACHABLE`, and one whose
     * storage is not there lists nothing, with no warning.
     */
    requireComplete?: boolean;
  } = {},
): Asset[] {
  const sources = defaultSources(options);
  const ids = deriveBundleIds([...sources]);
  const found: Asset[] = [];
  for (const [index, source] of sources.entries()) {
    const bundle = ids[index] as string;
    if (source.unresolved || (options.bundle !== undefined && bundle !== options.bundle)) continue;
    const held = bundleOfSource(source, bundle);
    if (options.requireComplete) {
      if (!held.exists()) continue;
      const folder = options.type === undefined ? undefined : stashDirFor(options.type);
      const dir = folder === undefined ? undefined : path.join(source.path, folder);
      if (dir !== undefined && fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        throw new ConfigError(`ENOTDIR: not a directory, scandir '${dir}'`, "BUNDLE_UNREACHABLE");
      }
    }
    let listing: BundleListing;
    try {
      listing = held.list();
    } catch (error) {
      // A bundle that cannot be reached is not a shorter list: when it holds what is asked for, the command fails.
      if (!held.isStore) throw error;
      const unreachable = error instanceof ConfigError && error.code === "BUNDLE_UNREACHABLE";
      if (unreachable && (options.type === undefined || held.writes(options.type))) {
        throw new ConfigError(`Bundle "${bundle}" cannot be reached: ${toErrorMessage(error)}`, "BUNDLE_UNREACHABLE");
      }
      warn(`Bundle "${source.registryId ?? source.path}" was not listed completely: ${toErrorMessage(error)}`);
      continue;
    }
    if (!listing.complete && listing.incompleteReason) {
      warn(`Bundle "${source.registryId ?? source.path}" was not listed completely: ${listing.incompleteReason}`);
    }
    found.push(
      ...listing.assets
        .map((asset) => assetOf(bundle, source, asset))
        .sort((left, right) => compareCodePoints(left.conceptId, right.conceptId)),
    );
  }
  const types = options.type === undefined ? undefined : assetTypes(found);
  return found.filter((asset) => types === undefined || types.get(asset) === options.type);
}

/**
 * The conceptId `ref` names now, for a lookup of stored rows: the holding asset's, so an old spelling maps to the
 * asset's ref with one warning (none with `quiet`); as written when no asset holds it.
 */
export function currentConceptId(
  ref: BundleRef,
  sources: readonly SearchSource[],
  options: { quiet?: boolean } = {},
): string {
  return findAsset(ref, { sources, ...options })?.conceptId ?? ref.conceptId;
}

/** An asset's revision: the SHA-256 of its content. */
export function assetRevision(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
