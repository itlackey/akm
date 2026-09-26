// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Belief-state edge writer (#382): append a `supersededBy` edge to an asset's
 * frontmatter and demote its `beliefState`, metadata only. Idempotent (a
 * present edge AND demotion is a no-op; an edge without its demotion is
 * repaired) and never weakens a stronger demotion — severity is
 * superseded > contradicted > archived, per the ranker's `beliefStateBoost`.
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
