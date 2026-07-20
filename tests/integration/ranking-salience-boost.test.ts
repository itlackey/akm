// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R2 (docs/design/improve-self-learning-analysis.md) — the improve loop's
 * `asset_salience.rank_score` composes into user-facing ranking as a bounded
 * multiplicative boost, loaded fail-open from state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { upsertAssetSalience } from "../../src/commands/improve/salience";
import { acquireMaintenanceBarrier } from "../../src/core/maintenance-barrier";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { loadSalienceRankScores, type RankedEntryInput } from "../../src/indexer/search/ranking";
import { applyUtilityContributors, type UtilityRankingContext } from "../../src/indexer/search/ranking-contributors";
import type { Database } from "../../src/storage/database";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

function makeRanked(id: number, name: string, type = "lesson"): RankedEntryInput {
  const entry: IndexDocument = { name, type: type as IndexDocument["type"] };
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
      upsertAssetSalience(db, "lessons/hot", { encoding: 0.8, outcome: 0.5, retrieval: 0.9, rankScore: 0.77 });
    } finally {
      db.close();
    }
    const items = [makeRanked(11, "hot"), makeRanked(12, "cold")];
    const scores = loadSalienceRankScores(items);
    expect(scores.get(11)).toBeCloseTo(0.77, 9);
    expect(scores.has(12)).toBe(false);
  });

  test("missing state.db → empty map, and the search path never CREATES the file", () => {
    // No openStateDatabase() call in this test: state.db does not exist yet.
    const dbPath = getStateDbPath();
    expect(fs.existsSync(dbPath)).toBe(false);
    const scores = loadSalienceRankScores([makeRanked(1, "anything")]);
    expect(scores.size).toBe(0);
    // The read-only search path must not have created or migrated state.db.
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  test("coordinates the canonical read-only handle with the maintenance barrier", () => {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, "lessons/hot", { encoding: 0.8, outcome: 0.5, retrieval: 0.9, rankScore: 0.77 });
    } finally {
      db.close();
    }
    const items = [makeRanked(11, "hot")];
    const releaseBarrier = acquireMaintenanceBarrier();
    try {
      expect(loadSalienceRankScores(items).size).toBe(0);
    } finally {
      releaseBarrier();
    }
    expect(loadSalienceRankScores(items).get(11)).toBeCloseTo(0.77, 9);
  });
});

// ── F5d Step 5 — the required salience dual-read (legacy + item_ref) ───────────
//
// The Chunk-5 flip F5d dual-arms `loadSalienceRankScores`: it folds BOTH stored
// spellings into the single `asset_salience` IN query — the durable
// `bundle//conceptId` item_ref FIRST, the pre-flip `type:name` legacy key
// SECOND. An asset seeded under EITHER spelling must receive the SAME salience
// boost, and a fresh new-grammar row must win over any stale legacy row for the
// same asset (the Chunk-8 re-key transition window). These tests seed salience
// directly (bypassing the writers, which flip separately) so the read path is
// pinned independently of the write path.
describe("Chunk-8 — salience dual-key read (bare conceptId + `bundle//conceptId` item_ref)", () => {
  let cleanup: Cleanup;

  beforeEach(() => {
    ({ cleanup } = withIsolatedAkmStorage());
  });

  afterEach(() => cleanup());

  /** A ranked item that carries a durable `item_ref` (a post-flip, provenance-bearing row). */
  function makeRankedWithItemRef(id: number, name: string, itemRef: string, type = "lesson"): RankedEntryInput {
    return { ...makeRanked(id, name, type), itemRef };
  }

  test("an asset seeded under the bare conceptId and one under bundle//conceptId both boost identically", () => {
    const db = openStateDatabase();
    try {
      // Bare-conceptId spelling: the scope-ref / entry-absent write-key fallback.
      upsertAssetSalience(db, "lessons/legacy-hot", { encoding: 0.8, outcome: 0.5, retrieval: 0.9, rankScore: 0.66 });
      // Post-flip spelling: a provenance-bearing row keyed by the durable item_ref.
      upsertAssetSalience(db, "stash//lessons/new-hot", {
        encoding: 0.8,
        outcome: 0.5,
        retrieval: 0.9,
        rankScore: 0.66,
      });
    } finally {
      db.close();
    }

    // `legacyItem` has NO item_ref — it is matched by the bare-conceptId arm
    // (`lessons/legacy-hot`).
    const legacyItem = makeRanked(21, "legacy-hot");
    // `newItem` carries an item_ref — it is matched by the item_ref arm
    // (`stash//lessons/new-hot`).
    const newItem = makeRankedWithItemRef(22, "new-hot", "stash//lessons/new-hot");

    const scores = loadSalienceRankScores([legacyItem, newItem]);
    expect(scores.get(21)).toBeCloseTo(0.66, 9); // bare-conceptId arm hit
    expect(scores.get(22)).toBeCloseTo(0.66, 9); // new arm hit
    // Boost identically — the whole point of the dual-arm.
    expect(scores.get(21)).toBe(scores.get(22));
  });

  test("a fully-qualified item_ref row wins over a bare-conceptId row for the same asset", () => {
    const db = openStateDatabase();
    try {
      // A bare-conceptId row (scope-ref write)…
      upsertAssetSalience(db, "lessons/dual", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.1 });
      // …and the fully-qualified row the planner-resolved writer produced.
      upsertAssetSalience(db, "stash//lessons/dual", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.9 });
    } finally {
      db.close();
    }

    // The item resolves to BOTH keys (bare `lessons/dual` and item_ref
    // `stash//lessons/dual`); the fully-qualified score must win.
    const item = makeRankedWithItemRef(30, "dual", "stash//lessons/dual");
    const scores = loadSalienceRankScores([item]);
    expect(scores.get(30)).toBeCloseTo(0.9, 9);
  });

  test("an item_ref-bearing asset with only a bare-conceptId stored row still boosts (conceptId fallback)", () => {
    const db = openStateDatabase();
    try {
      // Only a bare-conceptId row exists (a scope-ref write), but the READ item
      // already carries provenance — the conceptId arm must still hit.
      upsertAssetSalience(db, "lessons/straggler", { encoding: 0, outcome: 0, retrieval: 0, rankScore: 0.42 });
    } finally {
      db.close();
    }
    const item = makeRankedWithItemRef(40, "straggler", "stash//lessons/straggler");
    const scores = loadSalienceRankScores([item]);
    expect(scores.get(40)).toBeCloseTo(0.42, 9);
  });
});
