/**
 * Tests for the agent CLI spawn wrapper (`runAgent`).
 *
 * Acceptance coverage:
 *   • Captured stdio collects stdout/stderr.
 *   • Hard timeout maps to `reason: "timeout"`.
 *   • Non-zero exit maps to `reason: "non_zero_exit"`.
 *   • Synchronous spawn failure maps to `reason: "spawn_failed"`.
 *   • Malformed JSON output (when `parseOutput: "json"`) maps to
 *     `reason: "parse_error"`.
 *   • Successful run returns `ok: true`, captured `stdout`, parsed JSON.
 *
 * The wrapper takes a `spawn` injection point so we never touch real
 * binaries here. Where we do touch a real subprocess (one fast `bun -e`
 * timeout test) we keep the timeout small and deterministic.
 */
import { describe, expect, test } from "bun:test";

import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { runAgent } from "../../src/integrations/agent/spawn";

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "test-agent",
    bin: "test-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function erroringReadableStream(text: string, error: Error): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(error);
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

interface FakeSubprocessConfig {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** When set, `proc.exited` only resolves once `kill()` is called. */
  hangsUntilKilled?: boolean;
  /** When set, throw synchronously from the spawn fn. */
  throwSync?: Error;
  /** When set, reject `proc.exited`. */
  rejectExit?: Error;
}

function fakeSpawnFn(config: FakeSubprocessConfig): { spawn: SpawnFn; kills: number } {
  const state = { kills: 0 };
  const spawn: SpawnFn = () => {
    if (config.throwSync) throw config.throwSync;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve, reject) => {
      resolveExit = resolve;
      if (config.rejectExit) {
        reject(config.rejectExit);
      } else if (!config.hangsUntilKilled) {
        resolve(config.exitCode);
      }
    });
    const proc: SpawnedSubprocess = {
      exitCode: config.hangsUntilKilled ? null : config.exitCode,
      exited,
      stdout: asReadableStream(config.stdout ?? ""),
      stderr: asReadableStream(config.stderr ?? ""),
      stdin: null,
      kill() {
        state.kills += 1;
        // Simulate process exit on signal.
        resolveExit(143);
      },
    };
    return proc;
  };
  return { spawn, kills: 0 } as { spawn: SpawnFn; kills: number };
}

describe("runAgent — captured stdio", () => {
  test("returns ok:true with stdout/stderr on exit 0", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: "hello\n", stderr: "" });
    const result = await runAgent(makeProfile(), "go", { spawn });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.reason).toBeUndefined();
    expect(typeof result.durationMs).toBe("number");
  });

  test("non-zero exit yields structured `non_zero_exit`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 7, stderr: "boom" });
    const result = await runAgent(makeProfile(), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("boom");
    expect(result.error).toContain("exited with code 7");
  });

  test("synchronous spawn failure yields `spawn_failed`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, throwSync: new Error("ENOENT: command not found") });
    const result = await runAgent(makeProfile(), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_failed");
    expect(result.error).toContain("ENOENT");
    expect(result.exitCode).toBeNull();
  });

  test("rejected proc.exited yields `spawn_failed`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, rejectExit: new Error("kernel ate it") });
    const result = await runAgent(makeProfile(), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_failed");
  });
});

