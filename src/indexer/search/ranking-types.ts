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

/**
 * `unit_texts.kind` (index-redesign-contract.md B1): `"card"` is the one
 * structured-fields unit every entry has (ordinal 0); `"fragment"` is a
 * Markdown-fragment-derived unit. Duplicated here rather than imported from
 * the storage layer because B3 derives it from `fragmentId` nullity alone
 * (see `fuseByEntry` in `ranking.ts`) and never reads `unit_texts` itself.
 */
export type UnitKind = "card" | "fragment";

/** Which unit (of possibly several per entry) a units-search hit matched on. */
export interface MatchedUnit {
  unitHash: string;
  fragmentId: string | null;
  kind: UnitKind;
}

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
   * Set by `applyBeliefStateScoreCeiling` when a demoting belief state's
   * ceiling clamped this item: the score BEFORE the clamp. The final ranking
   * comparator (`db-search.ts`) checks this instead of the clamped score for
   * its tie-break ordering, so a demoted hit still sorts among its peers by
   * the relevance it would have had without the demotion, rather than
   * collapsing every ceilinged item to the same clamped value.
   */
  preCeilingScore?: number;
  /**
   * Set by the relaxed non-name lexical ceiling before that ceiling reduces a
   * body-only candidate's raw score. This is ranking evidence only: unlike
   * `preCeilingScore`, it must survive a later belief-state ceiling so a
   * compound-demoted relaxed set does not fall back to filename order.
   */
  preRelaxedCeilingScore?: number;
  /**
   * Set by `fuseByEntry` (index-redesign-contract.md B3): the specific unit —
   * of possibly several the entry has — whose reciprocal-rank score won the
   * entry its grouping. Absent only for a browse-path hit (a deterministic
   * listing, not a relevance match — see `enumerateEntries` in
   * `db-search.ts`).
   */
  matchedUnit?: MatchedUnit;
}
