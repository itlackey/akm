// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import type { AkmConfig } from "../../src/core/config/config-types";
import {
  clampMaxConcurrency,
  cpuDerivedUnitConcurrency,
  maxUnitConcurrency,
  scheduleUnits,
  WORKFLOW_MAX_CONCURRENCY_CEILING,
} from "../../src/workflows/exec/scheduler";

/**
 * Direct scheduler tests (orchestration plan §Trust & limits): the engine
 * caps that guard native fan-out — default concurrency 1 (local-model-safe),
 * clamping to min(16, cores − 2), and cooperative abort semantics inherited
 * from concurrentMap. The lifetime unit cap is enforced per ACTUAL dispatch
 * by the native executor (durable-row reuses are free — peer review R1), so
 * it is tested there, not here.
 */

/** Track the high-water mark of concurrent in-flight dispatches. */
function concurrencyProbe(delayMs = 5) {
  let inFlight = 0;
  let peak = 0;
  return {
    dispatch: async (item: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;
      return item * 2;
    },
    peak: () => peak,
  };
}

describe("scheduleUnits", () => {
  test("defaults to concurrency 1 (sequential) when none is declared", async () => {
    const probe = concurrencyProbe();
    const results = await scheduleUnits([1, 2, 3, 4], probe.dispatch, {});
    expect(results).toEqual([2, 4, 6, 8]);
    expect(probe.peak()).toBe(1);
  });

  test("honours declared concurrency up to the cap", async () => {
    const probe = concurrencyProbe();
    // Pin the cap: the real CPU-derived cap varies by machine (min 1 on 2 cores).
    await scheduleUnits([1, 2, 3, 4, 5, 6], probe.dispatch, {
      concurrency: 3,
      maxConcurrency: 8,
      hostConcurrency: 8,
    });
    expect(probe.peak()).toBe(3);
  });

  test("clamps declared concurrency to the engine cap", async () => {
    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, { concurrency: 64, maxConcurrency: 2 });
    expect(probe.peak()).toBe(2);
  });

  test("applies the minimum of map, frozen workflow, selected LLM, and current host limits", async () => {
    for (const [expected, options] of [
      [2, { concurrency: 2, maxConcurrency: 8, llmConcurrency: 7, hostConcurrency: 6 }],
      [3, { concurrency: 8, maxConcurrency: 3, llmConcurrency: 7, hostConcurrency: 6 }],
      [4, { concurrency: 8, maxConcurrency: 7, llmConcurrency: 4, hostConcurrency: 6 }],
      [5, { concurrency: 8, maxConcurrency: 7, llmConcurrency: 6, hostConcurrency: 5 }],
    ] as const) {
      const probe = concurrencyProbe();
      await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, options);
      expect(probe.peak()).toBe(expected);
    }
  });

  test("concurrency wider than the item list never over-schedules — peak is capped at the item count", async () => {
    // A declared/cap concurrency far above the number of items must not spin up
    // more in-flight dispatches than there are items to dispatch.
    const probe = concurrencyProbe();
    const results = await scheduleUnits([1, 2, 3], probe.dispatch, {
      concurrency: 32,
      maxConcurrency: 16,
      hostConcurrency: 16,
    });
    expect(results).toEqual([2, 4, 6]);
    expect(probe.peak()).toBe(3);
  });

  test("maxUnitConcurrency default is min(16, cores − 2), floored at 1 (config unset)", () => {
    // Pass `configured: undefined` explicitly to force the CPU-derived path
    // regardless of any ambient config file.
    expect(maxUnitConcurrency(32, undefined)).toBe(16);
    expect(maxUnitConcurrency(8, undefined)).toBe(6);
    expect(maxUnitConcurrency(2, undefined)).toBe(1);
    expect(maxUnitConcurrency(1, undefined)).toBe(1);
    // cpuDerivedUnitConcurrency is the same formula in isolation.
    expect(cpuDerivedUnitConcurrency(32)).toBe(16);
    expect(cpuDerivedUnitConcurrency(1)).toBe(1);
  });

  test("an explicit workflow.maxConcurrency wins over the CPU default and is clamped", () => {
    // Configured value takes precedence over the CPU formula (which would be 16 on 32 cores).
    expect(maxUnitConcurrency(32, 4)).toBe(4);
    expect(maxUnitConcurrency(2, 8)).toBe(8);
    // Clamped to [1, ceiling]: values above the ceiling clamp down, <1 floors to 1.
    expect(maxUnitConcurrency(32, 100000)).toBe(WORKFLOW_MAX_CONCURRENCY_CEILING);
    expect(maxUnitConcurrency(32, 0)).toBe(1);
    expect(maxUnitConcurrency(32, -5)).toBe(1);
    // Fractional values floor before clamping.
    expect(maxUnitConcurrency(32, 3.9)).toBe(3);
  });

  test("clampMaxConcurrency floors at 1 and caps at the ceiling", () => {
    expect(clampMaxConcurrency(1)).toBe(1);
    expect(clampMaxConcurrency(0)).toBe(1);
    expect(clampMaxConcurrency(-100)).toBe(1);
    expect(clampMaxConcurrency(WORKFLOW_MAX_CONCURRENCY_CEILING)).toBe(WORKFLOW_MAX_CONCURRENCY_CEILING);
    expect(clampMaxConcurrency(WORKFLOW_MAX_CONCURRENCY_CEILING + 1)).toBe(WORKFLOW_MAX_CONCURRENCY_CEILING);
    expect(WORKFLOW_MAX_CONCURRENCY_CEILING).toBe(64);
  });

  test("an aborted signal stops claiming new items; unclaimed slots stay undefined", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const results = await scheduleUnits(
      [1, 2, 3, 4],
      async (item) => {
        dispatches++;
        if (item === 1) controller.abort();
        return item;
      },
      { signal: controller.signal },
    );
    expect(dispatches).toBe(1);
    expect(results).toEqual([1, undefined, undefined, undefined]);
  });

  test("individual dispatch failures do not cancel siblings", async () => {
    const results = await scheduleUnits(
      [1, 2, 3],
      async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      },
      { concurrency: 3, maxConcurrency: 3 },
    );
    expect(results).toEqual([1, undefined, 3]);
  });
});

describe("scheduleUnits — workflow.maxConcurrency config knob", () => {
  afterEach(() => {
    resetConfigCache();
  });

  test("does not re-read live config after the execution policy is frozen", async () => {
    // The scheduler receives the frozen cap from its caller. A live config
    // change without that frozen value must not alter an in-flight run.
    saveConfig({ workflow: { maxConcurrency: 2 } } as AkmConfig);
    resetConfigCache();
    expect(loadConfig().workflow?.maxConcurrency).toBe(2);

    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, {
      concurrency: 8,
      hostConcurrency: 8,
    });
    expect(probe.peak()).toBe(8);
  });

  test("the maxConcurrency test seam still overrides the configured value", async () => {
    saveConfig({ workflow: { maxConcurrency: 2 } } as AkmConfig);
    resetConfigCache();

    const probe = concurrencyProbe();
    // Seam of 4 wins over the configured 2.
    await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, {
      concurrency: 8,
      maxConcurrency: 4,
      hostConcurrency: 4,
    });
    expect(probe.peak()).toBe(4);
  });
});
