// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Supporting type family for the `BundleAdapter` interface
 * (`./bundle-adapter.ts`).
 *
 * Types:
 *
 *  - `BundleId` / `ComponentId` / `ItemRef` / `BundleInstallation` /
 *    `BundleComponent` — the bundle / component / installation model.
 *
 *  - `IndexDocument` — the durable indexed-entry shape.
 *
 *  - `ValidateContext` — the context an adapter's `validate` receives.
 *
 *  - `Diagnostic` — `validate`'s `Promise<Diagnostic[]>` return type. Modeled
 *    on the existing `LintIssue` (`src/commands/lint/types.ts`:
 *    `{ file, issue, detail, fixed }`), with one deliberate generalization:
 *    `issue` is an open `string` here rather than `LintIssueType` (a closed
 *    union of lint-command-specific codes) — `Diagnostic` is produced by
 *    arbitrary adapters' `validate()`, not scoped to the lint command's
 *    vocabulary.
 *
 * Not declared here: the OPTIONAL authoring, export, and memory facet methods
 * and their type family (`AuthoringTarget`/`AuthoringContext`/`CreateRequest`/
 * `BundleExport`/`BindingRequest`/`BindingPlan`/`MemoryRecord`/
 * `MemorySemanticPlan`). No adapter implements those facets, and the type
 * shapes are added together with the method when a facet is built, rather
 * than as meaningless `Record<string, unknown>` placeholders on the
 * foundational contract.
 */

import type { TocHeading } from "../asset/markdown";

// ── Bundle / component / installation model ─────────────────────────────────

/** Stable bundle name (workspace identity); the optional ref prefix. */
export type BundleId = string;

/** A configured root under one adapter; PROVENANCE, not a ref segment. */
export type ComponentId = string;

/** `"[<bundle>//]<concept-id>"` — the ref grammar. */
export type ItemRef = string;

export interface BundleInstallation {
  id: BundleId;
  /** Resolved git sha / npm version+integrity / snapshot digest. */
  revision?: string;
  /** Transport locator, kept OUT of identity. */
  source?: string;
  components: BundleComponent[];
  /** Explicit trust; installation grants nothing. */
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
// These IndexDocument sub-shapes live HERE (not in
// `indexer/passes/metadata.ts`) so {@link IndexDocument} (below) can reference
// them WITHOUT closing a `metadata.ts ↔ types.ts` import cycle (the cycle
// ratchet counts type-only edges). `metadata.ts` re-exports them under their
// historical names, and the value `SCOPE_KEYS` stays there.

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

/** Allowed keys in the `--filter k=v` flag (used by `akm search` and `akm show`). */
export type ScopeKey = keyof StashEntryScope;

// ── IndexDocument ───────────────────────────────────────────────────────────
//
// The scan engine drains `IndexDocument`s, and the durable `document_json`
// column is a faithful `IndexDocument`. To let a metadata-pipeline entry
// literal (`{ name, type, … }`, no provenance) satisfy this type, the seven
// provenance fields are OPTIONAL here; `recognize` and the scan writer fill
// them in, and they are never serialized onto `document_json`.

export interface IndexDocument {
  // ── Provenance — OPTIONAL; see header ──
  /** Fully-qualified "<bundle>//<concept-id>" (canonical stored spelling). */
  ref?: ItemRef;
  bundle?: BundleId;
  /** PROVENANCE from the bundle's single configured component, not a ref segment. */
  component?: ComponentId;
  /** OKF concept ID = path within bundle − ext; opaque to the core. */
  conceptId?: string;
  /** Absolute local path (the read path). */
  path?: string;
  hash?: string;
  adapterId?: string;
  /**
   * The owning adapter provides the complete generic presentation projection.
   * When true, `show` must not reinterpret the open `type` through AKM's native
   * renderer table. Omitted means the core may apply its type renderer.
   */
  ownsPresentation?: boolean;

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
  /**
   * True when `content` was cut to fit `MARKDOWN_CONTENT_MAX_CHARS`
   * (src/indexer/passes/metadata.ts) — the projection was longer than the
   * bound before truncation. Omitted (not `false`) when no truncation
   * occurred. Surfaces the otherwise-silent cut so a caller can tell indexed
   * content was cut short.
   */
  contentTruncated?: boolean;

