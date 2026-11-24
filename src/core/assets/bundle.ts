// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A bundle as the asset facade sees it. It holds its adapter privately, so nothing outside this module calls an
 * adapter member except through the gates the facade puts in front of it, and it is the one mapping from a source or
 * write target to its adapter: nothing outside `src/core/adapter/` and this module asks the registry for one.
 */

import fs from "node:fs";
import { readUsableIndex } from "../../indexer/index-readiness";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { getStoreFindings } from "../../storage/repositories/index-meta-repository";
import type {
  AssetChange,
  AssetEntry,
  AssetPlacement,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  PackageFile,
  Retirement,
  RetireNote,
} from "../adapter/bundle-adapter";
import { bundleAdapterId } from "../adapter/detect-adapter";
import { bundleOf, requireAdapter } from "../adapter/registry";
import type { AssetEdit, Bundle, Diagnostic, IndexDocument, ValidateContext } from "../adapter/types";
import { deriveBundleIds } from "../bundle-id";
import { resolveStashDir } from "../common";
import { type AkmConfig, loadConfig } from "../config/config";
import { bundleAtDir } from "../config/config-sources";
import { ConfigError, UsageError, type UsageErrorCode } from "../errors";
import { type BundleSource, materialisedBundle, materialisedBundles } from "../materialised-bundles";

export class AssetBundle {
  /** The id refs use. */
  readonly name: string;
  /** The directory its assets are read from (a store's synthetic root), and a store's `location`: for the index and for display only. */
  readonly root: string;
  readonly location?: string;
  /** The adapter that reads it, as recorded in config (found once where an old entry without one is resolved). */
  readonly adapterId: string;
  readonly #adapter: BundleAdapter;
  readonly #bundle: Bundle;

