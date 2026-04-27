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
    let timerCallback: (() => void) | undefined;
    const fakeSet = ((cb: () => void) => {
      timerCallback = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
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
    expect(timerCallback).toBeDefined();
    timerCallback?.();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.error).toContain("100ms");
  });

  test("real timeout against `bun -e` sleeping past the deadline (deterministic & fast)", async () => {
    const profile = makeProfile({ bin: "bun", args: ["-e", "await new Promise(r => setTimeout(r, 5000))"] });
    const start = Date.now();
    const result = await runAgent(profile, undefined, { timeoutMs: 250 });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    // Should bail well before the 5-second sleep would complete.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("runAgent — JSON parse mode", () => {
  test("parses JSON stdout and surfaces it via `parsed`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: '{"role":"agent"}' });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual({ role: "agent" });
  });

  test("malformed JSON yields `parse_error`", async () => {
    const { spawn } = fakeSpawnFn({ exitCode: 0, stdout: "not json {" });
    const result = await runAgent(makeProfile({ parseOutput: "json" }), "go", { spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parse_error");
    expect(result.error).toBeTruthy();
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
});