  // ── IndexDocument durable fields ──
  examples?: string[];
  searchHints?: string[];
  intent?: StashIntent;
  filename?: string;
  /**
   * Asset quality marker. Four values are well-known:
   * `"generated"` and `"curated"` are included in default search;
   * `"enriched"` marks entries the now-retired LLM metadata-enhancement pass
   * rewrote (also included in default search; nothing sets
   * it anymore); `"proposed"` is excluded from default search and surfaced
   * only with `--include-proposed`. Unknown string values parse with a
   * one-time `console.warn` and remain searchable (treated as
   * included-by-default).
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
   * frontmatter keys. Used by `akm search --filter` and `akm show --filter`.
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
  /** Cross-references to other knowledge entries by ref (e.g. "knowledge/auth-design"). */
  xrefs?: string[];
  /** Source identifiers this page was distilled from (typically `raw/<slug>` files). */
  sources?: string[];
  /**
   * Asset category, surfaced from the `category:` frontmatter key. Primarily
   * used by fact assets: `convention` marks house-rule facts delivered via
   * resolveStashStandards prompt injection; `meta` marks stash-about-itself
   * canon (e.g. active-projects slug lists). Any non-empty string is accepted
   * — this is descriptive metadata, not a validated enum. Captured into
   * document_json so category-keyed policies are implementable.
   */
  category?: string;
  beliefState?: "active" | "asserted" | "deprecated" | "superseded" | "contradicted" | "archived" | (string & {});
  supersededBy?: string[];
  contradictedBy?: string[];
  currentBeliefRefs?: string[];
  /**
   * How the memory was captured. `hot` indicates a user-driven write
   * (the `akm remember` CLI path); `background` indicates an
   * agent/derived write (e.g. memory-inference). Optional when capture mode is unknown.
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
   * For derived memories, the parent ref that this
   * entry was distilled from. Surfaced from the `source:` frontmatter key
   * (form: `"memories/<parent-name>"`) when the entry is recognized as a
   * derived child. The indexer mirrors this value into the dedicated
   * `entries.derived_from` column so `getDerivedForParent()` can resolve the
   * child by parent ref without a full table scan.
   */
  derivedFrom?: string;
  // ── IndexDocument-native extras (no IndexDocument equivalent) ──
  pinned?: boolean;
  /** ← OKF `timestamp` (v0.1) — v0.2 prefers `generated.at` when present; see `updated`'s derivation note below. */
  updated?: string;
  /** Resolved native links = relationships; navigation/lint, NOT graph boost. */
  links?: string[];
  /** The assets a workflow's steps or a task target (`uses:` refs, stored `akm/command` refs), in authored order. */
  uses?: string[];
  /**
   * OKF v0.2 trust/provenance family ← frontmatter `generated`/`verified`/`sources`.
   * This TypeScript field is NAMESPACED to avoid colliding with the
   * pre-existing `sources?: string[]` (wiki citations) and
   * `quality: "generated"` (enum value) fields
   * above — see the file-level note ahead of {@link OkfProvenance}. The
   * ON-DISK spelling is a separate, deliberately hybrid decision (#730
   * review): `okf` parses third-party OKF v0.2 bundles' bare top-level
   * `generated:`/`verified:`/`sources:`; `promoteProposal` additionally
   * *writes* AKM-native assets it promotes, stamping `generated:`/`verified:`
   * bare at the top level (matching OKF v0.2's own spelling exactly — neither
   * key collides with an existing AKM field) while keeping only `sources`
   * namespaced under `provenance:` (a bare `sources:` would collide with the
   * wiki-citation convention). Both read paths fold onto this SAME TypeScript
   * shape, and the `akm` adapter rereads what it wrote.
   */
  provenance?: OkfProvenance;
  /** OKF v0.2 lifecycle ← frontmatter `status`. Upstream defaults absence to "stable"; left `undefined` here (not defaulted) so callers can distinguish "undeclared" from "explicitly stable." */
  lifecycleStatus?: "draft" | "stable" | "deprecated";
  /** OKF v0.2 lifecycle ← frontmatter `stale_after` (nominally `YYYY-MM-DD`, read verbatim/untyped). Read-only — no re-verification or trust-tier ranking is driven off it. */
  staleAfter?: string;
  /** ← frontmatter `okf_version`. Upstream declares this only on the bundle-root reserved structural listing file (itself never indexed as a concept); read defensively from ANY concept's frontmatter, best-effort (conformance Rule 9 — an unknown/foreign value is never rejected). */
  okfVersion?: string;
  /** Opaque adapter extras ONLY (arbitrary OKF frontmatter keys); not FTS, never parsed by core. */
  documentJson?: unknown;
}

// ── OKF v0.2 trust/provenance/lifecycle family (see okf-support.md) ─────────
//
// These fields use NEW, NAMESPACED names — never overloading the AKM-native
// fields that already occupy adjacent names on this interface:
//   - `sources?: string[]`   (above) — wiki citation strings (llm-wiki adapter,
//     `indexer/passes/metadata.ts#applyWikiFrontmatter`); a v0.2 `sources:`
//     frontmatter block is a list of OBJECTS (`{resource, id?, title?, …}`),
//     an incompatible shape that would silently drop to `[]` if folded onto
//     this field (the exact collision this namespacing avoids).
//   - `quality: "generated"` (above) — an existing enum VALUE, unrelated.
// See `docs/architecture/specs/okf-support.md`'s v0.2 note.

/** One `sources:` entry (OKF v0.2). Only `resource` is required upstream; the rest are optional credibility signals, read verbatim and never validated/scored. */
export interface OkfSourceEntry {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
}

/** One `verified:` entry (OKF v0.2). `at` is optional — a bare `by` is tolerated. */
export interface OkfVerifiedEntry {
  by: string;
  at?: string;
}

/**
 * OKF v0.2 trust/provenance family, parsed from the frontmatter `generated:`
 * (`{by, at}`) / `verified:` (a list, OR — v0.2's permitted shorthand — a
 * single mapping without the list dash) / `sources:` (object list) keys.
 * Present only when at least one sub-field parsed; every sub-field is
 * independently optional (never rejects a document for a missing/malformed
 * one — OKF conformance leniency).
 */
export interface OkfProvenance {
  sources?: OkfSourceEntry[];
  generatedBy?: string;
  generatedAt?: string;
  verified?: OkfVerifiedEntry[];
}

// ── ValidateContext ─────────────────────────────────────────────────────────

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

// ── Diagnostic ──────────────────────────────────────────────────────────────

/**
 * Modeled on `LintIssue` (`src/commands/lint/types.ts`) with
 * `issue` generalized to an open string (see file header for rationale).
 */
export interface Diagnostic {
  file: string;
  issue: string;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = fix attempted but threw. */
  fixed: boolean | "failed";
  /**
   * 1-indexed line in `file` the finding refers to, when the producing check
   * knows one. OPTIONAL by design: most adapter checks are whole-file
   * (`missing-skill-md`, `orphaned-stub`) and have no line to report. The
   * workflow frontend anchors every parse/compile error to a line
   * (`WorkflowError.line`), and that anchor now travels all the way to
   * `akm lint`'s human and JSON output instead of being dropped at this
   * boundary.
   */
  line?: number;
}
