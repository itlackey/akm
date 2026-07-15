// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single-pass stage-seam regression (Chunk 7, WI-7.2).
 *
 * Repurposed from the deleted `improve-multi-cycle.test.ts`'s AC1
 * ("default (no maxCycles) runs each stage exactly once and omits
 * cyclesRun") after Chunk 7 deleted the #616 bounded multi-cycle loop
 * (D12): `maxCycles`, the per-cycle re-collect, the fixed-point stop, and
 * the `cyclesRun` result field are gone. `akmImprove` now always runs a
 * single prep→loop→post-loop pass.
 *
 * This suite pins what survives: the four injectable stage seams
 * (`collectEligibleRefsFn`, `runImprovePreparationStageFn`,
 * `runImproveLoopStageFn`, `runImprovePostLoopStageFn`, kept per D12
 * because they are the DI that keeps `akmImprove` testable) are each
 * invoked EXACTLY ONCE per run, and `ensureIndexFn` runs exactly once
 * ahead of ref collection.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type AkmImproveOptions, akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

// ---------------------------------------------------------------------------
// Deterministic stage fakes
// ---------------------------------------------------------------------------

function eligibleRef(ref: string): ImproveEligibleRef {
  return { ref } as unknown as ImproveEligibleRef;
}

function makeCollectFn(backing: Set<string>) {
  return mock(async () => ({
    plannedRefs: [...backing].map(eligibleRef),
    memorySummary: { eligible: backing.size, derived: 0 },
    profileFilteredRefs: [] as ImproveEligibleRef[],
  }));
}

/** Minimal but envelope-complete consolidation result for fakes. */
function fakeConsolidation() {
  return {
    schemaVersion: 1,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: "memory",
    processed: 0,
    merged: 0,
    deleted: 0,
    promoted: [] as string[],
    contradicted: 0,
    warnings: [] as string[],
  };
}

/** Envelope-complete preparation result (all arrays the result envelope reads). */
function prepResult(plannedRefs: ImproveEligibleRef[], gateAutoAccepted: number) {
  return {
    actionableRefs: plannedRefs,
    loopRefs: plannedRefs,
    distillOnlyRefs: [],
    distillCooledRefs: new Set<string>(),
    signalBearingSet: new Set<string>(),
    utilityMap: new Map<string, number>(),
    actions: [],
    appliedCleanup: undefined,
    cleanupWarnings: [],
    validationFailures: [],
    schemaRepairs: [],
    coverageGaps: [],
    recentErrors: {},
    gateAutoAcceptedCount: gateAutoAccepted,
    gateAutoAcceptFailedCount: 0,
    consolidation: fakeConsolidation(),
    consolidationRan: false,
  } as never;
}

function makePrepFn(opts: { gateAutoAccepted: number }) {
  return mock(async (args: { plannedRefs: ImproveEligibleRef[] }) =>
    prepResult(args.plannedRefs, opts.gateAutoAccepted),
  );
}

function makeLoopFn(opts: { gateAutoAccepted?: number } = {}) {
  return mock(async (_args: { budgetSignal?: AbortSignal }) => ({
    reflectsWithErrorContext: 0,
    memoryRefsForInference: new Set<string>(),
    gateAutoAcceptedCount: opts.gateAutoAccepted ?? 0,
    gateAutoAcceptFailedCount: 0,
  }));
}

function makePostLoopFn(opts: { gateAutoAccepted?: number } = {}) {
  return mock(async () => ({
    allWarnings: [] as string[],
    gateAutoAcceptedCount: opts.gateAutoAccepted ?? 0,
    gateAutoAcceptFailedCount: 0,
    memoryInferenceDurationMs: 0,
    graphExtractionDurationMs: 0,
  }));
}

function baseConfig(): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improveStrategy: "single-pass-test" },
    improve: {
      strategies: {
        "single-pass-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            validation: { enabled: false },
            triage: { enabled: false },
            proactiveMaintenance: { enabled: false },
            procedural: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

/** Common seam bundle so each test only overrides what it cares about. */
function seams(over: Partial<AkmImproveOptions>): AkmImproveOptions {
  return {
    scope: "memory",
    stashDir,
    config: baseConfig(),
    ensureIndexFn: mock(async () => undefined),
    collectEligibleRefsFn: makeCollectFn(new Set(["memory:seed"])) as never,
    runImprovePreparationStageFn: makePrepFn({ gateAutoAccepted: 1 }) as never,
    runImproveLoopStageFn: makeLoopFn() as never,
    runImprovePostLoopStageFn: makePostLoopFn() as never,
    ...over,
  };
}

describe("akm improve — single-pass stage seams (Chunk 7)", () => {
  test(
    "each stage seam is called exactly once per run",
    async () => {
      const ensureIndexFn = mock(async () => undefined);
      const collectEligibleRefsFn = makeCollectFn(new Set(["memory:seed"]));
      const prepFn = makePrepFn({ gateAutoAccepted: 1 });
      const loopFn = makeLoopFn();
      const postLoopFn = makePostLoopFn();

      const result = await akmImprove(
        seams({
          ensureIndexFn,
          collectEligibleRefsFn: collectEligibleRefsFn as never,
          runImprovePreparationStageFn: prepFn as never,
          runImproveLoopStageFn: loopFn as never,
          runImprovePostLoopStageFn: postLoopFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      expect(ensureIndexFn).toHaveBeenCalledTimes(1);
      expect(collectEligibleRefsFn).toHaveBeenCalledTimes(1);
      expect(prepFn).toHaveBeenCalledTimes(1);
      expect(loopFn).toHaveBeenCalledTimes(1);
      expect(postLoopFn).toHaveBeenCalledTimes(1);
      // The #616 multi-cycle loop (and its `cyclesRun` result field) was
      // deleted in Chunk 7 (D12) — no such field exists on the result type.
      expect(Object.hasOwn(result, "cyclesRun")).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "the budget AbortSignal is threaded into the loop stage",
    async () => {
      const ensureIndexFn = mock(async () => undefined);
      const collectEligibleRefsFn = makeCollectFn(new Set(["memory:seed"]));
      let sawSignal = false;
      const loopFn = mock(async (args: { budgetSignal?: AbortSignal }) => {
        sawSignal = args.budgetSignal instanceof AbortSignal;
        return {
          reflectsWithErrorContext: 0,
          memoryRefsForInference: new Set<string>(),
          gateAutoAcceptedCount: 0,
          gateAutoAcceptFailedCount: 0,
        };
      });

      const result = await akmImprove(
        seams({
          ensureIndexFn,
          collectEligibleRefsFn: collectEligibleRefsFn as never,
          runImproveLoopStageFn: loopFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      expect(sawSignal).toBe(true);
    },
    TIMEOUT_MS,
  );
});
