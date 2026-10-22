// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit coverage for the managed-subprocess primitive (`runManagedSubprocess`).
 *
 * The primitive owns spawn/timeout/abort/capture for every non-agent
 * subprocess caller. Here we drive it with a fake {@link SpawnFn} and injected
 * timers so the kill ladder is fully deterministic:
 *
 *   • Timeout escalation: a child that IGNORES SIGTERM is force-killed via
 *     SIGKILL after the grace timer, and the result carries `timedOut`.
 *   • Group-kill fallback: a pid-less fake receives signals through
 *     `proc.kill()` directly (the negative-pid `process.kill` path is skipped).
 *   • Abort: aborting mid-run runs the same ladder and flags `aborted`.
 *   • Synchronous spawn failure surfaces as `spawnError`, never a throw.
 *   • Drain deadlines: WHEN the stream-drain timeout is armed — never while a
 *     live command still owns the pipe, so on the child's exit, or for a
 *     bounded run the earlier of that and the wall budget.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSpawnOptions,
  runManagedSubprocess,
  type SpawnedSubprocess,
  type SpawnFn,
  spawnsOwnProcessGroup,
} from "../../src/core/subprocess";

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface TimerHandle {
  cb: () => void;
  ms: number;
  unrefCalled: boolean;
  unref?: () => void;
}

/** A synchronous timer driver: timers are collected, never auto-fired. */
function fakeTimers() {
  const timers: TimerHandle[] = [];
  const setTimeoutFn = ((cb: () => void, ms?: number): TimerHandle => {
    const handle: TimerHandle = {
      cb,
      ms: ms ?? 0,
      unrefCalled: false,
      unref() {
        handle.unrefCalled = true;
      },
    };
    timers.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
  return { timers, setTimeoutFn, clearTimeoutFn };
}

/**
 * A fake subprocess that records the signals it receives. When `ignoreSigterm`
 * is set, only SIGKILL resolves `exited` — SIGTERM is swallowed, mimicking a
 * child that refuses graceful shutdown.
 */
function killTrackingSpawn(config: { pid?: number; ignoreSigterm?: boolean; exitOnKill?: number }): {
  spawn: SpawnFn;
  signals: string[];
} {
  const signals: string[] = [];
  const spawn: SpawnFn = () => {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const proc: SpawnedSubprocess = {
      exitCode: null,
      exited,
      stdout: asReadableStream(""),
      stderr: asReadableStream(""),
      stdin: null,
      ...(config.pid !== undefined ? { pid: config.pid } : {}),
      kill(signal?: number | string) {
        const name = String(signal);
        signals.push(name);
        if (config.ignoreSigterm && name === "SIGTERM") return;
        resolveExit(config.exitOnKill ?? 137);
      },
    };
    return proc;
  };
  return { spawn, signals };
}

/**
 * A fake child whose stdout the test writes by hand and whose exit it resolves
 * by hand — the two things a drain-deadline test has to drive. stderr is a
 * closed empty pipe, so it drains immediately.
 */
function controllableSpawn(): {
  spawn: SpawnFn;
  writeStdout: (text: string) => void;
  closeStdout: () => void;
  exit: (code: number) => void;
} {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc: SpawnedSubprocess = {
    exitCode: null,
    exited,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    }),
    stderr: asReadableStream(""),
    stdin: null,
    kill() {},
  };
  return {
    spawn: () => proc,
    writeStdout: (text) => stdoutController.enqueue(new TextEncoder().encode(text)),
    closeStdout: () => stdoutController.close(),
    exit: (code) => {
      proc.exitCode = code;
      resolveExit(code);
    },
  };
}

