// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Writing assets: the one write side of the asset facade. {@link writeAssets} runs a session against a write
 * target's bundle under the asset-mutation lease; every change the session makes passes the same gates here, in the
 * same order, whichever adapter holds the bundle, and its files are recorded for the target's boundary commit.
 */

import path from "node:path";
import { withAssetMutationLeaseSync } from "../../indexer/index-writer-lock";
import type {
  AssetChange,
  AssetPlacement,
  NewAsset,
  PackageFile,
  Retirement,
  RetireNote,
} from "../adapter/bundle-adapter";
import { stashDirFor } from "../asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { parsePlacementRef } from "../asset/resolve-ref";
import { toPosix } from "../common";
import { assetNotFound, ConfigError, UsageError } from "../errors";
import { warn } from "../warn";
import { recordWrittenPath } from "../write-provenance";
import {
  commitWriteTargetBoundary,
  ensureWritable,
  isWriteCapableSourceKind,
  type ResolvedWriteTarget,
  recordWriteTargetPath,
} from "../write-source";
import { type Asset, assetOf, readFrom } from "./asset";
import { type AssetBundle, assetBundleOf, bundleFor } from "./bundle";
import { forgetIndexedAsset, refreshIndexedAsset } from "./index-rows";
import { assetRevision } from "./read";
import { assetType } from "./type";

/**
 * The gates every write passes: the bundle takes writes, and it is a kind akm writes (a directory, a git checkout, or a
 * store its adapter keeps). A source built by hand of another kind is refused, as the loader would refuse it.
 */
function gate(source: ResolvedWriteTarget["source"], config: ResolvedWriteTarget["config"]): void {
  ensureWritable(source, config);
  if (source.location !== undefined || isWriteCapableSourceKind(source.kind)) return;
  throw new ConfigError(
    `write-source: unsupported kind "${source.kind}" for source "${source.name}". ` +
      "Writes are only defined for `filesystem` and `git` sources.",
    "INVALID_CONFIG_FILE",
    'Set `kind: "filesystem"` (or `kind: "git"`) on the source, or add a parallel filesystem entry.',
  );
}

/** Where a write to a ref goes. */
export interface AssetAddress {
  conceptId: string;
  type: string;
  /** The name within the type (`prod` for `env/prod`). */
  name: string;
  /**
   * Whether an asset holds the ref now: the asset the ref names, else the one at the concept a create of the ref
   * places, else a non-asset entry (a directory) where a create would write. Otherwise `conceptId` is where a new asset
   * of the ref's type goes.
   */
  exists: boolean;
  /**
   * The file that holds the asset, when it exists, else the file a new one would be kept at; absent when its bundle
   * keeps no file for it. Display only (§0.2 P13): never stored, never an identity.
   */
  file?: string;
  /** True when an asset holds the ref under another spelling than the one a create of the ref writes. */
  heldElsewhere?: boolean;
}

/** What a write tells its caller: the asset's ref and the content it now holds (absent after a delete or retire). */
export interface WriteResult {
  ref: string;
  content?: string | Buffer;
}

export interface AssetWriter {
  /** The asset `conceptId` names in the target's bundle, or undefined. */
  read(conceptId: string): Asset | undefined;
  /** An existing asset by ref, else where a new one of the ref's type goes. */
  address(ref: string): AssetAddress;
  /**
   * `exclusive`: refuse an existing asset. `verbatim`: keep `content` exactly, not in the adapter's form for the type.
   * `replaceLink`: an asset file that is a symbolic link to a file inside the bundle is replaced by a regular file;
   * `"any"`: a link to anywhere (or to nothing) is replaced, and what it led to is not written (clone, as base).
   */
  create(
    asset: NewAsset,
    options?: { exclusive?: boolean; verbatim?: boolean; replaceLink?: boolean | "any" },
  ): WriteResult;
  update(
    conceptId: string,
    content: string | Buffer,
    options?: { revision?: string; throughLink?: boolean },
  ): WriteResult;
  /** A package entry deletes its whole package, non-asset files included. */
  delete(conceptId: string, options?: { revision?: string }): WriteResult;
  /**
   * Make the package of `asset` an exact mirror of `files` (§0.2 P12): non-asset files included, existing files
   * overwritten, files `files` lacks removed, bytes and modes kept, nothing changed when it fails. An existing package
   * is refused unless `replace`. The result is the package entry's.
   */
  mirrorPackage(
    asset: Pick<NewAsset, "type" | "name">,
    files: readonly PackageFile[],
    options?: { replace?: boolean },
  ): WriteResult;
  /**
   * Take the asset out recoverably, keeping `note` with it: one retirement per asset, a package entry's first and then
   * every other asset of its package. A handle is the adapter's: pass it back to `restore` and `forget`, never parse it.
   */
  retire(conceptId: string, note: RetireNote, options?: { revision?: string }): Array<{ ref: string; handle: string }>;
  retired(): Retirement[];
  restore(handle: string, fallback?: string | Buffer): WriteResult;
  forget(handle: string): void;
  expireRetired(before: Date): void;
}

