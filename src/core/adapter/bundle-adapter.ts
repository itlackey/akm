// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `BundleAdapter` interface: the one layer through which the rest of akm
 * works with a bundle's assets, whatever keeps them.
 *
 * An adapter owns the mechanics of its bundles: how assets are listed, read,
 * described for the index, placed, created, updated, deleted and retired. Everything
 * outside the adapter calls these members and never asks which adapter it has
 * or how the bundle is stored. A directory bundle's adapter keeps assets as
 * files (`directory-adapter.ts` implements the mechanics every directory
 * adapter shares); a secret manager's adapter keeps them in the manager
 * (`secret-manager-adapter.ts`).
 *
 * Every member is required. A base class implements the ones its adapters do
 * not support by refusing; `writes` says which types an adapter writes, and is
 * empty for a read-only one; `retires` says which of those it retires
 * recoverably rather than deletes (never an env file or a secret). `renderExecutionSource` and `looksLikeRoot` are
 * optional: absence means "no runtime translation" and "never auto-detected".
 *
 * An asset is addressed by its concept id: the ref without its bundle. An
 * entry is one asset as its adapter holds it: `key` is the adapter's
 * storage key, and `content()` reads it once, when asked.
 */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
import type { AssetEdit, Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

/** One entry of a bundle: an asset as its adapter holds it. */
export interface AssetEntry {
  /** The adapter's storage key (directory: the POSIX path inside the root; secret manager: `secrets/<name>`). Only the adapter interprets it; the concept id derives from it. */
  readonly key: string;
  /** The absolute file that holds the asset, when the adapter keeps it as a file. Display and handing to a program only. */
  readonly file?: string;
  /** What the adapter needs to find the asset again in its storage (a keyring entry's object and attributes): a JSON value the index records (`IndexDocument.locator`) and hands back; only the adapter reads it. */
  readonly locator?: unknown;
  /** When the asset last changed, when the adapter knows (a directory: the file's mtime). Callers never stat `file`. */
  modified?(): Date;
  /** The content as text, read once, when first asked. */
  content(): string;
  /** The content as bytes, read once, when first asked. */
  bytes(): Buffer;
  /** The YAML frontmatter of `content()`, or null. */
  frontmatter(): Record<string, unknown> | null;
  /** Files that belong to the asset besides its entry (a skill's resources), by path below the asset's folder. */
  resources?(): ReadonlyArray<AssetResource>;
}

export interface AssetResource {
  readonly path: string;
  bytes(): Buffer;
}

/** One asset, as its adapter reads it: its identity and the entry that holds it. The type is index metadata (`recognize`). */
export interface BundleAsset {
  conceptId: string;
  entry: AssetEntry;
}

/**
 * Every asset of a bundle, one per concept. Listing reads no content. A store that cannot be reached at all (a keyring
 * that is not there or refuses to unlock, a vault that refuses the account) is not a listing: `list` throws
 * `BUNDLE_UNREACHABLE`.
 */
export interface BundleListing {
  assets: BundleAsset[];
  /** False when part of the bundle could not be read: the index keeps the rows it had. */
  complete: boolean;
  /** When `complete` is false: why. */
  incompleteReason?: string;
  /** What is wrong with a store's entries (a secret manager's): `akm index` records and reports it, `akm lint` reads it back. */
  findings?: Diagnostic[];
}

/** An asset to create: its type and its name within the type (`env/prod` is type `env`, name `prod`). */
export interface NewAsset {
  type: string;
  name: string;
  content: string | Buffer;
  /** What a warning about the asset calls it (the home-path advisory): the caller's own name for it, else its file's name. */
  label?: string;
  /** Files that belong to the asset (a skill package's resources), by path below the asset's folder. */
  resources?: ReadonlyArray<{ path: string; content: Buffer }>;
}

/** What a write did. */
export interface AssetChange {
  conceptId: string;
  /** The files the write changed, for the bundle's commit boundary. Empty when the bundle is not a directory. */
  changed: string[];
  /** The content the asset holds after the write. Absent after a delete, retire or forget. */
  content?: string | Buffer;
  /**
   * The entry the write left, when the adapter has it without reading the store again (a keyring's item as the service
   * now holds it, with the locator the index records). The facade refreshes the asset's index row from it.
   */
  entry?: AssetEntry;
}

/**
 * Where a create of an asset goes: the one answer of `place`. A directory adapter also says the storage key the create
 * writes (an asset held under another key is held under another spelling), whether anything is kept there now (an asset,
 * or an entry no adapter reads as one: a directory) and the file to show for it (display only, §0.2 P13; never stored).
 */
export interface AssetPlacement {
  /** The concept id a create gives. */
  conceptId: string;
  key?: string;
  occupied?: boolean;
  file?: string;
}

/** What the caller records with a retirement; kept with it and returned by `retired`. YAML-serializable. */
export interface RetireNote {
  /** Names the retirement's archive (default: the asset's concept id). A ref into the bundle is stored without its `bundle//`. */
  readonly ref?: string;
  /** When it was retired (ISO 8601): `expireRetired` measures its age from it. */
  readonly retiredAt?: string;
  readonly [key: string]: unknown;
}

/** A recoverable retirement. */
export interface Retirement {
  /** The adapter's stable name for it. Callers pass it back to `restore` and `forget`. */
  handle: string;
  /** The concept id the asset had. */
  conceptId: string;
  note: RetireNote;
  /** False once the retired content has expired: `restore` then needs a fallback. */
  restorable: boolean;
}

export interface BundleAdapter {
  readonly id: string;
  /** Feeds index incrementality and fingerprints. */
  readonly version: string;
  /** How config names the adapter's bundles: a directory by `path`/`git`/`website`/`npm`, a store by `location`. */
  readonly addressedBy: "root" | "location";
  /** Types it creates, updates and deletes. Empty: read-only. */
  readonly writes: readonly string[];
  /** Types it retires recoverably; a subset of `writes`. Empty: it deletes only. */
  readonly retires: readonly string[];

  /** Whether the bundle's storage is there. It reads no asset and never prompts. */
  exists(b: Bundle): boolean;
  /**
   * Every asset of the bundle, one per concept. Identity comes from each entry's storage key alone: no content is read.
   * The indexer describes each with `recognize`. Throws `BUNDLE_UNREACHABLE` when the storage cannot be reached. With
   * `type`, `complete` speaks for the part of the bundle that holds assets of that type only.
   */
  list(b: Bundle, type?: string): BundleListing;
  /**
   * The asset `conceptId` names, or undefined when the bundle has none (an asset a full listing would not reach is
   * none). When storage holds the concept under more than one spelling the adapter picks the first by its spelling
   * order, the same for every caller and without reading content; `validate` reports the rest. `locator`: the entry's
   * locator as the index recorded it, which the facade hands back to an adapter that lists one; the adapter never reads
   * the index itself.
   */
  read(b: Bundle, conceptId: string, locator?: unknown): BundleAsset | undefined;
  /**
   * An entry's metadata for the index, the only place a type is given; null when it is no asset. The concept id is the
   * one the entry's storage key names. May read content.
   */
  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null;
  /**
   * The type the entry's bytes give it, as `recognize` would say it, without describing the rest (a check that holds the
   * bytes and must change nothing asks this). Absent: the adapter has no cheaper answer; undefined: it types nothing.
   */
  contentType?(b: Bundle, entry: AssetEntry): string | undefined;
  /**
   * Native validation of pending `edits`, each an asset by its concept id (`akm lint` checks every asset as an
   * `update`). It never writes. A directory adapter checks the bundle's snapshot with the edits overlaid; a store
   * with no files has nothing to check. Cross-bundle ref existence is a core base check, not an adapter concern.
   */
  validate(b: Bundle, edits: AssetEdit[], ctx: ValidateContext): Promise<Diagnostic[]>;

  /**
   * Where a `create` of `asset` would go, without writing: its concept id and, for an adapter that keeps assets as
   * files, where. A name that cannot be placed throws, as does a read-only adapter.
   */
  place(b: Bundle, asset: Pick<NewAsset, "type" | "name">): AssetPlacement;
  /**
   * Create the asset, in the adapter's own form for its type, or with `verbatim` as exactly `asset.content` (a promoted
   * proposal's bytes are the ones it was reviewed with). Over an existing asset of the same concept it writes the same
   * bytes only with `replace`; without it the create is refused. With `replaceLink`, an asset file that is a symbolic
   * link to a file inside the bundle is replaced by a regular file (the link's target is left as it is); a link to
   * nothing or to a file outside the bundle is still refused.
   */
  create(
    b: Bundle,
    asset: NewAsset,
    options?: { replace?: boolean; verbatim?: boolean; replaceLink?: boolean; locator?: unknown },
  ): AssetChange;
  /**
   * Replace the content of the asset `conceptId` holds with exactly `content`. With `throughLink`, an asset file reached
   * through a symbolic link whose target is a file inside the bundle is written where the link leads and the link is kept;
   * a link to nothing or to a file outside the bundle is still refused.
   */
  update(
    b: Bundle,
    conceptId: string,
    content: string | Buffer,
    options?: { throughLink?: boolean; locator?: unknown },
  ): AssetChange;
  /** Take the asset out of the bundle. `locator` (here, on `update` and on a replacing `create`): as on `read`. */
  delete(b: Bundle, conceptId: string, options?: { locator?: unknown }): AssetChange;

  /**
   * Take the asset out of the bundle recoverably, keeping `note` with it. The handle in the result names the
   * retirement. Refused for a type not in `retires`.
   */
  retire(b: Bundle, conceptId: string, note: RetireNote): AssetChange & { handle: string };
  /** The bundle's retirements. */
  retired(b: Bundle): Retirement[];
  /**
   * Put a retired asset back; when its retired content has expired, write `fallback` (refused without one). The
   * retirement is kept, so a caller can record its decision before `forget` removes it: restoring twice is a no-op.
   */
  restore(b: Bundle, handle: string, fallback?: string | Buffer): AssetChange;
  /** Drop a retirement's record, and with it any retired content that remains. */
  forget(b: Bundle, handle: string): { changed: string[] };
  /** Delete the retired content of every retirement recorded before `before`, when the adapter can recover it elsewhere. */
  expireRetired(b: Bundle, before: Date): { changed: string[] };

  /**
   * Runtime translation for executable agent assets. The adapter receives the authoritative native entry and
   * returns only a branded, frontmatter-free command/persona source. Core resolution never reads raw native bytes
   * into a prompt after this boundary.
   */
  renderExecutionSource?(b: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null;
  /** Install-time probe; ordered by the registry. */
  looksLikeRoot?(root: string): boolean;
  /**
   * The concept id a stored storage key (a bundle-relative path) holds, from the key alone, so it is valid when no
   * file exists. For converters of old stored records only (§8.4: `legacyRefOf`).
   */
  identifyKey?(b: Bundle, key: string): string | null;
}
