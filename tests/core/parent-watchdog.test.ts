// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: the parent-death watchdog polls `process.ppid` (injected
 * here) and fires once when it changes. Both the ppid reader and the
 * `setInterval` driver are injected so this stays a pure, timer-free unit
 * test — no real 2s wait, no real process reparenting.
 */

import { describe, expect, test } from "bun:test";
import { isReparented, startParentDeathWatchdog } from "../../src/core/parent-watchdog";

/** A synchronous `setInterval`/`clearInterval` pair: `tick()` runs every registered callback once. */
function fakeIntervalDriver() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const setIntervalFn = ((fn: () => void) => {
    const id = nextId++;
    callbacks.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalFn = ((id: unknown) => {
    callbacks.delete(id as number);
  }) as typeof clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    tick: () => {
      for (const fn of callbacks.values()) fn();
    },
    registeredCount: () => callbacks.size,
  };
}

describe("isReparented", () => {
  test("false when the ppid is unchanged", () => {
    expect(isReparented(100, 100)).toBe(false);
  });

  test("true once the ppid differs", () => {
    expect(isReparented(100, 1)).toBe(true);
  });
});

describe("startParentDeathWatchdog (#956)", () => {
  test("does not fire while the ppid stays the same", () => {
    const driver = fakeIntervalDriver();
    let fired = 0;
    const ppid = 100;
    startParentDeathWatchdog({
      initialPpid: 100,
      getPpid: () => ppid,
      onOrphaned: () => {
        fired++;
      },
      setIntervalFn: driver.setIntervalFn,
      clearIntervalFn: driver.clearIntervalFn,
    });

    driver.tick();
    driver.tick();
    expect(fired).toBe(0);
    // ppid never actually changes above; keep the variable "used" for the
    // no-op poll case without a lint complaint.
    expect(ppid).toBe(100);
  });

  test("fires exactly once, on the first tick that observes a changed ppid", () => {
    const driver = fakeIntervalDriver();
    let fired = 0;
    let ppid = 100;
    startParentDeathWatchdog({
      initialPpid: 100,
      getPpid: () => ppid,
      onOrphaned: () => {
        fired++;
      },
      setIntervalFn: driver.setIntervalFn,
      clearIntervalFn: driver.clearIntervalFn,
    });

    driver.tick(); // still 100 — no fire
    expect(fired).toBe(0);
    ppid = 1; // reparented to init
    driver.tick();
    expect(fired).toBe(1);
    driver.tick(); // a later tick must not fire again
    driver.tick();
    expect(fired).toBe(1);
  });

  test("stop() removes the timer so no further tick can fire", () => {
    const driver = fakeIntervalDriver();
    let fired = 0;
    let ppid = 100;
    const watchdog = startParentDeathWatchdog({
      initialPpid: 100,
      getPpid: () => ppid,
      onOrphaned: () => {
        fired++;
      },
      setIntervalFn: driver.setIntervalFn,
      clearIntervalFn: driver.clearIntervalFn,
    });

    expect(driver.registeredCount()).toBe(1);
    watchdog.stop();
    expect(driver.registeredCount()).toBe(0);
    ppid = 1;
    driver.tick(); // no-op: nothing registered any more
    expect(fired).toBe(0);
  });

  test("defaults to a 2000ms interval when intervalMs is omitted", () => {
    let capturedMs: number | undefined;
    const setIntervalFn = ((_fn: () => void, ms?: number) => {
      capturedMs = ms;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn = (() => {}) as typeof clearInterval;
    startParentDeathWatchdog({
      initialPpid: 100,
      getPpid: () => 100,
      onOrphaned: () => {},
      setIntervalFn,
      clearIntervalFn,
    });
    expect(capturedMs).toBe(2000);
  });
});
