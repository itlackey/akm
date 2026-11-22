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
import { parseBundleRef } from "../asset/asset-ref";
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
import { type Asset, assetRevision, readFrom, warnOutdatedRef, withoutTypeHead } from "./read";

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

export interface AssetWriter {
  /** The asset `conceptId` names in the target's bundle, or undefined. */
  read(conceptId: string, options?: { unlisted?: boolean }): Asset | undefined;
  /** An existing asset by ref (the outdated spelling retried), else where a new one of the ref's type goes. */
  address(ref: string): AssetAddress;
  create(asset: NewAsset, options?: { exclusive?: boolean }): AssetChange;
  update(conceptId: string, content: string | Buffer, options?: { revision?: string }): AssetChange;
  delete(conceptId: string, options?: { revision?: string }): AssetChange;
  retire(conceptId: string, note: RetireNote, options?: { revision?: string }): AssetChange & { handle: string };
  retired(): Retirement[];
  restore(handle: string, fallback?: string | Buffer): AssetChange;
  forget(handle: string): { changed: string[] };
  expireRetired(before: Date): { changed: string[] };
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
  const readIn = (id: string): Asset | undefined => readFrom(searchSourceOf(source), source.name, id, { mode: "read" });
  const { bundle: origin, conceptId: asWritten, fragment } = parseBundleRef(ref);
  let conceptId = asWritten;
  let found = fragment === undefined ? readIn(conceptId) : undefined;
  const current = fragment === undefined && !found ? withoutTypeHead(asWritten) : undefined;
  if (current !== undefined) {
    found = readIn(current);
    if (found) {
      warnOutdatedRef(asWritten, current);
      conceptId = current;
    }
  }
  if (found) {
    const { type } = found;
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

/** The asset `conceptId` names in `source`'s bundle, read outside a write session; `unlisted` finds one `list` leaves out. */
export function readAsset(source: WriteSource, conceptId: string, options?: { unlisted?: boolean }): Asset | undefined {
  return readFrom(searchSourceOf(source), source.name, conceptId, { unlisted: options?.unlisted });
}

function writerFor(target: ResolvedWriteTarget): AssetWriter {
  const { source, config } = target;
  const held = assetBundleOf(source);
  const record = <T extends { changed: string[] }>(change: T): T => {
    for (const file of change.changed) {
      recordWriteTargetPath(source, file);
      // Run-scoped write provenance (#652).
      recordWrittenPath(file);
    }
    return change;
  };
  /** The asset a change applies to, after the gates every change to an existing asset passes. */
  const existing = (conceptId: string, options?: { revision?: string; retire?: boolean }): Asset => {
    ensureWritable(source, config);
    const asset = readAsset(source, conceptId, { unlisted: true });
    if (!asset) throw new NotFoundError(`Asset not found: ${source.name}//${conceptId}`);
    const { type } = asset;
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
    read: (conceptId, options) => readAsset(source, conceptId, options),
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
      return record(held.create(asset));
    },
    update(conceptId, content, options) {
      existing(conceptId, options);
      return record(held.update(conceptId, content));
    },
    delete(conceptId, options) {
      existing(conceptId, options);
      return record(held.delete(conceptId));
    },
    retire(conceptId, note, options) {
      existing(conceptId, { ...options, retire: true });
      return record(held.retire(conceptId, note));
    },
    retired: () => held.retired(),
    restore(handle, fallback) {
      ensureWritable(source, config);
      return record(held.restore(handle, fallback));
    },
    forget(handle) {
      ensureWritable(source, config);
      return record(held.forget(handle));
    },
    expireRetired(before) {
      ensureWritable(source, config);
      return record(held.expireRetired(before));
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
