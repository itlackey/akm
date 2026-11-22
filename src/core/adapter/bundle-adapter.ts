// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `BundleAdapter` interface: the one layer through which the rest of akm
 * works with a bundle's assets, whatever keeps them.
 *
 * An adapter owns the mechanics of its bundles: how assets are listed, read,
 * described for the index, created, updated and retired. Everything outside
 * the adapter calls these members and never asks which adapter it has or how
 * the bundle is stored. A directory bundle's adapter keeps assets as files
 * (`adapters/directory-assets.ts` implements the mechanics every directory
 * adapter shares); an adapter may keep them elsewhere, such as an OS keyring
 * or a cloud vault.
 *
 *   id, version, extensions ........... REQUIRED (readonly fields)
 *   list ............................... REQUIRED  every asset entry, for the index
 *   read ............................... REQUIRED  one asset, by its concept id
 *   recognize .......................... REQUIRED  an entry's metadata for the index
 *   validate ........................... REQUIRED  native validation
 *   writes + create / update / retire .. optional  absent: the adapter is read-only
 *   renderExecutionSource .............. optional  agent/command runtime source
 *   readCandidates / directoryList / looksLikeRoot ... optional, directory adapters
 *
 * An asset is addressed by its concept id: the ref without its bundle. An
 * entry is the `FileContext` holding an asset: `relPath` is the path it is
 * indexed under, and `content()` reads it once, when asked.
 */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
// D1-3: type-only import of FileContext from the indexer layer. Erased at
// build time (no runtime edge); verified to add no import-cycle
// participant (`bun scripts/lint-import-cycles.ts` — ratchet stays 28,
// since nothing in `src/` imports FROM `src/core/adapter/` yet, only this
// WI's test does).
import type { FileContext } from "../../indexer/walk/file-context";
import type { WorkflowSourceFile } from "../../workflows/source-files";
import type { FileChange } from "../file-change";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "./types";

export interface AdapterReadCandidate {
  path: string;
  /** Canonical concept identity this authored path may own. */
  conceptId: string;
}

/** Every entry of a bundle, as one listing. */
export interface BundleListing {
  files: FileContext[];
  /** False when part of the bundle could not be read: the index keeps the entries it had. */
  complete: boolean;
  /** When `complete` is false: why. */
  incompleteReason?: string;
}

/** One asset of a bundle, as its adapter reads it. */
export interface BundleAsset {
  conceptId: string;
  /** The entry holding it. */
  file: FileContext;
  /** For a workflow: the one source file among its peer formats that holds it. */
  workflowSource?: WorkflowSourceFile;
  /** Whether `list` lists the asset. Absent: it does. An asset `read` finds but `list` leaves out is not indexed. */
  listed?(): boolean;
}

export interface AssetReadOptions {
  /**
   * When more than one entry holds the asset: `"read"` warns and reads the first; otherwise the read is refused
   * (a write must not pick one of two copies).
   */
  mode?: "read" | "write";
  /** Also read an env file or secret that a `.sensitive` marker hides from the index. For a run or an injection. */
  includeSensitive?: boolean;
}

/** An asset to create: its type and its name within that type (`env/prod` is type `env`, name `prod`). */
export interface NewAsset {
  type: string;
  name: string;
  content: string | Buffer;
  /** Keep the asset out of the index and listings; it is still read by its ref. */
  sensitive?: boolean;
}

/** What a write did. */
export interface AssetChange {
  conceptId: string;
  /** The asset's entry path: the path it is indexed under. */
  path: string;
  /** The files the write changed, for the bundle's commit boundary. Empty when the bundle is not a directory. */
  changed: string[];
}

export interface BundleAdapter {
  readonly id: string;
  /** Feeds incrementality (§4) + fingerprints. */
  readonly version: string;
  /** Recognized extensions; longest-match stripping + collision priority. */
  readonly extensions: readonly string[];
  /**
   * How a directory adapter lists its bundle. Omitted: the akm-bundle walk
   * (skips dot-directories, `bin/`, `.cache/`; lists git-ignored `env/` and
   * `secrets/` files). `"all-directories"`: every directory except `.git` and
   * `node_modules`, with no special `env/`/`secrets/` listing.
   */
  readonly walkMode?: "all-directories";

  // REQUIRED — listing and reading.
  /** Every entry of the bundle. The indexer describes each with `recognize`. */
  list(c: BundleComponent): BundleListing;
  /** The asset `conceptId` names, or undefined when the bundle has none. */
  read(c: BundleComponent, conceptId: string, options?: AssetReadOptions): BundleAsset | undefined;

  // REQUIRED — the single-file recognition primitive; replaces the matcher
  // stack (matchers.ts:151-305; file-context.ts:242-265).
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;

  // REQUIRED — native validation (change-transaction pre-commit + lint
  // --fix); adapter MUST NOT write and MUST NOT read the live filesystem:
  // ctx serves the run snapshot WITH the pending changes overlaid (one core
  // overlay implementation), plus a read-only resolveRef for link/xref
  // existence (normative §12.1). Cross-component ref existence is a CORE
  // base check, not an adapter concern.
  validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  // OPTIONAL — writing. `writes` lists the asset types the adapter creates,
  // updates and retires, and an adapter that lists any implements all three.
  // Without it the adapter is read-only.
  readonly writes?: readonly string[];
  /** Create the asset; one of the same type and name is replaced. */
  create?(c: BundleComponent, asset: NewAsset): AssetChange;
  /** Replace the content of the asset `conceptId` holds. */
  update?(c: BundleComponent, conceptId: string, content: string | Buffer): AssetChange;
  /** Take the asset out of the bundle. */
  retire?(c: BundleComponent, conceptId: string): AssetChange;

  // OPTIONAL — runtime translation for executable agent assets. The adapter
  // receives the authoritative native file and returns only a branded,
  // frontmatter-free command/persona source. Core resolution never reads raw
  // native bytes into a prompt after this boundary.
  renderExecutionSource?(c: BundleComponent, file: FileContext): AdapterRenderedExecutionSource | null;

  // OPTIONAL — authoritative read placement. Unlike `extensions` (a walk
  // collection hint), this lists the existing path spellings that may own one canonical concept. Every
  // candidate carries that canonical identity, so core can arbitrate without
  // reading authored bytes or inferring identity from the query.
  readCandidates?(c: BundleComponent, conceptId: string): AdapterReadCandidate[];

  // OPTIONAL — placement / discovery
  /** Owned dirs; feeds git exact-path staging (git-stash.ts:241). */
  directoryList?(c: BundleComponent): string[];
  /** Install-time probe; ordered per §1.2. */
  looksLikeRoot?(root: string): boolean;

  // NOTE — the OPTIONAL authoring, export, and memory facet methods are
  // DEFERRED, not declared here: no adapter implements them, and every type they
  // reference (AuthoringContext/CreateRequest/BundleExport/BindingRequest/
  // BindingPlan/MemoryRecord/MemorySemanticPlan) is shapeless.
  // Committing them now would mean 7 meaningless `Record<string, unknown>`
  // placeholder types on the foundational contract. The owning facet adds its
  // method + a REAL type shape when it is built.
}
