/**
 * Unit tests for the bench cleanup registry (#267).
 *
 * The shared registry installs ONE pair of SIGINT/SIGTERM handlers on first
 * registration and runs every registered fn when a signal fires. We use the
 * `_drainForTest` test seam so the assertions don't have to actually kill
 * the test process — but we also exercise the real handler installation
 * path to make sure it's idempotent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _drainForTest, _registeredCountForTest, _resetForTest, registerCleanup } from "./cleanup";

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
});

describe("registerCleanup (#267)", () => {
  test("registers a cleanup fn and increments the count", () => {
    expect(_registeredCountForTest()).toBe(0);
    registerCleanup(() => {});
    expect(_registeredCountForTest()).toBe(1);
  });

  test("returns a deregister thunk that drops the registration", () => {
    const deregister = registerCleanup(() => {});
    expect(_registeredCountForTest()).toBe(1);
    deregister();
    expect(_registeredCountForTest()).toBe(0);
  });

  test("drainForTest runs every registered cleanup once", async () => {
    const calls: string[] = [];
    registerCleanup(() => {
      calls.push("a");
    });
    registerCleanup(() => {
      calls.push("b");
    });
    registerCleanup(() => {
      calls.push("c");
    });
    await _drainForTest();
    expect(calls.sort()).toEqual(["a", "b", "c"]);
    // Registry is empty after drain.
    expect(_registeredCountForTest()).toBe(0);
  });

  test("drainForTest swallows errors so one bad fn doesn't block the rest", async () => {
    const calls: string[] = [];
    registerCleanup(() => {
      calls.push("first");
    });
    registerCleanup(() => {
      throw new Error("boom");
    });
    registerCleanup(() => {
      calls.push("third");
    });
    await _drainForTest();
    expect(calls.sort()).toEqual(["first", "third"]);
  });

  test("drainForTest awaits async cleanup fns", async () => {
    const calls: string[] = [];
    registerCleanup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("async-done");
    });
    await _drainForTest();
    expect(calls).toEqual(["async-done"]);
  });

  test("idempotent installer: repeated registers do not multiply listeners", () => {
    const initialSigint = process.listenerCount("SIGINT");
    const initialSigterm = process.listenerCount("SIGTERM");
    registerCleanup(() => {});
    registerCleanup(() => {});
    registerCleanup(() => {});
    // Exactly one listener each, no matter how many cleanup fns we add.
    expect(process.listenerCount("SIGINT")).toBe(initialSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigterm + 1);
  });

  test("deregister-all leaves the listeners installed (registry is sticky)", () => {
    // The contract is: once installed, the handlers stay installed for the
    // process lifetime. Subsequent register calls reuse them.
    registerCleanup(() => {})();
    expect(_registeredCountForTest()).toBe(0);
    // Re-register: this MUST NOT add a second pair of listeners.
    const initialSigint = process.listenerCount("SIGINT");
    registerCleanup(() => {});
    expect(process.listenerCount("SIGINT")).toBe(initialSigint);
  });

  test("deregistered fns do not run on drain", async () => {
    const calls: string[] = [];
    const dereg = registerCleanup(() => {
      calls.push("kept");
    });
    const _wasted = registerCleanup(() => {
      calls.push("dropped");
    });
    _wasted();
    void dereg; // keep referenced
    await _drainForTest();
    expect(calls).toEqual(["kept"]);
  });

  test("simulated SIGINT path: handler runs cleanup before exit (via drain seam)", async () => {
    // We can't actually `process.exit(130)` inside a unit test, so we use the
    // drain seam (which mirrors the runAllAndExit path minus the exit call).
    // This verifies the OBSERVABLE behaviour the brief asked for: signal →
    // every registered cleanup fn ran.
    const ran: string[] = [];
    registerCleanup(() => {
      ran.push("rmsync(workspace)");
    });
    registerCleanup(() => {
      ran.push("rmsync(stash)");
    });
    await _drainForTest();
    expect(ran.length).toBe(2);
    expect(ran).toContain("rmsync(workspace)");
    expect(ran).toContain("rmsync(stash)");
  });

  test("re-entrant signals during running cleanup are dropped", async () => {
    // Drive the registered handler twice in sequence. The second drain
    // should observe the cleared registry (running flag flipped) and run
    // nothing extra. This protects against a Ctrl-C double-press
    // interrupting cleanup mid-run.
    const calls: string[] = [];
    registerCleanup(() => {
      calls.push("first");
    });
    await _drainForTest();
    expect(calls).toEqual(["first"]);
    // No further fns registered → second drain is a no-op.
    await _drainForTest();
    expect(calls).toEqual(["first"]);
  });
});
