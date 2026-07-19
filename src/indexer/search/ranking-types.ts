// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types shared by `indexer/search/ranking.ts` and
 * `indexer/search/ranking-contributors.ts`.
 *
 * Split out of `ranking.ts` so that `ranking-contributors.ts` (which
 * `ranking.ts` imports the contributor functions/lists from) does not need a
 * type-only import back into `ranking.ts` — that back-edge is a static-graph
 * cycle even though it is type-only (chunk 9 WI-9.8 KILL 2 sever). `ranking.ts`
 * re-exports `RankedEntryInput` so existing import sites are unaffected.
 */

import type { IndexDocument } from "../passes/metadata";

export interface RankedEntryInput {
  id: number;
  entry: IndexDocument;
  filePath: string;
  score: number;
  rankingMode: "hybrid" | "semantic" | "fts";
  utilityBoosted?: boolean;
  /**
   * Set by `applyBeliefStateScoreCeiling` when a demoting belief state's
   * ceiling clamped this item: the score BEFORE the clamp. The semantic-only
   * `minScore` floor in db-search checks this instead of the clamped score,
   * so a ceiling that sits below the floor (e.g. archived 0.15 < default
   * minScore 0.2) demotes the hit to last place instead of silently DROPPING
   * a result that would otherwise have listed.
   */
  preCeilingScore?: number;
}
