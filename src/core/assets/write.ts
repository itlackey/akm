// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Writing assets: the one write side of the asset facade. {@link writeAssets} runs a session against a write
 * target's bundle under the asset-mutation lease; every change the session makes passes the same gates here, in the
 * same order, whichever adapter holds the bundle, and its files are recorded for the target's boundary commit.
 */

import { withAssetMutationLeaseSync } from "../../indexer/index-writer-lock";
import type { SearchSource } from "../../indexer/search/search-source";
import type { AssetChange, NewAsset, Retirement, RetireNote } from "../adapter/bundle-adapter";
import { stashDirFor } from "../asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../asset/asset-ref";
import { parsePlacementRef } from "../asset/resolve-ref";
import { NotFoundError, UsageError } from "../errors";
import { recordWrittenPath } from "../write-provenance";
import {
  commitWriteTargetBoundary,
  ensureWritable,
  type ResolvedWriteTarget,
  recordWriteTargetPath,
} from "../write-source";
import { type AssetBundle, assetBundleOf } from "./bundle";
import { type Asset, assetRevision, readFrom } from "./read";
import { assetType, forgetIndexedAsset, refreshIndexedAsset } from "./type";

/** Where a write to a ref goes. */
export interface AssetAddress {
  conceptId: string;
  type: string;
  /** The name within the type (`prod` for `env/prod`). */
  name: string;
  /** The bundle the ref names, when it names one. */
  origin?: string;
  /** Whether an asset holds the ref now. Otherwise `conceptId` is where a new asset of the ref's type goes. */
  exists: boolean;
  /** The file that holds the asset, when it exists and its bundle keeps it as a file. */
  file?: string;
}

/** What a write tells its caller: the asset's ref, and the content it now holds (absent after a delete or retire). */
export interface WriteResult {
  ref: string;
  content?: string | Buffer;
}

export interface AssetWriter {
  /** The asset `conceptId` names in the target's bundle, or undefined. */
  read(conceptId: string): Asset | undefined;
  /** An existing asset by ref, else where a new one of the ref's type goes. */
  address(ref: string): AssetAddress;
  create(asset: NewAsset, options?: { exclusive?: boolean }): WriteResult;
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

function addressIn(held: AssetBundle, source: WriteSource, ref: string): AssetAddress {
  const readIn = (id: string): Asset | undefined => readFrom(searchSourceOf(source), source.name, id);
  const { bundle: origin, conceptId: written, fragment } = parseBundleRef(ref);
  const found = fragment === undefined ? readIn(written) : undefined;
  if (found) {
    const { conceptId } = found;
    const type = assetType(found);
    const typeDir = stashDirFor(type);
    const name =
      typeDir !== undefined && conceptId.startsWith(`${typeDir}/`) ? conceptId.slice(typeDir.length + 1) : conceptId;
    return {
      conceptId,
      type,
      name,
      ...(origin !== undefined ? { origin } : {}),
      exists: true,
      ...(found.entry.file !== undefined ? { file: found.entry.file } : {}),
    };
  }
  const placed = parsePlacementRef(ref);
  held.assertWrites(placed.type);
  return {
    conceptId: held.place(placed),
    type: placed.type,
    name: placed.name,
    ...(origin !== undefined ? { origin } : {}),
    exists: false,
  };
}

/** Where a write to `ref` goes in `source`'s bundle, without a write session: the address {@link AssetWriter.address} gives. */
export function addressOf(source: WriteSource, ref: string): AssetAddress {
  return addressIn(assetBundleOf(source), source, ref);
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
    ensureWritable(source, config);
    const asset = readAsset(source, conceptId);
    if (!asset) throw new NotFoundError(`Asset not found: ${source.name}//${conceptId}`);
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
    address: (ref) => addressIn(held, source, ref),
    create(asset, options) {
      ensureWritable(source, config);
      held.assertWrites(asset.type);
      if (options?.exclusive) {
        const conceptId = held.place(asset);
        if (held.read(conceptId)) {
          throw new UsageError(`Asset "${source.name}//${conceptId}" already exists.`, "RESOURCE_ALREADY_EXISTS");
        }
      }
      // Without `exclusive` a create replaces the asset, and the adapter refuses to create over one: its content is
      // updated (the store keeps what else it holds of it), or a package is taken out whole first.
      if (!options?.exclusive) {
        const conceptId = held.place(asset);
        if (held.read(conceptId)) {
          if (!asset.resources?.length) return result(held.update(conceptId, asset.content));
          record(held.delete(conceptId));
        }
      }
      return result(held.create(asset));
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
      ensureWritable(source, config);
      return result(held.restore(handle, fallback));
    },
    forget(handle) {
      ensureWritable(source, config);
      record(held.forget(handle));
    },
    expireRetired(before) {
      ensureWritable(source, config);
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
