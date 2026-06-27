// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type CurateJudgment,
  mrr,
  ndcgAtK,
  noBannedAboveRequired,
  recallAtK,
  scoreCurateCase,
  summarizeCurateMetrics,
} from "../scripts/akm-eval/src/curate-metrics";

const judgment: CurateJudgment = {
  id: "t",
  query: "q",
  relevant: ["a", "b"],
  idealOrder: ["a", "b"],
  banned: ["x", "y"],
  limit: 5,
};

describe("curate-metrics", () => {
  test("ndcg rewards relevant items ranked higher", () => {
    const rel = new Set(["a", "b"]);
    const perfect = ndcgAtK(["a", "b", "x"], rel, 5);
    const worse = ndcgAtK(["x", "a", "b"], rel, 5);
    expect(perfect).toBe(1);
    expect(worse).toBeLessThan(perfect);
  });

  test("recall@k counts relevant within the top k only", () => {
    const rel = new Set(["a", "b"]);
    expect(recallAtK(["a", "b", "x"], rel, 5)).toBe(1);
    expect(recallAtK(["a", "x", "y", "z", "w", "b"], rel, 3)).toBe(0.5);
    expect(recallAtK(["x"], new Set<string>(), 5)).toBe(1); // empty relevant ⇒ vacuous 1
  });

  test("mrr is the reciprocal rank of the first relevant ref", () => {
    const rel = new Set(["a"]);
    expect(mrr(["a", "x"], rel)).toBe(1);
    expect(mrr(["x", "a"], rel)).toBe(0.5);
    expect(mrr(["x", "y"], rel)).toBe(0);
  });

  test("noBannedAboveRequired catches a banned ref leapfrogging a relevant one", () => {
    const rel = new Set(["a", "b"]);
    const banned = new Set(["x"]);
    // clean: banned below relevant
    expect(noBannedAboveRequired(["a", "b", "x"], rel, banned)).toEqual({ score: 1, leapfrogCount: 0 });
    // leapfrog: x above b
    expect(noBannedAboveRequired(["a", "x", "b"], rel, banned)).toEqual({ score: 0, leapfrogCount: 1 });
    // no banned present ⇒ vacuous pass
    expect(noBannedAboveRequired(["a", "b"], rel, banned)).toEqual({ score: 1, leapfrogCount: 0 });
    // no relevant present ⇒ vacuous pass (nothing to leapfrog)
    expect(noBannedAboveRequired(["x"], rel, banned)).toEqual({ score: 1, leapfrogCount: 0 });
  });

  test("scoreCurateCase is monotonic: better order ⇒ higher composite", () => {
    const good = scoreCurateCase(["a", "b", "x", "y"], judgment).score;
    const bad = scoreCurateCase(["x", "y", "a", "b"], judgment).score;
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeLessThanOrEqual(1);
    expect(bad).toBeGreaterThanOrEqual(0);
  });

  test("summarize averages and totals leapfrogs", () => {
    const a = scoreCurateCase(["a", "b"], judgment);
    const b = scoreCurateCase(["x", "a", "b"], judgment);
    const s = summarizeCurateMetrics([a, b]);
    expect(s.caseCount).toBe(2);
    expect(s.totalBannedLeapfrog).toBe(1);
    expect(s.meanScore).toBeCloseTo((a.score + b.score) / 2, 6);
  });
});
