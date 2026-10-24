// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `BundleAdapter` interface — one interface with optional capability
 * methods.
 *
 * Member-by-member required/optional status:
 *
 *   id, version, extensions .......... REQUIRED (readonly fields)
 *   recognize ......................... REQUIRED
 *   index .............................. optional
 *   affectedItems ....................... optional
 *   validate .......................... REQUIRED
 *   readCandidates / placeNew / directoryList / looksLikeRoot ... optional
 *
 * `renderExecutionSource` (for the approved agent/command design) and
 * `readCandidates` are two independent optional read/runtime facets.
 * `readCandidates` makes an adapter's closed-form set of physical spellings
 * for one concept id explicit without changing write placement (#857: it is
 * the ONLY read-candidate surface; it is inverted from the concept id, so it
 * needs no bundle walk).
 *
 * `recognize` takes `FileContext` (`src/indexer/walk/file-context.ts`)
 * as-is — a core->indexer layering import, taken `import type` so it is
 * erased at build time and adds no runtime edge. FileContext arguably belongs
 * in core long-term.
 *
 * `FileChange` is reused as-is from `../file-change.ts` (a deliberately
 * dependency-free type).
 *
 * No concrete adapter is implemented here — this is the contract only; the
 * live indexer's per-dir `drainDirDocuments` × `adapter.recognize` is the core
 * scan engine.
 */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
// Type-only import of FileContext from the indexer layer. Erased at
// build time (no runtime edge).
import type { FileContext } from "../../indexer/walk/file-context";
import type { FileChange } from "../file-change";
import type { BundleComponent, BundleInstallation, Diagnostic, IndexDocument, ValidateContext } from "./types";

export interface AdapterReadCandidate {
  path: string;
  /** Canonical concept identity this authored path may own. */
  conceptId: string;
}

export interface BundleAdapter {
  readonly id: string;
  /** Feeds incrementality + fingerprints. */
  readonly version: string;
  /** Recognized extensions; longest-match stripping + collision priority. */
  readonly extensions: readonly string[];

  // REQUIRED — the single-file recognition primitive.
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;

  // OPTIONAL — full-component scan for non-per-file layouts (website
  // snapshots, llm-wiki multi-file semantics). When absent, the CORE scans:
  //   the live indexer's per-dir walk (git-aware, symlink-safe, skip-dirs;
  //   `walkStashFlat`) × adapter.recognize per file, drained by
  //   `drainDirDocuments`.
  // The core walk is ONE implementation carrying the security policy;
  // adapters never reimplement it. An adapter overriding index() MUST keep
  // recognize() coherent (conformance: index() == fold of recognize() over
  // the walk) or declare component-level incrementality.
  index?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;

  // OPTIONAL — item-scoped incrementality. Default: identity (one file
  // = one item).
  affectedItems?(c: BundleComponent, changedPaths: string[]): string[];

  // REQUIRED — native validation (change-transaction pre-commit + lint
  // --fix); adapter MUST NOT write and MUST NOT read the live filesystem:
  // ctx serves the run snapshot WITH the pending changes overlaid (one core
  // overlay implementation), plus a read-only resolveRef for link/xref
  // existence. Cross-component ref existence is a CORE
  // base check, not an adapter concern.
  validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  // OPTIONAL — runtime translation for executable agent assets. The adapter
  // receives the authoritative native file and returns only a branded,
  // frontmatter-free command/persona source. Core resolution never reads raw
  // native bytes into a prompt after this boundary.
  renderExecutionSource?(c: BundleComponent, file: FileContext): AdapterRenderedExecutionSource | null;

  // OPTIONAL — authoritative read placement. Unlike `extensions` (a walk
  // collection hint) and `placeNew` (a write-normalization policy), this lists
  // the existing path spellings that may own one canonical concept. Every
  // candidate carries that canonical identity, so core can arbitrate without
  // reading authored bytes or inferring identity from the query.
  readCandidates?(c: BundleComponent, conceptId: string): AdapterReadCandidate[];

  // OPTIONAL — placement / discovery
  /** Replaces the per-type stash-subdir + name-to-path placement primitives. */
  placeNew?(c: BundleComponent, conceptId: string): string;
  /** Owned dirs; feeds git exact-path staging. */
  directoryList?(c: BundleComponent): string[];
  /** Install-time probe; probed in registry order, first match wins. */
  looksLikeRoot?(root: string): boolean;

  // NOTE — the OPTIONAL authoring, export, and memory facet methods are not
  // declared here: no adapter implements them, and the types they would
  // reference (AuthoringContext/CreateRequest/BundleExport/BindingRequest/
  // BindingPlan/MemoryRecord/MemorySemanticPlan) have no shape yet. Declaring
  // them now would mean meaningless `Record<string, unknown>` placeholder
  // types on the foundational contract; each facet adds its method + a REAL
  // type shape when it is built.
}
