// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../src/commands/improve/improve";
import type { AkmConfig } from "../../src/core/config/config";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  stashDir = storage.stashDir;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

const config = {
  semanticSearchMode: "off",
  defaults: { improveStrategy: "exact-paths-test" },
  improve: {
    strategies: {
      "exact-paths-test": {
        processes: Object.fromEntries(
          [
            "reflect",
            "distill",
            "consolidate",
            "memoryInference",
            "graphExtraction",
            "extract",
            "validation",
            "triage",
            "proactiveMaintenance",
            "recombine",
            "procedural",
          ].map((name) => [name, { enabled: false }]),
        ),
      },
    },
  },
} as unknown as AkmConfig;

test("improve auto-sync excludes pre-staged WIP from the same content directory", async () => {
  expect(spawnSync("git", ["init", "--initial-branch=main", stashDir], { encoding: "utf8" }).status).toBe(0);
  const memoriesDir = path.join(stashDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, "staged-wip.md"), "pre-staged WIP\n", "utf8");
  expect(spawnSync("git", ["-C", stashDir, "add", "--", "memories/staged-wip.md"]).status).toBe(0);
  const calls: string[][] = [];

  const result = await akmImprove({
    scope: "memory",
    stashDir,
    config,
    ensureIndexFn: async () => undefined,
    collectEligibleRefsFn: (async () => ({
      plannedRefs: [{ ref: "memory:seed" }],
      memorySummary: { eligible: 1, derived: 0 },
      profileFilteredRefs: [],
    })) as never,
    runImprovePreparationStageFn: (async (args: { plannedRefs: Array<{ ref: string }> }) => {
      fs.writeFileSync(path.join(memoriesDir, "operation.md"), "operation\n", "utf8");
      return {
        actionableRefs: args.plannedRefs,
        loopRefs: args.plannedRefs,
        distillOnlyRefs: [],
        distillCooledRefs: new Set(),
        signalBearingSet: new Set(),
        utilityMap: new Map(),
        actions: [],
        cleanupWarnings: [],
        validationFailures: [],
        schemaRepairs: [],
        coverageGaps: [],
        recentErrors: {},
        gateAutoAcceptedCount: 1,
        gateAutoAcceptFailedCount: 0,
        consolidation: {
          schemaVersion: 1,
          ok: true,
          shape: "consolidate-result",
          dryRun: false,
          previewOnly: false,
          target: "memory",
          processed: 0,
          merged: 0,
          deleted: 0,
          promoted: [],
          contradicted: 0,
          warnings: [],
        },
        consolidationRan: false,
      };
    }) as never,
    runImproveLoopStageFn: (async () => ({
      reflectsWithErrorContext: 0,
      memoryRefsForInference: new Set(),
      gateAutoAcceptedCount: 0,
      gateAutoAcceptFailedCount: 0,
    })) as never,
    runImprovePostLoopStageFn: (async () => ({
      allWarnings: [],
      gateAutoAcceptedCount: 0,
      gateAutoAcceptFailedCount: 0,
      memoryInferenceDurationMs: 0,
      graphExtractionDurationMs: 0,
    })) as never,
    saveGitStashFn: mock((_name?: string, _message?: string, _writable?: boolean, options?: { paths?: string[] }) => {
      calls.push(options?.paths ?? []);
      return { committed: true, pushed: false, skipped: false, output: "committed" };
    }) as never,
  });

  expect(result.ok).toBe(true);
  expect(calls).toEqual([["memories/operation.md"]]);
});
