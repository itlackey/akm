// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R2 (docs/design/improve-self-learning-analysis.md) — the improve loop's
 * `asset_salience.rank_score` composes into user-facing ranking as a bounded
 * multiplicative boost, loaded fail-open from state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { upsertAssetSalience } from "../src/commands/improve/salience";
import { openStateDatabase } from "../src/core/state-db";
import type { StashEntry } from "../src/indexer/passes/metadata";
import { loadSalienceRankScores, type RankedEntryInput } from "../src/indexer/search/ranking";
import { applyUtilityContributors, type UtilityRankingContext } from "../src/indexer/search/ranking-contributors";
import type { Database } from "../src/storage/database";
import { type Cleanup, withIsolatedAkmStorage } from "./_helpers/sandbox";

function makeRanked(id: number, name: string, type = "lesson"): RankedEntryInput {
  const entry: StashEntry = { name, type: type as StashEntry["type"] };
  return {
    id,
    entry,
    filePath: `/stash/${type}s/${name}.md`,
    score: 1,
    rankingMode: "fts",
  };
}

function makeCtx(salienceRankScores?: Map<number, number>): UtilityRankingContext {
  return {
    db: null as unknown as Database,
    query: "x",
    queryLower: "x",
    queryTokens: ["x"],
    graphContext: null,
    utilityScores: new Map(),
    salienceRankScores,
  };
}

describe("R2 — salience ranking contributor", () => {
  test("rank_score boosts the item score, bounded at 1.2×", () => {
    const item = makeRanked(1, "hot");
    applyUtilityContributors(item, makeCtx(new Map([[1, 1.0]])));
    expect(item.score).toBeCloseTo(1.2, 9); // 1 + 1.0 × 0.2, capped

    const half = makeRanked(2, "warm");
    applyUtilityContributors(half, makeCtx(new Map([[2, 0.5]])));
    expect(half.score).toBeCloseTo(1.1, 9);
  });

  test("absent/zero rank_score leaves the score untouched (fail-open parity)", () => {
    const missing = makeRanked(1, "unknown");
    applyUtilityContributors(missing, makeCtx(new Map()));
    expect(missing.score).toBe(1);

    const zero = makeRanked(2, "zero");
    applyUtilityContributors(zero, makeCtx(new Map([[2, 0]])));
    expect(zero.score).toBe(1);

    const noMap = makeRanked(3, "nomap");
    applyUtilityContributors(noMap, makeCtx(undefined));
    expect(noMap.score).toBe(1);
  });
});

describe("R2 — loadSalienceRankScores (state.db read path)", () => {
  let cleanup: Cleanup;

  beforeEach(() => {
    ({ cleanup } = withIsolatedAkmStorage());
  });

  afterEach(() => cleanup());

  test("maps stored asset_salience rank scores back to entry ids by ref", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "lesson:hot", { encoding: 0.8, outcome: 0.5, retrieval: 0.9, rankScore: 0.77 });
    } finally {
      db.close();
    }
    const items = [makeRanked(11, "hot"), makeRanked(12, "cold")];
    const scores = loadSalienceRankScores(items);
    expect(scores.get(11)).toBeCloseTo(0.77, 9);
    expect(scores.has(12)).toBe(false);
  });
});
