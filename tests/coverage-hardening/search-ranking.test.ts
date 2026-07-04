// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: score-BLENDING math in the hybrid ranking pipeline.
 *
 * `normalizeFtsScores` had NO test at all, and `combineSearchScores` was
 * tested only for its type-exclusion branch (search-exclude-sessions-vector)
 * — never for the actual numeric blend it exists to compute. These assert the
 * exact weights/normalization so a regression in the FTS/vector blend (or the
 * min-max normalization edge cases) is caught, not just "returns results".
 */

import { describe, expect, test } from "bun:test";
import type { DbSearchResult } from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { combineSearchScores, normalizeFtsScores } from "../../src/indexer/search/ranking";

function entry(name: string, type: string): StashEntry {
  return { name, type, description: `${type} ${name}` };
}

function ftsResult(id: number, bm25: number, name = `e${id}`, type = "skill"): DbSearchResult {
  return { id, filePath: `/stash/${type}/${name}.md`, entry: entry(name, type), searchText: name, bm25Score: bm25 };
}

describe("normalizeFtsScores", () => {
  test("empty input returns an empty map", () => {
    expect(normalizeFtsScores([]).size).toBe(0);
  });

  test("single result normalizes to the top of the band (range === 0)", () => {
    // range === 0 hits the guard branch → normalized 1.0 → ftsScore 0.3 + 0.7.
    const map = normalizeFtsScores([ftsResult(1, -2.5)]);
    expect(map.get(1)?.score).toBeCloseTo(1.0, 10);
  });

  test("all-equal bm25 scores all normalize to 1.0 (range === 0 guard)", () => {
    const map = normalizeFtsScores([ftsResult(1, -4), ftsResult(2, -4), ftsResult(3, -4)]);
    expect(map.get(1)?.score).toBeCloseTo(1.0, 10);
    expect(map.get(2)?.score).toBeCloseTo(1.0, 10);
    expect(map.get(3)?.score).toBeCloseTo(1.0, 10);
  });

  test("best row maps to 1.0, worst to 0.3, middle interpolates within [0.3,1.0]", () => {
    // Results arrive sorted best-first. FTS bm25 is negative; more-negative =
    // better, so results[0] is the most-negative. The formula must still put
    // the best at 1.0 and the worst at 0.3 regardless of sign.
    const results = [ftsResult(1, -10), ftsResult(2, -6), ftsResult(3, -2)];
    const map = normalizeFtsScores(results);
    expect(map.get(1)?.score).toBeCloseTo(1.0, 10); // best
    expect(map.get(3)?.score).toBeCloseTo(0.3, 10); // worst
    const mid = map.get(2)?.score ?? 0;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(1.0);
    // -6 is exactly midway between -10 and -2 → normalized 0.5 → 0.3 + 0.35.
    expect(mid).toBeCloseTo(0.65, 10);
  });

  test("carries the originating result object through unchanged", () => {
    const r = ftsResult(7, -3, "carry", "command");
    const map = normalizeFtsScores([r]);
    expect(map.get(7)?.result).toBe(r);
  });
});

describe("combineSearchScores blend math", () => {
  const getEntryById = (id: number) =>
    id === 99 ? { entry: entry("vec-only", "knowledge"), filePath: "/stash/knowledge/vec-only.md" } : undefined;

  test("FTS+vector hit blends 0.7*fts + 0.3*vec and marks rankingMode hybrid", () => {
    const ftsScoreMap = new Map([[1, { score: 0.8, result: ftsResult(1, -5) }]]);
    const embedScoreMap = new Map([[1, 0.6]]);
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById });
    const item = scored.find((s) => s.id === 1);
    expect(item?.rankingMode).toBe("hybrid");
    // 0.8 * 0.7 + 0.6 * 0.3 = 0.74
    expect(item?.score).toBeCloseTo(0.74, 10);
  });

  test("FTS hit with NO vector neighbor keeps the raw fts score and mode fts", () => {
    const ftsScoreMap = new Map([[1, { score: 0.8, result: ftsResult(1, -5) }]]);
    const embedScoreMap = new Map<number, number>();
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById });
    const item = scored.find((s) => s.id === 1);
    expect(item?.rankingMode).toBe("fts");
    expect(item?.score).toBeCloseTo(0.8, 10); // NOT down-weighted by 0.7
  });

  test("vector-only neighbor (no FTS hit) scores cosine*0.3 and mode semantic", () => {
    const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();
    const embedScoreMap = new Map([[99, 0.9]]);
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById });
    const item = scored.find((s) => s.id === 99);
    expect(item?.rankingMode).toBe("semantic");
    expect(item?.score).toBeCloseTo(0.27, 10); // 0.9 * 0.3
  });

  test("vector-only neighbor with no registry entry is dropped (getEntryById undefined)", () => {
    const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();
    const embedScoreMap = new Map([[12345, 0.9]]); // getEntryById returns undefined
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById });
    expect(scored.length).toBe(0);
  });

  test("typeFilter drops a vector-only neighbor of a different type", () => {
    // 99 is type 'knowledge'; a typeFilter of 'skill' must exclude it.
    const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();
    const embedScoreMap = new Map([[99, 0.9]]);
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById, typeFilter: "skill" });
    expect(scored.some((s) => s.id === 99)).toBe(false);
  });

  test("an FTS-matched id is never re-added by the vector loop (dedup by seenIds)", () => {
    const ftsScoreMap = new Map([[1, { score: 0.8, result: ftsResult(1, -5) }]]);
    const embedScoreMap = new Map([[1, 0.6]]); // same id present in both
    const scored = combineSearchScores({ ftsScoreMap, embedScoreMap, getEntryById });
    expect(scored.filter((s) => s.id === 1).length).toBe(1);
  });
});
