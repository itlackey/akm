// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Belief-state edge writer (#382): append a `supersededBy` edge to an asset's
 * frontmatter and demote its `beliefState`, metadata only. Idempotent (a
 * present edge AND demotion is a no-op; an edge without its demotion is
 * repaired) and never weakens a stronger demotion — severity is
 * superseded > contradicted > archived. (alpha.4 removed belief weights from
 * ranking: search no longer reads `beliefState` at all, and `--belief
 * current|historical` is the only reader, opt-in.)
 * The SCC resolver in memory-improve.ts is a state-transition writer (it
 * replaces and clears edges) and deliberately does not use this (#885).
 */

import { mutateFrontmatter } from "../../../core/asset/frontmatter";

export type { MemoryBeliefState, MemoryBeliefStateTransition } from "../../../core/improve-types";
export type { MemoryBeliefTransitionLogRecord } from "./memory-improve";

/**
 * An edge value as a list. A scalar string is live data (the indexer accepts
 * it), so it is promoted rather than dropped on the next write.
 */
function readEdgeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Mark an asset superseded by a correction (`akm remember|import --supersedes`). */
export function writeSupersededEdge(filePath: string, supersededByRef: string): void {
  mutateFrontmatter(filePath, (parsed) => {
    const existing = readEdgeList(parsed.data.supersededBy);
    const currentState = parsed.data.beliefState;
    const nextState = currentState === "contradicted" || currentState === "archived" ? currentState : "superseded";
    if (existing.includes(supersededByRef) && currentState === nextState) return null;
    return {
      ...parsed.data,
      supersededBy: [...new Set([...existing, supersededByRef])].sort(),
      beliefState: nextState,
    };
  });
}

/**
 * The inverse of {@link writeSupersededEdge}: drop `supersededByRef` from the
 * edge list and, once the list is empty, demote `beliefState` back to
 * `active` (never touches a stronger `contradicted`/`archived` state, which
 * this edge did not set). Used only by `akm proposal revert` undoing a
 * consolidate pair-pass `supersedes` retire proposal (alpha.9) — the file
 * must still exist at `filePath`, which revert has already verified.
 */
export function removeSupersededEdge(filePath: string, supersededByRef: string): void {
  mutateFrontmatter(filePath, (parsed) => {
    const existing = readEdgeList(parsed.data.supersededBy);
    if (!existing.includes(supersededByRef)) return null;
    const remaining = existing.filter((ref) => ref !== supersededByRef);
    const currentState = parsed.data.beliefState;
    const next: Record<string, unknown> = { ...parsed.data };
    if (remaining.length > 0) {
      next.supersededBy = remaining;
    } else {
      delete next.supersededBy;
      if (currentState === "superseded") next.beliefState = "active";
    }
    return next;
  });
}
