/**
 * Phase 1A / Rec 2 — Extended MemoryBeliefState.
 *
 * Verifies the two new first-class belief states `asserted` and `deprecated`
 * across three subsystems:
 *
 * 1. `resolveFamilyContradictions` / belief-refresh logic
 *    (`src/core/memory-improve.ts`) — `asserted` is treated like `active`
 *    (no spurious refresh, preserves `asserted` authority); `deprecated` is
 *    treated like `superseded` (frozen historical, never refreshed to active).
 *
 * 2. `beliefStateBoost` (`src/indexer/ranking-contributors.ts`):
 *    `asserted` (+0.08) > `active` (+0.06) > unset (0) > `deprecated` (-0.15)
 *    > `superseded` (-0.25) > `contradicted` (-0.45) > `archived` (-0.6).
 *
 * 3. `matchBeliefFilter` (`src/indexer/db-search.ts`) — `asserted` is
 *    surfaced under `belief=current`; `deprecated` is surfaced under
 *    `belief=historical`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmImprove } from "../src/commands/improve/improve";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import type { StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyScoreContributors } from "../src/indexer/search/ranking-contributors";
import type { Database } from "../src/storage/database";
import { writeMemory } from "./_helpers/assets";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-belief-phase1a-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-belief-phase1a-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-belief-phase1a-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-belief-phase1a-state-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.AKM_STATE_DIR === undefined) delete process.env.AKM_STATE_DIR;
  else process.env.AKM_STATE_DIR = savedEnv.AKM_STATE_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveFamilyContradictions (driven via akmImprove)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1A: belief-state transitions for asserted/deprecated", () => {
  test("'asserted' memory is not spuriously refreshed to 'active' when nothing changed", async () => {
    const stashDir = makeTempDir("akm-belief-asserted-stable-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy guidance.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        beliefState: "asserted",
        title: "Use gateway A",
        description: "User-explicit deploy guidance.",
        searchHints: ["gateway a deploy"],
      },
      "# Use gateway A\n\nUser-asserted guidance.",
    );

    await buildIndex(stashDir);
    const result = await akmImprove({ scope: "memory", dryRun: true, stashDir });

    // No spurious belief-refresh transition: 'asserted' is active-like.
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([]);
    expect(result.memoryCleanup?.contradictionCandidates).toEqual([]);
  });

  test("'asserted' state is preserved (not downgraded to 'active') when contradiction metadata clears", async () => {
    const stashDir = makeTempDir("akm-belief-asserted-preserved-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy guidance.");
    // Stale: marked asserted but with leftover contradictedBy referring to a now-missing memory.
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        beliefState: "asserted",
        contradictedBy: ["memory:deploy-missing.derived"],
        currentBeliefRefs: ["memory:deploy-missing.derived"],
        title: "Use gateway A",
      },
      "# Use gateway A\n\nGuidance.",
    );

    await buildIndex(stashDir);
    const result = await akmImprove({ scope: "memory", stashDir });

    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([
      {
        ref: "memory:deploy.derived",
        parentRef: "memory:deploy",
        fromState: "asserted",
        // Critically: preserved as 'asserted', not downgraded to 'active'.
        toState: "asserted",
        reason: "belief-refresh",
      },
    ]);

    const raw = fs.readFileSync(path.join(stashDir, "memories", "deploy.derived.md"), "utf8");
    expect(raw).toContain("beliefState: asserted");
    expect(raw).not.toContain("contradictedBy:");
    expect(raw).not.toContain("currentBeliefRefs:");
  });

  test("'deprecated' memory is never refreshed to 'active' (frozen historical)", async () => {
    const stashDir = makeTempDir("akm-belief-deprecated-frozen-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy guidance.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        beliefState: "deprecated",
        title: "Use legacy gateway",
        description: "Old guidance.",
      },
      "# Use legacy gateway\n\nOld guidance.",
    );

    await buildIndex(stashDir);
    const result = await akmImprove({ scope: "memory", dryRun: true, stashDir });

    // No transition emitted: 'deprecated' is frozen historical, like 'superseded'.
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. beliefStateBoost ranking ordering
// ─────────────────────────────────────────────────────────────────────────────

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

describe("Phase 1A: beliefStateBoost ordering", () => {
  test("asserted > active > unset > deprecated > superseded > contradicted > archived", () => {
    const asserted = makeRanked("m-asserted", { beliefState: "asserted" });
    const active = makeRanked("m-active", { beliefState: "active" });
    const unset = makeRanked("m-unset", {});
    const deprecated = makeRanked("m-deprecated", { beliefState: "deprecated" });
    const superseded = makeRanked("m-superseded", { beliefState: "superseded" });
    const contradicted = makeRanked("m-contradicted", { beliefState: "contradicted" });
    const archived = makeRanked("m-archived", { beliefState: "archived" });

    for (const item of [asserted, active, unset, deprecated, superseded, contradicted, archived]) {
      rank(item, "irrelevant");
    }

    expect(asserted.score).toBeGreaterThan(active.score);
    expect(active.score).toBeGreaterThan(unset.score);
    expect(unset.score).toBeGreaterThan(deprecated.score);
    expect(deprecated.score).toBeGreaterThan(superseded.score);
    expect(superseded.score).toBeGreaterThan(contradicted.score);
    expect(contradicted.score).toBeGreaterThan(archived.score);
  });

  test("non-memory entries are unaffected by beliefStateBoost (default-safe)", () => {
    const skillAsserted = {
      id: 1,
      entry: { name: "s1", type: "skill", beliefState: "asserted" } as StashEntry,
      filePath: "/stash/skills/s1.md",
      score: 1,
      rankingMode: "fts" as const,
    };
    const skillPlain = {
      id: 2,
      entry: { name: "s2", type: "skill" } as StashEntry,
      filePath: "/stash/skills/s2.md",
      score: 1,
      rankingMode: "fts" as const,
    };
    rank(skillAsserted, "irrelevant");
    rank(skillPlain, "irrelevant");
    expect(skillAsserted.score).toBeCloseTo(skillPlain.score, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. matchBeliefFilter via akmSearch
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1A: matchBeliefFilter classification", () => {
  test("belief=current includes 'asserted' but excludes 'deprecated'", async () => {
    const stashDir = makeTempDir("akm-belief-filter-current-");
    writeMemory(stashDir, "parent", { description: "parent memory" }, "Parent.");
    writeMemory(
      stashDir,
      "alpha-asserted.derived",
      {
        inferred: true,
        source: "memory:parent",
        beliefState: "asserted",
        title: "Alpha asserted gateway guidance",
        description: "Alpha gateway guidance.",
        searchHints: ["alpha gateway guidance"],
      },
      "# Alpha asserted\n\nAlpha gateway guidance.",
    );
    writeMemory(
      stashDir,
      "alpha-deprecated.derived",
      {
        inferred: true,
        source: "memory:parent",
        beliefState: "deprecated",
        title: "Alpha deprecated gateway guidance",
        description: "Alpha gateway guidance.",
        searchHints: ["alpha gateway guidance"],
      },
      "# Alpha deprecated\n\nAlpha gateway guidance.",
    );

    await buildIndex(stashDir);

    const currentResult = await akmSearch({
      query: "alpha gateway guidance",
      source: "local",
      type: "memory",
      belief: "current",
    });
    const currentNames = currentResult.hits.filter((hit) => hit.type !== "registry").map((hit) => hit.name);
    expect(currentNames).toContain("alpha-asserted.derived");
    expect(currentNames).not.toContain("alpha-deprecated.derived");
  });

  test("belief=historical includes 'deprecated' alongside superseded/contradicted/archived", async () => {
    const stashDir = makeTempDir("akm-belief-filter-historical-");
    writeMemory(stashDir, "parent", { description: "parent memory" }, "Parent.");
    writeMemory(
      stashDir,
      "alpha-asserted.derived",
      {
        inferred: true,
        source: "memory:parent",
        beliefState: "asserted",
        title: "Alpha asserted beta guidance",
        description: "Alpha beta guidance.",
        searchHints: ["alpha beta guidance"],
      },
      "# Alpha asserted\n\nAlpha beta guidance.",
    );
    writeMemory(
      stashDir,
      "alpha-deprecated.derived",
      {
        inferred: true,
        source: "memory:parent",
        beliefState: "deprecated",
        title: "Alpha deprecated beta guidance",
        description: "Alpha beta guidance.",
        searchHints: ["alpha beta guidance"],
      },
      "# Alpha deprecated\n\nAlpha beta guidance.",
    );

    await buildIndex(stashDir);

    const historicalResult = await akmSearch({
      query: "alpha beta guidance",
      source: "local",
      type: "memory",
      belief: "historical",
    });
    const historicalNames = historicalResult.hits.filter((hit) => hit.type !== "registry").map((hit) => hit.name);
    expect(historicalNames).toContain("alpha-deprecated.derived");
    expect(historicalNames).not.toContain("alpha-asserted.derived");
  });
});
