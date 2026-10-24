// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reciprocal rank fusion of the lexical and vector channels, and the bounded
 * utility factor applied to the fused scores.
 */

import { describe, expect, test } from "bun:test";
import {
  applyUtilityToFused,
  feedbackUtilities,
  RRF_K,
  reciprocalRankFusion,
  UTILITY_RANK_WEIGHT,
} from "../src/indexer/search/ranking";
import type { UtilityScoreRow } from "../src/storage/repositories/index-entry-types";

const ref = (id: number, name: string) => ({ id, itemRef: `stash//knowledge/${name}` });

describe("reciprocalRankFusion", () => {
  test("sums 1 / (60 + rank) over the channels that returned a candidate", () => {
    const fused = reciprocalRankFusion([
      [ref(1, "a"), ref(2, "b")],
      [ref(2, "b"), ref(3, "c")],
    ]);
    expect(RRF_K).toBe(60);
    expect(fused.map((candidate) => candidate.itemRef)).toEqual([
      "stash//knowledge/b",
      "stash//knowledge/a",
      "stash//knowledge/c",
    ]);
    expect(fused[0]).toEqual({ id: 2, itemRef: "stash//knowledge/b", score: 1 / 62 + 1 / 61, ranks: [2, 1] });
    expect(fused[1]).toEqual({ id: 1, itemRef: "stash//knowledge/a", score: 1 / 61, ranks: [1, undefined] });
    expect(fused[2]).toEqual({ id: 3, itemRef: "stash//knowledge/c", score: 1 / 62, ranks: [undefined, 2] });
  });

  test("weights the channels equally", () => {
    const fused = reciprocalRankFusion([[ref(1, "lexical-first")], [ref(2, "vector-first")]]);
    expect(fused[0]?.score).toBe(fused[1]?.score);
  });

  test("breaks equal scores by item ref, whatever the input order", () => {
    const channels = [
      [ref(1, "zeta"), ref(2, "alpha")],
      [ref(2, "alpha"), ref(1, "zeta")],
    ];
    const forward = reciprocalRankFusion(channels).map((candidate) => candidate.itemRef);
    const reversed = reciprocalRankFusion([...channels].reverse()).map((candidate) => candidate.itemRef);
    expect(forward).toEqual(["stash//knowledge/alpha", "stash//knowledge/zeta"]);
    expect(reversed).toEqual(forward);
  });

  test("counts a candidate once per channel, at its best rank", () => {
    const fused = reciprocalRankFusion([[ref(1, "a"), ref(1, "a")], []]);
    expect(fused).toEqual([{ id: 1, itemRef: "stash//knowledge/a", score: 1 / 61, ranks: [1, undefined] }]);
  });

  test("returns nothing for empty channels", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe("applyUtilityToFused", () => {
  // Scores 1/61, 1/62, 1/63: adjacent ranks differ by about 1.6 percent.
  const fused = reciprocalRankFusion([[ref(1, "a"), ref(2, "b"), ref(3, "c")], []]);
  const order = (candidates: ReadonlyArray<{ itemRef: string }>) =>
    candidates.map((candidate) => candidate.itemRef.split("/").pop());

  test("no utility, a midpoint utility or a non-finite utility leaves order and scores unchanged", () => {
    expect(applyUtilityToFused(fused, new Map())).toEqual(fused);
    expect(
      applyUtilityToFused(
        fused,
        new Map([
          [1, 0.5],
          [2, 0.5],
        ]),
      ),
    ).toEqual(fused);
    expect(
      applyUtilityToFused(
        fused,
        new Map([
          [1, Number.NaN],
          [2, Number.POSITIVE_INFINITY],
        ]),
      ),
    ).toEqual(fused);
  });

  test("returns a new array and leaves its input as it was", () => {
    const before = structuredClone(fused);
    const adjusted = applyUtilityToFused(fused, new Map([[3, 1]]));
    expect(adjusted).not.toBe(fused);
    expect(fused).toEqual(before);
  });

  test("a higher utility raises a candidate past its neighbour, a lower one sinks it", () => {
    // 1/62 * 1.025 beats 1/61; 1/61 * 0.975 loses to 1/62.
    expect(order(applyUtilityToFused(fused, new Map([[2, 0.55]])))).toEqual(["b", "a", "c"]);
    expect(order(applyUtilityToFused(fused, new Map([[1, 0.45]])))).toEqual(["b", "a", "c"]);
    expect(order(applyUtilityToFused(fused, new Map([[3, 1]])))).toEqual(["c", "a", "b"]);
  });

  test("scales the fused score by 1 + UTILITY_RANK_WEIGHT * (utility - 0.5)", () => {
    expect(UTILITY_RANK_WEIGHT).toBe(0.5);
    const [first] = applyUtilityToFused(fused, new Map([[1, 0.7]]));
    expect(first?.score).toBeCloseTo((1 / 61) * 1.1, 12);
    expect(first?.ranks).toEqual([1, undefined]);
  });

  test("the factor stays within 0.75 to 1.25 whatever the utility", () => {
    const score = (utility: number) => applyUtilityToFused(fused.slice(0, 1), new Map([[1, utility]]))[0]?.score;
    expect(score(1)).toBeCloseTo((1 / 61) * 1.25, 12);
    expect(score(0)).toBeCloseTo((1 / 61) * 0.75, 12);
    expect(score(40)).toBe(score(1));
    expect(score(-40)).toBe(score(0));
  });

  test("the bound keeps a candidate both channels agree on ahead of a one-channel match at maximum utility", () => {
    const both = [
      [ref(1, "agreed"), ref(2, "other")],
      [ref(1, "agreed"), ref(3, "vector-only")],
    ];
    const adjusted = applyUtilityToFused(
      reciprocalRankFusion(both),
      new Map([
        [1, 0],
        [2, 1],
        [3, 1],
      ]),
    );
    expect(order(adjusted)[0]).toBe("agreed");
  });

  test("equal adjusted scores are ordered by item ref", () => {
    const tied = reciprocalRankFusion([[ref(1, "zeta")], [ref(2, "alpha")]]);
    expect(order(applyUtilityToFused(tied, new Map([[1, 0.8]])))[0]).toBe("zeta");
    expect(order(applyUtilityToFused(tied, new Map()))).toEqual(["alpha", "zeta"]);
  });
});

describe("feedbackUtilities", () => {
  const row = (overrides: Partial<UtilityScoreRow>): UtilityScoreRow => ({
    entryId: 1,
    utility: 0,
    showCount: 0,
    searchCount: 0,
    selectRate: 0,
    lastUsedAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    feedbackScore: undefined,
    feedbackCount: 0,
    ...overrides,
  });
  const only = (overrides: Partial<UtilityScoreRow>) => feedbackUtilities(new Map([[1, row(overrides)]]));

  test("uses the feedback score of a row with feedback, not its utility", () => {
    expect(only({ feedbackScore: 0.45, feedbackCount: 1, utility: 0.9 })).toEqual(new Map([[1, 0.45]]));
    expect(only({ feedbackScore: 0.55, feedbackCount: 3 })).toEqual(new Map([[1, 0.55]]));
  });

  test("a row with search and show history still ranks by its feedback score", () => {
    const seen = { searchCount: 4, showCount: 2, selectRate: 0.5, utility: 0.3 };
    expect(only({ ...seen, feedbackScore: 0.6, feedbackCount: 2 })).toEqual(new Map([[1, 0.6]]));
  });

  test("a row the index seeded from search results has no feedback and is neutral", () => {
    // What `akm index` writes for an asset that appeared in a search and was never shown.
    expect(only({ utility: 0, searchCount: 1, selectRate: 0 }).size).toBe(0);
  });

  test("a row the index derived from searches and shows has no feedback and is neutral", () => {
    expect(only({ utility: 0.3, searchCount: 1, showCount: 1, selectRate: 1 }).size).toBe(0);
    expect(only({ utility: 0.9, searchCount: 4, showCount: 4, selectRate: 1 }).size).toBe(0);
  });

  test("a row whose feedback score is unset or whose count is zero is neutral", () => {
    expect(only({ feedbackCount: 2, feedbackScore: undefined }).size).toBe(0);
    expect(only({ feedbackCount: 0, feedbackScore: 0.45 }).size).toBe(0);
  });

  test("an entry with no row is absent, so untouched assets keep their fused scores", () => {
    const fused = reciprocalRankFusion([[ref(1, "a"), ref(2, "b")], []]);
    const seeded = new Map([[1, row({ utility: 0, searchCount: 3, selectRate: 0 })]]);
    expect(applyUtilityToFused(fused, feedbackUtilities(seeded))).toEqual(fused);
    expect(applyUtilityToFused(fused, feedbackUtilities(new Map()))).toEqual(fused);
  });

  test("a feedback score moves a candidate through applyUtilityToFused", () => {
    const fused = reciprocalRankFusion([[ref(1, "a"), ref(2, "b")], []]);
    const rows = new Map([[1, row({ searchCount: 5, feedbackScore: 0.45, feedbackCount: 1 })]]);
    expect(applyUtilityToFused(fused, feedbackUtilities(rows)).map((c) => c.id)).toEqual([2, 1]);
  });
});