/** Flush pending microtasks (fake timers never fire on their own). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("runManagedSubprocess — timeout escalation (SIGKILL ladder)", () => {
  test("a child that ignores SIGTERM is SIGKILLed after the grace timer", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    // pid-less fake → killGroup falls back to proc.kill() directly.
    const { spawn, signals } = killTrackingSpawn({ ignoreSigterm: true, exitOnKill: 137 });

    const promise = runManagedSubprocess(["hang"], {
      capture: true,
      timeoutMs: 100,
      spawnFn: spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Timer 0 is the main deadline; timer 1 is the stdout drain, timer 2 the
    // stderr drain. Fire the deadline → SIGTERM (ignored) + a scheduled SIGKILL.
    const deadline = timers.find((t) => t.ms === 100);
    expect(deadline).toBeDefined();
    deadline?.cb();
    expect(signals).toEqual(["SIGTERM"]);

    // The follow-up SIGKILL timer is the 5000 ms grace, and it is unref'ed.
    const graceTimer = timers.find((t) => t.ms === 5000);
    expect(graceTimer).toBeDefined();
    expect(graceTimer?.unrefCalled).toBe(true);
    graceTimer?.cb();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(137);
    expect(result.spawnError).toBeUndefined();
  });

  test("honours a custom graceMs for the SIGKILL follow-up", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const { spawn, signals } = killTrackingSpawn({ ignoreSigterm: true });

    const promise = runManagedSubprocess(["hang"], {
      capture: true,
      timeoutMs: 50,
      graceMs: 250,
      spawnFn: spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    timers.find((t) => t.ms === 50)?.cb();
    const graceTimer = timers.find((t) => t.ms === 250);
    expect(graceTimer).toBeDefined();
    graceTimer?.cb();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await promise;
  });
});

describe("runManagedSubprocess — abort", () => {
  test("aborting mid-run runs the ladder and flags aborted (not timedOut)", async () => {
    const { setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const { spawn, signals } = killTrackingSpawn({ exitOnKill: 143 });
    const controller = new AbortController();

    const promise = runManagedSubprocess(["hang"], {
      capture: true,
      timeoutMs: null,
      signal: controller.signal,
      spawnFn: spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Let the primitive register the abort listener, then abort. The fake dies
    // on the first (SIGTERM) signal, so the ladder completes immediately.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(signals[0]).toBe("SIGTERM");
    expect(result.exitCode).toBe(143);
  });

  test("a pre-aborted signal returns aborted without spawning", async () => {
    let spawnCalled = false;
    const spawn: SpawnFn = () => {
      spawnCalled = true;
      throw new Error("must not spawn");
    };
    const controller = new AbortController();
    controller.abort();

    const result = await runManagedSubprocess(["x"], {
      capture: true,
      timeoutMs: null,
      signal: controller.signal,
      spawnFn: spawn,
    });

    expect(result.aborted).toBe(true);
    expect(spawnCalled).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

describe("runManagedSubprocess — when the stream-drain deadline is armed", () => {
  const SAFETY_MS = 60 * 60 * 1000;
  /** The post-exit grace a bounded run's pipes get once nothing owns them. */
  const GRACE_MS = 2_000;

  test("a null timeout schedules NOTHING against a still-running child", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const child = controllableSpawn();

    const promise = runManagedSubprocess(["long-job"], {
      capture: true,
      timeoutMs: null,
      spawnFn: child.spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    child.writeStdout("before\n");
    await tick();
    // No kill timer (the caller asked for no budget) and no drain deadline: an
    // unbounded run must have no timer that could cancel a live child's reader,
    // which is the slot the old arm-at-capture safety bound occupied.
    expect(timers).toHaveLength(0);

    // So output written arbitrarily far past that old deadline still lands, and
    // the exit-0 verdict stands on the WHOLE artifact.
    child.writeStdout("after\n");
    child.closeStdout();
    child.exit(0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("before\nafter\n");
    expect(result.stdoutRead.timedOut).toBe(false);
  });

  test("the safety bound is armed by the child's EXIT, so a descendant cannot hold the drain open forever", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const child = controllableSpawn();

    const promise = runManagedSubprocess(["leader"], {
      capture: true,
      timeoutMs: null,
      spawnFn: child.spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    child.writeStdout("prefix");
    await tick();
    expect(timers).toHaveLength(0);

    // The leader exits 0 but stdout stays open — a background descendant still
    // holds the fd. THAT is what the safety bound exists to cut.
    child.exit(0);
    await tick();
    // One, not two: stderr drained before the exit, and a finished drain arms
    // no timer at all.
    const safety = timers.filter((timer) => timer.ms === SAFETY_MS);
    expect(safety).toHaveLength(1);
    safety[0]?.cb();

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdoutRead.timedOut).toBe(true);
    expect(result.stdout).toBe("prefix");
  });

  test("a bounded run arms its drain deadline when the CHILD EXITS, not at capture", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const child = controllableSpawn();

    const promise = runManagedSubprocess(["job"], {
      capture: true,
      timeoutMs: 30_000,
      spawnFn: child.spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    child.writeStdout("prefix");
    await tick();
    // The kill timer at the budget and nothing else: while the command runs,
    // its pipes are a live process's.
    expect(timers.filter((timer) => timer.ms === 30_000)).toHaveLength(1);
    expect(timers.filter((timer) => timer.ms === GRACE_MS)).toHaveLength(0);
    expect(timers.some((timer) => timer.ms === SAFETY_MS)).toBe(false);

    // The leader exits 0 in milliseconds but stdout stays open — a background
    // descendant holds the fd. The deadline is armed HERE, so the run cannot
    // stall for a 30 s budget it never came close to spending.
    child.exit(0);
    await tick();
    const drain = timers.filter((timer) => timer.ms === GRACE_MS);
    expect(drain).toHaveLength(1); // stderr drained before the exit; a finished drain arms nothing.
    drain[0]?.cb();

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdoutRead.timedOut).toBe(true);
    expect(result.stdout).toBe("prefix");
  });

  test("a bounded child that outlives its kill ladder still has its drain cut at budget + grace", async () => {
    const { timers, setTimeoutFn, clearTimeoutFn } = fakeTimers();
    const child = controllableSpawn();

    const promise = runManagedSubprocess(["wedged"], {
      capture: true,
      timeoutMs: 30_000,
      spawnFn: child.spawn,
      setTimeoutFn,
      clearTimeoutFn,
    });

    child.writeStdout("prefix");
    await tick();
    expect(timers.filter((timer) => timer.ms === GRACE_MS)).toHaveLength(0);

    // The budget expires with the child still running (this fake ignores its
    // signals). Waiting on an exit that may never come would leave the drain
    // unarmed forever, so the budget arms it too — landing on the same absolute
    // moment this path always had: budget + grace.
    timers.find((timer) => timer.ms === 30_000)?.cb();
    await tick();
    const drain = timers.filter((timer) => timer.ms === GRACE_MS);
    expect(drain).toHaveLength(1);
    drain[0]?.cb();

    child.exit(137);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.stdoutRead.timedOut).toBe(true);
    expect(result.stdout).toBe("prefix");
  });
});

