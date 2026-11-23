// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Writing assets: the one write side of the asset facade. {@link writeAssets} runs a session against a write
 * target's bundle under the asset-mutation lease; every change the session makes passes the same gates here, in the
 * same order, whichever adapter holds the bundle, and its files are recorded for the target's boundary commit.
 */

import fs from "node:fs";
import { withAssetMutationLeaseSync } from "../../indexer/index-writer-lock";
import type { SearchSource } from "../../indexer/search/search-source";
import type { AssetChange, NewAsset, Retirement, RetireNote } from "../adapter/bundle-adapter";
import { stashDirFor } from "../asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { parsePlacementRef } from "../asset/resolve-ref";
import { assetNotFound, ConfigError, UsageError } from "../errors";
import { recordWrittenPath } from "../write-provenance";
import {
  commitWriteTargetBoundary,
  ensureWritable,
  isWriteCapableSourceKind,
  type ResolvedWriteTarget,
  recordWriteTargetPath,
} from "../write-source";
import { type AssetBundle, assetBundleOf } from "./bundle";
import { type Asset, assetRevision, readFrom } from "./read";
import { assetType, forgetIndexedAsset, refreshIndexedAsset } from "./type";

/**
 * The gates every write passes: the bundle takes writes, and it is a kind akm writes (a directory, a git checkout, or a
 * store its adapter keeps). A source built by hand of another kind is refused, as the loader would refuse it.
 */
function gate(source: ResolvedWriteTarget["source"], config: ResolvedWriteTarget["config"]): void {
  ensureWritable(source, config);
  if (source.kind === "location" || isWriteCapableSourceKind(source.kind)) return;
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
  /** The bundle the ref names, when it names one. */
  origin?: string;
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
  /** The file a create of the ref writes when no asset holds it; differs from `file` when the asset is held under another spelling. */
  placedFile?: string;
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
  /** `exclusive`: refuse an existing asset. `verbatim`: keep `content` exactly, not in the adapter's form for the type. */
  create(asset: NewAsset, options?: { exclusive?: boolean; verbatim?: boolean }): WriteResult;
  update(conceptId: string, content: string | Buffer, options?: { revision?: string }): WriteResult;
  delete(conceptId: string, options?: { revision?: string }): WriteResult;
  retire(conceptId: string, note: RetireNote, options?: { revision?: string }): WriteResult & { handle: string };
  retired(): Retirement[];
  restore(handle: string, fallback?: string | Buffer): WriteResult;
  forget(handle: string): void;
  expireRetired(before: Date): void;
}

type WriteSource = { name: string; path: string; location?: string; adapterId?: string };

function searchSourceOf(source: WriteSource): SearchSource {
  return {
    path: source.path,
    registryId: source.name,
    ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
    ...(source.location !== undefined ? { location: source.location } : {}),
  };
}

