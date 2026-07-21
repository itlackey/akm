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
 */
import { describe, expect, test } from "bun:test";
import { runManagedSubprocess, type SpawnedSubprocess, type SpawnFn } from "../../src/core/subprocess";

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
