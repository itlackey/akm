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
  EVENTS_READ_CAP_BYTES,
  parseTokenUsage,
  type RunOptions,
  readRunEvents,
  runOne,
  stripAkmStashDir,
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
    expect(result.tokenMeasurement).toBe("parsed");
  });

  test("tokenMeasurement: parsed when stdout reports tokens", async () => {
    const { spawn } = scriptedSpawn({
      exitCode: 0,
      stdout: "ok\ninput_tokens: 10 output_tokens: 5",
    });
    const result = await runOne({ ...baseOptions, workspace, spawn });
    expect(result.outcome).toBe("pass");
    expect(result.tokenMeasurement).toBe("parsed");
    expect(result.tokens.input).toBe(10);
    expect(result.tokens.output).toBe(5);
  });

  test("tokenMeasurement: missing when stdout has no token line — and budget is NOT enforced", async () => {
    // Agent never reports tokens. budgetTokens is 1, but the harness must not
    // mark this as budget_exceeded (issue #252) — measurement is missing.
    const { spawn } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
    const result = await runOne({ ...baseOptions, workspace, spawn, budgetTokens: 1 });
    expect(result.tokenMeasurement).toBe("missing");
    expect(result.tokens).toEqual({ input: 0, output: 0 });
    expect(result.outcome).not.toBe("budget_exceeded");
  });

  test("tokenMeasurement: harness_error path leaves measurement as 'missing'", async () => {
    const { spawn } = scriptedSpawn({ exitCode: 0, throwSync: new Error("ENOENT") });
    const result = await runOne({ ...baseOptions, workspace, spawn });
    expect(result.outcome).toBe("harness_error");
    // No agent stdout was ever observed → measurement stays at the default.
    expect(result.tokenMeasurement).toBe("missing");
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

  // ── #261: synthetic-arm AKM_STASH_DIR isolation ─────────────────────────────

  test("synthetic arm: child env never carries AKM_STASH_DIR (recurrence guard for #243 fixup)", async () => {
    // CRITICAL: synthetic-arm runs MUST NOT carry AKM_STASH_DIR. Without
    // this guard the operator's real AKM_STASH_DIR leaks in via parent-env
    // inheritance — exactly the failure mode the #243 fixup chased. We
    // exercise both the explicit-stashDir case (bad caller passes one
    // anyway) and the no-stashDir case.
    const operatorStash = "/tmp/operator-stash-must-never-leak-into-synthetic";
    const prior = process.env.AKM_STASH_DIR;
    process.env.AKM_STASH_DIR = operatorStash;
    try {
      // 1) Synthetic arm with NO stashDir option: AKM_STASH_DIR must be
      //    absent in the child env.
      const { spawn, invocations } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      await runOne({
        ...baseOptions,
        workspace,
        arm: "synthetic",
        spawn,
      });
      const childEnv1 = invocations[0]?.env ?? {};
      expect(childEnv1.AKM_STASH_DIR).toBeUndefined();
      expect(childEnv1.AKM_STASH_DIR).not.toBe(operatorStash);

      // 2) Even when a buggy caller forwards a stashDir to the synthetic
      //    arm, the driver MUST refuse to wire it into the child env.
      const { spawn: spawn2, invocations: invocations2 } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      await runOne({
        ...baseOptions,
        workspace,
        arm: "synthetic",
        stashDir: "/tmp/buggy-caller-stash",
        spawn: spawn2,
      });
      const childEnv2 = invocations2[0]?.env ?? {};
      expect(childEnv2.AKM_STASH_DIR).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = prior;
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

  test("stripAkmStashDir deletes AKM_STASH_DIR in place (#261 synthetic-arm guard)", () => {
    const env: Record<string, string | undefined> = {
      AKM_STASH_DIR: "/tmp/operator-stash",
      XDG_CACHE_HOME: "/tmp/cache",
    };
    const result = stripAkmStashDir(env);
    expect(result).toBe(env); // mutates in place + returns same ref
    expect(env.AKM_STASH_DIR).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBe("/tmp/cache"); // siblings untouched
    // No-op on env without AKM_STASH_DIR.
    const env2: Record<string, string | undefined> = { XDG_CACHE_HOME: "/tmp/cache" };
    stripAkmStashDir(env2);
    expect(env2).toEqual({ XDG_CACHE_HOME: "/tmp/cache" });
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

  test("parseTokenUsage extracts numbers when present, missing otherwise", () => {
    // No matchable token line at all → measurement is "missing", not a real zero (issue #252).
    expect(parseTokenUsage("")).toEqual({ input: 0, output: 0, measurement: "missing" });
    expect(parseTokenUsage("noise")).toEqual({ input: 0, output: 0, measurement: "missing" });
    // Both keys present → "parsed" with the actual numbers.
    expect(parseTokenUsage("input_tokens: 123 output_tokens: 456")).toEqual({
      input: 123,
      output: 456,
      measurement: "parsed",
    });
    // Only one key present → still "parsed", missing key defaults to 0.
    expect(parseTokenUsage("input_tokens: 99")).toEqual({ input: 99, output: 0, measurement: "parsed" });
    expect(parseTokenUsage("output_tokens: 55")).toEqual({ input: 0, output: 55, measurement: "parsed" });
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

  test("readRunEvents caps reads at EVENTS_READ_CAP_BYTES and records a warning when exceeded", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-events-cap-"));
    try {
      const akm = path.join(tmp, "akm");
      fs.mkdirSync(akm, { recursive: true });
      const eventsPath = path.join(akm, "events.jsonl");
      // Write a leading parseable record, then a giant filler line that
      // pushes total size past the cap.
      const firstLine = `${JSON.stringify({ schemaVersion: 1, ts: "2026-04-27T00:00:00Z", eventType: "feedback" })}\n`;
      const fd = fs.openSync(eventsPath, "w");
      try {
        fs.writeSync(fd, firstLine);
        // Filler line: a single very long line that — combined with the
        // first — exceeds the cap. We cap at 16MiB so write 17MiB of 'x'.
        const fillerSize = EVENTS_READ_CAP_BYTES + 1024 * 1024;
        const chunk = Buffer.alloc(64 * 1024, "x".charCodeAt(0));
        let written = 0;
        while (written < fillerSize) {
          const remaining = fillerSize - written;
          const toWrite = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
          fs.writeSync(fd, toWrite);
          written += toWrite.length;
        }
        fs.writeSync(fd, "\n");
      } finally {
        fs.closeSync(fd);
      }
      const totalSize = fs.statSync(eventsPath).size;
      expect(totalSize).toBeGreaterThan(EVENTS_READ_CAP_BYTES);

      const warnings: string[] = [];
      const events = readRunEvents(tmp, { warnings });
      // The first parseable record should still be returned from the prefix.
      expect(events.length).toBe(1);
      expect(events[0]?.eventType).toBe("feedback");
      // A warning was appended that mentions the cap and the actual size.
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("events.jsonl truncated");
      expect(warnings[0]).toContain(String(EVENTS_READ_CAP_BYTES));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
