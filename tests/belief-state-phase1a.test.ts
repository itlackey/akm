/**
 * Phase 1A / Rec 2 — Extended MemoryBeliefState.
 *
 * Verifies the two new first-class belief states `asserted` and `deprecated`
 * across two subsystems:
 *
 * 1. `resolveFamilyContradictions` / belief-refresh logic
 *    (`src/core/memory-improve.ts`) — `asserted` is treated like `active`
 *    (no spurious refresh, preserves `asserted` authority); `deprecated` is
 *    treated like `superseded` (frozen historical, never refreshed to active).
 *
 * 2. `matchBeliefFilter` (`src/indexer/search/db-search.ts`) — `asserted` is
 *    surfaced under `belief=current`; `deprecated` is surfaced under
 *    `belief=historical`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../src/commands/improve/improve";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { writeMemory } from "./_helpers/assets";
import { withImproveAutonomy, withTestImproveLlm } from "./_helpers/improve-config";
import { type IsolatedAkmStorage, makeSandboxDir, mutateScopedEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

const dirCleanups: (() => void)[] = [];

function makeTempDir(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  dirCleanups.push(cleanup);
  return dir;
}

async function buildIndex(stashDir: string): Promise<void> {
  mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
  saveConfig(withImproveAutonomy(withTestImproveLlm({ semanticSearchMode: "off" })));
  await akmIndex({ stashDir, full: true });
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  const akmDataDir = makeSandboxDir("akm-belief-phase1a-data-");
  const akmStateDir = makeSandboxDir("akm-belief-phase1a-state-");
  dirCleanups.push(akmDataDir.cleanup, akmStateDir.cleanup);
  storage = withIsolatedAkmStorage({ AKM_DATA_DIR: akmDataDir.dir, AKM_STATE_DIR: akmStateDir.dir });
});

afterEach(() => {
  storage.cleanup();
  for (const cleanup of dirCleanups.splice(0)) cleanup();
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
        parentRef: "memories/deploy",
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
// 2. matchBeliefFilter via akmSearch
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
