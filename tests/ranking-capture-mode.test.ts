/**
 * Phase 1B / Rec 7 — capture-mode ranking boost.
 *
 * Verifies the additive +0.2 boost applied to memories with
 * `captureMode: "hot"`. Hot-captured memories must outrank otherwise-equal
 * memories that lack `captureMode` (legacy) or are tagged
 * `captureMode: "background"` (derived).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyScoreContributors } from "../src/indexer/search/ranking-contributors";

function makeRanked(name: string, overrides: Partial<StashEntry>): RankedEntryInput {
  const entry: StashEntry = { name, type: "memory", ...overrides };
  return {
    id: 1,
    entry,
    filePath: `/stash/memories/${name}.md`,
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

describe("captureModeRankingContributor (Phase 1B)", () => {
  test("hot memory outranks legacy memory with identical otherwise-equal fields", () => {
    const hot = makeRanked("hot-memory", { captureMode: "hot" });
    const legacy = makeRanked("legacy-memory", {});

    rank(hot, "irrelevant query");
    rank(legacy, "irrelevant query");

    expect(hot.score).toBeGreaterThan(legacy.score);
  });

  test("hot memory outranks an equivalent background memory", () => {
    const hot = makeRanked("hot", { captureMode: "hot" });
    const background = makeRanked("background", { captureMode: "background" });

    rank(hot, "irrelevant");
    rank(background, "irrelevant");

    expect(hot.score).toBeGreaterThan(background.score);
  });

  test("legacy memory (no captureMode) scores identically to background memory (default-safe)", () => {
    const legacy = makeRanked("legacy", {});
    const background = makeRanked("background", { captureMode: "background" });

    rank(legacy, "irrelevant");
    rank(background, "irrelevant");

    expect(legacy.score).toBeCloseTo(background.score, 9);
  });

  test("non-memory entries are unaffected by capture-mode boost", () => {
    const skillHot = {
      id: 1,
      entry: { name: "skill", type: "skill", captureMode: "hot" as const } as StashEntry,
      filePath: "/stash/skills/skill.md",
      score: 1,
      rankingMode: "fts" as const,
    };
    const skillPlain = {
      id: 2,
      entry: { name: "skill", type: "skill" } as StashEntry,
      filePath: "/stash/skills/skill2.md",
      score: 1,
      rankingMode: "fts" as const,
    };

    rank(skillHot, "irrelevant");
    rank(skillPlain, "irrelevant");

    expect(skillHot.score).toBeCloseTo(skillPlain.score, 9);
  });
});
