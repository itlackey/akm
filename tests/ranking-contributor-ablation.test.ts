// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateMetadata, type StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import {
  applyContributorAblation,
  defaultRankingContributors,
  defaultUtilityRankingContributors,
  type RankingContext,
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

// ── SPEC-2: tag-ranking fires for path-derived scope tokens ─────────────────
//
// The metadata pass now merges directory (scope/domain) tokens from the
// canonical ref subpath into tags even when explicit tags exist
// (docs/design/stash-conventions-code-spec.md SPEC-2), so a scoped memory
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

  function makeItem(entry: StashEntry): RankedEntryInput {
    return { id: 1, entry, filePath: "/stash/memories/projectA/auth-tip.md", score: 1, rankingMode: "fts" };
  }

  test("scoped memory with explicit tags earns the exact-tag boost for its directory token", async () => {
    const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rank-spec2-"));
    createdTmpDirs.push(memRoot);
    const file = path.join(memRoot, "projectA", "auth-tip.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["---", "tags:", "  - auth", "---", "Scoped memory body."].join("\n"));

    const stash = await generateMetadata(memRoot, "memory", [file]);
    expect(stash.entries).toHaveLength(1);
    const item = makeItem(stash.entries[0]);
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
    const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rank-spec2-"));
    createdTmpDirs.push(memRoot);
    const file = path.join(memRoot, "team-alpha", "projectA", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["---", "tags:", "  - auth", "---", "Scoped memory body."].join("\n"));

    const stash = await generateMetadata(memRoot, "memory", [file]);
    expect(stash.entries).toHaveLength(1);
    // Merge produced three dir tokens on top of the explicit tag.
    expect([...(stash.entries[0].tags ?? [])].sort()).toEqual(["alpha", "auth", "projecta", "team"]);
    const item = makeItem(stash.entries[0]);

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
