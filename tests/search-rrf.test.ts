// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reciprocal rank fusion of the lexical and vector channels.
 */

import { describe, expect, test } from "bun:test";
import { RRF_K, reciprocalRankFusion } from "../src/indexer/search/ranking";

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
