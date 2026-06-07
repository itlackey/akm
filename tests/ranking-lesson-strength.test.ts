/**
 * Phase 7A / Advantage D4b — lesson strength ranking boost.
 *
 * `lessonStrengthContributor` adds `min(0.3, 0.06 × strength)` to the boost
 * sum for lesson-type entries. Strength is the count of refs that have
 * credited the lesson via `akm feedback --applied-to`. This test verifies
 * monotonicity and the 0.3 cap.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyScoreContributors } from "../src/indexer/search/ranking-contributors";

function makeLesson(name: string, lessonStrength?: number): RankedEntryInput {
  const entry: StashEntry = { name, type: "lesson" };
  if (lessonStrength !== undefined) entry.lessonStrength = lessonStrength;
  return {
    id: 1,
    entry,
    filePath: `/stash/lessons/${name}.md`,
    score: 1,
    rankingMode: "fts",
  };
}

function rank(item: RankedEntryInput, query: string) {
  applyScoreContributors(item, {
    db: null as unknown as Database,
    query,
    queryLower: query.toLowerCase(),
    queryTokens: query.toLowerCase().split(/\s+/).filter(Boolean),
    graphContext: null,
  });
}

describe("lessonStrengthContributor (Phase 7A)", () => {
  test("lesson with no lessonStrength scores identically to lesson with strength 0 (default-safe)", () => {
    const noStrength = makeLesson("no-strength");
    const zeroStrength = makeLesson("zero-strength", 0);

    rank(noStrength, "irrelevant");
    rank(zeroStrength, "irrelevant");

    expect(noStrength.score).toBeCloseTo(zeroStrength.score, 9);
  });

  test("boost is monotonic — more strength means higher score", () => {
    const oneCredit = makeLesson("one", 1);
    const twoCredits = makeLesson("two", 2);
    const threeCredits = makeLesson("three", 3);

    rank(oneCredit, "irrelevant");
    rank(twoCredits, "irrelevant");
    rank(threeCredits, "irrelevant");

    expect(twoCredits.score).toBeGreaterThan(oneCredit.score);
    expect(threeCredits.score).toBeGreaterThan(twoCredits.score);
  });

  test("boost saturates at 0.3 (cap kicks in beyond 5 credits)", () => {
    // 0.06 × 5 = 0.30 — exactly at the cap. Adding more credits should not
    // increase the score further (the contributor returns min(0.3, ...)).
    const fiveCredits = makeLesson("five", 5);
    const tenCredits = makeLesson("ten", 10);
    const hundredCredits = makeLesson("hundred", 100);

    rank(fiveCredits, "irrelevant");
    rank(tenCredits, "irrelevant");
    rank(hundredCredits, "irrelevant");

    // All three should produce identical scores because the cap is the
    // smallest of the three boost values (= 0.3 once strength ≥ 5).
    expect(tenCredits.score).toBeCloseTo(fiveCredits.score, 9);
    expect(hundredCredits.score).toBeCloseTo(fiveCredits.score, 9);
  });

  test("non-lesson entries are unaffected by the lesson-strength boost", () => {
    const skillEntry: RankedEntryInput = {
      id: 1,
      entry: { name: "skill", type: "skill", lessonStrength: 10 } as StashEntry,
      filePath: "/stash/skills/skill.md",
      score: 1,
      rankingMode: "fts",
    };
    const skillNoStrength: RankedEntryInput = {
      id: 2,
      entry: { name: "skill2", type: "skill" } as StashEntry,
      filePath: "/stash/skills/skill2.md",
      score: 1,
      rankingMode: "fts",
    };

    rank(skillEntry, "irrelevant");
    rank(skillNoStrength, "irrelevant");

    expect(skillEntry.score).toBeCloseTo(skillNoStrength.score, 9);
  });
});
