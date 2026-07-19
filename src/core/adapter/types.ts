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
 *    placeholder: Chunk 5 later reconciles it with the `IndexDocument` ->
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

import type { TocHeading } from "../asset/markdown";

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

// ── Durable entry sub-shapes ────────────────────────────────────────────────
//
// akm 0.9.0 Chunk 5 F4a M-core-1 (type-merge): these IndexDocument sub-shapes move
// HERE from `indexer/passes/metadata.ts` so the merged {@link IndexDocument}
// (below) can reference them WITHOUT closing a `metadata.ts ↔ types.ts` import
// cycle (the cycle ratchet counts type-only edges). They are the durable field
// shapes per the M1 decision — the durable truth. `metadata.ts` re-exports them
// under their historical names, and the value `SCOPE_KEYS` stays there.

export interface StashIntent {
  when?: string;
  input?: string;
  output?: string;
}

export interface AssetParameter {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: string;
}

/**
 * Multi-tenant / multi-agent scope keys. All four fields are optional;
 * persisted as the canonical top-level frontmatter keys
 * `scope_user`, `scope_agent`, `scope_run`, `scope_channel`.
 *
 * This shape is the wire-level scope contract — the CLI's `--user`,
 * `--agent`, `--run`, `--channel` flags map into these fields, and
 * `akm search --filter user=…` queries against them.
 *
 * Memories written before scope flags shipped have no scope keys at all;
 * unfiltered queries continue to surface them.
 */
export interface StashEntryScope {
  user?: string;
  agent?: string;
  run?: string;
  channel?: string;
}

/** Allowed keys in `--filter k=v` and `--scope k=v` flags. */
export type ScopeKey = keyof StashEntryScope;

// ── §3 — IndexDocument (Chunk 5 F4a M-core-1: IS IndexDocument + provenance) ─────
//
// The spec's §3 `IndexDocument` IS `IndexDocument` + provenance (M1 decision). The
// scan engine drains `IndexDocument`s; the durable `entry_json` column stays a
// faithful `IndexDocument`, so `IndexDocument` is now a deprecated alias OF this type
// (`metadata.ts`, `// F5: delete`). To let a metadata-pipeline entry literal
// (`{ name, type, … }`, no provenance) satisfy the alias, the seven provenance
// fields are OPTIONAL here; `recognize` and the scan writer fill them in, and
// they are NEVER serialized onto `entry_json` (that durable shape is unchanged).
// Where the pre-merge `IndexDocument` and `IndexDocument` field shapes conflicted
// (`supersededBy`, `scope`, `captureMode`, `quality`, `beliefState`), the
// IndexDocument shape wins — the durable truth.

export interface IndexDocument {
  // ── Provenance (spec §3) — OPTIONAL for the IndexDocument alias; see header ──
  /** Fully-qualified "<bundle>//<concept-id>" (canonical stored spelling, §1.3). */
  ref?: ItemRef;
  bundle?: BundleId;
  /** PROVENANCE (derived: longest-prefix match of the concept-id against component roots), not a ref segment. */
  component?: ComponentId;
  /** OKF concept ID = path within bundle − ext; opaque to the core. */
  conceptId?: string;
  /** Absolute local path (the read path). */
  path?: string;
  hash?: string;
  adapterId?: string;

  // ── Identity + FTS surface ──
  /** = OKF `type`; open; frontmatter (native) or adapter-derived (foreign). Presents/ranks/filters; NEVER executes or identifies. Required — the durable IndexDocument contract. */
  type: string;
  /** FTS 10 ← OKF `title` (fallback filename). */
  name: string;
  /** FTS 5 ← OKF `description`. */
  description?: string;
  /** FTS 3 ← OKF `tags`. */
  tags?: string[];
  /** FTS 2 — IndexDocument-native (IndexDocument uses `searchHints`). */
  hints?: string[];
  /** FTS 1 (bounded) — IndexDocument-native. */
  content?: string;

