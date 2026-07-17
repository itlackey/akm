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
