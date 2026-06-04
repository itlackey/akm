import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunResult } from "../src/integrations/agent";
import { resolveAkmInvocation } from "../src/tasks/resolveAkmBin";
import { exitCodeForStatus, readTaskHistory, runTask } from "../src/tasks/runner";

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
  // Pair AKM_STASH_DIR with AKM_STATE_DIR so the test-isolation guard in
  // src/core/paths.ts (getDataDir) stays inert.
  process.env.AKM_STATE_DIR = stateDir;
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

describe("runTask — workflow target", () => {
  test("dispatches to startWorkflowRun and writes log + history to state.db", async () => {
    writeTask("wf", ['schedule: "@daily"', "workflow: workflow:noop", ""].join("\n"));
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

    expect(calls).toEqual([{ ref: "workflow:noop", params: {} }]);
    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "workflow", ref: "workflow:noop" });
    expect(result.detail?.runId).toBe("run-id-1");

    const logExists = fs.existsSync(result.log);
    expect(logExists).toBe(true);

    const rows = readTaskHistory({ id: "wf" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("wf");
    expect(rows[0].status).toBe("completed");
  });
});

describe("runTask — prompt target", () => {
  test("dispatches to runAgent (mocked) and writes captured stdout to the log", async () => {
    writeTask("prompt", ['schedule: "@daily"', "prompt: say hello", "profile: opencode", ""].join("\n"));

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

    // We need a config with an agent block so requireAgentProfile succeeds.
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ agent: { default: "opencode" } }));

    const result = await runTask("prompt", {
      stashDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "prompt", profile: "opencode" });
    expect(fs.readFileSync(result.log, "utf8")).toContain("agent received: say hello");

    const rows = readTaskHistory({ id: "prompt" });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toEqual({ kind: "prompt", profile: "opencode" });
  });

  test("agent failure surfaces as failed status with reason", async () => {
    writeTask("fail", ['schedule: "@daily"', "prompt: boom", "profile: opencode", ""].join("\n"));

    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ agent: { default: "opencode" } }));

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
  });
});

describe("runTask — disabled tasks no-op", () => {
  test("disabled task is recorded but not dispatched", async () => {
    writeTask("off", ['schedule: "@daily"', "workflow: workflow:noop", "enabled: false", ""].join("\n"));
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
    });
    expect(called).toBe(false);
    expect(result.status).toBe("disabled");
    expect(exitCodeForStatus(result.status)).toBe(0);
  });
});

describe("resolveAkmInvocation", () => {
  test("AKM_BIN takes precedence", () => {
    const r = resolveAkmInvocation({ env: { AKM_BIN: "/abs/akm" } });
    expect(r).toEqual({ argv: ["/abs/akm"], via: "AKM_BIN" });
  });
});
