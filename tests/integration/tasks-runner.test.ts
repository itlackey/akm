import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTaskRunId, openLogsDatabase, queryTaskLogs, type TaskLogRow } from "../../src/core/logs-db";
import { createMigrationBackup } from "../../src/core/migration-backup";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import type { AgentRunResult } from "../../src/integrations/agent";
import { resolveAkmInvocation } from "../../src/tasks/resolve-akm-bin";
import { exitCodeForStatus, readTaskHistory, runTask } from "../../src/tasks/runner";
import { withEnv } from "../_helpers/sandbox";

type FakeWorkflowRunner = (
  ref: string,
  params?: Record<string, unknown>,
) => Promise<{
  run: {
    id: string;
    workflowRef: string;
    workflowTitle: string;
    status: "active" | "completed" | "blocked" | "failed";
    params: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    currentStepId: string | null;
  };
  workflow: { ref: string; title: string; steps: [] };
}>;

type FakeRunAgent = (...args: unknown[]) => Promise<AgentRunResult>;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-runner-"));
const stashDir = path.join(tmpRoot, "stash");
const cacheDir = path.join(tmpRoot, "cache");
const dataDir = path.join(tmpRoot, "data");
const stateDir = path.join(tmpRoot, "state");
const logDir = path.join(cacheDir, "tasks", "logs");
const tasksDir = path.join(stashDir, "tasks");
const configDir = path.join(tmpRoot, "cfg");

const TRACKED_ENV_KEYS = ["AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_STASH_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR"];
const PRESERVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TRACKED_ENV_KEYS) PRESERVED_ENV[key] = process.env[key];
  fs.rmSync(stashDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  // Workflows directory needs to exist so resolveAssetPath can stat the type root.
  fs.mkdirSync(path.join(stashDir, "workflows"), { recursive: true });
  // Point state.db to an isolated data dir so tests don't share history.
  process.env.AKM_DATA_DIR = dataDir;
  process.env.AKM_CONFIG_DIR = configDir;
  process.env.AKM_CACHE_DIR = cacheDir;
  // Pair AKM_STASH_DIR with AKM_STATE_DIR so the test-isolation guard in
  // src/core/paths.ts (getDataDir) stays inert.
  process.env.AKM_STATE_DIR = stateDir;
  createMigrationBackup();
});

afterEach(() => {
  for (const key of TRACKED_ENV_KEYS) {
    if (PRESERVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = PRESERVED_ENV[key];
    }
  }
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTask(id: string, body: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), body, "utf8");
}

/** Read this run's logs.db rows (the runner writes them via persistRunLog). */
function readRunLogRows(taskId: string): TaskLogRow[] {
  const db = openLogsDatabase();
  try {
    return queryTaskLogs(db, { taskId });
  } finally {
    db.close();
  }
}

function emptyReadableStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

interface FakeTimer {
  cb: () => void;
  ms: number;
  fired: boolean;
  unref?: () => void;
}

