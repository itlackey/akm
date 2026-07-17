// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The amended `BundleAdapter` interface — akm 0.9.0 chunk-1, WI-1.1.
 *
 * Transcribed VERBATIM from `docs/design/akm-0.9.0-bundle-adapter-spec.md`
 * §2 (lines 133-179) — "one interface, optional capability methods," per
 * History §8.3's reconciliation. This is THE authoritative shape (chunk-1
 * anchors.md §A.1/§A.2 census): two other documents show incomplete or
 * stale restatements of the same interface and were deliberately NOT used
 * as the source here —
 *
 *   - `akm-format-neutral-bundle-workspace-spec.md` §12.1 (lines ~530-560)
 *     restates the same contract but its own code block OMITS
 *     `affectedItems` entirely (it only appears in §14.2 prose, not the
 *     §12.1 TS snippet), and splits placeNew/directoryList/looksLikeRoot
 *     into a separate "§12.2 Authoring methods" heading rather than the
 *     adapter spec's single inline block.
 *   - `akm-architecture-decision-history.md` §8.3 (lines 805-823) is a
 *     STALE pre-amendment shape: `index()` REQUIRED (no `recognize` at
 *     all), no `ValidateContext` parameter on `validate`, no
 *     `affectedItems`.
 *
 * `ValidateContext` is not restated in the adapter spec's own §2 code block
 * — it is defined only in the normative spec (lines 562-569) and is
 * transcribed there into `./types.ts`.
 *
 * Member-by-member required/optional status (adapter spec §2, verified
 * against the transcription table in chunk-1 anchors.md §A.1):
 *
 *   id, version, extensions .......... REQUIRED (readonly fields)
 *   recognize ......................... REQUIRED
 *   index .............................. optional
 *   affectedItems ....................... optional
 *   validate .......................... REQUIRED
 *   placeNew / directoryList / looksLikeRoot ... optional
 *
 * The spec's optional authoring (§12.2) / export (§12.3) / memory (§12.4)
 * facet methods are Tier-B ("no 0.9.0 adapter implements these") and their
 * parameter types are shapeless in every doc — they are DEFERRED to their
 * owning chunks (which will add the method + a real type), NOT declared here
 * as meaningless placeholders. Refines D1-1; flagged for the maintainer.
 *
 * `recognize` takes `FileContext` (`src/indexer/walk/file-context.ts`)
 * as-is, per decision D1-3 — a core->indexer layering import, taken
 * `import type` so it is erased at build time and adds no runtime edge.
 * This is flagged for the maintainer: FileContext arguably belongs in core
 * long-term; moving it is out of chunk 1's netLoc-0 scope.
 *
 * `FileChange` is reused as-is from `../file-change.ts` (Chunk 6's
 * deliberately dependency-free type) — not re-minted here.
 *
 * No concrete adapter is implemented here — this is the additive contract
 * only (Chunk 2 mints the first real adapters; WI-1.3 adds the core-owned
 * `scanComponent` walk in a sibling module).
 */

// D1-3: type-only import of FileContext from the indexer layer. Erased at
// build time (no runtime edge); verified to add no import-cycle
// participant (`bun scripts/lint-import-cycles.ts` — ratchet stays 28,
// since nothing in `src/` imports FROM `src/core/adapter/` yet, only this
// WI's test does).
import type { FileContext } from "../../indexer/walk/file-context";
import type { FileChange } from "../file-change";
import type { BundleComponent, BundleInstallation, Diagnostic, IndexDocument, ValidateContext } from "./types";

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
  //   scanComponent(c, adapter) = core walk (git-aware, symlink-safe,
  //   skip-dirs, nested-root subtraction §1.2) x adapter.recognize per
  //   file.
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

  // OPTIONAL — placement / discovery
  /** Replaces TYPE_DIRS + resolveAssetPathFromName. */
  placeNew?(c: BundleComponent, conceptId: string): string;
  /** Owned dirs; feeds git exact-path staging (git-stash.ts:241). */
  directoryList?(c: BundleComponent): string[];
  /** Install-time probe; ordered per §1.2. */
  looksLikeRoot?(root: string): boolean;

  // NOTE — the spec's OPTIONAL authoring (§12.2), export (§12.3), and memory
  // (§12.4/§25) facet methods are DEFERRED, not declared here. They are Tier-B
  // ("no 0.9.0 adapter implements these" — adapter spec §2; the bind/authoring
  // family is deferred Tier-B per the manifest's Chunk-10 note), and every type
  // they reference (AuthoringContext/CreateRequest/BundleExport/BindingRequest/
  // BindingPlan/MemoryRecord/MemorySemanticPlan) is shapeless in every spec doc.
  // Committing them now would mean 7 meaningless `Record<string, unknown>`
  // placeholder types on the foundational contract. Refines D1-1: chunk 1
  // implements the 0.9.0 CORE contract; the owning chunk of each facet adds its
  // method + a REAL type shape when that facet is built. FLAGGED for maintainer.
}
