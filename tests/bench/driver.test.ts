/**
 * Unit tests for the bench driver — exercises every RunResult outcome
 * (`pass`, `fail`, `budget_exceeded`, `harness_error`) via an injected fake
 * spawn. Real opencode is never invoked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import {
  _ISOLATED_ENV_NAMES,
  buildIsolatedEnv,
  createIsolationDirs,
  parseTokenUsage,
  type RunOptions,
  readRunEvents,
  runOne,
} from "./driver";

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface FakeAgent {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  hangsUntilKilled?: boolean;
  throwSync?: Error;
}

interface FakeVerifier {
  exitCode: number;
  stdout?: string;
}

interface ScriptedSpawn {
  spawn: SpawnFn;
  /** Agent invocations that the fake observed, captured for assertions. */
  invocations: Array<{ cmd: string[]; env: Record<string, string> | undefined }>;
}

/**
 * Build a spawn fn that scripts the agent run first, then any subsequent
 * verifier run. Distinguishes by command: opencode is the configured `bin`
 * for the built-in opencode profile (i.e. cmd[0] === "opencode"); anything
 * else is a verifier.
 */
function scriptedSpawn(agent: FakeAgent, verifier?: FakeVerifier): ScriptedSpawn {
  const invocations: ScriptedSpawn["invocations"] = [];
  const spawn: SpawnFn = (cmd, options) => {
    invocations.push({ cmd, env: options.env });
    const isAgent = cmd[0] === "opencode";
    const config = isAgent ? agent : (verifier ?? { exitCode: 0, stdout: "" });
    if (isAgent && agent.throwSync) throw agent.throwSync;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
      if (!(isAgent && agent.hangsUntilKilled)) resolve(config.exitCode);
    });
    const proc: SpawnedSubprocess = {
      exitCode: isAgent && agent.hangsUntilKilled ? null : config.exitCode,
      exited,
      stdout: asReadableStream(config.stdout ?? ""),
      stderr: asReadableStream((config as FakeAgent).stderr ?? ""),
      stdin: null,
      kill() {
        // Honour kill so timeout path resolves cleanly.
        resolveExit(143);
      },
    };
    return proc;
  };
  return { spawn, invocations };
}

const baseOptions: Omit<RunOptions, "spawn"> = {
  track: "utility",
  arm: "noakm",
  taskId: "_example/example-task",
  workspace: "",
  model: "anthropic/claude-opus-4-7",
  seed: 0,
  budgetTokens: 100000,
  budgetWallMs: 60_000,
  verifier: "regex",
  taskDir: "",
  expectedMatch: "ok",
};

