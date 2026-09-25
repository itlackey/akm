// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { IMPROVE_AUTONOMY_CONFIG_KEY } from "../../../../src/core/config/experimental";
import { readEvents } from "../../../../src/core/events";
import { _setWarnSinkForTests } from "../../../../src/core/warn";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { overrideSeam } from "../../../_helpers/seams";

const config = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  defaults: { improveStrategy: "contradiction-report" },
  improve: {
    strategies: {
      "contradiction-report": {
        processes: {
          reflect: { enabled: false },
          distill: { enabled: false },
          consolidate: { enabled: false, contradictionDetection: { enabled: true } },
          memoryInference: { enabled: false },
          graphExtraction: { enabled: false },
          extract: { enabled: false },
          validation: { enabled: false },
          triage: { enabled: false },
          proactiveMaintenance: { enabled: false },
        },
      },
    },
  },
} as unknown as AkmConfig;

const emptyPreparation = {
  actionableRefs: [],
  loopRefs: [],
  distillOnlyRefs: [],
  distillCooledRefs: new Set<string>(),
  signalBearingSet: new Set<string>(),
  utilityMap: new Map<string, number>(),
  actions: [],
  cleanupWarnings: [],
  validationFailures: [],
  schemaRepairs: [],
  coverageGaps: [],
  recentErrors: {},
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
};

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("review-first improve autonomy reporting", () => {
  test("cleanup and disabled contradiction writes do not emit stale autonomy-gated reports", async () => {
    const warningLines: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warningLines.push(args.map(String).join(" "));
    });
    const contradictionDetectionFn = mock(async () => ({
      familiesExamined: 0,
      pairsChecked: 0,
      edgesWritten: 0,
      warnings: [],
    }));

    const result = await akmImprove({
      scope: "memory",
      stashDir: storage.stashDir,
      config,
      ensureIndexFn: async () => undefined,
      collectEligibleRefsFn: (async () => ({
        plannedRefs: [],
        memorySummary: { eligible: 2, derived: 2 },
        strategyFilteredRefs: [],
      })) as never,
      contradictionDetectionFn: contradictionDetectionFn as never,
      runImprovePreparationStageFn: (async () => emptyPreparation) as never,
      runImproveLoopStageFn: (async () => ({
        reflectsWithErrorContext: 0,
        memoryRefsForInference: new Set(),
      })) as never,
      runImprovePostLoopStageFn: (async () => ({
        allWarnings: [],
        memoryInferenceDurationMs: 0,
        graphExtractionDurationMs: 0,
      })) as never,
    });

    expect(result.ok).toBe(true);
    expect(result.memoryCleanup?.analyzedDerived).toBe(0);
    expect(contradictionDetectionFn).not.toHaveBeenCalled();

    const directLanes = ["consolidate", "contradiction", "memoryCleanup"];
    const warningLanes = directLanes.filter((lane) =>
      warningLines.some(
        (line) => line.includes(`[improve] ${lane} skipped`) && line.includes(IMPROVE_AUTONOMY_CONFIG_KEY),
      ),
    );
    const eventLanes = readEvents({ type: "improve_skipped" })
      .events.filter((event) => event.metadata?.reason === "autonomy_gated")
      .map((event) => event.metadata?.lane)
      .filter((lane): lane is string => typeof lane === "string")
      .sort();

    expect({ warningLanes, eventLanes }).toEqual({
      warningLanes: [],
      eventLanes: [],
    });
  });
});
