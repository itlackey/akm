// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `BundleAdapter` interface — one interface, optional capability methods.
 *
 * Member-by-member required/optional status:
 *
 *   id, version, extensions .......... REQUIRED (readonly fields)
 *   recognize ......................... REQUIRED
 *   index .............................. optional
 *   affectedItems ....................... optional
 *   validate .......................... REQUIRED
 *   readCandidates / directoryList / looksLikeRoot ... optional
 *
 * `renderExecutionSource` and `readCandidates` are two independent optional
 * read/runtime facets: `renderExecutionSource` serves the agent/command design,
 * and `readCandidates` makes an adapter's closed-form set of physical
 * spellings for one concept id explicit without changing write placement
 * (#857: this is the ONLY read-candidate surface — it is inverted from the
 * concept id, so it needs no bundle walk). This does not change the indexing or
 * validation contract.
 *
 * The optional authoring, export and memory facet methods are not declared
 * here: no adapter implements them, and their parameter types would be
 * shapeless placeholders. Each facet adds its method + a real type when it is
 * built.
 *
 * `recognize` takes `FileContext` (`src/indexer/walk/file-context.ts`)
 * as-is — a core->indexer layering import, taken
 * `import type` so it is erased at build time and adds no runtime edge.
 * FileContext arguably belongs in core long-term.
 *
 * `FileChange` is reused as-is from `../file-change.ts` (a
 * deliberately dependency-free type) — not re-minted here.
 *
 * No concrete adapter is implemented here — this is the contract only; the
 * live indexer's per-dir `drainDirDocuments` × `adapter.recognize` is the core
 * scan engine.
 */

import type { AdapterRenderedExecutionSource } from "../../execution/source";
// D1-3: type-only import of FileContext from the indexer layer. Erased at
// build time (no runtime edge); verified to add no import-cycle
// participant (`bun scripts/lint-import-cycles.ts` — ratchet stays 28,
// since nothing in `src/` imports FROM `src/core/adapter/` yet, only this
// WI's test does).
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
  /** Feeds incrementality (§4) + fingerprints. */
  readonly version: string;
  /** Recognized extensions; longest-match stripping + collision priority. */
  readonly extensions: readonly string[];

  // REQUIRED — the single-file recognition primitive; replaces the matcher
  // stack (matchers.ts:151-305; file-context.ts:242-265).
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;

  // OPTIONAL — full-component scan for non-per-file layouts (website
  // snapshots, llm-wiki multi-file semantics). When absent, the CORE scans:
  //   the live indexer's per-dir walk (git-aware, symlink-safe, skip-dirs;
  //   `walkStashFlat`) × adapter.recognize per file, drained by
  //   `drainDirDocuments`.
  // The core walk is ONE implementation carrying the security policy;
  // adapters never reimplement it. An adapter overriding index() MUST keep
  // recognize() coherent (conformance: index() == fold of recognize() over
  // the walk) or declare component-level incrementality (§4).
  index?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;

  // OPTIONAL — item-scoped incrementality (§4). Default: identity (one file
  // = one item).
  affectedItems?(c: BundleComponent, changedPaths: string[]): string[];

  // REQUIRED — native validation (change-transaction pre-commit + lint
  // --fix); adapter MUST NOT write and MUST NOT read the live filesystem:
  // ctx serves the run snapshot WITH the pending changes overlaid (one core
  // overlay implementation), plus a read-only resolveRef for link/xref
  // existence (normative §12.1). Cross-component ref existence is a CORE
  // base check, not an adapter concern.
  validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

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
