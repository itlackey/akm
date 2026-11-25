// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Finding and listing assets: the one read side of the asset facade. An asset is found in the bundles' adapters,
 * in source order, and comes back as an {@link Asset} whatever adapter holds it. Synchronous and index-free: finding
 * and listing read no database and no file content, so a caller may use it at dispatch. Only `listAssets({ type })`
 * asks the index, because a type is index metadata, and a listing of a store, whose entries the index records.
 */

import { createHash } from "node:crypto";
import { readUsableIndex } from "../../indexer/index-readiness";
import type { SearchSource } from "../../indexer/search/search-source";
import type { AssetEntry, BundleListing, PackageFile } from "../adapter/bundle-adapter";
import { fileContextOfEntry } from "../adapter/directory/file-context";
import type { FileContext, IndexDocument } from "../adapter/types";
import { makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { compareCodePoints } from "../common";
import { assetNotFound, ConfigError } from "../errors";
import { warnOnce } from "../warn";
import { type Asset, assetOf, readExact, readFrom, readOutdated } from "./asset";
import {
  type AssetBundle,
  assetBundleOf,
  type BundleAddress,
  bundleFor,
  bundleNameOf,
  lookupBundles,
  orderedBundles,
} from "./bundle";
import { assetTypes } from "./type";

export type { Asset } from "./asset";

/**
 * An input ref, qualified: the one place an unqualified ref is resolved to a bundle (§4.2). A qualified `input` keeps its
 * bundle, its outdated type-folder spelling (`knowledge/reports/x` for `reports/x.md`) mapped to the asset's current
 * concept id with the warning; an unqualified one gets the first bundle, in the order `from`, the default bundle, the
 * configured order, whose adapter reads it as written, else (the outdated spelling, with the warning) the first that
 * reads it that way, else `<from or default>//<input>`. Reads no content. A source set that cannot be read is a
 * `ConfigError`.
 */
export function qualifyRef(input: string, from?: { bundle: BundleAddress }): string {
  return resolveInput(input, from).ref;
}

/**
 * {@link qualifyRef} and {@link findAsset} in one pass: the asset an input ref names, as `qualifyRef` would qualify it
 * (the same bundle order, the same warning), read once. Undefined when no bundle holds it.
 */
export function lookupAsset(input: string, from?: { bundle: BundleAddress }): Asset | undefined {
  return resolveInput(input, from).asset;
}

function resolveInput(input: string, from?: { bundle: BundleAddress }): { ref: string; asset?: Asset } {
  const parsed = parseBundleRef(input);
  const all = lookupBundles(from?.bundle);
  const fromName = from && bundleNameOf(from.bundle);
  const order = from ? [...all].sort((a, b) => Number(b.name === fromName) - Number(a.name === fromName)) : all;
  const candidates = parsed.bundle === undefined ? order : order.filter((bundle) => bundle.name === parsed.bundle);
  const find = (conceptId: string): Asset | undefined => {
    for (const bundle of candidates) {
      const found = readExact(bundle, conceptId);
      if (found) return found;
    }
    return undefined;
  };
  const held = find(parsed.conceptId) ?? readOutdated(parsed.conceptId, find, true);
  if (held) return { ref: makeBundleRef(held.bundle, held.conceptId, parsed.fragment), asset: held };
  const bundle = parsed.bundle ?? fromName ?? all[0]?.name;
  return { ref: makeBundleRef(bundle, parsed.conceptId, parsed.fragment) };
}

/**
 * The one "where is asset X right now?" lookup. `ref` is qualified (`qualifyRef` qualifies an input), or a stored ref with
 * no bundle, found in the first bundle that holds it; the asset comes back under its canonical ref, whichever spelling the adapter read, and an outdated spelling of a stored ref is read
 * without a warning.
 */
export function findAsset(ref: string, held?: BundleAddress): Asset | undefined {
  const parsed = parseBundleRef(ref);
  // A ref with no bundle (a stored row of an older record) is looked up in every bundle, silently: it is no user's input.
  return findIn(
    lookupBundles(held).filter((bundle) => parsed.bundle === undefined || bundle.name === parsed.bundle),
    parsed.conceptId,
  );
}

/** The asset `conceptId` names in the first of `candidates` that holds it as written, else under its outdated spelling; no warning. */
function findIn(candidates: readonly AssetBundle[], conceptId: string): Asset | undefined {
  const find = (id: string): Asset | undefined => {
    for (const bundle of candidates) {
      const found = readExact(bundle, id);
      if (found) return found;
    }
    return undefined;
  };
  // The ref as written first, then its outdated spelling.
  return find(conceptId) ?? readOutdated(conceptId, find);
}

/** {@link findAsset}, refused with a `NotFoundError` when no bundle holds the ref. */
export function requireAsset(ref: string, held?: BundleAddress): Asset {
  const found = findAsset(ref, held);
  if (!found) {
    const parsed = parseBundleRef(ref);
    throw assetNotFound(makeBundleRef(parsed.bundle, parsed.conceptId));
  }
  return found;
}

/**
 * The asset `conceptId` names in the bundle `bundle`, as its adapter reads it (an outdated spelling of it too), read
 * outside a write session.
 */
export function readAsset(bundle: BundleAddress, conceptId: string): Asset | undefined {
  return readFrom(bundleFor(bundle), conceptId);
}

/** The asset the file at `key` (its path inside `bundle`) holds, as its adapter reads it; undefined when that file holds none. */
export function assetAtKey(bundle: BundleAddress, key: string): Asset | undefined {
  const held = bundleFor(bundle);
  const conceptId = held.identifyKey(key);
  return conceptId === null ? undefined : readExact(held, conceptId);
}

/**
 * Every file of the package whose entry is the file at `key` (its path inside `bundle`), non-assets included, with
 * bytes and mode (§0.2 P12). The folder is read by content even where a listing does not reach it (a link).
 */
export function packageFilesAt(bundle: BundleAddress, key: string): PackageFile[] {
  const held = bundleFor(bundle);
  const conceptId = held.identifyKey(key);
  if (conceptId === null) throw assetNotFound(`${bundleNameOf(bundle)}//${key}`);
  return held.packageFiles(conceptId);
}

/**
 * Every asset across the bundles, one per concept as each bundle's adapter lists it, in the order of the bundles and
 * then by concept id within each. With `type`, the ones the index says are of that type. A bundle that cannot be listed
 * completely lists what it could (only `akm index` reports it, §0.2 P4). A store (a keyring, a vault) is listed from
 * its index rows, which `akm index` refreshes: a listing never reaches, or unlocks, the store (§0.2 N25).
 */
export function listAssets(
  options: {
    bundle?: BundleAddress;
    type?: string;
    /**
     * For a caller that acts on what is not there (a scheduler removes the rows of a task that is gone): a bundle whose
     * listing is incomplete (with `type`, the part that holds that type) fails with `BUNDLE_UNREACHABLE` and the
     * listing's reason, and one whose storage is not there lists nothing, with no warning.
     */
    requireComplete?: boolean;
  } = {},
): Asset[] {
  const found: Asset[] = [];
  // A bundle a caller names may be a directory no config has; a listing of every bundle never is.
  for (const held of options.bundle !== undefined ? lookupBundles(options.bundle) : orderedBundles()) {
    const bundle = held.name;
    if (options.bundle !== undefined && bundle !== bundleNameOf(options.bundle)) continue;
    if (held.isStore) {
      found.push(...indexedAssets(held, options.type));
      continue;
    }
    if (options.requireComplete && !held.exists()) continue;
    const listing = held.list(options.type);
    if (options.requireComplete && !listing.complete) {
      throw new ConfigError(
        listing.incompleteReason ?? `Bundle "${bundle}" could not be listed completely.`,
        "BUNDLE_UNREACHABLE",
      );
    }
    found.push(
      ...listing.assets
        .map((asset) => assetOf(held, asset))
        .sort((left, right) => compareCodePoints(left.conceptId, right.conceptId)),
    );
  }
  const types = options.type === undefined ? undefined : assetTypes(found);
  return found.filter((asset) => types === undefined || types.get(asset) === options.type);
}

/**
 * A store's assets as the index recorded them, by concept id; a value is read from the store only when asked. With no
 * usable index there are none, and a listing of what the store holds (`type` absent or one it writes) says so once.
 */
function indexedAssets(held: AssetBundle, type?: string): Asset[] {
  const rows = readUsableIndex(
    (db) =>
      db.prepare("SELECT concept_id, document_json FROM entries WHERE bundle_id = ?").all(held.name) as Array<{
        concept_id: string;
        document_json: string;
      }>,
    undefined,
  );
  if (rows === undefined) {
    if (type === undefined || held.writes(type)) {
      warnOnce(
        `unindexed-store:${held.name}`,
        `Bundle "${held.name}" is listed from the index, and there is no usable index: run \`akm index\`.`,
      );
    }
    return [];
  }
  return rows
    .map((row) =>
      assetOf(held, { conceptId: row.concept_id, entry: indexedEntry(held, row.concept_id, row.document_json) }),
    )
    .sort((left, right) => compareCodePoints(left.conceptId, right.conceptId));
}

/** The entry of an index row: its key and what the adapter recorded of it; the value comes from the adapter's read. */
function indexedEntry(held: AssetBundle, conceptId: string, documentJson: string): AssetEntry {
  const { locator } = JSON.parse(documentJson) as IndexDocument;
  let read: AssetEntry | undefined;
  const live = (): AssetEntry => {
    read ??= held.read(conceptId)?.entry;
    if (!read) throw assetNotFound(makeBundleRef(held.name, conceptId));
    return read;
  };
  return {
    key: conceptId,
    content: () => live().content(),
    bytes: () => live().bytes(),
    frontmatter: () => live().frontmatter(),
    ...(locator !== undefined ? { locator } : {}),
  };
}

/**
 * The hint for a ref no bundle holds: when it names a store's bundle (a keyring, a vault), whose entries akm finds
 * through the index alone, `akm index`; otherwise none.
 */
export function unindexedHint(ref: string): string | undefined {
  const { bundle } = parseBundleRef(ref);
  if (bundle === undefined) return undefined;
  let held: AssetBundle;
  try {
    held = bundleFor(bundle);
  } catch {
    // No bundle has that id: the not-found message says what it says.
    return undefined;
  }
  if (!held.isStore) return undefined;
  return `akm finds the entries of bundle "${bundle}" through the index: run \`akm index\` if this one was added since it last ran.`;
}

/** What the index scan asks of one bundle: its adapter's id, one listing, and the description of one entry. */
export interface BundleScan {
  /** The id of the adapter that holds the bundle. */
  readonly adapterId: string;
  /** `<adapter id>@<adapter version>+`: the prefix of the freshness variant the index records for the bundle's rows. */
  readonly variantPrefix: string;
  /** Whether the bundle's entries are files in directories, which the scan groups and keeps per-directory state for; not a keyring's or a vault's. */
  readonly inDirectories: boolean;
  /** Every asset the adapter holds, one per concept, with whether the listing is complete. Throws `BUNDLE_UNREACHABLE` for a store it cannot reach. */
  list(): BundleListing;
  /** What the adapter says about one of its entries for the index; null: the adapter abstains on it. */
  recognize(entry: AssetEntry): IndexDocument | null;
  /** One of its entries as the scan's per-directory pipeline takes it: with the path fields of a file under the bundle's root. */
  fileContext(entry: AssetEntry): FileContext;
}

/**
 * The bundle `source` is, as `akm index` scans it: refused when its adapter is not one akm has (`requireAdapter`). The
 * indexer scans the sources it resolved itself (an override directory, a source not yet in config), so it is handed
 * the source, not an id to resolve again for each bundle.
 */
export function scanBundle(source: SearchSource, bundle: string): BundleScan {
  const held = assetBundleOf({
    name: bundle,
    path: source.path,
    ...(source.location !== undefined ? { location: source.location } : {}),
    ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
  });
  return {
    adapterId: held.adapterId,
    variantPrefix: held.variantPrefix,
    inDirectories: !held.isStore,
    list: () => held.list(),
    recognize: (entry) => held.recognize(entry),
    fileContext: (entry) => fileContextOfEntry(held.root, entry),
  };
}

/**
 * The conceptId the stored `ref` names now, for a lookup of stored rows: the holding asset's, so an old spelling maps
 * to the asset's ref, silently; as written when no asset holds it.
 */
export function currentConceptId(ref: string, held?: BundleAddress): string {
  const { bundle, conceptId } = parseBundleRef(ref);
  // A stored ref with no bundle (an older record) names its asset by concept id alone: whichever bundle holds it now.
  const candidates = lookupBundles(held).filter((found) => bundle === undefined || found.name === bundle);
  return findIn(candidates, conceptId)?.conceptId ?? conceptId;
}

/** The asset as `akm show` renders it: its entry, with the path fields of a file at its key under `root`. */
export function fileContextOf(asset: Asset, root: string): FileContext {
  return fileContextOfEntry(root, asset.entry);
}

/** An asset's revision: the SHA-256 of its content. */
export function assetRevision(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
