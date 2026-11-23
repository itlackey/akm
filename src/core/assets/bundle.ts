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
import { bundleAdapterId } from "../adapter/detect-adapter";
import { bundleOf, requireAdapter } from "../adapter/registry";
import type { AssetEdit, Bundle, Diagnostic, IndexDocument, ValidateContext } from "../adapter/types";
import { UsageError, type UsageErrorCode } from "../errors";

type BundleSource = { name: string; path: string; location?: string; adapterId?: string };

export class AssetBundle {
  /** The id refs use. */
  readonly name: string;
  readonly #adapter: BundleAdapter;
  readonly #bundle: Bundle;

  /** The adapter the source is configured with, else the one its root's probe finds. */
  constructor(source: BundleSource) {
    this.name = source.name;
    this.#adapter = requireAdapter(source.name, bundleAdapterId(source), { location: source.location !== undefined });
    this.#bundle = bundleOf(source);
  }

  /** The id of the adapter that holds this bundle. */
  get adapterId(): string {
    return this.#adapter.id;
  }

  /** The prefix of the freshness variant the index records for this adapter's rows: id and version. */
  get variantPrefix(): string {
    return `${this.#adapter.id}@${this.#adapter.version}+`;
  }

  /** Whether this bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. */
  writes(type: string): boolean {
    return this.#adapter.writes.includes(type);
  }

  /** Refuse a write this bundle's adapter does not make: it writes nothing, or (with `type`) not assets of that type. The sentence is the one base gave. */
  assertWrites(type?: string): void {
    const { writes } = this.#adapter;
    if (writes.length > 0 && (type === undefined || this.writes(type))) return;
    this.refuse("does not support AKM asset writes", "INVALID_FLAG_VALUE");
  }

  /** Refuse with a message that names this bundle and its adapter: `Bundle "x" uses adapter "y", which <what>.` */
  refuse(what: string, code: UsageErrorCode): never {
    throw new UsageError(`Bundle "${this.name}" uses adapter "${this.#adapter.id}", which ${what}.`, code);
  }

  /** Refuse a retirement of `type`: this bundle's adapter deletes assets of it. */
  assertRetires(type: string): void {
    if (this.#adapter.retires.includes(type)) return;
    this.refuse("does not support AKM asset writes", "INVALID_FLAG_VALUE");
  }

  /** Refuse retirement bookkeeping (restore, forget, expire) on a bundle whose adapter retires no type. */
  assertRetiring(): void {
    if (this.#adapter.retires.length > 0) return;
    this.refuse("does not support AKM asset writes", "INVALID_FLAG_VALUE");
  }

  /** Whether the bundle is a store (a keyring, a vault) rather than a directory. */
  get isStore(): boolean {
    return this.#adapter.addressedBy === "location";
  }
  /** Whether the bundle's storage is there. */
  exists(): boolean {
    return this.#adapter.exists(this.#bundle);
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
  validate(edits: AssetEdit[], ctx: ValidateContext): Promise<Diagnostic[]> {
    return this.#adapter.validate(this.#bundle, edits, ctx);
  }
  place(asset: Pick<NewAsset, "type" | "name">): string {
    return this.#adapter.place(this.#bundle, asset);
  }
  /** The file a new asset would be kept at, when its adapter keeps assets as files and writes the type. Display only. */
  placedFile(asset: Pick<NewAsset, "type" | "name">): string | undefined {
    return this.#adapter.placedFile?.(this.#bundle, asset);
  }
  /** The concept id a stored key holds, from the key alone; null when it holds none or the adapter has no keys. */
  identifyKey(key: string): string | null {
    return this.#adapter.identifyKey?.(this.#bundle, key) ?? null;
  }
  create(asset: NewAsset, options?: { replace?: boolean; verbatim?: boolean }): AssetChange {
    return this.#adapter.create(this.#bundle, asset, options);
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