describe("runOne", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bench-driver-test-"));
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test("pass: agent exits 0, verifier exits 0", async () => {
    const { spawn, invocations } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
    const result = await runOne({ ...baseOptions, workspace, spawn });
    expect(result.outcome).toBe("pass");
    expect(result.verifierExitCode).toBe(0);
    expect(result.taskId).toBe("_example/example-task");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.seed).toBe(0);
    expect(result.schemaVersion).toBe(1);
    expect(invocations[0]?.cmd[0]).toBe("opencode");
  });

  test("fail: agent exits 0 but verifier rejects output", async () => {
    const { spawn } = scriptedSpawn({ exitCode: 0, stdout: "nope" });
    const result = await runOne({ ...baseOptions, workspace, spawn });
    expect(result.outcome).toBe("fail");
    expect(result.verifierExitCode).toBe(1);
  });

  test("budget_exceeded: agent times out (runAgent reason: timeout)", async () => {
    const { spawn } = scriptedSpawn({ exitCode: 0, hangsUntilKilled: true });
    const result = await runOne({
      ...baseOptions,
      workspace,
      spawn,
      // Tiny budget so the timer fires before the fake agent ever exits.
      budgetWallMs: 50,
    });
    expect(result.outcome).toBe("budget_exceeded");
  });

  test("harness_error: agent spawn throws synchronously", async () => {
    const { spawn } = scriptedSpawn({ exitCode: 0, throwSync: new Error("ENOENT") });
    const result = await runOne({ ...baseOptions, workspace, spawn });
    expect(result.outcome).toBe("harness_error");
  });

  test("budget_exceeded: parsed token usage exceeds budgetTokens", async () => {
    // Agent reports 70k input + 50k output = 120k tokens, budget is 100k.
    // Verifier should NOT run; outcome must be budget_exceeded.
    const { spawn } = scriptedSpawn({
      exitCode: 0,
      stdout: "input_tokens: 70000 output_tokens: 50000",
    });
    const result = await runOne({
      ...baseOptions,
      workspace,
      spawn,
      budgetTokens: 100_000,
    });
    expect(result.outcome).toBe("budget_exceeded");
    expect(result.tokens.input + result.tokens.output).toBeGreaterThan(100_000);
    expect(result.tokens.input).toBe(70_000);
    expect(result.tokens.output).toBe(50_000);
  });

  test("isolation: child env carries pinned XDG/OPENCODE/AKM dirs and not operator values", async () => {
    const sentinel = "/tmp/operator-config-must-not-leak";
    const priors: Record<string, string | undefined> = {};
    for (const name of _ISOLATED_ENV_NAMES) {
      priors[name] = process.env[name];
      process.env[name] = sentinel;
    }
    try {
      const { spawn, invocations } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      await runOne({
        ...baseOptions,
        workspace,
        stashDir: "/tmp/some-stash",
        arm: "akm",
        spawn,
      });
      const childEnv = invocations[0]?.env ?? {};
      // Each isolated key MUST be present and MUST NOT equal the operator sentinel.
      for (const name of _ISOLATED_ENV_NAMES) {
        expect(childEnv[name]).toBeDefined();
        expect(childEnv[name]).not.toBe(sentinel);
      }
      expect(childEnv.AKM_STASH_DIR).toBe("/tmp/some-stash");
      expect(childEnv.BENCH_OPENCODE_MODEL).toBe("anthropic/claude-opus-4-7");
    } finally {
      for (const name of _ISOLATED_ENV_NAMES) {
        if (priors[name] === undefined) delete process.env[name];
        else process.env[name] = priors[name];
      }
    }
  });
});

describe("driver helpers", () => {
  test("createIsolationDirs creates four dirs under a single root", () => {
    const dirs = createIsolationDirs();
    try {
      expect(fs.existsSync(dirs.cacheHome)).toBe(true);
      expect(fs.existsSync(dirs.configHome)).toBe(true);
      expect(fs.existsSync(dirs.opencodeConfig)).toBe(true);
      expect(dirs.cacheHome.startsWith(dirs.root)).toBe(true);
    } finally {
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test("buildIsolatedEnv pins the four isolation keys plus model", () => {
    const dirs = createIsolationDirs("/tmp/stash");
    try {
      const env = buildIsolatedEnv(dirs, "model-x");
      expect(env.XDG_CACHE_HOME).toBe(dirs.cacheHome);
      expect(env.XDG_CONFIG_HOME).toBe(dirs.configHome);
      expect(env.OPENCODE_CONFIG).toBe(dirs.opencodeConfig);
      expect(env.AKM_STASH_DIR).toBe("/tmp/stash");
      expect(env.BENCH_OPENCODE_MODEL).toBe("model-x");
    } finally {
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test("parseTokenUsage extracts numbers when present, zero otherwise", () => {
    expect(parseTokenUsage("")).toEqual({ input: 0, output: 0 });
    expect(parseTokenUsage("noise")).toEqual({ input: 0, output: 0 });
    expect(parseTokenUsage("input_tokens: 123 output_tokens: 456")).toEqual({ input: 123, output: 456 });
  });

  test("readRunEvents returns [] when events.jsonl is missing and parses lines when present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-events-"));
    try {
      expect(readRunEvents(tmp)).toEqual([]);
      const akm = path.join(tmp, "akm");
      fs.mkdirSync(akm, { recursive: true });
      fs.writeFileSync(
        path.join(akm, "events.jsonl"),
        `${JSON.stringify({ schemaVersion: 1, ts: "2026-04-27T00:00:00Z", eventType: "feedback" })}\n`,
      );
      const events = readRunEvents(tmp);
      expect(events.length).toBe(1);
      expect(events[0]?.eventType).toBe("feedback");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
