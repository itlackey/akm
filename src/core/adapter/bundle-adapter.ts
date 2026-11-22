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
 * entry is one asset as its adapter holds it: `relPath` is the path it is
 * indexed under, and `content()` reads it once, when asked.
 */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
import type { FileChange } from "../file-change";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

/** One entry of a bundle: an asset as its adapter holds it. */
export interface AssetEntry {
  /** POSIX path inside the bundle. The index keys the entry under it; the concept id derives from it. */
  readonly relPath: string;
  /** The absolute file that holds the asset, when the adapter keeps it as a file. Absent: no file holds it. */
  readonly file?: string;
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

export interface AdapterReadCandidate {
  path: string;
  /** Canonical concept identity this authored path may own. */
  conceptId: string;
}

/** Every entry of a bundle. */
export interface BundleListing {
  entries: AssetEntry[];
  /** False when part of the bundle could not be read: the index keeps the rows it had. */
  complete: boolean;
  /** When `complete` is false: why. */
  incompleteReason?: string;
}

/** One asset, as its adapter reads it. */
export interface BundleAsset {
  conceptId: string;
  /** The asset's type, as the adapter knows it, also for an asset `list` leaves out. */
  type: string;
  entry: AssetEntry;
  /** Whether `list` lists it. False for an env file or secret kept out of listings (`.sensitive`). */
  listed: boolean;
}

export interface AssetReadOptions {
  /**
   * When more than one entry holds the asset: `"read"` warns and reads the first; otherwise (`"write"`, the
   * default) the read is refused (a write must not pick one of two copies).
   */
  mode?: "read" | "write";
}

/** An asset to create: its type and its name within the type (`env/prod` is type `env`, name `prod`). */
export interface NewAsset {
  type: string;
  name: string;
  content: string | Buffer;
  /** Files that belong to the asset (a skill package's resources), by path below the asset's folder. */
  resources?: ReadonlyArray<{ path: string; content: Buffer }>;
  /** Keep it out of listings (`env create --sensitive`). Refused by an adapter that cannot. */
  unlisted?: boolean;
}

/** What a write did. */
export interface AssetChange {
  conceptId: string;
  /** The asset's file after the write, when it is a file. */
  file?: string;
  /** The files the write changed, for the bundle's commit boundary. Empty when the bundle is not a directory. */
  changed: string[];
  /** The content the asset holds after the write. Absent after a delete, retire or forget. */
  content?: string | Buffer;
}

/** What the caller records with a retirement; kept with it and returned by `retired`. YAML-serializable. */
export type RetireNote = Readonly<Record<string, unknown>>;

/** A recoverable retirement. */
export interface Retirement {
  /** The adapter's stable name for it. Callers persist it (a proposal's `retiredArchive.dirs`). */
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
  /** Types it creates, updates and deletes. Empty: read-only. */
  readonly writes: readonly string[];
  /** Types it retires recoverably; a subset of `writes`. Empty: it deletes only. */
  readonly retires: readonly string[];

  /** Every entry of the bundle. The indexer describes each with `recognize`. */
  list(b: Bundle): BundleListing;
  /** The asset `conceptId` names, or undefined when the bundle has none. */
  read(b: Bundle, conceptId: string, options?: AssetReadOptions): BundleAsset | undefined;
  /** An entry's metadata for the index; null when it is no asset. */
  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null;
  /**
   * Native validation (change-transaction pre-commit and `akm lint`). It must not write and must not read the live
   * filesystem: `ctx` serves the run snapshot with the pending changes overlaid, plus a read-only `resolveRef` for
   * link and xref existence. Cross-bundle ref existence is a core base check, not an adapter concern.
   */
  validate(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  /** The concept id a `create` of `asset` would give, without writing. Refused by a read-only adapter. */
  place(b: Bundle, asset: Pick<NewAsset, "type" | "name">): string;
  /** Create the asset, in the adapter's own form for its type; one of the same type and name is replaced. */
  create(b: Bundle, asset: NewAsset): AssetChange;
  /** Replace the content of the asset `conceptId` holds with exactly `content`. */
  update(b: Bundle, conceptId: string, content: string | Buffer): AssetChange;
  /** Take the asset out of the bundle. */
  delete(b: Bundle, conceptId: string): AssetChange;

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
  forget(b: Bundle, handle: string): AssetChange;
  /** Delete the retired content of every retirement recorded before `before`, when the adapter can recover it elsewhere. */
  expireRetired(b: Bundle, before: Date): AssetChange;

  /**
   * Runtime translation for executable agent assets. The adapter receives the authoritative native entry and
   * returns only a branded, frontmatter-free command/persona source. Core resolution never reads raw native bytes
   * into a prompt after this boundary.
   */
  renderExecutionSource?(b: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null;
  /** Install-time probe; ordered by the registry. */
  looksLikeRoot?(root: string): boolean;
}
