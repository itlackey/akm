// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  applyContributorAblation,
  defaultRankingContributors,
  defaultUtilityRankingContributors,
} from "../src/indexer/search/ranking-contributors";

describe("applyContributorAblation (eval-only AKM_ABLATE_CONTRIBUTORS filter)", () => {
  const all = defaultRankingContributors;

  test("undefined env is a no-op — returns the full list unchanged", () => {
    expect(applyContributorAblation(all, undefined)).toBe(all);
  });

  test("empty / whitespace env is a no-op", () => {
    expect(applyContributorAblation(all, "")).toBe(all);
    expect(applyContributorAblation(all, "   ")).toBe(all);
    expect(applyContributorAblation(all, " , ,")).toBe(all);
  });

  test("removes exactly the named contributor", () => {
    const out = applyContributorAblation(all, "belief-state-ranking");
    expect(out.length).toBe(all.length - 1);
    expect(out.some((c) => c.name === "belief-state-ranking")).toBe(false);
    // every other contributor survives
    expect(out.some((c) => c.name === "exact-name-ranking")).toBe(true);
  });

  test("removes multiple names, tolerates whitespace and unknown names", () => {
    const out = applyContributorAblation(all, " exact-name-ranking , type-ranking , not-a-real-contributor ");
    expect(out.some((c) => c.name === "exact-name-ranking")).toBe(false);
    expect(out.some((c) => c.name === "type-ranking")).toBe(false);
    expect(out.length).toBe(all.length - 2);
  });

  test("works on the utility contributor list too (salience/utility)", () => {
    const out = applyContributorAblation(defaultUtilityRankingContributors, "salience-ranking");
    expect(out.some((c) => c.name === "salience-ranking")).toBe(false);
    expect(out.some((c) => c.name === "utility-ranking")).toBe(true);
  });

  test("does not mutate the input array", () => {
    const before = all.length;
    applyContributorAblation(all, "belief-state-ranking");
    expect(all.length).toBe(before);
  });
});