  /** The adapter the source is configured with, else the one its root's probe finds. */
  constructor(source: BundleSource) {
    this.name = source.name;
    this.root = source.path;
    if (source.location !== undefined) this.location = source.location;
    this.adapterId = bundleAdapterId(source);
    this.#adapter = requireAdapter(source.name, this.adapterId, { location: source.location !== undefined });
    this.#bundle = bundleOf(source);
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
  list(type?: string): BundleListing {
    return this.#adapter.list(this.#bundle, type);
  }
  read(conceptId: string): BundleAsset | undefined {
    return this.#adapter.read(this.#bundle, conceptId, this.#locator(conceptId));
  }
  /** What the index recorded of a store's entry for its adapter to find it by; a directory's entries need none. */
  #locator(conceptId: string): unknown {
    if (!this.isStore) return undefined;
    return readUsableIndex((db) => {
      const row = db
        .prepare("SELECT document_json FROM entries WHERE item_ref = ?")
        .get(`${this.name}//${conceptId}`) as { document_json: string } | undefined;
      return row ? (JSON.parse(row.document_json) as IndexDocument).locator : undefined;
    }, undefined);
  }
  recognize(entry: AssetEntry): IndexDocument | null {
    return this.#adapter.recognize(this.#bundle, entry);
  }
  /** The type the entry's bytes give it, when the adapter can say so without describing the entry (undefined: it types nothing, or cannot). */
  contentType(entry: AssetEntry): string | undefined {
    return this.#adapter.contentType?.(this.#bundle, entry);
  }
  /** The adapter's findings, and for a store what the last `akm index` found wrong with it (none when never indexed). */
  async validate(edits: AssetEdit[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const found = await this.#adapter.validate(this.#bundle, edits, ctx);
    if (!this.isStore) return found;
    return [...found, ...readUsableIndex((db) => getStoreFindings(db, this.name) ?? [], [])];
  }
  /** Where a create of the asset goes: its concept id and, for a bundle kept in files, where. A name that cannot be placed throws. */
  place(asset: Pick<NewAsset, "type" | "name">): AssetPlacement {
    return this.#adapter.place(this.#bundle, asset);
  }
  /** The concept id a stored key holds, from the key alone; null when it holds none or the adapter has no keys. */
  identifyKey(key: string): string | null {
    return this.#adapter.identifyKey?.(this.#bundle, key) ?? null;
  }
  create(
    asset: NewAsset,
    options?: { replace?: boolean; verbatim?: boolean; replaceLink?: boolean | "any" },
  ): AssetChange {
    const locator = this.isStore ? this.#locator(this.place(asset).conceptId) : undefined;
    return this.#adapter.create(this.#bundle, asset, { ...options, ...(locator !== undefined ? { locator } : {}) });
  }
  update(conceptId: string, content: string | Buffer, options?: { throughLink?: boolean }): AssetChange {
    const locator = this.#locator(conceptId);
    return this.#adapter.update(this.#bundle, conceptId, content, {
      ...options,
      ...(locator !== undefined ? { locator } : {}),
    });
  }
  delete(conceptId: string): AssetChange[] {
    const locator = this.#locator(conceptId);
    return this.#adapter.delete(this.#bundle, conceptId, locator !== undefined ? { locator } : {});
  }
  /** Every file of the package a package entry holds, non-assets included. */
  packageFiles(conceptId: string): PackageFile[] {
    return this.#adapter.packageFiles(this.#bundle, conceptId);
  }
  /** Make the package of `asset` an exact mirror of `files`; one change per asset added, changed or removed, the entry's first. */
  mirrorPackage(
    asset: Pick<NewAsset, "type" | "name">,
    files: readonly PackageFile[],
    options?: { replace?: boolean },
  ): AssetChange[] {
    return this.#adapter.mirrorPackage(this.#bundle, asset, files, options);
  }
  retire(conceptId: string, note: RetireNote): Array<AssetChange & { handle: string }> {
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

/** The bundle of a source: inside the facade, and for the install-time probes of a directory no bundle is configured at. */
export function assetBundleOf(source: BundleSource): AssetBundle {
  return new AssetBundle(source);
}

/**
 * The sources a lookup reads: the configured ones. When the working directory is a disabled configured bundle they
 * cannot be resolved as a set, and the enabled bundles are read without it.
 */
export function activeSources(config: AkmConfig): SearchSource[] {
  try {
    return resolveSourceEntries(undefined, config);
  } catch (cause) {
    const working = bundleAtDir(config, resolveStashDir());
    const entry = working ? config.bundles?.[working] : undefined;
    if (!(cause instanceof ConfigError) || !working || !entry || entry.enabled !== false) throw cause;
    const enabled = { ...config, bundles: { ...config.bundles, [working]: { ...entry, enabled: true } } };
    return resolveSourceEntries(undefined, enabled).filter((source) => source.registryId !== working);
  }
}

/**
 * The bundle `id` names: a configured bundle (the implicit working bundle and `AKM_BUNDLE_DIR` are among the resolved
 * sources), else a directory a command materialised (`materialiseBundleDir`). Its adapter is the one config records
 * for it. A configured bundle is never shadowed by a materialised one. Refused when no bundle has the id.
 */
export function bundleFor(id: string): AssetBundle {
  const materialised = materialisedBundle(id);
  let sources: SearchSource[] | undefined;
  try {
    sources = activeSources(loadConfig());
  } catch (cause) {
    // The configured sources need not be resolvable for a directory a command was handed.
    if (materialised === undefined) throw cause;
  }
  const source = sources?.[deriveBundleIds([...sources]).indexOf(id)];
  // A configured source is never shadowed; the implicit working bundle (no registry id) yields to a directory a command materialised under its id.
  if (source && (source.registryId !== undefined || !materialised || !fs.existsSync(materialised.path))) {
    return assetBundleOf(sourceBundle(id, source));
  }
  if (materialised) return assetBundleOf(materialised);
  throw new ConfigError(`Bundle "${id}" is not among the configured sources.`, "INVALID_CONFIG_FILE");
}

function sourceBundle(name: string, source: SearchSource): BundleSource {
  return {
    name,
    path: source.path,
    adapterId: bundleAdapterId(source),
    ...(source.location !== undefined ? { location: source.location } : {}),
  };
}

/** Every configured bundle in source order (the default bundle first); an unresolved source is left out. */
export function orderedBundles(): AssetBundle[] {
  const config = loadConfig();
  const sources = activeSources(config);
  const ids = deriveBundleIds(sources);
  return sources.flatMap((source, index) =>
    source.unresolved ? [] : [assetBundleOf(sourceBundle(ids[index] as string, source))],
  );
}

/**
 * The bundles a lookup looks in: the configured ones, then the directories a command materialised. The implicit working
 * bundle yields to a materialised directory that has its id; a configured bundle never does. A listing of every bundle
 * (`orderedBundles`) never includes the materialised ones.
 */
export function lookupBundles(): AssetBundle[] {
  const held = materialisedBundles();
  let sources: SearchSource[] = [];
  try {
    sources = activeSources(loadConfig());
  } catch (error) {
    // The configured sources can be unresolvable (no working directory) while the directories a command was handed are not.
    if (held.length === 0) throw error;
  }
  const ids = deriveBundleIds(sources);
  const heldIds = new Set(held.map((source) => source.name));
  const bundles = sources.flatMap((source, index) => {
    const id = ids[index] as string;
    if (source.unresolved || (source.registryId === undefined && heldIds.has(id))) return [];
    return [assetBundleOf(sourceBundle(id, source))];
  });
  const taken = new Set(bundles.map((bundle) => bundle.name));
  return [...bundles, ...held.filter((source) => !taken.has(source.name)).map((source) => assetBundleOf(source))];
}