/** `gate`: refuse a new asset of a type the bundle's adapter does not write, as a write would. */
function addressIn(held: AssetBundle, source: WriteSource, ref: string, gate: boolean): AssetAddress {
  const readIn = (id: string): Asset | undefined => readFrom(searchSourceOf(source), source.name, id);
  const { bundle: origin, conceptId: written, fragment } = parseBundleRef(ref);
  const holding = (found: Asset, placedFile: () => string | undefined): AssetAddress => {
    const { conceptId } = found;
    const type = assetType(found);
    const typeDir = stashDirFor(type);
    const name =
      typeDir !== undefined && conceptId.startsWith(`${typeDir}/`) ? conceptId.slice(typeDir.length + 1) : conceptId;
    const placedAt = placedFile();
    return {
      conceptId,
      type,
      name,
      ...(origin !== undefined ? { origin } : {}),
      exists: true,
      ...(found.entry.file !== undefined ? { file: found.entry.file } : {}),
      ...(placedAt !== undefined ? { placedFile: placedAt } : {}),
    };
  };
  const found = fragment === undefined ? readIn(written) : undefined;
  if (found) {
    // Where a create of the ref would write, for a ref a create can place; the ref of any other asset has none.
    return holding(found, () => {
      try {
        return held.placedFile(parsePlacementRef(ref));
      } catch {
        return undefined;
      }
    });
  }
  const placed = parsePlacementRef(ref);
  const named = { type: placed.type, name: placed.name, ...(origin !== undefined ? { origin } : {}), exists: false };
  if (!held.writes(placed.type)) {
    if (gate) held.assertWrites(placed.type);
    // Not a write: the asset is named as written; the file is only the display path the adapter would give it.
    let shown: string | undefined;
    try {
      shown = held.placedFile(placed);
    } catch {
      shown = undefined;
    }
    return { conceptId: written, ...named, ...(shown !== undefined ? { file: shown } : {}) };
  }
  // Placement can refuse (a name that would be kept where no asset is). A write refuses where it is made, so only a
  // gated address does here; one that only says where an asset goes names it as written.
  const attempt = <T>(place: () => T): T | undefined => {
    try {
      return place();
    } catch (error) {
      if (gate) throw error;
      return undefined;
    }
  };
  const file = attempt(() => held.placedFile(placed));
  const conceptId = attempt(() => held.place(placed)) ?? written;
  // A create replaces the asset at the concept it places (`env/default` is placed as the concept `env/.env` holds).
  const there = conceptId !== written && fragment === undefined ? readIn(conceptId) : undefined;
  if (there) return holding(there, () => file);
  // A directory, or any other entry no adapter reads as an asset, at the file a create writes holds the ref too.
  const occupied = file !== undefined && fs.existsSync(file);
  return { conceptId, ...named, exists: occupied, ...(file !== undefined ? { file } : {}) };
}

/**
 * Where a write to `ref` goes in `source`'s bundle, without a write session. Unlike {@link AssetWriter.address} it
 * refuses nothing a write would refuse (a type the bundle's adapter does not write, a name it cannot place): nothing is
 * written, so the write refuses where it is made. Only an invalid ref throws.
 */
export function addressOf(source: WriteSource, ref: string): AssetAddress {
  return addressIn(assetBundleOf(source), source, ref, false);
}

/**
 * The file `ref` is kept in (the existing asset's, else the one a create would write) in a bundle that keeps assets as
 * files; undefined for a store, which keeps none and is not asked. For checks on where a name lands, never to find it.
 */
export function fileOfRef(source: WriteSource, ref: string): string | undefined {
  return assetBundleOf(source).isStore ? undefined : addressOf(source, ref).file;
}

/**
 * The ref of the asset an old stored record named by a bundle-relative path (`changes[].path`), for converters only
 * (§8.4). Valid when no file holds the asset any more; undefined when the path is no asset's.
 */
export function legacyRefOf(source: WriteSource, relPath: string): string | undefined {
  const conceptId = assetBundleOf(source).identifyKey(relPath);
  return conceptId === null ? undefined : makeBundleRef(source.name, conceptId);
}

/** The asset `conceptId` names in `source`'s bundle, read outside a write session. */
export function readAsset(source: WriteSource, conceptId: string): Asset | undefined {
  return readFrom(searchSourceOf(source), source.name, conceptId);
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
    const asset = kept ? readAsset(source, change.conceptId) : undefined;
    if (asset) refreshIndexedAsset(asset);
    else forgetIndexedAsset(searchSourceOf(source), source.name, change.conceptId);
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
    const asset = readAsset(source, conceptId);
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
    read: (conceptId) => readAsset(source, conceptId),
    address: (ref) => addressIn(held, source, ref, true),
    create(asset, options) {
      gate(source, config);
      held.assertWrites(asset.type);
      if (options?.exclusive) {
        const conceptId = held.place(asset);
        if (held.read(conceptId)) {
          throw new UsageError(`Asset "${source.name}//${conceptId}" already exists.`, "RESOURCE_ALREADY_EXISTS");
        }
      }
      // Without `exclusive` a create replaces the asset, with the bytes a create writes.
      return result(held.create(asset, { replace: !options?.exclusive, verbatim: options?.verbatim }));
    },
    update(conceptId, content, options) {
      existing(conceptId, options);
      return result(held.update(conceptId, content));
    },
    delete(conceptId, options) {
      existing(conceptId, options);
      return result(held.delete(conceptId), false);
    },
    retire(conceptId, note, options) {
      existing(conceptId, { ...options, retire: true });
      const change = held.retire(conceptId, note);
      return { ...result(change, false), handle: change.handle };
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
