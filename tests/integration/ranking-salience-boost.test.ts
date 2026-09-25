// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R2 / #692 — the salience ranking contributor.
 *
 * `asset_salience.rank_score` no longer composes into DEFAULT user-facing
 * ranking (search/curate) as of #692: `salienceRankingContributor` was
 * dropped from `defaultUtilityRankingContributors`, and the state.db
 * best-effort load (`loadSalienceRankScores`) was deleted outright — it was
 * both retrieval-dominated noise on live data (rationale: w_r = 0.60 in
 * salience.ts, warm-starts non-zero with no outcome evidence, zero pack
 * coverage, max observed multiplier ×1.071) AND the cause of a confirmed
 * hot-path defect: every default search synchronously waited on the
 * maintenance-activity barrier (up to a 5s spin) before the 250ms SQLite
 * `busy_timeout` even applied.
 *
 * `rank_score` is UNCHANGED as improve's own internal selection signal — only
 * its promotion into user-facing ranking is removed. The contributor itself,
 * and its weight/cap constants, stay exported (unwired) for a future gated
 * experiment; the tests below drive it via EXPLICIT injection — building a
 * contributor list that includes it and calling `applyUtilityContributors`
 * directly — since it is no longer reachable through the default ranking path
 * (`applyRankingRules` / `akm search` / `akm curate`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { upsertAssetSalience } from "../../src/commands/improve/salience";
import { conceptIdFromTypeName } from "../../src/core/asset/resolve-ref";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { searchLocal } from "../../src/indexer/search/db-search";
import {
  applyUtilityContributors,
  salienceRankingContributor,
  type UtilityRankingContext,
} from "../../src/indexer/search/ranking-contributors";
import type { RankedEntryInput } from "../../src/indexer/search/ranking-types";
import type { Database } from "../../src/storage/database";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function makeRanked(id: number, name: string, type = "lesson"): RankedEntryInput {
  const entry: IndexDocument = { name, type: type as IndexDocument["type"] };
  return {
    id,
    entry,
    filePath: `/stash/${type}s/${name}.md`,
    score: 1,
    rankingMode: "fts",
    itemRef: `stash//${conceptIdFromTypeName(type, name)}`,
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

describe("R2 — salience ranking contributor (explicit injection only — not in the default list)", () => {
  test("rank_score boosts the item score, bounded at 1.2×", () => {
    const item = makeRanked(1, "hot");
    applyUtilityContributors(item, makeCtx(new Map([[1, 1.0]])), [salienceRankingContributor]);
    expect(item.score).toBeCloseTo(1.2, 9); // 1 + 1.0 × 0.2, capped

    const half = makeRanked(2, "warm");
    applyUtilityContributors(half, makeCtx(new Map([[2, 0.5]])), [salienceRankingContributor]);
    expect(half.score).toBeCloseTo(1.1, 9);
  });

  test("absent/zero rank_score leaves the score untouched (fail-open parity)", () => {
    const missing = makeRanked(1, "unknown");
    applyUtilityContributors(missing, makeCtx(new Map()), [salienceRankingContributor]);
    expect(missing.score).toBe(1);

    const zero = makeRanked(2, "zero");
    applyUtilityContributors(zero, makeCtx(new Map([[2, 0]])), [salienceRankingContributor]);
    expect(zero.score).toBe(1);

    const noMap = makeRanked(3, "nomap");
    applyUtilityContributors(noMap, makeCtx(undefined), [salienceRankingContributor]);
    expect(noMap.score).toBe(1);
  });

  test("NOT applied via the default contributor list, even with a populated map (the #692 removal itself)", () => {
    // Same populated map that produced a 1.2× boost above, but this time run
    // through applyUtilityContributors with NO explicit contributors list —
    // i.e. exactly how applyRankingRules / akm search / akm curate call it.
    // defaultUtilityRankingContributors no longer contains salience-ranking,
    // so this must be a no-op.
    const item = makeRanked(1, "hot");
    applyUtilityContributors(item, makeCtx(new Map([[1, 1.0]])));
    expect(item.score).toBe(1);
  });
});

describe("R2 removal (#692) — default search no longer touches state.db", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => storage.cleanup());

  /** Seed one searchable lesson asset and build the real index for it. */
  async function seedAndIndex(): Promise<void> {
    const lessonPath = path.join(storage.stashDir, "lessons", "hot.md");
    fs.writeFileSync(lessonPath, "---\ndescription: a hot lesson\n---\n\n# hot\n\nBody text about hot.\n", "utf8");
    await akmIndex({ stashDir: storage.stashDir });
  }

  function search() {
    return searchLocal({
      query: "hot",
      searchType: "any",
      limit: 5,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config: { semanticSearchMode: "off" },
    });
  }

  test("default search never creates state.db (stronger form: it touches state.db not at all)", async () => {
    await seedAndIndex();
    const dbPath = getStateDbPath();
    // akmIndex itself legitimately touches state.db (index-run bookkeeping,
    // unrelated to search/ranking) via `withStateDb`, so a fresh sandbox is
    // not guaranteed to still be state.db-less after indexing. Force absence
    // right before the search call — that isolates the property this test
    // actually cares about: SEARCH, not indexing, must not create it.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    const result = await search();
    expect(result.hits.length).toBeGreaterThan(0);

    // The default search path must not have created (or opened) state.db —
    // loadSalienceRankScores, the only reason the search path ever touched
    // state.db, is deleted outright, not merely made conditional.
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
