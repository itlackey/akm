// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #662 — incremental + crash-safe stash sync for `akmImprove`.
 *
 * The end-of-run BATCH commit only ran on the happy path, so a run interrupted
 * AFTER writing but BEFORE finishing (mid-cycle crash, budget abort, external
 * SIGTERM) left every write uncommitted until a LATER clean run swept the
 * backlog up. The fix calls the shared `commitStashBatch` from three places:
 *
 *   - between cycles (bank each completed cycle's writes),
 *   - at end-of-run (the converged commit — unchanged behavior),
 *   - from the catch path (commit what was written before a crash/abort).
 *
 * Contract under test:
 *   - DEFAULT maxCycles=1 ⇒ sync fires EXACTLY once (byte-identical: the single
 *     end-of-run commit is still the only sync for a one-cycle run).
 *   - maxCycles=2 (both cycles do work) ⇒ sync fires TWICE: once between the
 *     cycles, once at end-of-run.
 *   - a mid-run throw ⇒ the run still commits (catch-path sync) AND the original
 *     error is rethrown (the safety net never swallows the failure).
 *
 * Driven against the REAL `akmImprove` with the same deterministic stage seams
 * as improve-multi-cycle.test.ts plus an injected `saveGitStashFn`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type AkmImproveOptions, akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import type { SaveGitStashResult } from "../../../src/sources/providers/git";
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

/** Mark the sandbox stash as git-backed (sync recognition is by `.git`). */
function makeGitBacked(): void {
  fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });
}

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
      promoted: [] as string[],
      contradicted: 0,
      warnings: [] as string[],
    },
    consolidationRan: false,
  } as never;
}

function makePrepFn(opts: { gateAutoAccepted: number; onRun?: () => void }) {
  return mock(async (args: { plannedRefs: ImproveEligibleRef[] }) => {
    opts.onRun?.();
    return prepResult(args.plannedRefs, opts.gateAutoAccepted);
  });
}

function makeLoopFn() {
  return mock(async () => ({
    reflectsWithErrorContext: 0,
    memoryRefsForInference: new Set<string>(),
    gateAutoAcceptedCount: 0,
    gateAutoAcceptFailedCount: 0,
  }));
}

function makePostLoopFn() {
  return mock(async () => ({
    allWarnings: [] as string[],
    gateAutoAcceptedCount: 0,
    gateAutoAcceptFailedCount: 0,
    memoryInferenceDurationMs: 0,
    graphExtractionDurationMs: 0,
  }));
}

function baseConfig(): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improve: "sync-resilience-test" },
    profiles: {
      improve: {
        "sync-resilience-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            triage: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function committed(): SaveGitStashResult {
  return { committed: true, pushed: true, skipped: false, output: "committed" };
}

/** Common seam bundle; each test overrides what it cares about. Gate-accepted=1
 * per cycle so the #616 fixed-point stop never ends a multi-cycle run early. */
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

describe("akm improve — incremental + crash-safe sync (#662)", () => {
  test(
    "default (maxCycles=1) commits exactly once — byte-identical single pass",
    async () => {
      makeGitBacked();
      const saveGitStashFn = mock(() => committed());

      const result = await akmImprove(seams({ saveGitStashFn: saveGitStashFn as never }));

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).toHaveBeenCalledTimes(1);
      expect(result.sync).toEqual({ committed: true, pushed: true, skipped: false });
    },
    TIMEOUT_MS,
  );

  test(
    "maxCycles=2 banks the first cycle: commits between cycles AND at end-of-run",
    async () => {
      makeGitBacked();
      const saveGitStashFn = mock(() => committed());

      const result = await akmImprove(
        seams({
          maxCycles: 2,
          saveGitStashFn: saveGitStashFn as never,
        }),
      );

      expect(result.ok).toBe(true);
      // One inter-cycle commit (before cycle 2) + one end-of-run commit.
      expect(saveGitStashFn).toHaveBeenCalledTimes(2);
      expect(result.sync).toEqual({ committed: true, pushed: true, skipped: false });
    },
    TIMEOUT_MS,
  );

  test(
    "a mid-run crash still commits what was written, then rethrows the original error",
    async () => {
      makeGitBacked();
      const saveGitStashFn = mock(() => committed());
      const boom = new Error("simulated mid-run crash");
      // Preparation has already written to the stash before the loop stage throws.
      const loopFn = mock(async () => {
        throw boom;
      });

      await expect(
        akmImprove(
          seams({
            runImproveLoopStageFn: loopFn as never,
            saveGitStashFn: saveGitStashFn as never,
          }),
        ),
      ).rejects.toThrow("simulated mid-run crash");

      // The catch-path safety net committed before the error propagated.
      expect(saveGitStashFn).toHaveBeenCalledTimes(1);
    },
    TIMEOUT_MS,
  );

  test(
    "catch-path sync is skipped when the stash is not git-backed",
    async () => {
      // Deliberately NOT git-backed.
      const saveGitStashFn = mock(() => committed());
      const loopFn = mock(async () => {
        throw new Error("crash without a git stash");
      });

      await expect(
        akmImprove(
          seams({
            runImproveLoopStageFn: loopFn as never,
            saveGitStashFn: saveGitStashFn as never,
          }),
        ),
      ).rejects.toThrow("crash without a git stash");

      expect(saveGitStashFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );
});
