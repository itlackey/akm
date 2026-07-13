// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove, armBudgetWatchdog } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";

// A deterministic, controllable fake timer so we can exercise the
// concurrency-sensitive ordering of the H7 (#566) cooperative-drain watchdog
// without real wall-clock waits.
class FakeTimers {
  private seq = 0;
  private readonly pending = new Map<number, { fn: () => void; due: number }>();
  private now = 0;

  readonly setTimeout = ((fn: () => void, ms?: number): { unref?: () => void } => {
    const id = ++this.seq;
    this.pending.set(id, { fn, due: this.now + (ms ?? 0) });
    // Mimic Node's Timeout object: only `unref` is consulted by the watchdog.
    return { __id: id, unref: () => {} } as unknown as { unref?: () => void };
  }) as unknown as typeof setTimeout;

  readonly clearTimeout = ((handle: unknown): void => {
    const id = (handle as { __id?: number } | undefined)?.__id;
    if (id !== undefined) this.pending.delete(id);
  }) as unknown as typeof clearTimeout;

  /** Advance virtual time, firing every timer whose deadline has passed. */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending.entries()]) {
      if (t.due <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

describe("budget signal remainingBudgetMs getter (WS-3a blocker fix)", () => {
  // Verify that the AbortController signal created in akmImprove has the live
  // `remainingBudgetMs` getter attached by the fix for the cold-start budget
  // estimation blocker. The property must return a decreasing value as time
  // passes — not a stale snapshot — so consolidate.ts can use it to auto-
  // reduce the chunk pool.
  test("remainingBudgetMs is readable from the signal and returns the correct initial value", () => {
    const startMs = Date.now();
    const budgetMs = 60_000; // 1 minute
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "remainingBudgetMs", {
      get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
      enumerable: false,
      configurable: true,
    });

    const sig = controller.signal as AbortSignal & { remainingBudgetMs?: number };
    const remaining = sig.remainingBudgetMs;
    // Immediately after attachment, remaining should be close to budgetMs.
    expect(remaining).toBeDefined();
    expect(remaining as number).toBeGreaterThan(budgetMs - 500); // within 500ms
    expect(remaining as number).toBeLessThanOrEqual(budgetMs);
  });

  test("remainingBudgetMs decreases over time (getter is live, not a snapshot)", async () => {
    const startMs = Date.now();
    const budgetMs = 10_000; // 10 seconds
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "remainingBudgetMs", {
      get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
      enumerable: false,
      configurable: true,
    });

    const sig = controller.signal as AbortSignal & { remainingBudgetMs?: number };
    const first = sig.remainingBudgetMs as number;
    // Wait 20ms then read again — value must be strictly less.
    await new Promise((r) => setTimeout(r, 20));
    const second = sig.remainingBudgetMs as number;

    expect(second).toBeLessThan(first);
  });

  test("remainingBudgetMs floors at 0 when budget is exhausted", () => {
    // Simulate a startMs far in the past so the budget is already over.
    const startMs = Date.now() - 120_000; // 2 minutes ago
    const budgetMs = 60_000; // only 1 minute
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "remainingBudgetMs", {
      get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
      enumerable: false,
      configurable: true,
    });

    const sig = controller.signal as AbortSignal & { remainingBudgetMs?: number };
    expect(sig.remainingBudgetMs).toBe(0);
  });
});

describe("armBudgetWatchdog (H7 #566)", () => {
  test("clean drain within grace: dispose() cancels the hard-kill — no exit", () => {
    const timers = new FakeTimers();
    const controller = new AbortController();
    let exitCalls = 0;

    const dispose = armBudgetWatchdog(1_000, controller, {
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      exitFn: () => {
        exitCalls += 1;
      },
      hardKillGraceMs: 5_000,
    });

    // Budget expires → cooperative cancellation fires, hard-kill is armed.
    timers.advance(1_000);
    expect(controller.signal.aborted).toBe(true);
    expect(timers.pendingCount).toBe(1); // hard-kill timer pending

    // Run drains cleanly *before* the grace deadline and reaches its finally.
    timers.advance(2_000);
    dispose();

    // Past the old 5s point: the hard-kill must NOT fire on a clean drain.
    timers.advance(10_000);
    expect(exitCalls).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  test("drain overruns grace: hard-kill fires exit(0)", () => {
    const timers = new FakeTimers();
    const controller = new AbortController();
    const exitCodes: number[] = [];

    armBudgetWatchdog(1_000, controller, {
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      exitFn: (code) => exitCodes.push(code),
      hardKillGraceMs: 5_000,
    });

    timers.advance(1_000); // budget exhausted → abort + arm watchdog
    expect(controller.signal.aborted).toBe(true);

    // Drain hangs past the grace deadline without dispose() being reached.
    timers.advance(5_000);
    expect(exitCodes).toEqual([0]); // normal exit code for budget exhaustion
  });

  test("dispose() before budget expiry cancels everything; idempotent", () => {
    const timers = new FakeTimers();
    const controller = new AbortController();
    let exitCalls = 0;

    const dispose = armBudgetWatchdog(1_000, controller, {
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      exitFn: () => {
        exitCalls += 1;
      },
    });

    // Run finishes well within budget.
    dispose();
    dispose(); // idempotent — no throw

    timers.advance(100_000);
    expect(controller.signal.aborted).toBe(false);
    expect(exitCalls).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });
});

describe("akmImprove whole-run deadline", () => {
  test("is active and shared with initial blocking index work", async () => {
    const storage = withIsolatedAkmStorage();
    const config = {
      semanticSearchMode: "off",
      stashDir: storage.stashDir,
      defaults: { improveStrategy: "quiet-test" },
      improve: {
        strategies: {
          "quiet-test": {
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
    let receivedSignal: AbortSignal | undefined;
    let remainingAtIndex: number | undefined;

    try {
      await akmImprove({
        stashDir: storage.stashDir,
        config,
        timeoutMs: 10_000,
        ensureIndexFn: async (_stashDir, options) => {
          receivedSignal = options?.signal;
          remainingAtIndex = (options?.signal as AbortSignal & { remainingBudgetMs?: number }).remainingBudgetMs;
          expect(fs.existsSync(path.join(storage.stashDir, ".akm", "improve.lock"))).toBe(true);
          return false;
        },
        collectEligibleRefsFn: async () => ({
          plannedRefs: [],
          memorySummary: { eligible: 0, derived: 0 },
          strategyFilteredRefs: [],
        }),
      });
    } finally {
      storage.cleanup();
    }

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
    expect(remainingAtIndex).toBeGreaterThan(0);
    expect(remainingAtIndex).toBeLessThanOrEqual(10_000);
  });
});
