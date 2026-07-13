// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #616 — bounded multi-cycle phasing for `akmImprove`.
 *
 * These tests drive the REAL `akmImprove` against an isolated sandbox stash, but
 * inject deterministic seams for the four per-cycle stages so cycles run without
 * any LLM/network calls:
 *
 *   - `ensureIndexFn`               — re-run once per cycle (already an option)
 *   - `collectEligibleRefsFn`       — fresh ref selection each cycle (NEW seam)
 *   - `runImprovePreparationStageFn`(NEW seam)
 *   - `runImproveLoopStageFn`       (NEW seam)
 *   - `runImprovePostLoopStageFn`   (NEW seam)
 *
 * The contract under test (#616):
 *   AC1 — DEFAULT maxCycles=1 ⇒ each stage seam called EXACTLY once; result has
 *         NO cyclesRun field (omit-when-1 convention) ⇒ byte-identical single pass.
 *   AC2 — cycle N's gate-accepted output is selectable input to cycle N+1: with
 *         maxCycles=2, collectEligibleRefsFn is called twice and the second call
 *         sees a ref promoted during cycle 1; ensureIndexFn re-runs each cycle.
 *   AC3 — fixed-point stop: a cycle producing ZERO gate-accepted proposals ends
 *         the loop even if maxCycles is higher.
 *   AC4 — budget gate: a cycle is NOT started once remainingBudgetMs is exhausted.
 *   AC5 — result.cyclesRun reports the number of cycles executed (>1).
 *
 * #616 bounded multi-cycle phasing seam: the options `maxCycles`,
 * `collectEligibleRefsFn`, `runImprovePreparationStageFn`,
 * `runImproveLoopStageFn`, `runImprovePostLoopStageFn`, and the result field
 * `cyclesRun`.
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

/**
 * Fake `collectEligibleRefs` whose returned plannedRefs are snapshotted from a
 * mutable backing set, so a "promotion" recorded by a stage fake during cycle N
 * becomes visible to the (re-run) selection in cycle N+1.
 */
function makeCollectFn(backing: Set<string>) {
  return mock(async () => ({
    plannedRefs: [...backing].map(eligibleRef),
    memorySummary: { eligible: backing.size, derived: 0 },
    profileFilteredRefs: [] as ImproveEligibleRef[],
  }));
}

/**
 * Fake preparation stage. `actionableRefs` echoes the planned refs so the
 * aggregation's last-wins `plannedRefs` reflects the final cycle's selection.
 * `gateAutoAccepted` controls the fixed-point signal contribution.
 */
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

function makePrepFn(opts: { gateAutoAccepted: number; onRun?: () => void }) {
  return mock(async (args: { plannedRefs: ImproveEligibleRef[] }) => {
    opts.onRun?.();
    return prepResult(args.plannedRefs, opts.gateAutoAccepted);
  });
}

function makeLoopFn(opts: { gateAutoAccepted?: number; signal?: () => AbortSignal } = {}) {
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
    defaults: { improveStrategy: "multi-cycle-test" },
    improve: {
      strategies: {
        "multi-cycle-test": {
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
            recombine: { enabled: false },
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

// ---------------------------------------------------------------------------
// AC1 — byte-identical default (maxCycles omitted ⇒ 1)
// ---------------------------------------------------------------------------

describe("akm improve — multi-cycle (#616)", () => {
  test(
    "AC1: default (no maxCycles) runs each stage exactly once and omits cyclesRun",
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
      // omit-when-1 convention ⇒ byte-identical default serialized envelope.
      expect((result as { cyclesRun?: number }).cyclesRun).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // AC2 — cycle N output visible to cycle N+1
  // -------------------------------------------------------------------------
  test(
    "AC2: maxCycles=2 re-runs ensureIndex + collect; cycle 2 sees cycle 1's promotion",
    async () => {
      const backing = new Set<string>(["memory:seed"]);
      const ensureIndexFn = mock(async () => undefined);
      const collectEligibleRefsFn = makeCollectFn(backing);

      // Cycle 1 promotes a NEW ref into the backing set (simulating a gate
      // promotion that ensureIndex would surface for cycle 2's selection).
      let prepCalls = 0;
      const prepFn = makePrepFn({
        gateAutoAccepted: 1,
        onRun: () => {
          prepCalls += 1;
          if (prepCalls === 1) backing.add("memory:promoted-in-cycle-1");
        },
      });

      const result = await akmImprove(
        seams({
          maxCycles: 2,
          ensureIndexFn,
          collectEligibleRefsFn: collectEligibleRefsFn as never,
          runImprovePreparationStageFn: prepFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      expect(ensureIndexFn).toHaveBeenCalledTimes(2);
      expect(collectEligibleRefsFn).toHaveBeenCalledTimes(2);

      // Second selection sees the ref promoted during cycle 1.
      const secondCallResult = await (collectEligibleRefsFn.mock.results[1]?.value as Promise<{
        plannedRefs: ImproveEligibleRef[];
      }>);
      const secondRefs = secondCallResult.plannedRefs.map((r) => r.ref);
      expect(secondRefs).toContain("memory:promoted-in-cycle-1");

      // Final result reflects the last cycle's selection.
      expect(result.plannedRefs.map((r) => r.ref)).toContain("memory:promoted-in-cycle-1");
      expect((result as { cyclesRun?: number }).cyclesRun).toBe(2);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // AC3 — fixed-point stop
  // -------------------------------------------------------------------------
  test(
    "AC3: maxCycles=3 stops at the first cycle that gate-accepts ZERO proposals",
    async () => {
      const ensureIndexFn = mock(async () => undefined);
      const collectEligibleRefsFn = makeCollectFn(new Set(["memory:seed"]));

      // Cycle 1 productive (gateAutoAccepted=1), cycle 2 produces zero across all
      // three stages ⇒ fixed point ⇒ loop ends after cycle 2 (NOT 3).
      let cycle = 0;
      const prepFn = mock(async (args: { plannedRefs: ImproveEligibleRef[] }) => {
        cycle += 1;
        return prepResult(args.plannedRefs, cycle === 1 ? 1 : 0);
      });
      const loopFn = makeLoopFn({ gateAutoAccepted: 0 });
      const postLoopFn = makePostLoopFn({ gateAutoAccepted: 0 });

      const result = await akmImprove(
        seams({
          maxCycles: 3,
          ensureIndexFn,
          collectEligibleRefsFn: collectEligibleRefsFn as never,
          runImprovePreparationStageFn: prepFn as never,
          runImproveLoopStageFn: loopFn as never,
          runImprovePostLoopStageFn: postLoopFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      expect(ensureIndexFn).toHaveBeenCalledTimes(2);
      expect(collectEligibleRefsFn).toHaveBeenCalledTimes(2);
      expect(prepFn).toHaveBeenCalledTimes(2);
      expect(loopFn).toHaveBeenCalledTimes(2);
      expect(postLoopFn).toHaveBeenCalledTimes(2);
      expect((result as { cyclesRun?: number }).cyclesRun).toBe(2);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // AC4 — budget gate skips starting a further cycle
  // -------------------------------------------------------------------------
  test(
    "AC4a: an exhausted budget prevents cycle 2 from starting (cycle 1 always runs)",
    async () => {
      const ensureIndexFn = mock(async () => undefined);
      const collectEligibleRefsFn = makeCollectFn(new Set(["memory:seed"]));
      // Both cycles would be productive, so only the budget gate can stop cycle 2.
      const prepFn = makePrepFn({ gateAutoAccepted: 1 });
      const loopFn = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          reflectsWithErrorContext: 0,
          memoryRefsForInference: new Set<string>(),
          gateAutoAcceptedCount: 0,
          gateAutoAcceptFailedCount: 0,
        };
      });
      const postLoopFn = makePostLoopFn();

      const result = await akmImprove(
        seams({
          maxCycles: 3,
          // 1ms budget ⇒ after cycle 1 (which awaits real async work) the
          // remaining budget is <= 0, so cycle 2 must NOT start.
          timeoutMs: 1,
          ensureIndexFn,
          collectEligibleRefsFn: collectEligibleRefsFn as never,
          runImprovePreparationStageFn: prepFn as never,
          runImproveLoopStageFn: loopFn as never,
          runImprovePostLoopStageFn: postLoopFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      // Cycle 1 always runs; cycle 2 is budget-gated out.
      expect(ensureIndexFn).toHaveBeenCalledTimes(1);
      expect(collectEligibleRefsFn).toHaveBeenCalledTimes(1);
      expect(prepFn).toHaveBeenCalledTimes(1);
      expect(postLoopFn).not.toHaveBeenCalled();
      expect((result as { cyclesRun?: number }).cyclesRun).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    "AC4b: the budget AbortSignal is threaded into each per-cycle loop stage",
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
          maxCycles: 1,
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

  // -------------------------------------------------------------------------
  // AC5 — cyclesRun reported on a productive multi-cycle run
  // -------------------------------------------------------------------------
  test(
    "AC5: a two-productive-cycle run reports result.cyclesRun === 2",
    async () => {
      const result = await akmImprove(
        seams({
          maxCycles: 2,
          // both cycles productive (prep gateAutoAccepted=1 from seams())
        }),
      );

      expect(result.ok).toBe(true);
      expect((result as { cyclesRun?: number }).cyclesRun).toBe(2);
    },
    TIMEOUT_MS,
  );
});
