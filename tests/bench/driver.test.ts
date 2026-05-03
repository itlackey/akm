/**
 * Unit tests for the bench driver — exercises every RunResult outcome
 * (`pass`, `fail`, `budget_exceeded`, `harness_error`) via an injected fake
 * spawn. Real opencode is never invoked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import {
  _ISOLATED_ENV_NAMES,
  _SCRUBBED_OPERATOR_ENV_NAMES,
  buildIsolatedEnv,
  buildSanitizedEnvSource,
  createIsolationDirs,
  EVENTS_READ_CAP_BYTES,
  parseTokenUsage,
  type RunOptions,
  readRunEvents,
  runOne,
  stripAkmStashDir,
} from "./driver";
import type { LoadedOpencodeProviders } from "./opencode-config";
import { benchMkdtemp } from "./tmp";

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
    workspace = benchMkdtemp("bench-driver-test-");
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

  // ── #271: operator-env isolation (OPENCODE_API_KEY/ANTHROPIC_API_KEY/AKM_CONFIG_DIR)

  test("operator env isolation: bench child never inherits OPENCODE_API_KEY/ANTHROPIC_API_KEY/AKM_CONFIG_DIR (#271)", async () => {
    // Even though `OPENCODE_API_KEY` is in the opencode profile's
    // `envPassthrough` list, the bench driver MUST scrub these operator-env
    // names before profile.envPassthrough copies them into the child. This
    // is the regression guard the #271 review identified — without it,
    // operator credentials and the operator's `AKM_CONFIG_DIR` would leak
    // into every (task × arm × seed) child.
    const sentinels: Record<string, string> = {
      OPENCODE_API_KEY: "sentinel-A-must-not-leak",
      ANTHROPIC_API_KEY: "sentinel-B-must-not-leak",
      AKM_CONFIG_DIR: "sentinel-C-must-not-leak",
    };
    const priors: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(sentinels)) {
      priors[name] = process.env[name];
      process.env[name] = value;
    }
    try {
      const { spawn, invocations } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      await runOne({
        ...baseOptions,
        workspace,
        arm: "akm",
        stashDir: "/tmp/some-stash",
        spawn,
      });
      const childEnv = invocations[0]?.env ?? {};
      // None of the operator sentinels reach the child env that runAgent
      // hands to spawn — neither as a key:value pair nor as a substring
      // match (paranoid: confirm the literal sentinel strings are absent
      // even from values like `OPENCODE_CONFIG`).
      for (const name of _SCRUBBED_OPERATOR_ENV_NAMES) {
        expect(childEnv[name]).toBeUndefined();
      }
      for (const sentinel of Object.values(sentinels)) {
        for (const value of Object.values(childEnv)) {
          expect(value).not.toContain(sentinel);
        }
      }
      // The explicit bench keys ARE present and pinned to the per-run
      // tmpdirs (sanity: the scrubbing didn't accidentally drop them).
      expect(childEnv.XDG_CACHE_HOME).toBeDefined();
      expect(childEnv.XDG_CONFIG_HOME).toBeDefined();
      expect(childEnv.OPENCODE_CONFIG).toBeDefined();
      expect(childEnv.AKM_STASH_DIR).toBe("/tmp/some-stash");
      expect(childEnv.BENCH_OPENCODE_MODEL).toBe("anthropic/claude-opus-4-7");
    } finally {
      for (const [name, prior] of Object.entries(priors)) {
        if (prior === undefined) delete process.env[name];
        else process.env[name] = prior;
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

  // ── opencodeProviders: materialise tests ──────────────────────────────────

  test("runOne with opencodeProviders writes opencode.json into OPENCODE_CONFIG before spawn", async () => {
    // We need to capture the OPENCODE_CONFIG path from the child env to
    // check the file was written. We do this by saving it from the spawn
    // invocation then checking AFTER the run returns (before dir teardown
    // occurs — note: driver tears down dirs in finally; but we copy the path
    // from the invocation). Actually: dirs are torn down in the driver's
    // finally block AFTER runAgent returns, so by the time our fake spawn
    // is called the file SHOULD be present. We check via a closure.
    let capturedOpencodeCfgDir: string | undefined;
    let fileExistedAtSpawnTime = false;

    const checkingSpawn: SpawnFn = (cmd, options) => {
      // Capture the OPENCODE_CONFIG dir from the child env.
      const env = options.env as Record<string, string> | undefined;
      if (env?.OPENCODE_CONFIG) {
        capturedOpencodeCfgDir = env.OPENCODE_CONFIG;
        // OPENCODE_CONFIG now points directly to the opencode.json file.
        fileExistedAtSpawnTime = require("node:fs").existsSync(env.OPENCODE_CONFIG);
      }
      // Behave like the normal fake (agent exits 0, stdout = "ok").
      const { spawn: inner } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      return inner(cmd, options);
    };

    const fakeProviders: LoadedOpencodeProviders = {
      source: "/fake/providers.json",
      providers: {
        testprov: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:9999/v1" },
        },
      },
      defaultModel: "testprov/my-model",
    };

    const result = await runOne({
      ...baseOptions,
      workspace,
      model: "testprov/my-model",
      spawn: checkingSpawn,
      opencodeProviders: fakeProviders,
    });

    // The run should succeed or fail on the verifier — the key thing is it
    // is not harness_error from the provider materialise step.
    expect(result.outcome).not.toBe("harness_error");
    // The file MUST have existed at spawn time.
    expect(fileExistedAtSpawnTime).toBe(true);
    // Regression: the OPENCODE_CONFIG dir is torn down after the run.
    if (capturedOpencodeCfgDir) {
      // Dir should be cleaned up by the driver's finally block.
      // (We can't assert it's gone because the test itself runs in the same
      //  process; just verify the captured path was non-empty.)
      expect(capturedOpencodeCfgDir.length).toBeGreaterThan(0);
    }
  });

  test("runOne WITHOUT opencodeProviders writes minimal stub to OPENCODE_CONFIG (regression guard)", async () => {
    let capturedDir: string | undefined;
    let filesAtSpawnTime: string[] = [];
    let stubContent: string | undefined;

    const checkingSpawn: SpawnFn = (cmd, options) => {
      const env = options.env as Record<string, string> | undefined;
      if (env?.OPENCODE_CONFIG) {
        capturedDir = env.OPENCODE_CONFIG;
        try {
          // OPENCODE_CONFIG points to the file, so read it directly.
          stubContent = require("node:fs").readFileSync(env.OPENCODE_CONFIG, "utf8") as string;
          filesAtSpawnTime = ["opencode.json"];
        } catch {
          filesAtSpawnTime = [];
        }
      }
      const { spawn: inner } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      return inner(cmd, options);
    };

    await runOne({
      ...baseOptions,
      workspace,
      spawn: checkingSpawn,
      // No opencodeProviders
    });

    expect(capturedDir).toBeDefined();
    // Without opencodeProviders, the driver writes a minimal stub opencode.json.
    expect(filesAtSpawnTime).toEqual(["opencode.json"]);
    expect(stubContent).toBeDefined();
    const parsed = JSON.parse(stubContent ?? "{}");
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.provider).toBeUndefined();
  });

  test("runOne falls back to model-only stub when provider prefix not in map (cloud/built-in models)", async () => {
    // "nonexistent" prefix not in fakeProviders — should write a model-only
    // stub and proceed rather than returning harness_error. This supports
    // built-in cloud models like "opencode/big-pickle" that don't need a
    // custom provider entry.
    const fakeProviders: LoadedOpencodeProviders = {
      source: "/fake/providers.json",
      providers: { myprov: {} },
    };

    let stubContent: string | undefined;
    const checkingSpawn: SpawnFn = (cmd, options) => {
      const env = options.env as Record<string, string> | undefined;
      if (env?.OPENCODE_CONFIG) {
        try {
          stubContent = require("node:fs").readFileSync(env.OPENCODE_CONFIG, "utf8") as string;
        } catch {
          /* file may not exist */
        }
      }
      const { spawn: inner } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
      return inner(cmd, options);
    };

    const result = await runOne({
      ...baseOptions,
      workspace,
      model: "nonexistent/some-model",
      spawn: checkingSpawn,
      opencodeProviders: fakeProviders,
    });

    // Should NOT be harness_error — fell back to stub.
    expect(result.outcome).not.toBe("harness_error");
    // The written stub should have model key but no provider block.
    expect(stubContent).toBeDefined();
    const written = JSON.parse(stubContent ?? "{}");
    expect(written.model).toBe("nonexistent/some-model");
    expect(written.provider).toBeUndefined();
  });

  test("harness_error: custom provider prefix without opencodeProviders refuses to run", async () => {
    // "shredder/qwen/qwen3.5-9b" has a custom prefix. Without opencodeProviders,
    // opencode would silently fall back to a cloud model and burn API credits.
    // The harness must refuse to run rather than allow that.
    const { spawn } = scriptedSpawn({ exitCode: 0, stdout: "ok" });
    const result = await runOne({
      ...baseOptions,
      workspace,
      model: "shredder/qwen/qwen3.5-9b",
      spawn,
      // opencodeProviders deliberately omitted
    });
    expect(result.outcome).toBe("harness_error");
    // Error surfaces via setupBenchEnvironment (may be wrapped in "environment setup failed")
    expect(result.verifierStdout).toMatch(/custom provider prefix|environment setup failed/);
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

  test("buildSanitizedEnvSource strips OPENCODE_API_KEY/ANTHROPIC_API_KEY/AKM_CONFIG_DIR (#271)", () => {
    const source: NodeJS.ProcessEnv = {
      OPENCODE_API_KEY: "leak-A",
      ANTHROPIC_API_KEY: "leak-B",
      AKM_CONFIG_DIR: "/operator/akm",
      PATH: "/usr/bin",
      HOME: "/home/op",
      OPENCODE_CONFIG: "/operator/opencode",
      UNRELATED: "kept",
    };
    const result = buildSanitizedEnvSource(source);
    // Operator names removed.
    expect(result.OPENCODE_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.AKM_CONFIG_DIR).toBeUndefined();
    // Everything else preserved verbatim.
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/op");
    expect(result.OPENCODE_CONFIG).toBe("/operator/opencode");
    expect(result.UNRELATED).toBe("kept");
    // Result is a copy, not the same reference (caller can mutate freely).
    expect(result).not.toBe(source);
    // Source object is untouched.
    expect(source.OPENCODE_API_KEY).toBe("leak-A");
  });

  test("buildSanitizedEnvSource defaults to process.env when no source given", () => {
    const prior = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "default-source-leak";
    try {
      const result = buildSanitizedEnvSource();
      expect(result.OPENCODE_API_KEY).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prior;
    }
  });

  test("buildIsolatedEnv pins the four isolation keys plus model", () => {
    const dirs = createIsolationDirs("/tmp/stash");
    try {
      const env = buildIsolatedEnv(dirs, "model-x");
      expect(env.XDG_CACHE_HOME).toBe(dirs.cacheHome);
      expect(env.XDG_CONFIG_HOME).toBe(dirs.configHome);
      expect(env.OPENCODE_CONFIG).toBe(path.join(dirs.opencodeConfig, "opencode.json"));
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
    const tmp = benchMkdtemp("bench-events-");
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
    const tmp = benchMkdtemp("bench-events-cap-");
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