/** Collect timers so a test can fire the kill ladder deterministically. */
function collectTimers() {
  const timers: FakeTimer[] = [];
  const setTimeoutFn = ((cb: () => void, ms?: number): FakeTimer => {
    const handle: FakeTimer = { cb, ms: ms ?? 0, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
  return { timers, setTimeoutFn, clearTimeoutFn };
}

/** Yield the event loop until a timer for `ms` is registered, then fire it. */
async function fireWhenRegistered(timers: FakeTimer[], ms: number): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const timer = timers.find((t) => t.ms === ms && !t.fired);
    if (timer) {
      timer.fired = true;
      timer.cb();
      return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timer for ${ms}ms never registered`);
}

describe("runTask — workflow target", () => {
  test("dispatches to startWorkflowRun and writes log + history to state.db", async () => {
    writeTask("wf", ["version: 2", 'schedule: "@daily"', "workflow: workflows/noop", ""].join("\n"));
    const calls: Array<{ ref: string; params: Record<string, unknown> }> = [];
    const fakeWf: FakeWorkflowRunner = async (ref, params = {}) => {
      calls.push({ ref, params });
      return {
        run: {
          id: "run-id-1",
          workflowRef: ref,
          workflowTitle: "Noop",
          status: "completed",
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        workflow: { ref, title: "Noop", steps: [] },
      };
    };

    const result = await runTask("wf", {
      stashDir,
      logDir,
      startWorkflowRunImpl: fakeWf as never,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(calls).toEqual([{ ref: "workflows/noop", params: {} }]);
    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "workflow", ref: "workflows/noop" });
    expect(result.detail?.runId).toBe("run-id-1");

    const logExists = fs.existsSync(result.log);
    expect(logExists).toBe(true);

    const rows = readTaskHistory({ id: "wf" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("wf");
    expect(rows[0]!.status).toBe("completed");
  });

  // M4: mapWorkflowStatus is now an exhaustive switch over WorkflowRunStatus
  // with an assertNever default (no silent `default: "completed"`). Lock in the
  // exact output for every runtime status so the explicit mapping provably
  // reproduces the previous behaviour for all known statuses.
  const STATUS_CASES = [
    { wf: "completed", expected: "completed" },
    { wf: "blocked", expected: "blocked" },
    { wf: "failed", expected: "failed" },
    { wf: "active", expected: "active" },
  ] as const;
  for (const { wf, expected } of STATUS_CASES) {
    test(`maps workflow run status "${wf}" → task status "${expected}"`, async () => {
      writeTask("map", ["version: 2", 'schedule: "@daily"', "workflow: workflows/noop", ""].join("\n"));
      const fakeWf: FakeWorkflowRunner = async (ref, params = {}) => ({
        run: {
          id: "run-map",
          workflowRef: ref,
          workflowTitle: "Noop",
          status: wf,
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: null,
          currentStepId: null,
        },
        workflow: { ref, title: "Noop", steps: [] },
      });

      const result = await runTask("map", {
        stashDir,
        logDir,
        startWorkflowRunImpl: fakeWf as never,
        now: () => new Date("2025-01-01T00:00:00Z"),
      });

      expect(result.status).toBe(expected);
    });
  }
});

describe("runTask — 0.8 command target", () => {
  test("runs a nested akm command with a stripped scheduler PATH", async () => {
    writeTask("legacy-self", 'schedule: "@daily"\ncommand: akm --version\nenabled: true\n');

    const result = await withEnv({ PATH: "/usr/bin:/bin" }, () => runTask("legacy-self", { stashDir, logDir }));

    expect(result.status).toBe("completed");
    expect(result.detail?.exitCode).toBe(0);
    expect(fs.readFileSync(result.log, "utf8")).toContain("0.9.0");
  });

  test.skipIf(process.platform === "win32")(
    "resolves only the command position after env options and assignments",
    async () => {
      writeTask(
        "legacy-env-self",
        [
          'schedule: "@daily"',
          `command: ${JSON.stringify(["env", "--unset", "akm", "MODE=fast", "akm", "--version"])}`,
          "enabled: true",
          "",
        ].join("\n"),
      );

      const result = await withEnv({ PATH: "/usr/bin:/bin" }, () => runTask("legacy-env-self", { stashDir, logDir }));

      expect(result.status).toBe("completed");
      expect(result.detail?.exitCode).toBe(0);
      expect(fs.readFileSync(result.log, "utf8")).toContain("0.9.0");
    },
  );

  test("executes an explicitly selected akm path without replacing it", async () => {
    const vendorDir = path.join(tmpRoot, "vendor");
    const executable = path.join(vendorDir, process.platform === "win32" ? "akm.exe" : "akm");
    fs.mkdirSync(vendorDir, { recursive: true });
    try {
      fs.linkSync(process.execPath, executable);
    } catch {
      fs.copyFileSync(process.execPath, executable);
    }
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    writeTask(
      "explicit-akm",
      [
        'schedule: "@daily"',
        `command: ${JSON.stringify([executable, "-e", 'console.log("explicit vendor akm")'])}`,
        "",
      ].join("\n"),
    );

    const result = await runTask("explicit-akm", { stashDir, logDir });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("explicit vendor akm");
  });

  test("uses the platform temp directory when HOME is absent", async () => {
    const fallbackDir = path.join(tmpRoot, "command-cwd");
    fs.mkdirSync(fallbackDir, { recursive: true });
    writeTask(
      "portable-cwd",
      [
        "version: 2",
        'schedule: "@daily"',
        `command: ${JSON.stringify([process.execPath, "-e", "console.log('cwd=' + process.cwd())"])}`,
        "",
      ].join("\n"),
    );

    const result = await withEnv({ HOME: undefined, TMPDIR: fallbackDir, TEMP: fallbackDir, TMP: fallbackDir }, () =>
      runTask("portable-cwd", { stashDir, logDir }),
    );

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain(`cwd=${fallbackDir}`);
  });

  test("a command that ignores SIGTERM is SIGKILLed on timeout, logging timed_out + exit 143", async () => {
    writeTask(
      "stubborn",
      ['schedule: "@daily"', "command: hang-forever", "timeoutMs: 100", "enabled: true", ""].join("\n"),
    );

    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const signals: string[] = [];
    // A child that swallows SIGTERM: only SIGKILL resolves its exit. Proves the
    // runner now escalates (old inline path signalled SIGTERM once and hung).
    const spawnFn: SpawnFn = () => {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const proc: SpawnedSubprocess = {
        exitCode: null,
        exited,
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill(signal?: number | string) {
          const name = String(signal);
          signals.push(name);
          if (name === "SIGTERM") return; // ignored — force the SIGKILL rung
          resolveExit(143);
        },
      };
      return proc;
    };

    const promise = runTask("stubborn", { stashDir, logDir, spawnFn, setTimeoutFn, clearTimeoutFn });
    await fireWhenRegistered(timers, 100); // deadline → SIGTERM (ignored)
    await fireWhenRegistered(timers, 5000); // grace → SIGKILL → child exits 143
    const result = await promise;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.status).toBe("failed");
    expect(result.detail?.exitCode).toBe(143);
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain("timed_out=true timeout_ms=100");
    expect(log).toContain("exit_code=143");
  });

  test("does not fall back to PATH when a bare self-invocation cannot be resolved", async () => {
    writeTask("unresolved-self", 'schedule: "@daily"\ncommand: akm --version\nenabled: true\n');
    const execPath = process.execPath;

    try {
      process.execPath = "";
      await expect(withEnv({ PATH: "" }, () => runTask("unresolved-self", { stashDir, logDir }))).rejects.toThrow(
        "Cannot resolve absolute path to the akm binary",
      );
    } finally {
      process.execPath = execPath;
    }
  });
});

describe("runTask — prompt target", () => {
  test("resolves agent model aliases once and marks the dispatched model exact", async () => {
    writeTask(
      "aliased",
      ["version: 2", 'schedule: "@daily"', "prompt: review", "engine: reviewer", "model: premium", ""].join("\n"),
    );
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          reviewer: {
            kind: "agent",
            platform: "opencode",
            modelAliases: { premium: "provider/exact-model" },
          },
        },
        defaults: { engine: "reviewer" },
      }),
    );
    let dispatched: { model?: string; modelIsExact?: boolean } | undefined;

    await runTask("aliased", {
      stashDir,
      logDir,
      runAgentImpl: async (profile) => {
        dispatched = { model: profile.model, modelIsExact: profile.modelIsExact };
        return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      },
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(dispatched).toEqual({ model: "provider/exact-model", modelIsExact: true });
  });

  test("dispatches an LLM prompt task through its selected engine", async () => {
    writeTask(
      "llm",
      ["version: 2", 'schedule: "@daily"', "prompt: answer briefly", "engine: fast", "model: qwen3-small", ""].join(
        "\n",
      ),
    );
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          fast: {
            kind: "llm",
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "qwen3",
          },
        },
        defaults: { engine: "fast", llmEngine: "fast" },
      }),
    );
    const seen: { model?: string; prompt?: string } = {};

    const result = await runTask("llm", {
      stashDir,
      logDir,
      chatCompletionImpl: async (connection, messages) => {
        seen.model = connection.model;
        seen.prompt = messages[0]?.content;
        return "complete";
      },
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "prompt", engine: "fast" });
    expect(seen).toEqual({ model: "qwen3-small", prompt: "answer briefly" });
  });

  test("dispatches to runAgent (mocked) and writes captured stdout to the log", async () => {
    writeTask("prompt", ["version: 2", 'schedule: "@daily"', "prompt: say hello", "engine: opencode", ""].join("\n"));

    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const prompt = args[1] as string;
      return {
        ok: true,
        exitCode: 0,
        stdout: `agent received: ${prompt}`,
        stderr: "",
        durationMs: 12,
      };
    };

    // The prompt task resolves this named agent engine before dispatch.
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const result = await runTask("prompt", {
      stashDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "prompt", engine: "opencode" });
    expect(fs.readFileSync(result.log, "utf8")).toContain("agent received: say hello");

    const rows = readTaskHistory({ id: "prompt" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toEqual({ kind: "prompt", engine: "opencode" });

    // #579: the same run is queryable from logs.db by task_id AND run_id,
    // with the captured agent stdout stored as stream='stdout' rows.
    const logRows = readRunLogRows("prompt");
    expect(logRows.length).toBeGreaterThan(0);
    const runId = buildTaskRunId("prompt", result.startedAt);
    expect(logRows.every((row) => row.run_id === runId)).toBe(true);
    const stdoutRows = logRows.filter((row) => row.stream === "stdout" && row.level === "info");
    expect(stdoutRows.map((row) => row.line)).toContain("agent received: say hello");
    // ...and no stray "--- agent stdout ---" file markers leak into the DB.
    expect(logRows.some((row) => row.line.startsWith("---"))).toBe(false);

    const db = openLogsDatabase();
    try {
      expect(queryTaskLogs(db, { runId })).toHaveLength(logRows.length);
    } finally {
      db.close();
    }
  });

  test("lowers a prompt-task model through the selected agent engine aliases exactly once", async () => {
    writeTask(
      "agent-model",
      ["version: 2", 'schedule: "@daily"', "prompt: review this", "engine: reviewer", "model: fast", ""].join("\n"),
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          reviewer: {
            kind: "agent",
            platform: "opencode",
            modelAliases: { fast: "provider/exact-model" },
          },
        },
        defaults: { engine: "reviewer" },
      }),
    );
    let captured: { model?: string; modelIsExact?: boolean } = {};

    const result = await runTask("agent-model", {
      stashDir,
      logDir,
      runAgentImpl: async (profile) => {
        captured = { model: profile.model, modelIsExact: profile.modelIsExact };
        return { ok: true, exitCode: 0, stdout: "reviewed", stderr: "", durationMs: 1 };
      },
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(captured).toEqual({ model: "provider/exact-model", modelIsExact: true });
  });

  test("redacts echoed agent credentials before task logs are persisted", async () => {
    const sentinel = "TASK-ECHO-SENTINEL";
    writeTask("redacted", ["version: 2", 'schedule: "@daily"', "prompt: say hello", "engine: opencode", ""].join("\n"));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const result = await withEnv({ AKM_CONFIG_DIR: configDir, OPENCODE_API_KEY: sentinel }, () =>
      runTask("redacted", {
        stashDir,
        logDir,
        runAgentImpl: async () => ({
          ok: true,
          exitCode: 0,
          stdout: `echo ${sentinel}`,
          stderr: "",
          durationMs: 1,
        }),
        now: () => new Date("2025-01-01T00:00:00Z"),
      }),
    );

    const durable = fs.readFileSync(result.log, "utf8") + JSON.stringify(readRunLogRows("redacted"));
    expect(durable).not.toContain(sentinel);
    expect(durable).toContain("[REDACTED]");
  });

  test("agent failure surfaces as failed status with reason", async () => {
    writeTask("fail", ["version: 2", 'schedule: "@daily"', "prompt: boom", "engine: opencode", ""].join("\n"));

    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const fakeRunAgent: FakeRunAgent = async () => {
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "boom",
        durationMs: 12,
        reason: "non_zero_exit",
        error: "agent CLI exited with code 2",
      };
    };

    const result = await runTask("fail", {
      stashDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });
    expect(result.status).toBe("failed");
    expect(result.detail?.reason).toBe("non_zero_exit");
    expect(exitCodeForStatus(result.status)).toBe(1);

    // #579: failure diagnostics land in logs.db with level='error', and the
    // captured agent stderr is recorded as stream='stderr'.
    const logRows = readRunLogRows("fail");
    const errorRows = logRows.filter((row) => row.level === "error");
    expect(errorRows.some((row) => row.line.includes("non_zero_exit"))).toBe(true);
    expect(errorRows.filter((row) => row.stream === "stderr").map((row) => row.line)).toContain("boom");
  });
});

describe("runTask — disabled tasks", () => {
  test("manual invocation dispatches an intentionally disabled task", async () => {
    writeTask("off", ["version: 2", 'schedule: "@daily"', "workflow: workflows/noop", "enabled: false", ""].join("\n"));
    let called = false;
    const fakeWf: FakeWorkflowRunner = async (ref, params = {}) => {
      called = true;
      return {
        run: {
          id: "manual-disabled",
          workflowRef: ref,
          workflowTitle: "Manual disabled run",
          status: "completed",
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        workflow: { ref, title: "Manual disabled run", steps: [] },
      };
    };

    const result = await runTask("off", {
      stashDir,
      logDir,
      startWorkflowRunImpl: fakeWf as never,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(called).toBe(true);
    expect(result.status).toBe("completed");
  });

  test("scheduler-generated invocation is recorded but not dispatched", async () => {
    writeTask("off", ["version: 2", 'schedule: "@daily"', "workflow: workflows/noop", "enabled: false", ""].join("\n"));
    let called = false;
    const fakeWf = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const result = await runTask("off", {
      stashDir,
      logDir,
      startWorkflowRunImpl: fakeWf as never,
      now: () => new Date("2025-01-01T00:00:00Z"),
      scheduled: true,
    });
    expect(called).toBe(false);
    expect(result.status).toBe("disabled");
    expect(exitCodeForStatus(result.status)).toBe(0);

    // #579: even a skipped run leaves a queryable trace in logs.db.
    const logRows = readRunLogRows("off");
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.line).toContain("disabled");
    expect(logRows[0]!.run_id).toBe(buildTaskRunId("off", result.startedAt));
  });
});

describe("resolveAkmInvocation", () => {
  function packageLauncher(packageRoot: string): string {
    const fixtureDir = path.join(packageRoot, "dist");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"akm-cli"}\n');
    const launcher = path.join(fixtureDir, "akm");
    fs.writeFileSync(launcher, "#!/usr/bin/env node\n");
    return launcher;
  }

  test("binds a package owned by the active npm global root, including paths with spaces", () => {
    const globalRoot = path.join(tmpRoot, "npm prefix with spaces", "lib", "node_modules");
    const launcher = packageLauncher(path.join(globalRoot, "akm-cli"));
    const r = resolveAkmInvocation({
      env: {},
      runtime: "node",
      execPath: "/usr/bin/node",
      launcherPath: launcher,
      nodePath: "/usr/bin/node",
      resolveNpmGlobalRoot: () => globalRoot,
    });
    expect(r).toEqual({ argv: ["/usr/bin/node", launcher], via: "npm", kind: "npm", eligible: true });
  });

  test("classifies a project-local node_modules package as ineligible", () => {
    const launcher = packageLauncher(path.join(tmpRoot, "project", "node_modules", "akm-cli"));
    const globalRoot = path.join(tmpRoot, "global", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath: "/usr/bin/node",
        resolveNpmGlobalRoot: () => globalRoot,
      }),
    ).toEqual({
      argv: ["/usr/bin/node", launcher],
      via: "package-local",
      kind: "package-local",
      eligible: false,
    });
  });

  test("classifies an npm exec cache package as ineligible", () => {
    const launcher = packageLauncher(path.join(tmpRoot, ".npm", "_npx", "abc123", "node_modules", "akm-cli"));
    const globalRoot = path.join(tmpRoot, "global-cache-case", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });

    const result = resolveAkmInvocation({
      env: {},
      runtime: "node",
      launcherPath: launcher,
      nodePath: "/usr/bin/node",
      resolveNpmGlobalRoot: () => globalRoot,
    });

    expect(result.kind).toBe("package-local");
    expect(result.eligible).toBe(false);
  });

  test("fails closed when npm global-root resolution is unavailable", () => {
    const launcher = packageLauncher(path.join(tmpRoot, "unresolved-package", "akm-cli"));
    const nodePath = path.join(tmpRoot, "node-without-npm", "bin", "node");
    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath,
      }),
    ).toMatchObject({ argv: [nodePath, launcher], via: "package-local", kind: "package-local", eligible: false });
  });

  test("accepts an npm global package under an NVM-style prefix", () => {
    const prefix = path.join(tmpRoot, ".nvm", "versions", "node", "v22.14.0");
    const nodePath = path.join(prefix, "bin", "node");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const launcher = packageLauncher(path.join(globalRoot, "akm-cli"));

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath,
        resolveNpmGlobalRoot: (bootstrapNode) => {
          expect(bootstrapNode).toBe(nodePath);
          return globalRoot;
        },
      }),
    ).toEqual({ argv: [nodePath, launcher], via: "npm", kind: "npm", eligible: true });
  });

  test("classifies a source CLI invocation as checkout-only", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "/usr/bin/bun",
      mainPath: path.resolve(import.meta.dir, "../../src/cli.ts"),
    });
    expect(r).toEqual({
      argv: ["/usr/bin/bun", path.resolve(import.meta.dir, "../../src/cli.ts")],
      via: "checkout",
      kind: "checkout",
      eligible: false,
    });
  });

  test("uses cli-node.mjs rather than dist/cli.js for a direct Node checkout", () => {
    const dist = path.join(tmpRoot, "node-checkout", "dist");
    const tasks = path.join(dist, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    const modulePath = path.join(tasks, "resolve-akm-bin.js");
    const cliPath = path.join(dist, "cli.js");
    const wrapperPath = path.join(dist, "cli-node.mjs");
    fs.writeFileSync(modulePath, "");
    fs.writeFileSync(cliPath, "");
    fs.writeFileSync(wrapperPath, "");

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        execPath: "/usr/bin/node",
        mainPath: cliPath,
        cliEntryUrl: pathToFileURL(modulePath).href,
      }),
    ).toEqual({
      argv: ["/usr/bin/node", wrapperPath],
      via: "checkout",
      kind: "checkout",
      eligible: false,
    });
  });

  test("refuses a direct Node checkout when cli-node.mjs is unavailable", () => {
    const dist = path.join(tmpRoot, "node-checkout-missing-wrapper", "dist");
    const tasks = path.join(dist, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    const modulePath = path.join(tasks, "resolve-akm-bin.js");
    const cliPath = path.join(dist, "cli.js");
    fs.writeFileSync(modulePath, "");
    fs.writeFileSync(cliPath, "");

    expect(() =>
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        execPath: "/usr/bin/node",
        mainPath: cliPath,
        cliEntryUrl: pathToFileURL(modulePath).href,
      }),
    ).toThrow("Cannot resolve absolute path");
  });

  test("reports the removed AKM_BIN scheduler override with migration guidance", () => {
    expect(() =>
      resolveAkmInvocation({
        env: { AKM_BIN: "/opt/vendor/akm" },
        runtime: "bun",
        execPath: "/usr/bin/bun",
        mainPath: path.resolve(import.meta.dir, "../../src/cli.ts"),
      }),
    ).toThrow("npm-global or standalone launcher; run `akm tasks sync --rebind`");
  });

  test("uses only the executable for a Bun standalone build", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "/opt/akm",
      mainPath: "/$bunfs/root/src/cli.ts",
    });
    expect(r).toEqual({ argv: ["/opt/akm"], via: "standalone", kind: "standalone", eligible: true });
  });

  test("uses only the executable for a Windows Bun standalone build", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "D:\\akm\\akm.exe",
      mainPath: "B:\\~BUN\\root\\src\\cli.ts",
    });
    expect(r).toEqual({
      argv: ["D:\\akm\\akm.exe"],
      via: "standalone",
      kind: "standalone",
      eligible: true,
    });
  });
});
