// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A bundle as the asset facade sees it. It holds its adapter privately, so nothing outside this module calls an
 * adapter member except through the gates the facade puts in front of it, and it is the one mapping from a source or
 * write target to its adapter: nothing outside `src/core/adapter/` and this module asks the registry for one.
 */

import fs from "node:fs";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
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
import { bundleIdForDir, deriveBundleIds } from "../bundle-id";
import { resolveStashDir, safeRealpath } from "../common";
import { type AkmConfig, loadConfig } from "../config/config";
import { bundleAtDir } from "../config/config-sources";
import { ConfigError, UsageError, type UsageErrorCode } from "../errors";

type BundleSource = { name: string; path: string; location?: string; adapterId?: string };

/**
 * Bundles of directories no configured bundle is at (an ad-hoc `--dir`, the working directory named by
 * `AKM_BUNDLE_DIR`, a directory a stored record names), by id. Each directory has one id, kept for the life of the process.
 */
const adHocBundles = new Map<string, BundleSource>();
const adHocIdOfDir = new Map<string, string>();

/**
 * Make the bundle of a directory a caller holds addressable by an id (`bundleFor`): one no config entry names, or one
 * config names but did not resolve to a directory (a git bundle not yet cloned that a write has just made; it keeps the
 * adapter and location config gives it). A configured bundle keeps its adapter and location, and a store is never replaced. Returns the id: the one the
 * directory already has, else `source.name`, else (another directory holds that id) an id derived from this
 * directory that no configured name and no other registered directory has. Use the returned id, not the one asked for.
 */
export function registerAdHocBundle(source: BundleSource): string {
  const config = loadConfig();
  const entry = config.bundles?.[source.name];
  const named = entry !== undefined;
  if (named) {
    // A configured bundle keeps the adapter and location config gives it, whatever the caller holds.
    let held: SearchSource | undefined;
    try {
      const sources = activeSources(config);
      held = sources[deriveBundleIds(sources).indexOf(source.name)];
    } catch {
      // The configured sources cannot be resolved as a set: this bundle is then taken as the caller holds it.
    }
    // A store, or a directory bundle the caller holds at the directory config resolves it to, is config's as it is.
    if (held !== undefined && !held.unresolved) {
      if (entry.location !== undefined || safeRealpath(held.path) === safeRealpath(source.path)) return source.name;
    }
    // Otherwise the caller holds the directory somewhere else (a scratch copy a task is checked in) or config has not
    // resolved it yet (a git bundle a write just cloned): it is kept where the caller has it.
    const adapterId = entry.adapter ?? held?.adapterId;
    source = {
      name: source.name,
      path: source.path,
      ...(adapterId !== undefined ? { adapterId } : {}),
      ...(entry.location !== undefined ? { location: entry.location } : {}),
    };
  }
  const dir = safeRealpath(source.path);
  // A name config gives a bundle is its id, whatever id the directory was registered under before (a rename).
  let id = named ? source.name : (adHocIdOfDir.get(dir) ?? source.name);
  const holder = adHocBundles.get(id);
  // An id whose directory is gone (a removed temporary directory) is free again.
  const heldByOther = !named && holder !== undefined && safeRealpath(holder.path) !== dir && fs.existsSync(holder.path);
  if (heldByOther) {
    id = bundleIdForDir(source.path, new Set([...Object.keys(config.bundles ?? {}), ...adHocBundles.keys()]));
  }
  adHocIdOfDir.set(dir, id);
  adHocBundles.set(id, { ...source, name: id });
  return id;
}

/** Forget the ad-hoc bundles: a host that serves many requests (AKM Desktop) and each test start clean. */
export function clearAdHocBundles(): void {
  adHocBundles.clear();
  adHocIdOfDir.clear();
}

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

  /** Whether this bundle's adapter declares assets of `type`: it writes them, or recognizes them without writing. */
  declares(type: string): boolean {
    return this.#adapter.writes.includes(type) || (this.#adapter.reads?.includes(type) ?? false);
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
  create(asset: NewAsset, options?: { replace?: boolean; verbatim?: boolean; replaceLink?: boolean }): AssetChange {
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
 * The bundle `id` names: a configured bundle, the implicit working bundle or `AKM_BUNDLE_DIR`, else an ad-hoc directory
 * recorded by `bundleSourceAt`. Its adapter is the one config records for it. Refused when no bundle has the id.
 */
export function bundleFor(id: string): AssetBundle {
  // An ad-hoc directory is recorded for an id no config entry has; the configured sources need not be resolvable for it.
  const adHoc = adHocBundles.get(id);
  if (adHoc && fs.existsSync(adHoc.path)) return assetBundleOf(adHoc);
  const sources = activeSources(loadConfig());
  const source = sources[deriveBundleIds([...sources]).indexOf(id)];
  if (source) return assetBundleOf(sourceBundle(id, source));
  if (adHoc) return assetBundleOf(adHoc);
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

/**
 * Every bundle in source order (the default bundle first); an unresolved source is left out. `adHoc`: then the
 * directories `bundleSourceAt` named, which a lookup may need and a listing never includes.
 */
export function orderedBundles(options: { adHoc?: boolean } = {}): AssetBundle[] {
  const config = loadConfig();
  let sources: SearchSource[] = [];
  try {
    sources = activeSources(config);
  } catch (error) {
    // The configured sources can be unresolvable (no working directory) while the directories a command was handed are not.
    if (!options.adHoc || adHocBundles.size === 0) throw error;
  }
  const ids = deriveBundleIds(sources);
  // An ad-hoc directory whose id a source also derives (two directories named `stash`) is the one a command named.
  const named = (id: string): BundleSource | undefined => {
    const held = adHocBundles.get(id);
    return options.adHoc && held !== undefined && fs.existsSync(held.path) ? held : undefined;
  };
  const bundles = sources.flatMap((source, index) =>
    source.unresolved || named(ids[index] as string) !== undefined
      ? []
      : [assetBundleOf(sourceBundle(ids[index] as string, source))],
  );
  if (options.adHoc) {
    for (const source of adHocBundles.values()) {
      if (fs.existsSync(source.path)) bundles.push(assetBundleOf(source));
    }
  }
  return bundles;
}