/** Where a write to `ref` goes, refusing nothing a write would refuse. Only an invalid ref throws. */
function addressIn(held: AssetBundle, ref: string): AssetAddress {
  const readIn = (id: string): Asset | undefined => readFrom(held, id);
  const { conceptId: written, fragment } = parseBundleRef(ref);
  const holding = (found: Asset, placement: AssetPlacement | undefined): AssetAddress => {
    const { conceptId } = found;
    const type = assetType(found);
    const typeDir = stashDirFor(type);
    const name =
      typeDir !== undefined && conceptId.startsWith(`${typeDir}/`) ? conceptId.slice(typeDir.length + 1) : conceptId;
    return {
      conceptId,
      type,
      name,
      exists: true,
      ...(found.entry.file !== undefined ? { file: found.entry.file } : {}),
      // The asset is kept under a key other than the one a create of the ref writes.
      ...(placement?.key !== undefined && placement.key !== found.entry.key ? { heldElsewhere: true } : {}),
    };
  };
  /** Where a create of the ref goes; undefined for a name that cannot be placed. */
  const placementOf = (): AssetPlacement | undefined => {
    try {
      return held.place(parsePlacementRef(ref));
    } catch {
      return undefined;
    }
  };
  const found = fragment === undefined ? readIn(written) : undefined;
  // Where a create of the ref would write, for a ref a create can place; the ref of any other asset has none.
  if (found) return holding(found, placementOf());
  const placed = parsePlacementRef(ref);
  const named = { type: placed.type, name: placed.name, exists: false };
  const placement = placementOf();
  const shown = placement?.file !== undefined ? { file: placement.file } : {};
  // Not a write: the asset is named as written; the file is only the display path the adapter would give it.
  if (!held.writes(placed.type)) return { conceptId: written, ...named, ...shown };
  // A name that cannot be placed is named as written; a write refuses it where it is made.
  const conceptId = placement?.conceptId ?? written;
  // A create replaces the asset at the concept it places (`env/default` is placed as the concept `env/.env` holds).
  const there = conceptId !== written && fragment === undefined ? readIn(conceptId) : undefined;
  if (there) return holding(there, placement);
  // A directory, or any other entry no adapter reads as an asset, where a create writes holds the ref too.
  return { conceptId, ...named, exists: placement?.occupied === true, ...shown };
}

/** Where a write to `ref` goes, with the refusals a write makes: a type its adapter does not write, a name it cannot place. */
function gatedAddressIn(held: AssetBundle, ref: string): AssetAddress {
  const address = addressIn(held, ref);
  if (address.exists) return address;
  const placed = parsePlacementRef(ref);
  held.assertWrites(placed.type);
  held.place(placed);
  return address;
}

/**
 * Where a write to `ref` goes in the bundle `bundle`, without a write session. Unlike {@link AssetWriter.address} it
 * refuses nothing a write would refuse (a type the bundle's adapter does not write, a name it cannot place): nothing is
 * written, so the write refuses where it is made. Only an invalid ref throws.
 */
export function addressOf(bundle: string, ref: string): AssetAddress {
  return addressIn(bundleFor(bundle), ref);
}

/**
 * The file `ref` is kept in (the existing asset's, else the one a create would write) in a bundle that keeps assets as
 * files; undefined for a store, which keeps none and is not asked. For checks on where a name lands, never to find it.
 */
export function fileOfRef(bundle: string, ref: string): string | undefined {
  const held = bundleFor(bundle);
  return held.isStore ? undefined : addressIn(held, ref).file;
}

/**
 * The ref of the asset an old stored record named by a bundle-relative path (`changes[].path`), for converters only
 * (§8.4). Valid when no file holds the asset any more; undefined when the path is no asset's.
 */
export function legacyRefOf(bundle: string, relPath: string): string | undefined {
  const conceptId = bundleFor(bundle).identifyKey(relPath);
  return conceptId === null ? undefined : makeBundleRef(bundle, conceptId);
}

/**
 * The concept id of the asset a file of the directory bundle `bundle` would hold, from the path alone (the adapter's rule);
 * undefined when the file is outside the bundle or no asset's. For a caller that holds a file it read and writes the asset.
 */
export function conceptIdAtFile(bundle: string, file: string): string | undefined {
  const held = bundleFor(bundle);
  const key = toPosix(path.relative(held.root, file));
  return key === "" || key.startsWith("..") ? undefined : (held.identifyKey(key) ?? undefined);
}

