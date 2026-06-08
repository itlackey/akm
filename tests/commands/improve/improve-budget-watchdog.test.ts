// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { armBudgetWatchdog } from "../../../src/commands/improve/improve";

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
