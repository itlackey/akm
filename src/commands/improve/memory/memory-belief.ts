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

import fs from "node:fs";
import { assembleAsset } from "../../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../../core/frontmatter";

// ── Re-exported belief-state types ───────────────────────────────────────────

export type {
  MemoryBeliefState,
  MemoryBeliefStateTransition,
  MemoryBeliefTransitionLogRecord,
} from "./memory-improve";

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
 * Idempotent: if the `contradictedByRef` is already in `contradictedBy`,
 * the file is not rewritten.
 *
 * @param filePath          - Absolute path to the memory markdown file.
 * @param contradictedByRef - The ref that contradicts this memory.
 */
export function writeContradictEdge(filePath: string, contradictedByRef: string): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);

  const existing: string[] = Array.isArray(parsed.data.contradictedBy) ? (parsed.data.contradictedBy as string[]) : [];
  if (existing.includes(contradictedByRef)) return; // Already written — idempotent.

  const nextContradictedBy = [...new Set([...existing, contradictedByRef])].sort();
  const nextFrontmatter: Record<string, unknown> = {
    ...parsed.data,
    contradictedBy: nextContradictedBy,
    beliefState: "contradicted",
  };

  fs.writeFileSync(filePath, assembleAsset(nextFrontmatter, parsed.content), "utf8");
}