function writerFor(target: ResolvedWriteTarget): AssetWriter {
  const { source, config } = target;
  const held = assetBundleOf(source);
  /** Record the files a change touched for the boundary commit and the run's provenance; answer with its result. */
  const record = (change: { changed: string[] }): void => {
    for (const file of change.changed) {
      recordWriteTargetPath(source, file);
      // Run-scoped write provenance (#652).
      recordWrittenPath(file);
    }
  };
  /** What the index holds for the asset a change touched: its row is written again, or dropped with the asset. */
  const reindex = (change: AssetChange, kept: boolean): void => {
    // The entry the write handed back (a keyring's item), else what the bundle reads for the concept now.
    const asset = !kept
      ? undefined
      : change.entry
        ? assetOf(held, { conceptId: change.conceptId, entry: change.entry })
        : readFrom(held, change.conceptId);
    const updated = asset ? refreshIndexedAsset(asset) : forgetIndexedAsset(held, change.conceptId);
    // A store's asset is found through its index row alone: a row not updated is a secret later commands miss or still list.
    if (!updated && held.isStore) {
      warn(
        `The index was not updated for "${makeBundleRef(source.name, change.conceptId)}" (no index, or another akm is writing it): run \`akm index\` so other commands see the change.`,
      );
    }
  };
  const result = (change: AssetChange, kept = true): WriteResult => {
    record(change);
    reindex(change, kept);
    return {
      ref: makeBundleRef(source.name, change.conceptId),
      ...(change.content !== undefined ? { content: change.content } : {}),
    };
  };
  /** The asset a change applies to, after the gates every change to an existing asset passes. */
  const existing = (conceptId: string, options?: { revision?: string; retire?: boolean }): Asset => {
    gate(source, config);
    const asset = readFrom(held, conceptId);
    if (!asset) throw assetNotFound(`${source.name}//${conceptId}`);
    const type = assetType(asset);
    held.assertWrites(type);
    if (options?.retire) held.assertRetires(type);
    if (options?.revision !== undefined && assetRevision(asset.entry.bytes()) !== options.revision) {
      throw new UsageError(
        `Asset "${source.name}//${conceptId}" changed since it was read; the change was not applied.`,
        "ASSET_CONTENT_CHANGED",
      );
    }
    return asset;
  };
  return {
    read: (conceptId) => readFrom(held, conceptId),
    address: (ref) => gatedAddressIn(held, ref),
    create(asset, options) {
      gate(source, config);
      held.assertWrites(asset.type);
      if (options?.exclusive) {
        const { conceptId } = held.place(asset);
        if (held.read(conceptId)) {
          throw new UsageError(`Asset "${source.name}//${conceptId}" already exists.`, "RESOURCE_ALREADY_EXISTS");
        }
      }
      // Without `exclusive` a create replaces the asset, with the bytes a create writes.
      return result(
        held.create(asset, {
          replace: !options?.exclusive,
          verbatim: options?.verbatim,
          replaceLink: options?.replaceLink,
        }),
      );
    },
    update(conceptId, content, options) {
      existing(conceptId, options);
      return result(held.update(conceptId, content, { throughLink: options?.throughLink }));
    },
    delete(conceptId, options) {
      existing(conceptId, options);
      // A package's delete is one change per asset it held, the entry's first: every row of them leaves the index.
      const [entry, ...members] = held.delete(conceptId);
      for (const member of members) result(member, false);
      return result(entry as AssetChange, false);
    },
    mirrorPackage(asset, files, options) {
      gate(source, config);
      held.assertWrites(asset.type);
      const [entry, ...others] = held.mirrorPackage(asset, files, { replace: options?.replace });
      for (const change of others) result(change);
      return result(entry as AssetChange);
    },
    retire(conceptId, note, options) {
      existing(conceptId, { ...options, retire: true });
      return held.retire(conceptId, note).map((change) => ({ ref: result(change, false).ref, handle: change.handle }));
    },
    retired: () => held.retired(),
    restore(handle, fallback) {
      gate(source, config);
      held.assertRetiring();
      return result(held.restore(handle, fallback));
    },
    forget(handle) {
      gate(source, config);
      held.assertRetiring();
      record(held.forget(handle));
    },
    expireRetired(before) {
      gate(source, config);
      held.assertRetiring();
      record(held.expireRetired(before));
    },
  };
}

/**
 * Run `run` with a writer for `target`'s bundle, under the asset-mutation lease (re-entrant, so an async caller
 * holding `withAssetMutationLease` may call it). Every change's files are recorded for the target's boundary commit
 * and the run's write provenance. With `message`, the boundary commit runs when `run` returns; without, the
 * caller's own boundary commits them.
 */
export function writeAssets<T>(
  target: ResolvedWriteTarget,
  options: { purpose: string; message?: string },
  run: (writer: AssetWriter) => T,
): T {
  return withAssetMutationLeaseSync(options.purpose, () => {
    const result = run(writerFor(target));
    if (options.message !== undefined) commitWriteTargetBoundary(target, options.message);
    return result;
  });
}
