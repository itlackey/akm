// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IndexDocument } from "../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../src/indexer/scan/drain-dir";
import { lexicalNameMatchTier } from "../src/indexer/search/ranking";
import {
  applyBeliefStateScoreCeiling,
  defaultRankingContributors,
  type RankingContext,
} from "../src/indexer/search/ranking-contributors";
import type { RankedEntryInput } from "../src/indexer/search/ranking-types";

// ── SPEC-2: tag-ranking fires for path-derived scope tokens ─────────────────
//
// The metadata pass now merges directory (scope/domain) tokens from the
// canonical ref subpath into tags even when explicit tags exist
// (docs/architecture/specs/stash-conventions-code-spec.md SPEC-2), so a scoped memory
// with author tags earns the exact-tag ranking boost (+0.15/token) for its
// path token. These tests pin that end-to-end delta at the contributor level
// (the shared ranking-baseline fixture is byte-frozen per its MANIFEST, so
// the case lives here rather than in tests/ranking-regression.test.ts).

describe("tag-ranking boost for path-derived scope tokens (SPEC-2)", () => {
  const createdTmpDirs: string[] = [];

  afterAll(() => {
    for (const dir of createdTmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const tagRanking = defaultRankingContributors.find((c) => c.name === "tag-ranking");

  function makeCtx(query: string): RankingContext {
    return {
      // tag-ranking never touches the database — a null placeholder keeps
      // this a pure unit test of the contributor.
      db: null as unknown as RankingContext["db"],
      query,
      queryLower: query.toLowerCase(),
      queryTokens: query.toLowerCase().split(/\s+/).filter(Boolean),
      graphContext: null,
    };
  }

  function makeItem(entry: IndexDocument): RankedEntryInput {
    return { id: 1, entry, filePath: "/stash/memories/projectA/auth-tip.md", score: 1, rankingMode: "fts" };
  }

  test("scoped memory with explicit tags earns the exact-tag boost for its directory token", async () => {
    const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rank-spec2-"));
    createdTmpDirs.push(stashRoot);
    const file = path.join(stashRoot, "memories", "projectA", "auth-tip.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["---", "tags:", "  - auth", "---", "Scoped memory body."].join("\n"));

    const stash = recognizeStashEntries(stashRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    const item = makeItem(stash.entries[0]!);
    const ctx = makeCtx("projecta");

    expect(tagRanking).toBeDefined();
    expect(tagRanking?.appliesTo(item, ctx)).toBe(true);
    // The path token reached tags via the SPEC-2 merge, so the exact-tag
    // match boost (+0.15 per token) fires for the scope slug.
    expect(tagRanking?.adjust(item, ctx)).toBeCloseTo(0.15);
  });

  test("multiple merged directory tokens hit the 0.3 cap, not 0.15 per token unbounded", async () => {
    // Pre-existing contributor behavior (+0.15/token, Math.min 0.3 cap), but
    // the SPEC-2 merge is what makes a multi-dir-token entry with explicit
    // tags reachable at all — pin the interaction end-to-end.
    const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rank-spec2-"));
    createdTmpDirs.push(stashRoot);
    const file = path.join(stashRoot, "memories", "team-alpha", "projectA", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["---", "tags:", "  - auth", "---", "Scoped memory body."].join("\n"));

    const stash = recognizeStashEntries(stashRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    // Merge produced three dir tokens on top of the explicit tag.
    expect([...(stash.entries[0]!.tags ?? [])].sort()).toEqual(["alpha", "auth", "projecta", "team"]);
    const item = makeItem(stash.entries[0]!);

    // All three dir tokens match: 3 × 0.15 = 0.45, capped at 0.3.
    expect(tagRanking?.adjust(item, makeCtx("team alpha projecta"))).toBeCloseTo(0.3);
    // Two matches sit exactly at the cap boundary.
    expect(tagRanking?.adjust(item, makeCtx("team projecta"))).toBeCloseTo(0.3);
  });

  test("author tags alone (pre-merge shape) earn no boost for the path token — pins the SPEC-2 delta", () => {
    // The pre-SPEC-2 entry shape: explicit tags suppressed path derivation,
    // so the scope token lived only in the name field and the tag boost
    // never fired for it.
    const item = makeItem({
      name: "projectA/auth-tip",
      type: "memory",
      description: "scoped memory",
      tags: ["auth"],
      filename: "auth-tip.md",
    });
    const ctx = makeCtx("projecta");
    expect(tagRanking?.adjust(item, ctx)).toBe(0);
  });
});

// ── Storage-name identity is not name evidence (#930) ─────────────────────

describe("exact-name ranking contributor identity isolation (#930)", () => {
  const exactNameRanking = defaultRankingContributors.find((contributor) => contributor.name === "exact-name-ranking");

  function makeCtx(query: string, queryTokens: string[]): RankingContext {
    return {
      db: null as unknown as RankingContext["db"],
      query,
      queryLower: query.toLowerCase(),
      queryTokens,
      graphContext: null,
    };
  }

  function makeItem(name: string): RankedEntryInput {
    return {
      id: 1,
      entry: { name, type: "memory", description: "fixture", filename: `${name}.md` },
      filePath: `/stash/memories/${name}.md`,
      score: 1,
      rankingMode: "fts",
    };
  }

  test("does not treat short or infix opaque storage-name fragments as name evidence", () => {
    // The evaluator projects the same document onto opaque storage filenames.
    // A query can legitimately contain a numeric token such as "4"; that
    // token must not award an exact-name boost merely because one projection
    // happened to receive an opaque name containing the same digit.
    const opaque = makeItem("z9xq000");
    expect(exactNameRanking?.adjust(makeItem("z9xq4m"), makeCtx("4", ["4"]))).toBe(0);
    expect(exactNameRanking?.adjust(opaque, makeCtx("000", ["000"]))).toBe(0);
    expect(exactNameRanking?.adjust(opaque, makeCtx("xq000", ["xq000"]))).toBe(0);
  });

  test("shares structural phrase matching with final name tiers", () => {
    // Exact full names remain the strongest signal. Leading three-character
    // prefixes are still useful user-authored name evidence, unlike an infix.
    expect(exactNameRanking?.adjust(makeItem("z9xq000"), makeCtx("z9xq000", ["z9xq000"]))).toBe(2);
    expect(exactNameRanking?.adjust(makeItem("deployment"), makeCtx("deploy", ["deploy"]))).toBe(1);
    expect(
      exactNameRanking?.adjust(
        makeItem("deployment-production-plan"),
        makeCtx("deploy production", ["deploy", "production"]),
      ),
    ).toBe(1);
  });

  test("keeps the contributor and final tier on the same structural evidence", () => {
    const opaque = { name: "z9xq000", type: "memory" } as IndexDocument;
    const deployment = { name: "deployment", type: "knowledge" } as IndexDocument;
    const multiToken = { name: "deployment-production-plan", type: "knowledge" } as IndexDocument;

    expect(lexicalNameMatchTier(opaque, ["000"])).toBe(0);
    expect(lexicalNameMatchTier(opaque, ["xq000"])).toBe(0);
    expect(lexicalNameMatchTier(deployment, ["deploy"])).toBeGreaterThanOrEqual(2);
    expect(lexicalNameMatchTier(multiToken, ["deploy", "production"])).toBeGreaterThanOrEqual(2);
  });
});

// ── SPEC-5: demoting-belief-state final-score ceilings ──────────────────────
//
// The additive beliefStateBoost penalties multiply the bounded FTS base, so a
// demoted incumbent can still earn enough independent boosts to outrank its
// own correction — the ceilings are what actually guarantee "subsequent
// search ranks new above old". These unit tests pin the mechanism directly
// (constants, severity order, no-op states, below-ceiling relative order, and
// the preCeilingScore handoff to db-search's final ranking comparator, which
// orders a ceilinged hit by what it would have scored rather than dropping
// it), independent of any bm25 delta in the e2e fixtures.

describe("applyBeliefStateScoreCeiling (SPEC-5 demoting-state ceilings)", () => {
  function makeBeliefItem(beliefState: string | undefined, score: number): RankedEntryInput {
    const entry: IndexDocument = {
      name: "belief-item",
      type: "memory",
      description: "ceiling unit fixture",
      filename: "belief-item.md",
      ...(beliefState !== undefined ? { beliefState } : {}),
    } as IndexDocument;
    return { id: 1, entry, filePath: "/stash/memories/belief-item.md", score, rankingMode: "fts" };
  }

  test("pins the ceiling constants and the severity order deprecated > superseded > contradicted > archived", () => {
    const expected: Array<[string, number]> = [
      ["deprecated", 0.28],
      ["superseded", 0.25],
      ["contradicted", 0.2],
      ["archived", 0.15],
    ];
    const clamped: number[] = [];
    for (const [state, ceiling] of expected) {
      const item = makeBeliefItem(state, 1.0);
      applyBeliefStateScoreCeiling(item);
      expect(item.score).toBe(ceiling);
      clamped.push(item.score);
    }
    // Severity order mirrors the additive-penalty order (phase 1A): each
    // demoting state sits strictly below the previous, and every ceiling sits
    // below 0.3 — comfortably under the RRF-normalized score of any
    // un-demoted keyword hit — so any un-demoted keyword hit outranks a
    // ceilinged one.
    for (let i = 1; i < clamped.length; i++) {
      expect(clamped[i]).toBeLessThan(clamped[i - 1]!);
    }
    for (const ceiling of clamped) {
      expect(ceiling).toBeLessThan(0.3);
    }
  });

  test("no-op for asserted, active, and unset belief states", () => {
    for (const state of ["asserted", "active", undefined]) {
      const item = makeBeliefItem(state, 1.37);
      applyBeliefStateScoreCeiling(item);
      expect(item.score).toBe(1.37);
      expect(item.preCeilingScore).toBeUndefined();
    }
  });

  test("scores already below the ceiling are untouched — relative order among demoted entries survives", () => {
    const low = makeBeliefItem("superseded", 0.1);
    const high = makeBeliefItem("superseded", 0.2);
    applyBeliefStateScoreCeiling(low);
    applyBeliefStateScoreCeiling(high);
    expect(low.score).toBe(0.1);
    expect(high.score).toBe(0.2);
    expect(low.score).toBeLessThan(high.score);
    // Not clamped → no preCeilingScore, so db-search's final ranking
    // comparator judges these by their real score exactly as before.
    expect(low.preCeilingScore).toBeUndefined();
    expect(high.preCeilingScore).toBeUndefined();
  });

  test("records the pre-clamp score so a demoted hit orders by what it WOULD have scored", () => {
    // db-search's final ranking comparator must consult preCeilingScore so
    // the demotion ranks the hit last (by its real relevance among other
    // demoted hits) instead of collapsing every ceilinged hit to a tie.
    const item = makeBeliefItem("archived", 0.6);
    item.rankingMode = "semantic";
    applyBeliefStateScoreCeiling(item);
    expect(item.score).toBe(0.15);
    expect(item.preCeilingScore).toBe(0.6);
  });
});
