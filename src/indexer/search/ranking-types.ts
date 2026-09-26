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
 * keeps the ranking dependency graph acyclic.
 */

import type { IndexDocument } from "../passes/metadata";
import type { LexicalQueryExecution } from "./fts-query";

export interface RankedEntryInput {
  id: number;
  entry: IndexDocument;
  filePath: string;
  score: number;
  rankingMode: "hybrid" | "semantic" | "fts";
  /** Stage of the central lexical plan that admitted this candidate. */
  lexicalMatch?: LexicalQueryExecution;
  /** Durable fully-qualified `<bundle>//<concept-id>` indexed identity. */
  itemRef?: string | null;
  bundleId?: string | null;
  conceptId?: string | null;
  /** Safe selector returned only for a fragment-supported lexical hit. */
  fragmentId?: string;
  utilityBoosted?: boolean;
  /**
   * Set by the relaxed non-name lexical ceiling before that ceiling reduces a
   * body-only candidate's raw score. Ranking evidence only, so a ceilinged
   * relaxed set does not fall back to filename order.
   */
  preRelaxedCeilingScore?: number;
}
