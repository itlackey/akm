// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A bundle as the asset facade sees it. It holds its adapter privately, so nothing outside this module calls an
 * adapter member except through the gates the facade puts in front of it, and it is the one mapping from a source or
 * write target to its adapter: nothing outside `src/core/adapter/` and this module asks the registry for one.
 */

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
import { type AkmConfig, loadConfig } from "../config/config";
import { readCredential } from "../env-secret-ref";
import { ConfigError, UsageError, type UsageErrorCode } from "../errors";

export type BundleSource = { name: string; path?: string; location?: string; adapterId?: string };

/**
 * A bundle as a caller names it to the facade: a configured bundle by its id, else the source of a directory no config
 * names (a `--dir`, a root a stored record gives, a checkout cloned during a write), which the caller holds.
 */
export type BundleAddress = string | BundleSource;

/** The id refs use for `bundle`. */
export function bundleNameOf(bundle: BundleAddress): string {
  return typeof bundle === "string" ? bundle : bundle.name;
}

/** A store bundle as its adapter is given it: with its `credential`, which is read only when the adapter calls it. */
function withCredential(bundle: Bundle): Bundle {
  const reference = bundle.location !== undefined ? loadConfig().bundles?.[bundle.id]?.credential : undefined;
  return reference === undefined ? bundle : { ...bundle, credential: () => readCredential(bundle.id, reference) };
}

export class AssetBundle {
  /** The id refs use. */
  readonly name: string;
  /** The directory its assets are read from, absent for a store. */
  readonly root?: string;
  readonly location?: string;
  /** The adapter that reads it, as recorded in config (found once where an old entry without one is resolved). */
  readonly adapterId: string;
  readonly #adapter: BundleAdapter;
  readonly #bundle: Bundle;

  /** The adapter the source is configured with, else the one its root's probe finds. */
  constructor(source: BundleSource) {
    this.name = source.name;
    if (source.location !== undefined) this.location = source.location;
    this.adapterId = bundleAdapterId(source);
    this.#adapter = requireAdapter(source.name, this.adapterId, { location: source.location !== undefined });
    this.#bundle = withCredential(bundleOf(source));
    this.root = this.#bundle.root;
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
  /** What a create of `type` puts before the asset's name in its concept id (`tasks/`); empty when nothing. */
  prefixOf(type: string): string {
    return this.#adapter.prefixOf?.(type) ?? "";
  }
  /** The concept id a stored key holds, from the key alone; null when it holds none or the adapter has no keys. */
  identifyKey(key: string): string | null {
    return this.#adapter.identifyKey?.(this.#bundle, key) ?? null;
  }
  create(asset: NewAsset, options?: { replace?: boolean; verbatim?: boolean }): AssetChange {
    const locator = this.isStore ? this.#locator(this.place(asset).conceptId) : undefined;
    return this.#adapter.create(this.#bundle, asset, { ...options, ...(locator !== undefined ? { locator } : {}) });
  }
  update(conceptId: string, content: string | Buffer): AssetChange {
    const locator = this.#locator(conceptId);
    return this.#adapter.update(this.#bundle, conceptId, content, locator !== undefined ? { locator } : {});
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
 * The sources a lookup reads: the configured ones. When the working directory cannot be read as one of them (it is a
 * disabled configured bundle, or it is not there), the configured bundles are read without it.
 */
export function activeSources(config: AkmConfig): SearchSource[] {
  try {
    return resolveSourceEntries(undefined, config);
  } catch (cause) {
    if (!(cause instanceof ConfigError) || Object.keys(config.bundles ?? {}).length === 0) throw cause;
    return resolveSourceEntries(null, config);
  }
}

/**
 * The bundle `bundle` names: a source a caller holds, or a configured bundle by its id (the implicit working bundle and
 * `AKM_BUNDLE_DIR` are among the resolved sources). Its adapter is the one config records for it. Refused when no
 * bundle has the id, and for a configured bundle that is disabled.
 */
export function bundleFor(bundle: BundleAddress): AssetBundle {
  if (typeof bundle !== "string") return assetBundleOf(bundle);
  const sources = activeSources(loadConfig());
  const source = sources.find((source) => source.bundleId === bundle);
  if (source?.unresolved) {
    throw new ConfigError(`Bundle "${bundle}" is unavailable: ${source.unresolved.reason}`, "INVALID_CONFIG_FILE");
  }
  if (source) return assetBundleOf(sourceBundle(source));
  throw new ConfigError(`Bundle "${bundle}" is not among the configured sources.`, "INVALID_CONFIG_FILE");
}

export function sourceBundle(source: SearchSource): BundleSource {
  return {
    name: source.bundleId,
    path: source.path,
    adapterId: bundleAdapterId(source),
    ...(source.location !== undefined ? { location: source.location } : {}),
  };
}

/** Every configured bundle in source order (the default bundle first); an unresolved source is left out. */
export function orderedBundles(): AssetBundle[] {
  const config = loadConfig();
  const sources = activeSources(config);
  return sources.flatMap((source) => (source.unresolved ? [] : [assetBundleOf(sourceBundle(source))]));
}

/**
 * The bundles a lookup looks in: the configured ones, then `held`, a source the caller holds that config does not name.
 * The implicit working bundle yields to `held` when it has its id. A listing of every bundle (`orderedBundles`) never
 * includes it.
 */
export function lookupBundles(held?: BundleAddress): AssetBundle[] {
  const extra = typeof held === "object" ? held : undefined;
  let sources: SearchSource[] = [];
  try {
    sources = activeSources(loadConfig());
  } catch (error) {
    // The configured sources can be unresolvable (no working directory) while the directory a command was handed is not.
    if (extra === undefined) throw error;
  }
  const bundles = sources.flatMap((source) =>
    source.unresolved || source.bundleId === extra?.name ? [] : [assetBundleOf(sourceBundle(source))],
  );
  return extra ? [...bundles, assetBundleOf(extra)] : bundles;
}
