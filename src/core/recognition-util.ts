// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The util home for recognition/grammar constants shared across the asset,
 * indexer, and workflow layers (chunk 1, D1-4).
 *
 * INVARIANT (D1-5, cycle-safety): this module MUST import NOTHING from
 * `src/` (no relative `./`/`../` imports into the tree). All four symbols
 * below are self-contained literals/pure functions today, so this file is a
 * pure sink — everything imports FROM it, it imports from nothing internal.
 * The import-cycle ratchet (`scripts/lint-import-cycles.ts`) is shrink-only:
 * a 29th cycle participant is a hard failure, so this file must never gain
 * an internal import that could pull it into an existing knot. Enforced
 * mechanically by `tests/core/recognition-util.test.ts`.
 */

/** All recognized script extensions for the script asset type. */
export const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".ts",
  ".js",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".rb",
  ".go",
  ".pl",
  ".php",
  ".lua",
  ".r",
  ".swift",
  ".kt",
  ".kts",
]);

/**
 * Recognized workflow asset extensions, in resolution-priority order.
 * `.md` (classic linear markdown workflows — the stable contract) stays
 * FIRST for back-compat; `.yaml`/`.yml` hold YAML workflow *programs*
 * (redesign addendum, R1). `workflow:<name>` refs resolve against this list.
 */
export const WORKFLOW_EXTENSIONS = [".md", ".yaml", ".yml"] as const;

/**
 * Strip a recognized workflow extension (`.md`/`.yaml`/`.yml`) from a workflow
 * asset *name* so `foo`, `foo.yaml`, `foo.yml`, and `foo.md` collapse to one
 * canonical identity — the same collapse `workflowSpec.toCanonicalName`
 * performs on a resolved file path. Callers that turn a `workflow:<name>` ref
 * into run identity (the active-run guard, list/status filters) MUST route the
 * name through this so an aliased spelling (`workflow:foo.yaml`) and the
 * canonical `workflow:foo` cannot start or hide parallel runs of the same
 * workflow. Names without a recognized workflow extension pass through
 * unchanged.
 */
export function canonicalizeWorkflowName(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of WORKFLOW_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** Structural marker suffix for a derived (inferred) memory's canonical name. */
export const DERIVED_SUFFIX = ".derived";

// ── Known-type taxonomy (chunk 1.5, D1.5-4) ─────────────────────────────────
//
// `KNOWN_TYPES` replaces the deleted `common.ts` closed asset-type union.
// It is a HINT/exhaustiveness tuple, NOT a validation gate: unknown/foreign
// `type` strings are still valid `IndexDocument`/`StashEntry`/`AssetRef` DATA
// (plan §2.3/§15.4) — this tuple only anchors compile-time completeness for
// AKM's OWN presentation/ranking tables (`Record<KnownType, X>` fails to
// compile if a key is missing). A plain `as const` literal tuple adds no
// import, so it lives here without breaking the D1-5 import-free invariant.

/**
 * The AKM-owned built-in asset type keys — the deleted `common.ts` `ASSET_TYPES`
 * set (same order) minus the retired `wiki` type (chunk 4); `instruction`
 * (CLAUDE.md / AGENTS.md project-instruction files) is the newest, added for the
 * format-family adapters (spec §6/§7 instruction row, maintainer resolution
 * 2026-07). An instruction file is a read-like-knowledge markdown document, so
 * it reuses knowledge's presentation shape (label "Instruction", `knowledge-md`
 * renderer, a "read the project instructions" action) rather than the generic
 * fallback. `wiki` was removed here in chunk 4 ("the wiki ASSET-TYPE dies", plan
 * §11 Chunk 4 / §7.4): the LLM Wiki structure now lives in the first-class
 * `llm-wiki` adapter whose page kinds are open (foreign) types, not AKM-owned.
 */
export const KNOWN_TYPES = [
  "skill",
  "command",
  "agent",
  "knowledge",
  "workflow",
  "script",
  "memory",
  "env",
  "secret",
  "lesson",
  "task",
  "session",
  "fact",
  "instruction",
] as const;

export type KnownType = (typeof KNOWN_TYPES)[number];

/**
 * Returns true when `type` is one of AKM's own known type keys
 * ({@link KNOWN_TYPES}). Unlike the deleted `isAssetType`, this is NOT a
 * validation gate — a `false` result does not mean `type` is invalid data,
 * only that it is not AKM-owned (a foreign/adapter type is still a valid
 * ref/entry). Used to index `Record<KnownType, X>` tables safely from an
 * open `string` and, later, for cross-surface known-type spelling checks.
 */
export function isKnownType(type: string): type is KnownType {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

/**
 * Type keys deliberately REMOVED from AKM (chunk 1.5, D1.5-6 — the key
 * correctness call in the open-token change). The open type token accepts
 * any non-empty string as valid ref/entry DATA except this set: silently
 * re-admitting a retired type as an ordinary "foreign" type would defeat the
 * guard that removed it in the first place.
 *
 *   - `vault` — removed in 0.9.0 in favor of `env`/`secret`; carries its own
 *     migration-hint `UsageError` in `asset-ref.ts` (checked before this
 *     set) and interacts with the dangerous-env-key lint
 *     (`commands/lint/env-key-rules.ts`) — vaults must never be silently
 *     re-admitted as an ordinary indexed/ref-able type.
 *   - `tool` — retired outright, no replacement.
 *
 * Consulted by `asset-ref.ts`'s `parseAssetRef` and `metadata.ts`'s
 * `validateStashEntry` gate (and the `akm` adapter's `recognize`) so the
 * rejection lives in one place instead of three closed-union-shaped copies.
 */
export const DEPRECATED_REJECTED_TYPES: ReadonlySet<string> = new Set(["tool", "vault"]);
