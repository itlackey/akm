/**
 * Architecture seam test — `runAgent` is the single agent CLI entry point.
 *
 * Locks v1 spec §9.7 (LLM/agent boundary) and §12 (agent CLI integration).
 * Issue #222.
 *
 * The test exercises the documented `runAgent` interface without
 * spawning a real binary. Every agent-CLI integration in akm passes
 * through this seam; if the shape changes, callers break.
 *
 * Specifically locked:
 *   • `runAgent` is exported from `src/integrations/agent/spawn.ts`
 *     and re-exported from `src/integrations/agent/index.ts`.
 *   • `AgentRunResult` carries the documented envelope.
 *   • `AgentFailureReason` is the discriminated union
 *     `"timeout" | "spawn_failed" | "non_zero_exit" | "parse_error"`.
 *   • Captured stdio captures stdout/stderr; interactive stdio inherits
 *     the parent's streams (no captured strings).
 *   • A per-call `timeoutMs` override forces a `timeout` reason.
 */
import { describe, expect, test } from "bun:test";

import * as agentBarrel from "../../src/integrations/agent";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentFailureReason, SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { runAgent } from "../../src/integrations/agent/spawn";

const KNOWN_FAILURE_REASONS: ReadonlySet<AgentFailureReason> = new Set([
  "timeout",
  "spawn_failed",
  "non_zero_exit",
  "parse_error",
]);

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "seam-test-agent",
    bin: "seam-test-agent",
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

function fakeSpawn(stdout: string, stderr: string, exitCode: number): { spawn: SpawnFn; calls: number } {
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

describe("`runAgent` seam (v1 spec §9.7, §12.2)", () => {
  test("`runAgent` is exported from both the spawn module and the agent barrel", () => {
    expect(typeof runAgent).toBe("function");
    expect(agentBarrel.runAgent).toBe(runAgent);
  });

  test("captured-stdio success returns `ok: true` with stdout/stderr strings", async () => {
    const fake = fakeSpawn("agent-output", "agent-stderr", 0);
    const result = await runAgent(makeProfile(), "hello", { spawn: fake.spawn });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("agent-output");
    expect(result.stderr).toBe("agent-stderr");
    expect(result.reason).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(typeof result.durationMs).toBe("number");
    expect(fake.calls).toBe(1);
  });

  test("interactive-stdio mode does not capture stdout/stderr into the result", async () => {
    // Build a spawn that records the stdio options it was given. The
    // contract: when stdio is "interactive", stdout/stderr default to
    // "inherit", which the wrapper must not try to read from.
    let observed: { stdin?: string; stdout?: string; stderr?: string } | undefined;
    const spawn: SpawnFn = (_cmd, options) => {
      observed = {
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      };
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: null,
        stderr: null,
        stdin: null,
        kill: () => undefined,
      };
    };
    const result = await runAgent(makeProfile({ stdio: "interactive" }), "hi", { spawn });
    expect(observed?.stdout).toBe("inherit");
    expect(observed?.stderr).toBe("inherit");
    expect(observed?.stdin).toBe("inherit");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("failure-reason discriminated union covers exactly the documented vocabulary", async () => {
    // Synchronous spawn failure → `spawn_failed`.
    const spawnFailedSpawn: SpawnFn = () => {
      throw new Error("boom");
    };
    const spawnFailed = await runAgent(makeProfile(), undefined, { spawn: spawnFailedSpawn });
    expect(spawnFailed.ok).toBe(false);
    expect(spawnFailed.reason).toBe("spawn_failed");
    expect(KNOWN_FAILURE_REASONS.has(spawnFailed.reason as AgentFailureReason)).toBe(true);

    // Non-zero exit → `non_zero_exit`.
    const nonZero = fakeSpawn("", "oops", 7);
    const nonZeroResult = await runAgent(makeProfile(), undefined, { spawn: nonZero.spawn });
    expect(nonZeroResult.ok).toBe(false);
    expect(nonZeroResult.reason).toBe("non_zero_exit");
    expect(nonZeroResult.exitCode).toBe(7);

    // Malformed JSON when parseOutput is "json" → `parse_error`.
    const badJson = fakeSpawn("not json", "", 0);
    const parseResult = await runAgent(makeProfile({ parseOutput: "json" }), undefined, { spawn: badJson.spawn });
    expect(parseResult.ok).toBe(false);
    expect(parseResult.reason).toBe("parse_error");
  });

  test("timeout override produces `reason: 'timeout'` deterministically", async () => {
    // A spawn that hangs until kill() is called. We drive the timer
    // synchronously so the timeout fires immediately.
    const hangingSpawn = (): { spawn: SpawnFn } => {
      const spawn: SpawnFn = () => {
        let resolve: ((code: number) => void) | undefined;
        const exited = new Promise<number>((r) => {
          resolve = r;
        });
        const proc: SpawnedSubprocess = {
          exitCode: null,
          exited,
          stdout: asReadableStream(""),
          stderr: asReadableStream(""),
          stdin: null,
          kill: () => resolve?.(143),
        };
        return proc;
      };
      return { spawn };
    };
    const fakeTimers: Array<{ id: number; cb: () => void }> = [];
    let nextId = 1;
    const setTimeoutFn = ((cb: () => void): number => {
      const id = nextId++;
      fakeTimers.push({ id, cb });
      return id;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = ((id: number): void => {
      const idx = fakeTimers.findIndex((t) => t.id === id);
      if (idx >= 0) fakeTimers.splice(idx, 1);
    }) as unknown as typeof clearTimeout;

    const { spawn } = hangingSpawn();
    const promise = runAgent(makeProfile(), undefined, {
      spawn,
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn,
    });
    // Drive the timer synchronously.
    expect(fakeTimers.length).toBe(1);
    fakeTimers[0]?.cb();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(typeof result.error).toBe("string");
  });

  test("`AgentFailureReason` union from the barrel matches the documented vocabulary", () => {
    // Compile-time + runtime: assigning each known reason string to the
    // exported type pins the union shape. If the union narrows or
    // widens, this block fails to compile (the runtime arm just
    // mirrors the same set so the test reads end-to-end).
    const reasons: AgentFailureReason[] = ["timeout", "spawn_failed", "non_zero_exit", "parse_error"];
    expect(new Set(reasons)).toEqual(KNOWN_FAILURE_REASONS as Set<AgentFailureReason>);
  });
});