  // ── IndexDocument durable fields (the M1 decision's durable truth) ──
  examples?: string[];
  searchHints?: string[];
  intent?: StashIntent;
  filename?: string;
  /**
   * Asset quality marker (v1 spec §4.2). Four values are well-known:
   * `"generated"` and `"curated"` are included in default search;
   * `"enriched"` marks entries that have been LLM-enhanced (also included in
   * default search, excluded from re-enrichment unless `--re-enrich` is set);
   * `"proposed"` is excluded from default search and surfaced only with
   * `--include-proposed`. Unknown string values parse with a one-time
   * `console.warn` and remain searchable (treated as included-by-default).
   */
  quality?: "generated" | "curated" | "enriched" | "proposed" | (string & {});
  confidence?: number;
  source?: "package" | "frontmatter" | "comments" | "filename" | "manual" | "llm";
  aliases?: string[];
  toc?: TocHeading[];
  usage?: string[];
  /** How to run this asset (e.g. "bash deploy.sh", "bun run.ts") */
  run?: string;
  /** Setup command to run before execution (e.g. "bun install") */
  setup?: string;
  /** Working directory for execution */
  cwd?: string;
  /** File size in bytes for output sizing hints */
  fileSize?: number;
  /** Structured parameter definitions extracted from the asset content */
  parameters?: AssetParameter[];
  /**
   * Multi-tenant / multi-agent scope. Populated from the canonical
   * `scope_user`, `scope_agent`, `scope_run`, `scope_channel`
   * frontmatter keys. Used by `akm search --filter` and `akm show --scope`.
   */
  scope?: StashEntryScope;
  /**
   * Wiki role for knowledge pages following the LLM Wiki pattern.
   * `schema` / `index` / `log` are the special files at the top of the wiki;
   * `raw` marks immutable ingested sources; `page` (default) is an LLM-authored page.
   */
  wikiRole?: "schema" | "index" | "log" | "raw" | "page";
  /**
   * Page archetype for wiki pages. Any non-empty string is accepted so users
   * can introduce categories freely (e.g. `entity`, `concept`, `question`,
   * `note`, `decision-record`). Wiki conventions live in `schema.md`.
   */
  pageKind?: string;
  /** Cross-references to other knowledge entries by ref (e.g. "knowledge:auth-design"). */
  xrefs?: string[];
  /** Source identifiers this page was distilled from (typically `raw/<slug>` files). */
  sources?: string[];
  /**
   * Asset category, surfaced from the `category:` frontmatter key. Primarily
   * used by fact assets: `convention` marks house-rule facts delivered via
   * resolveStashStandards prompt injection; `meta` marks stash-about-itself
   * canon (e.g. active-projects slug lists). Any non-empty string is accepted
   * — this is descriptive metadata, not a validated enum. Captured into
   * entry_json so category-keyed policies (SPEC-6) are implementable.
   */
  category?: string;
  beliefState?: "active" | "asserted" | "deprecated" | "superseded" | "contradicted" | "archived" | (string & {});
  supersededBy?: string[];
  contradictedBy?: string[];
  /**
   * R5 — merge depth counter (frontmatter `generation`), maintained by
   * consolidate's injectGenerationFrontmatter. Absent = original asset.
   */
  generation?: number;
  /**
   * R5 — provenance pointers (frontmatter `source_refs`): the refs this asset
   * was merged/distilled from. Lets the collapse detector's canary scoring
   * follow a legitimately-merged anchor instead of reading it as collapse.
   */
  sourceRefs?: string[];
  currentBeliefRefs?: string[];
  /**
   * How the memory was captured. `hot` indicates a user-driven write
   * (the `akm remember` CLI path); `background` indicates an
   * agent/derived write (e.g. memory-inference). Absent on legacy memories.
   * Surfaced from the `captureMode:` frontmatter key.
   */
  captureMode?: "hot" | "background";
  /**
   * Free-form guidance describing when this asset should be applied.
   * Surfaced from the `when_to_use:` frontmatter key. Indexed into the
   * `hints` FTS column so retrieval can match query intent.
   */
  whenToUse?: string;
  /**
   * Strength signal for lessons: count of refs that have credited this
   * lesson via `akm feedback --applied-to`. Extracted from frontmatter:
   * an array stores its length here, a number stores directly.
   */
  lessonStrength?: number;
  /**
   * Source refs that this asset is derived from. Surfaced from the
   * `evidenceSources:` frontmatter key.
   */
  evidenceSources?: string[];
  /**
   * For derived memories (Phase 5A / Advantage D5), the parent ref that this
   * entry was distilled from. Surfaced from the `source:` frontmatter key
   * (form: `"memory:<parent-name>"`) when the entry is recognized as a
   * derived child. The indexer mirrors this value into the dedicated
   * `entries.derived_from` column so `getDerivedForParent()` can resolve the
   * child by parent ref without a full table scan.
   */
  derivedFrom?: string;
  /**
   * First prose paragraph of the asset body — the conventions' self-situating
   * opening (stash-conventions SPEC-8). Captured by the metadata pass only when
   * `index.indexBodyOpening` is enabled (default off), capped at
   * `BODY_OPENING_MAX_CHARS`. `buildSearchFields` folds it into the lowest-weight
   * `content` FTS column whenever present. Never captured for secret/env files or
   * session-kind memories.
   */
  bodyOpening?: string;

  // ── IndexDocument-native extras (no IndexDocument equivalent) ──
  pinned?: boolean;
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
