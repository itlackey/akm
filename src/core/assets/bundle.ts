// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A bundle as the asset facade sees it. It holds its adapter privately, so nothing outside this module calls an
 * adapter member except through the gates the facade puts in front of it, and it is the one mapping from a source or
 * write target to its adapter: nothing outside `src/core/adapter/` and this module asks the registry for one.
 */

import type {
  AssetChange,
  AssetEntry,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  Retirement,
  RetireNote,
} from "../adapter/bundle-adapter";
import { adapterIdOf } from "../adapter/detect-adapter";
import { bundleOf, requireAdapter } from "../adapter/registry";
import type { Bundle, IndexDocument } from "../adapter/types";
import { UsageError } from "../errors";

type BundleSource = { name: string; path: string; location?: string; adapterId?: string };

export class AssetBundle {
  /** The id refs use. */
  readonly name: string;
  readonly #adapter: BundleAdapter;
  readonly #bundle: Bundle;

  /** The adapter the source is configured with, else the one its root's probe finds. */
  constructor(source: BundleSource) {
    this.name = source.name;
    this.#adapter = requireAdapter(source.name, adapterIdOf(source));
    this.#bundle = bundleOf(source);
  }

  /** Whether this bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. */
  writes(type: string): boolean {
    return this.#adapter.writes.includes(type);
  }

  /** Refuse a write this bundle's adapter does not make: it writes nothing, or (with `type`) not assets of that type. */
  assertWrites(type?: string): void {
    const { writes } = this.#adapter;
    if (writes.length > 0 && (type === undefined || this.writes(type))) return;
    throw new UsageError(
      writes.length === 0
        ? `Bundle "${this.name}" uses adapter "${this.#adapter.id}", which does not support AKM asset writes.`
        : `Bundle "${this.name}" uses adapter "${this.#adapter.id}", which does not write ${type} assets.`,
      "INVALID_FLAG_VALUE",
    );
  }

  /** Refuse a retirement of `type`: this bundle's adapter deletes assets of it. */
  assertRetires(type: string): void {
    if (this.#adapter.retires.includes(type)) return;
    throw new UsageError(
      `Bundle "${this.name}" uses adapter "${this.#adapter.id}", which does not retire ${type} assets.`,
      "INVALID_FLAG_VALUE",
    );
  }

  list(): BundleListing {
    return this.#adapter.list(this.#bundle);
  }
  read(conceptId: string): BundleAsset | undefined {
    return this.#adapter.read(this.#bundle, conceptId);
  }
  recognize(entry: AssetEntry): IndexDocument | null {
    return this.#adapter.recognize(this.#bundle, entry);
  }
  place(asset: Pick<NewAsset, "type" | "name">): string {
    return this.#adapter.place(this.#bundle, asset);
  }
  create(asset: NewAsset): AssetChange {
    return this.#adapter.create(this.#bundle, asset);
  }
  update(conceptId: string, content: string | Buffer): AssetChange {
    return this.#adapter.update(this.#bundle, conceptId, content);
  }
  delete(conceptId: string): AssetChange {
    return this.#adapter.delete(this.#bundle, conceptId);
  }
  retire(conceptId: string, note: RetireNote): AssetChange & { handle: string } {
    return this.#adapter.retire(this.#bundle, conceptId, note);
  }
  retired(): Retirement[] {
    return this.#adapter.retired(this.#bundle);
  }
  restore(handle: string, fallback?: string | Buffer): AssetChange {
    return this.#adapter.restore(this.#bundle, handle, fallback);
  }
  forget(handle: string): { changed: string[] } {
    return this.#adapter.forget(this.#bundle, handle);
  }
  expireRetired(before: Date): { changed: string[] } {
    return this.#adapter.expireRetired(this.#bundle, before);
  }
}

/** The bundle of a source. */
export function assetBundleOf(source: BundleSource): AssetBundle {
  return new AssetBundle(source);
}

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(source: BundleSource, type?: string): void {
  assetBundleOf(source).assertWrites(type);
}
