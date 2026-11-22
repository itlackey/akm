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
import { type AssetBundle, assertAdapterWrites, assetBundleOf } from "./bundle";
import { type Asset, assetRevision, warnOutdatedRef, withoutTypeHead } from "./read";

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
  readonly bundle: AssetBundle;
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
  forget(handle: string): AssetChange;
  expireRetired(before: Date): AssetChange;
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

function readIn(
  { adapter, bundle }: AssetBundle,
  source: WriteSource,
  conceptId: string,
  options: { unlisted?: boolean; mode: "read" | "write" },
): Asset | undefined {
  const found = adapter.read(bundle, conceptId, { mode: options.mode });
  if (!found || !(found.listed || options.unlisted)) return undefined;
  return {
    bundle: bundle.id,
    conceptId: found.conceptId,
    ref: `${bundle.id}//${found.conceptId}`,
    get type() {
      return found.type;
    },
    entry: found.entry,
    listed: found.listed,
    source: searchSourceOf(source),
    adapterId: adapter.id,
  };
}

function addressIn(held: AssetBundle, source: WriteSource, ref: string): AssetAddress {
  const { bundle: origin, conceptId: asWritten, fragment } = parseBundleRef(ref);
  let conceptId = asWritten;
  let found = fragment === undefined ? readIn(held, source, conceptId, { mode: "read" }) : undefined;
  const current = fragment === undefined && !found ? withoutTypeHead(asWritten) : undefined;
  if (current !== undefined) {
    found = readIn(held, source, current, { mode: "read" });
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
  return {
    conceptId: held.adapter.place(held.bundle, placed),
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

function writerFor(target: ResolvedWriteTarget): AssetWriter {
  const { source, config } = target;
  const held = assetBundleOf(source);
  const { adapter, bundle } = held;
  const record = <T extends AssetChange>(change: T): T => {
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
    const asset = readIn(held, source, conceptId, { unlisted: true, mode: "write" });
    if (!asset) throw new NotFoundError(`Asset not found: ${source.name}//${conceptId}`);
    const { type } = asset;
    assertAdapterWrites(source, type);
    if (options?.retire && !adapter.retires.includes(type)) {
      throw new UsageError(
        `Bundle "${source.name}" uses adapter "${adapter.id}", which does not retire ${type} assets.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (options?.revision !== undefined && assetRevision(asset.entry.bytes()) !== options.revision) {
      throw new UsageError(
        `Asset "${source.name}//${conceptId}" changed since it was read; the change was not applied.`,
        "ASSET_CONTENT_CHANGED",
      );
    }
    return asset;
  };
  return {
    bundle: held,
    read: (conceptId, options) => readIn(held, source, conceptId, { unlisted: options?.unlisted, mode: "write" }),
    address: (ref) => addressIn(held, source, ref),
    create(asset, options) {
      ensureWritable(source, config);
      assertAdapterWrites(source, asset.type);
      if (options?.exclusive) {
        const conceptId = adapter.place(bundle, asset);
        if (adapter.read(bundle, conceptId)) {
          throw new UsageError(`Asset "${source.name}//${conceptId}" already exists.`, "RESOURCE_ALREADY_EXISTS");
        }
      }
      return record(adapter.create(bundle, asset));
    },
    update(conceptId, content, options) {
      existing(conceptId, options);
      return record(adapter.update(bundle, conceptId, content));
    },
    delete(conceptId, options) {
      existing(conceptId, options);
      return record(adapter.delete(bundle, conceptId));
    },
    retire(conceptId, note, options) {
      existing(conceptId, { ...options, retire: true });
      return record(adapter.retire(bundle, conceptId, note));
    },
    retired: () => adapter.retired(bundle),
    restore(handle, fallback) {
      ensureWritable(source, config);
      return record(adapter.restore(bundle, handle, fallback));
    },
    forget(handle) {
      ensureWritable(source, config);
      return record(adapter.forget(bundle, handle));
    },
    expireRetired(before) {
      ensureWritable(source, config);
      return record(adapter.expireRetired(bundle, before));
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
