// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { maxUnitConcurrency, scheduleUnits } from "../../src/workflows/exec/scheduler";

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
    await scheduleUnits([1, 2, 3, 4, 5, 6], probe.dispatch, { concurrency: 3, maxConcurrency: 8 });
    expect(probe.peak()).toBe(3);
  });

  test("clamps declared concurrency to the engine cap", async () => {
    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, { concurrency: 64, maxConcurrency: 2 });
    expect(probe.peak()).toBe(2);
  });

  test("maxUnitConcurrency is min(16, cores − 2), floored at 1", () => {
    expect(maxUnitConcurrency(32)).toBe(16);
    expect(maxUnitConcurrency(8)).toBe(6);
    expect(maxUnitConcurrency(2)).toBe(1);
    expect(maxUnitConcurrency(1)).toBe(1);
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
