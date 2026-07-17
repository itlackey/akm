// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Supporting type family for the amended `BundleAdapter` interface
 * (`./bundle-adapter.ts`), minted per akm 0.9.0 chunk-1 decision D1-1
 * (`docs/design/execution/chunk-1/brief.md`).
 *
 * Provenance, per type:
 *
 *  - `BundleId` / `ComponentId` / `ItemRef` / `BundleInstallation` /
 *    `BundleComponent` — transcribed verbatim from
 *    `docs/design/akm-0.9.0-bundle-adapter-spec.md` §1.1 (lines 56-75).
 *
 *  - `IndexDocument` — transcribed verbatim from the same doc, §3 (lines
 *    205-241). Per D1-1 this is the FULL/real shape, not a deferred
 *    placeholder: Chunk 5 later reconciles it with the `StashEntry` ->
 *    `IndexDocument` rename (a merge into this type, not a re-creation of
 *    it).
 *
 *  - `ValidateContext` — NOT restated in the adapter spec's own §2 code
 *    block (chunk-1 anchors.md §A.1); defined only in the normative spec,
 *    `docs/design/akm-format-neutral-bundle-workspace-spec.md:562-569`.
 *    Transcribed verbatim from there.
 *
 *  - `Diagnostic` — referenced as `validate`'s `Promise<Diagnostic[]>`
 *    return type by both spec documents, but its shape is declared
 *    NOWHERE (adapter spec, normative spec, plan, and decision-history all
 *    searched — 0 hits). Per D1-1, MINTED here modeled on the existing
 *    `LintIssue` (`src/commands/lint/types.ts:19-25`:
 *    `{ file, issue, detail, fixed }`), with one deliberate generalization:
 *    `issue` is an open `string` here rather than `LintIssueType` (a closed
 *    union of 12 lint-command-specific codes) — `Diagnostic` is produced by
 *    arbitrary adapters' `validate()`, not scoped to the lint command's
 *    vocabulary. Flagged for the maintainer per the brief.
 *
 * DEFERRED (not declared here): the spec's OPTIONAL authoring (§12.2), export
 * (§12.3), and memory (§12.4) facet methods reference a type family
 * (`AuthoringTarget`/`AuthoringContext`/`CreateRequest`/`BundleExport`/
 * `BindingRequest`/`BindingPlan`/`MemoryRecord`/`MemorySemanticPlan`) that NO
 * spec document shapes. Those facets are Tier-B ("no 0.9.0 adapter implements
 * these"); rather than commit 8 meaningless `Record<string, unknown>`
 * placeholders on the foundational contract, both the facet methods (on
 * `BundleAdapter`) and these types are DROPPED from chunk 1 — the owning chunk
 * of each facet adds its method + a REAL type shape when it is built. Refines
 * D1-1 (0.9.0 core contract only); flagged for the maintainer.
 */

// ── §1.1 — bundle / component / installation model ─────────────────────────

/** Stable bundle name (workspace identity); the optional ref prefix. Spec §1.1. */
export type BundleId = string;

/** A configured root under one adapter; PROVENANCE, not a ref segment. Spec §1.1/§1.3. */
export type ComponentId = string;

/** `"[<bundle>//]<concept-id>"` — the ref grammar, spec §1.3. */
export type ItemRef = string;

export interface BundleInstallation {
  id: BundleId;
  /** Resolved git sha / npm version+integrity / snapshot digest. */
  revision?: string;
  /** Transport locator, kept OUT of identity (normative §11.2). */
  source?: string;
  components: BundleComponent[];
  /** Explicit trust; installation grants nothing (History D8). */
  trusted: boolean;
}

export interface BundleComponent {
  id: ComponentId;
  /** Static adapter id, one per root — no per-file competition. */
  adapter: string;
  /** Absolute materialized root; workspace state NEVER written here. */
  root: string;
  writable: boolean;
}

// ── §3 — IndexDocument ──────────────────────────────────────────────────────

export interface IndexDocument {
  /** Fully-qualified "<bundle>//<concept-id>" (canonical stored spelling, §1.3). */
  ref: ItemRef;
  bundle: BundleId;
  /** PROVENANCE (derived: longest-prefix match of the concept-id against component roots), not a ref segment. */
  component: ComponentId;
  /** OKF concept ID = path within bundle − ext; opaque to the core. */
  conceptId: string;
  /** Absolute local path (the read path). */
  path: string;
  hash: string;
  adapterId: string;
  /** = OKF `type`; open; frontmatter (native) or adapter-derived (foreign). Presents/ranks/filters; NEVER executes or identifies. */
  type?: string;

  /** FTS 10 ← OKF `title` (fallback filename). */
  name: string;
  /** FTS 5 ← OKF `description`. */
  description?: string;
  /** FTS 3 ← OKF `tags`. */
  tags?: string[];
  /** FTS 2. */
  hints?: string[];
  /** FTS 1 (bounded). */
  content?: string;

  // FIRST-CLASS query-time signals — read by ranking contributors and result
  // filters at query time, therefore NOT foldable into documentJson (the
  // parity gate fails or the filters silently vanish otherwise). Pinned by a
  // lint.
  /** Exact-alias 1.5 boost is distinct from the tags signal — NOT folded into tags. */
  aliases?: string[];
  searchHints?: string[];
  /** Curated boost + proposed-by-default exclusion filter. */
  quality?: string;
  confidence?: number;
  /** + currentBeliefRefs/supersededBy: boosts, ceilings, --belief filter. */
  beliefState?: string;
  currentBeliefRefs?: string[];
  supersededBy?: string;
  scope?: Record<string, string>;
  captureMode?: string;
  lessonStrength?: number;
  pinned?: boolean;
  /** Hit size + estimatedTokens. */
  fileSize?: number;
  /** Derived-twin belief inheritance. */
  derivedFrom?: string;
  /** ← OKF `timestamp`. */
  updated?: string;
  /** Resolved native links = relationships (§9); navigation/lint, NOT graph boost. */
  links?: string[];
  /** Opaque adapter extras ONLY (arbitrary OKF frontmatter keys); not FTS, never parsed by core. */
  documentJson?: unknown;
}

// ── §12.1 (normative) — ValidateContext ─────────────────────────────────────

/**
 * Not part of the adapter spec's own §2 code block — defined only in the
 * normative spec, `akm-format-neutral-bundle-workspace-spec.md:562-569`.
 * Transcribed verbatim from there.
 */
export interface ValidateContext {
  /**
   * Reads served from the run's snapshot WITH the pending changes overlaid —
   * one core overlay implementation, not one per adapter.
   */
  readFile(path: string): Promise<string | Uint8Array | null>;
  list(dir: string): Promise<string[]>;
  /** Read-only index lookup for link/xref existence checks (not search). */
  resolveRef(ref: string): Promise<{ exists: boolean; path?: string }>;
}

// ── Diagnostic — MINTED, no spec shape exists (see file header) ────────────

/**
 * MINTED per decision D1-1 — no spec document declares `Diagnostic`'s
 * shape. Modeled on `LintIssue` (`src/commands/lint/types.ts:19-25`) with
 * `issue` generalized to an open string (see file header for rationale).
 */
export interface Diagnostic {
  file: string;
  issue: string;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = fix attempted but threw. */
  fixed: boolean | "failed";
}