describe("runManagedSubprocess — capture and failure surfacing", () => {
  test("captures stdout/stderr on a clean exit", async () => {
    const spawn: SpawnFn = () => ({
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: asReadableStream("out\n"),
      stderr: asReadableStream("err\n"),
      stdin: null,
      kill() {},
    });
    const result = await runManagedSubprocess(["echo"], { capture: true, timeoutMs: null, spawnFn: spawn });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.timedOut).toBe(false);
  });

  test("a synchronous spawn throw surfaces as spawnError, never a throw", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT: command not found");
    };
    const result = await runManagedSubprocess(["nope"], { capture: true, timeoutMs: null, spawnFn: spawn });
    expect(result.spawnError).toBeInstanceOf(Error);
    expect(result.spawnError?.message).toContain("ENOENT");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
  });

  test("a captured spawn asks for its own process group only where that is what the flag means", async () => {
    // On POSIX `detached` is setsid(), which is what makes killGroup's
    // negative-pid kill reach the whole tree. On Windows the same flag is
    // DETACHED_PROCESS — the child gets no console, a console host
    // (powershell.exe/cmd.exe) allocates its own and thereby replaces the
    // std handles it was handed, and every byte it writes goes to that
    // phantom console instead of our pipe. That is how a scheduled
    // `akm --version` logged exit_code=0 with both streams empty, while
    // killGroup gains nothing there (process.kill(-pid) is POSIX-only).
    expect(spawnsOwnProcessGroup("linux")).toBe(true);
    expect(spawnsOwnProcessGroup("darwin")).toBe(true);
    expect(spawnsOwnProcessGroup("win32")).toBe(false);

    // The WIRING, not just the predicate — asserted for a platform this test
    // host is not, which is the whole point: Windows is where it breaks and
    // nothing runs the unit suite there.
    expect(buildSpawnOptions({ capture: true }, "win32").detached).toBeUndefined();
    expect(buildSpawnOptions({ capture: true }, "linux").detached).toBe(true);
    expect(buildSpawnOptions({ capture: true }, "darwin").detached).toBe(true);
    // Captured Windows runs still pipe all three streams; only the group flag goes.
    expect(buildSpawnOptions({ capture: true }, "win32").stdout).toBe("pipe");
    expect(buildSpawnOptions({ capture: true }, "win32").stderr).toBe("pipe");
    // Interactive never asked for a group on any platform.
    expect(buildSpawnOptions({ capture: false }, "linux").detached).toBeUndefined();

    let detached: unknown = "unset";
    const spawn: SpawnFn = (_cmd, opts) => {
      detached = opts.detached;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("out\n"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    const result = await runManagedSubprocess(["echo"], { capture: true, timeoutMs: null, spawnFn: spawn });
    expect(result.stdout).toBe("out\n");
    // The live wiring must follow the helper on whichever platform runs this.
    expect(detached).toBe(spawnsOwnProcessGroup() ? true : undefined);
  });

  test("interactive (capture: false) does not read streams", async () => {
    let capturedStdout: unknown;
    const spawn: SpawnFn = (_cmd, opts) => {
      capturedStdout = opts.stdout;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("must-not-be-read"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    const result = await runManagedSubprocess(["tui"], { capture: false, timeoutMs: null, spawnFn: spawn });
    expect(capturedStdout).toBe("inherit");
    expect(result.stdout).toBe("");
  });
});

describe("runManagedSubprocess — termination-signal guard", () => {
  // #1230: the guard used to go in only after the spawn returned, so a SIGTERM or SIGINT that landed in between met
  // the default disposition: akm died and the new process group was left running.
  test.skipIf(!spawnsOwnProcessGroup())(
    "is in force before a captured child is spawned and gone once it exits",
    async () => {
      // The guard stands aside when anything else handles the signals, and the test preload does; lift its listeners.
      const signals = ["SIGTERM", "SIGINT"] as const;
      const saved = signals.map((signal) => [signal, process.listeners(signal)] as const);
      for (const signal of signals) process.removeAllListeners(signal);
      try {
        const atSpawn: number[] = [];
        const { spawn: exitingSpawn, ...ctl } = controllableSpawn();
        const spawn: SpawnFn = (cmd, options) => {
          atSpawn.push(...signals.map((signal) => process.listenerCount(signal)));
          return exitingSpawn(cmd, options);
        };
        const run = runManagedSubprocess(["harness"], { capture: true, timeoutMs: null, spawnFn: spawn });
        ctl.closeStdout();
        ctl.exit(0);
        await run;
        expect(atSpawn).toEqual([1, 1]);
        expect(signals.map((signal) => process.listenerCount(signal))).toEqual([0, 0]);
      } finally {
        for (const [signal, listeners] of saved) for (const listener of listeners) process.on(signal, listener);
      }
    },
  );
});
