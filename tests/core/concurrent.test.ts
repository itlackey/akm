/**
 * Tests for `concurrentMap` — the bounded worker pool the workflow
 * scheduler generalizes (P0.5). Previously untested despite indexer use.
 *
 * Covered:
 *   • Order-preserving results at bounded concurrency.
 *   • Individual failures leave `undefined` without cancelling siblings.
 *   • The concurrency cap is actually enforced.
 *   • Abort: no NEW items are claimed after the signal fires; in-flight
 *     calls complete.
 */
import { describe, expect, test } from "bun:test";
import { concurrentMap } from "../../src/core/concurrent";

describe("concurrentMap", () => {
  test("maps all items, preserving index order", async () => {
    const results = await concurrentMap([1, 2, 3, 4], async (n) => n * 10, 2);
    expect(results).toEqual([10, 20, 30, 40]);
  });

  test("an individual failure leaves undefined and does not cancel others", async () => {
    const results = await concurrentMap(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      },
      3,
    );
    expect(results).toEqual([1, undefined, 3]);
  });

  test("enforces the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    await concurrentMap(
      Array.from({ length: 8 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("abort stops claiming new items; in-flight items complete", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const results = await concurrentMap(
      Array.from({ length: 10 }, (_, i) => i),
      async (i) => {
        started.push(i);
        if (i === 1) controller.abort();
        await new Promise((r) => setTimeout(r, 5));
        return i;
      },
      2,
      { signal: controller.signal },
    );
    // Workers claimed at most one more item after the abort (the claim that
    // was already past the check); the tail was never started.
    expect(started.length).toBeLessThanOrEqual(4);
    expect(results.filter((r) => r !== undefined).length).toBe(started.length);
    expect(results[9]).toBeUndefined();
  });

  test("pre-aborted signal maps nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const results = await concurrentMap(
      [1, 2, 3],
      async (n) => {
        calls++;
        return n;
      },
      2,
      { signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(results).toEqual([undefined, undefined, undefined]);
  });
});
