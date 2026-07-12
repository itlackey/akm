// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared memory belief-state machinery (C-3 / #382).
 *
 * Extracted from `memory-improve.ts` so both `akmConsolidate` and
 * `analyzeMemoryCleanup` can emit `MemoryBeliefTransitionLogRecord` entries
 * through a unified state-transition model.
 *
 * # Design
 *
 * The 4-state belief lifecycle (active → superseded | contradicted → archived)
 * was previously encoded only in `memory-improve.ts`. `akmConsolidate` used a
 * flat merge/delete/promote model with no belief states, causing the two engines
 * to diverge. This module:
 *
 *   1. Re-exports the belief-state types from `memory-improve.ts` so callers
 *      can import from one canonical location.
 *   2. Provides `writeContradictEdge` — a shared primitive that both engines
 *      use when an LLM (or heuristic) identifies a contradiction between two
 *      memories. This is the bridge between `akmConsolidate`'s LLM-detected
 *      contradictions and `resolveFamilyContradictions`' SCC resolver.
 *
 * # References
 *
 * - Zep / Graphiti (arXiv:2501.13956 §3) — unified belief-revision pipeline
 * - MemOS (arXiv:2507.03724) — formal archive/merge/transition with shared state model
 */

import { mutateFrontmatter } from "../../../core/asset/frontmatter";

// ── Re-exported belief-state types ───────────────────────────────────────────

export type {
  MemoryBeliefState,
  MemoryBeliefStateTransition,
  MemoryBeliefTransitionLogRecord,
} from "./memory-improve";

// ── Shared edge-list reader ───────────────────────────────────────────────────

/**
 * Read a frontmatter edge value (`supersededBy` / `contradictedBy`) as a
 * string list, promoting a scalar string to a one-element list.
 *
 * Scalar edges are LIVE data: the indexer's `normalizeNonEmptyStringList`
 * accepts them and lint deliberately never flags them. An Array.isArray-only
 * read treats a scalar as "no existing edges" and silently destroys the edge
 * on the next merge — mirror `mergeXrefsIntoContent`'s scalar promotion
 * instead.
 */
function readEdgeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// ── Contradiction edge writer ─────────────────────────────────────────────────

/**
 * Write `contradictedBy` and `beliefState: contradicted` edges to a memory
 * file's frontmatter (C-3 / #382).
 *
 * This is the shared primitive used by:
 *   - `akmConsolidate` when its LLM plan includes a `contradict` op
 *   - `memory-contradiction-detect.ts` for the M-1 automated contradiction pass
 *   - `resolveFamilyContradictions` in `memory-improve.ts` for SCC resolution
 *
 * Idempotent: if the `contradictedByRef` is already in `contradictedBy` AND
 * the file already carries the demotion state, the file is not rewritten. The
 * guard is state-aware like its sibling {@link writeSupersededEdge}: an edge
 * present WITHOUT the demotion (e.g. a hand-written `contradictedBy:` line,
 * or a beliefState lost to a partial edit) is repaired, not skipped — an
 * edge-only guard would make such a file a permanent no-op while
 * consolidate's handleContradictOp reports the contradiction as applied.
 *
 * Never weakens a stronger demotion: `archived` ranks BELOW `contradicted`
 * (see `BELIEF_STATE_SCORE_CEILINGS` in
 * src/indexer/search/ranking-contributors.ts), so contradicting an archived
 * memory keeps `archived` and only appends the edge.
 *
 * @param filePath          - Absolute path to the memory markdown file.
 * @param contradictedByRef - The ref that contradicts this memory.
 */
export function writeContradictEdge(filePath: string, contradictedByRef: string): void {
  mutateFrontmatter(filePath, (parsed) => {
    const existing = readEdgeList(parsed.data.contradictedBy);
    const currentState = parsed.data.beliefState;
    const nextState = currentState === "archived" ? currentState : "contradicted";
    if (existing.includes(contradictedByRef) && currentState === nextState) {
      return null; // Already written — idempotent.
    }

    const nextContradictedBy = [...new Set([...existing, contradictedByRef])].sort();
    return {
      ...parsed.data,
      contradictedBy: nextContradictedBy,
      beliefState: nextState,
    };
  });
}

// ── Supersession edge writer ─────────────────────────────────────────────────

/**
 * Write `supersededBy` and `beliefState: superseded` edges to an asset file's
 * frontmatter (SPEC-5, stash-conventions-code-spec.md).
 *
 * Sibling of {@link writeContradictEdge}: the shared primitive for the
 * conventions' corrections pattern — when a new asset supersedes an old one,
 * the old asset gets a METADATA-ONLY demotion edit (every other frontmatter
 * key and the body are preserved) so the ranker's beliefStateBoost demotes the
 * stale incumbent and `--belief current` hides it. Used by
 * `akm remember --supersedes` / `akm import --supersedes`.
 *
 * Idempotent: if `supersededByRef` is already in `supersededBy` and the file
 * is already demoted, the file is not rewritten. Multiple corrections
 * sorted-set-append their refs.
 *
 * Never WEAKENS an existing demotion: `contradicted` and `archived` rank
 * BELOW `superseded` (severity order deprecated > superseded > contradicted >
 * archived — see `BELIEF_STATE_SCORE_CEILINGS` in
 * src/indexer/search/ranking-contributors.ts), so superseding an already
 * contradicted/archived asset keeps the stronger state and only appends the
 * `supersededBy` edge.
 *
 * @param filePath        - Absolute path to the asset markdown file.
 * @param supersededByRef - The ref of the correction that supersedes this asset.
 */
export function writeSupersededEdge(filePath: string, supersededByRef: string): void {
  mutateFrontmatter(filePath, (parsed) => {
    const existing = readEdgeList(parsed.data.supersededBy);
    const currentState = parsed.data.beliefState;
    const nextState = currentState === "contradicted" || currentState === "archived" ? currentState : "superseded";
    if (existing.includes(supersededByRef) && currentState === nextState) {
      return null; // Already written — idempotent.
    }

    const nextSupersededBy = [...new Set([...existing, supersededByRef])].sort();
    return {
      ...parsed.data,
      supersededBy: nextSupersededBy,
      beliefState: nextState,
    };
  });
}