describe("runAgent — timeout", () => {
  test("kills the subprocess and reports `timeout`", async () => {
    // Drive the timer manually so the assertion is deterministic.
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const fakeSet = ((cb: () => void, ms?: number) => {
      timers.push({ cb, ms: ms ?? 0 });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClear = (() => {}) as unknown as typeof clearTimeout;

    const { spawn } = fakeSpawnFn({ exitCode: 0, hangsUntilKilled: true });
    const promise = runAgent(makeProfile(), "go", {
      spawn,
      setTimeoutFn: fakeSet,
      clearTimeoutFn: fakeClear,
      timeoutMs: 100,
    });
    // Kick the deadline.
    const deadline = timers.find((t) => t.ms === 100);
    expect(deadline).toBeDefined();
    deadline?.cb();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.error).toContain("100ms");
  });

  test("real timeout against `bun -e` sleeping past the deadline (deterministic & fast)", async () => {
    const profile = makeProfile({ bin: "bun", args: ["-e", "await new Promise(r => setTimeout(r, 5000))"] });
    const result = await runAgent(profile, undefined, { timeoutMs: 250 });
    // The observable result proves the deadline fired: had the 250ms timeout
    // NOT aborted the child, runAgent would have waited the full 5s sleep and
    // returned ok:true (or a non-timeout reason). Asserting reason === "timeout"
    // is the deterministic signal — a wall-clock `elapsed < 2000` upper bound
    // only adds scheduler-dependent flake risk under a loaded CI box.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });
});

describe("runAgent — JSON parse mode", () => {
  test("parses JSON stdout and surfaces it via `parsed`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: '{"role":"agent"}' });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual({ role: "agent" });
  });

  test("recovers a top-level JSON array embedded in prose", async () => {
    // The old inline `{…}`-only scanner could not salvage a top-level array.
    // parseEmbeddedJsonResponse handles both objects and arrays.
    const { spawn } = fakeSpawnFn({
      exitCode: 0,
      stdout: 'Here are the results:\n[{"id":1},{"id":2}]\nDone.',
    });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("malformed JSON yields `parse_error`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: "not json {" });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parse_error");
    expect(result.error).toBeTruthy();
  });

  test("stdout read failure yields `spawn_failed`, not an empty parse_error", async () => {
    const spawn: SpawnFn = () => ({
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: erroringReadableStream('{"partial":', new Error("pipe broke")),
      stderr: asReadableStream(""),
      stdin: null,
      kill() {},
    });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_failed");
    expect(result.stdout).toBe('{"partial":');
    expect(result.error).toContain("stdout read failed");
    expect(result.error).toContain("pipe broke");
  });

  // ── #284 GAP-HIGH 10: parseOutput=json + non-zero exit + non-JSON stderr ──

  test("parseOutput=json + non-zero exit: non_zero_exit precedence (parse_error suppressed)", async () => {
    // Non-zero exit must surface as `non_zero_exit`, not `parse_error`, even
    // when the stdout/stderr payload is malformed JSON. The exit code is the
    // primary failure signal; parse failures are downstream of a successful run.
    const { spawn } = fakeSpawnFn({
      exitCode: 5,
      stdout: "not json {",
      stderr: "agent panic: kernel ate my JSON",
    });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toBe("agent panic: kernel ate my JSON");
    expect(result.parsed).toBeUndefined();
  });
});

// ── #284 GAP-HIGH 11: timeoutMs precedence ────────────────────────────────

describe("runAgent — timeoutMs authority", () => {
  test("the invocation timeout controls the spawned process deadline", async () => {
    const observedDeadlinesMs: number[] = [];
    let deadlineCallback: (() => void) | undefined;
    const fakeSet = ((cb: () => void, ms: number) => {
      observedDeadlinesMs.push(ms);
      if (ms === 250) deadlineCallback = cb;
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClear = (() => {}) as unknown as typeof clearTimeout;

    const { spawn } = fakeSpawnFn({ exitCode: 0, hangsUntilKilled: true });
    const promise = runAgent(makeProfile(), "go", {
      spawn,
      setTimeoutFn: fakeSet,
      clearTimeoutFn: fakeClear,
      timeoutMs: 250,
    });
    expect(observedDeadlinesMs).toContain(250); // override won
    deadlineCallback?.();
    const result = await promise;
    expect(result.reason).toBe("timeout");
  });
});

describe("runAgent — argument and env construction", () => {
  test("appends prompt after profile.args and options.args", async () => {
    let capturedCmd: string[] | undefined;
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream(""),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    await runAgent(makeProfile({ args: ["--profile-arg"] }), "the-prompt", { spawn, args: ["--call-arg"] });
    expect(capturedCmd).toEqual(["test-agent", "--profile-arg", "--call-arg", "the-prompt"]);
  });

  test("env is filtered by envPassthrough plus profile/options env", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const spawn: SpawnFn = (_cmd, opts) => {
      capturedEnv = opts.env;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream(""),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    await runAgent(makeProfile({ envPassthrough: ["KEEP_ME"], env: { PROFILE_VAR: "1" } }), undefined, {
      spawn,
      env: { CALL_VAR: "2" },
      envSource: { KEEP_ME: "yes", DROP_ME: "no" } as NodeJS.ProcessEnv,
    });
    expect(capturedEnv).toEqual({ KEEP_ME: "yes", PROFILE_VAR: "1", CALL_VAR: "2" });
  });

  // Regression: usage-event provenance (AKM_EVENT_SOURCE) must survive the
  // agent boundary. When a parent akm command already stamped it (e.g. the task
  // runner sets AKM_EVENT_SOURCE=task), a nested agent — such as the one
  // `akm wiki ingest` spawns — must inherit it so the agent's own akm reads log
  // as machine traffic, not user demand. Missing it from the built-in
  // envPassthrough whitelist silently inflated every lane's read-back (GRR).
  test("built-in profiles pass AKM_EVENT_SOURCE through to the spawned agent", async () => {
    const opencode = getBuiltinAgentProfile("opencode");
    if (!opencode) throw new Error("opencode built-in profile missing");
    expect(opencode.envPassthrough).toContain("AKM_EVENT_SOURCE");

    let capturedEnv: Record<string, string> | undefined;
    const spawn: SpawnFn = (_cmd, opts) => {
      capturedEnv = opts.env;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream(""),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    await runAgent(opencode, undefined, {
      spawn,
      envSource: { PATH: "/usr/bin", AKM_EVENT_SOURCE: "task" } as NodeJS.ProcessEnv,
    });
    expect(capturedEnv?.AKM_EVENT_SOURCE).toBe("task");
  });
});

describe("runAgent — cooperative abort (RunAgentOptions.signal, P0.5)", () => {
  test("pre-aborted signal returns reason 'aborted' without spawning", async () => {
    let spawnCalled = false;
    const spawn: SpawnFn = () => {
      spawnCalled = true;
      throw new Error("must not spawn");
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(makeProfile(), "task", { spawn, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(spawnCalled).toBe(false);
  });

  test("aborting mid-run kills the child and maps to reason 'aborted'", async () => {
    // Fake timers so the 5s SIGKILL follow-up never leaves a live timer.
    const fakeSet = ((cb: () => void) => {
      void cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClear = (() => {}) as unknown as typeof clearTimeout;

    const { spawn } = fakeSpawnFn({ exitCode: 0, hangsUntilKilled: true });
    const controller = new AbortController();
    const promise = runAgent(makeProfile(), "go", {
      spawn,
      setTimeoutFn: fakeSet,
      clearTimeoutFn: fakeClear,
      timeoutMs: null,
      signal: controller.signal,
    });
    // Let runAgent register the abort listener, then abort.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(result.error).toContain("aborted by caller signal");
  });

  test("timeout path unrefs the SIGKILL grace timer", async () => {
    type TimerHandle = {
      cb: () => void;
      unrefCalled: boolean;
      unref?: () => void;
    };
    const timers: TimerHandle[] = [];
    const setTimeoutFn = ((cb: () => void): TimerHandle => {
      const handle: TimerHandle = {
        cb,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
        },
      };
      timers.push(handle);
      return handle;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;

    const { spawn } = fakeSpawnFn({ exitCode: 0, hangsUntilKilled: true });
    const promise = runAgent(makeProfile(), "go", {
      spawn,
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(timers.length).toBe(3);
    // First timer is the main timeout. Fire it so the timeout branch schedules the SIGKILL grace timer.
    timers[0]?.cb();
    expect(timers.length).toBe(4);
    expect(timers[3]?.unrefCalled).toBe(true);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("abort path unrefs the SIGKILL grace timer", async () => {
    type TimerHandle = {
      cb: () => void;
      unrefCalled: boolean;
      unref?: () => void;
    };
    const timers: TimerHandle[] = [];
    const setTimeoutFn = ((cb: () => void): TimerHandle => {
      const handle: TimerHandle = {
        cb,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
        },
      };
      timers.push(handle);
      return handle;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;

    const { spawn } = fakeSpawnFn({ exitCode: 0, hangsUntilKilled: true });
    const controller = new AbortController();
    const promise = runAgent(makeProfile(), "go", {
      spawn,
      timeoutMs: null,
      setTimeoutFn,
      clearTimeoutFn,
      signal: controller.signal,
    });

    expect(timers.length).toBe(2);
    controller.abort();
    expect(timers.length).toBe(3);
    expect(timers[2]?.unrefCalled).toBe(true);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
  });

  test("a clean fast exit is not misreported when the signal aborts afterwards", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: "done" });
    const controller = new AbortController();
    const result = await runAgent(makeProfile(), "go", { spawn, signal: controller.signal });
    controller.abort(); // after completion — listener already removed
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("runAgent — cwd authority", () => {
  function captureSpawnOpts() {
    const captured: { cwd?: string }[] = [];
    const spawn: SpawnFn = (_argv, opts) => {
      captured.push({ cwd: (opts as { cwd?: string } | undefined)?.cwd });
      return {
        exitCode: null,
        exited: Promise.resolve(0),
        stdout: asReadableStream(""),
        stderr: asReadableStream(""),
        pid: 1234,
        kill() {},
      } as unknown as SpawnedSubprocess;
    };
    return { spawn, captured };
  }

  test("does not invent a cwd when options.cwd is absent", async () => {
    const { spawn, captured } = captureSpawnOpts();
    await runAgent(makeProfile({ name: "claude", bin: "claude" }), undefined, {
      spawn,
      dispatch: { prompt: "go" },
    });
    expect(captured[0]?.cwd).toBeUndefined();
  });

  test("options.cwd is the sole cwd authority", async () => {
    const { spawn, captured } = captureSpawnOpts();
    await runAgent(makeProfile({ name: "claude", bin: "claude" }), undefined, {
      spawn,
      cwd: "/tmp/options-wins",
      dispatch: { prompt: "go" },
    });
    expect(captured[0]?.cwd).toBe("/tmp/options-wins");
  });
});
