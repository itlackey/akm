// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #998 — the promote pass's coverage rule, as pure text logic: a memory is
 * covered when at least half of its distinct 5-word shingles appear in one
 * knowledge doc. No database, model or network (unit target); the neighbour
 * lookup that feeds it is covered by the integration file of the same name.
 */
import { describe, expect, it } from "bun:test";
import {
  COVERAGE_MIN_CONTAINMENT,
  COVERAGE_SHINGLE_WORDS,
  shingleContainment,
  wordShingles,
} from "../../../src/commands/improve/consolidate/coverage";

const words = (n: number, prefix = "w"): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("wordShingles", () => {
  it("windows lower-cased words in fives, ignoring case, punctuation and markdown", () => {
    const shingles = wordShingles("# Use `Bun` — NOT node: run the tests, then commit.");
    expect([...shingles]).toEqual([
      "use bun not node run",
      "bun not node run the",
      "not node run the tests",
      "node run the tests then",
      "run the tests then commit",
    ]);
  });

  it("yields n - 4 shingles for n distinct words, and none below five words", () => {
    expect(wordShingles(words(4)).size).toBe(0);
    expect(wordShingles(words(5)).size).toBe(1);
    expect(wordShingles(words(12)).size).toBe(12 - (COVERAGE_SHINGLE_WORDS - 1));
    expect(wordShingles("").size).toBe(0);
  });

  it("counts a repeated shingle once", () => {
    expect(wordShingles("a b c d e a b c d e a b c d e").size).toBe(5);
  });

  it("reads non-latin words too", () => {
    expect(wordShingles("один два три четыре пять шесть").size).toBe(2);
  });
});

describe("shingleContainment", () => {
  const memory = wordShingles(words(20));

  it("is 1 when the doc holds the whole memory, however much else it holds", () => {
    expect(shingleContainment(memory, `# A long guide\n\n${words(40, "x")} ${words(20)} ${words(40, "y")}`)).toBe(1);
  });

  it("is 0 for an unrelated doc, and for a memory too short to shingle", () => {
    expect(shingleContainment(memory, words(60, "z"))).toBe(0);
    expect(shingleContainment(wordShingles("too short"), "too short")).toBe(0);
  });

  it("measures the memory's share, not the doc's: a small doc quoted inside a larger memory does not cover it", () => {
    const smallDoc = words(8); // its 4 shingles are all inside the 20-word memory
    expect(shingleContainment(memory, smallDoc)).toBeCloseTo(4 / 16);
    expect(shingleContainment(wordShingles(smallDoc), words(20))).toBe(1);
  });

  it("reaches the 0.5 cut when exactly half of the memory's shingles are in the doc", () => {
    expect(shingleContainment(memory, words(10))).toBeCloseTo(6 / 16); // just under the cut
    expect(shingleContainment(memory, words(12))).toBe(COVERAGE_MIN_CONTAINMENT); // 8 of 16
  });

  it("is not fooled by reordering: shingles keep word order", () => {
    const reversed = words(20).split(" ").reverse().join(" ");
    expect(shingleContainment(memory, reversed)).toBe(0);
  });
});
