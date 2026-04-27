/**
 * Unit tests for the K-seed runner.
 *
 * The runner is exercised end-to-end with an injected fake spawn so no real
 * opencode binary is required. We assert:
 *   • Cardinality: tasks × arms × seeds RunResults are produced.
 *   • Workspace isolation: each (arm, seed) sees a fresh cwd.
 *   • Cleanup: tmp dirs are torn down on success and failure.
 *   • Trajectory splice: goldRef + tool-call output produces the right boolean.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import type { TaskMetadata } from "./corpus";
import { runUtility } from "./runner";

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawnFactory(
  agentStdoutByArm: { noakm?: string; akm?: string } = {},
  options: { agentExitCode?: number; verifierExitCode?: number; verifierStdout?: string } = {},
): { spawn: SpawnFn; observed: { cmd: string[]; cwd?: string; armSeen: ("noakm" | "akm")[] } } {
  const observed = { cmd: [] as string[], cwd: undefined as string | undefined, armSeen: [] as ("noakm" | "akm")[] };
  let lastArmCacheHome: string | undefined;
  const spawn: SpawnFn = (cmd, opts) => {
    observed.cmd = cmd;
    observed.cwd = opts.cwd;
    const isAgent = cmd[0] === "opencode";
    let arm: "noakm" | "akm" = "noakm";
    if (isAgent) {
      arm = opts.env?.AKM_STASH_DIR ? "akm" : "noakm";
      observed.armSeen.push(arm);
      lastArmCacheHome = opts.env?.XDG_CACHE_HOME;
    }
    const stdout = isAgent
      ? ((arm === "akm" ? agentStdoutByArm.akm : agentStdoutByArm.noakm) ?? "")
      : (options.verifierStdout ?? "");
    const exitCode = isAgent ? (options.agentExitCode ?? 0) : (options.verifierExitCode ?? 0);

    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(""),
      stdin: null,
      kill() {},
    };

    // For akm-arm runs, drop a synthetic events.jsonl into the cache home so
    // the trajectory parser sees a feedback event when the test wants one.
    if (isAgent && arm === "akm" && lastArmCacheHome && agentStdoutByArm.akm?.includes("FEEDBACK")) {
      const akmDir = path.join(lastArmCacheHome, "akm");
      fs.mkdirSync(akmDir, { recursive: true });
      fs.writeFileSync(
        path.join(akmDir, "events.jsonl"),
        `${JSON.stringify({ schemaVersion: 1, ts: "2026-04-27T00:00:00Z", eventType: "feedback", ref: "skill:foo" })}\n`,
      );
    }

    return proc;
  };
  return { spawn, observed };
}

function fakeTask(taskDir: string, overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: "fake/task-a",
    title: "Fake task",
    domain: "fake",
    difficulty: "easy",
    stash: "minimal",
    verifier: "regex",
    expectedMatch: "ok",
    budget: { tokens: 1000, wallMs: 5000 },
    taskDir,
    ...overrides,
  };
}

describe("runUtility", () => {
  let workspaceRoot: string;
  let taskDir: string;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-test-"));
    taskDir = path.join(workspaceRoot, "task-a");
    fs.mkdirSync(taskDir, { recursive: true });
    // No workspace template — runs start with empty cwd, which is valid.
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("produces tasks × arms × seeds run records (cardinality)", async () => {
    const { spawn, observed } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    const report = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm", "akm"],
      model: "test-model",
      seedsPerArm: 3,
      spawn,
      materialiseStash: false,
      branch: "test-branch",
      commit: "abc123",
      timestamp: "2026-04-27T00:00:00Z",
    });
    expect(report.tasks.length).toBe(1);
    // 3 seeds × 2 arms = 6 agent invocations.
    expect(observed.armSeen.length).toBe(6);
    expect(observed.armSeen.filter((a) => a === "akm").length).toBe(3);
    expect(observed.armSeen.filter((a) => a === "noakm").length).toBe(3);

    // Per-task aggregates were filled.
    const t = report.tasks[0];
    expect(t).toBeDefined();
    expect(t?.noakm.count).toBe(3);
    expect(t?.akm.count).toBe(3);
    expect(t?.noakm.passRate).toBe(1); // verifier exitCode 0 → pass
    expect(t?.akm.passRate).toBe(1);
  });

  test("workspace isolation: each run gets a fresh cwd", async () => {
    const cwds = new Set<string>();
    const spawn: SpawnFn = (cmd, opts) => {
      if (cmd[0] === "opencode" && opts.cwd) cwds.add(opts.cwd);
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("ok"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    const report = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 2,
      spawn,
      materialiseStash: false,
    });
    expect(report.tasks.length).toBe(1);
    // 2 seeds × 2 arms = 4 unique cwds.
    expect(cwds.size).toBe(4);
  });

  test("cleanup: workspace tmp dirs are removed after each run", async () => {
    const cwdsObserved = new Set<string>();
    const spawn: SpawnFn = (cmd, opts) => {
      if (cmd[0] === "opencode" && opts.cwd) cwdsObserved.add(opts.cwd);
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("ok"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm"],
      model: "test",
      seedsPerArm: 2,
      spawn,
      materialiseStash: false,
    });
    expect(cwdsObserved.size).toBe(2);
    for (const cwd of cwdsObserved) {
      expect(fs.existsSync(cwd)).toBe(false);
    }
  });

  test("cleanup happens even when verifier reports failure (workspace still removed)", async () => {
    const cwdsObserved = new Set<string>();
    const spawn: SpawnFn = (cmd, opts) => {
      if (cmd[0] === "opencode" && opts.cwd) cwdsObserved.add(opts.cwd);
      const isAgent = cmd[0] === "opencode";
      const exitCode = isAgent ? 0 : 1;
      return {
        exitCode,
        exited: Promise.resolve(exitCode),
        stdout: asReadableStream(isAgent ? "nope" : ""),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    const report = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm"],
      model: "test",
      seedsPerArm: 2,
      spawn,
      materialiseStash: false,
    });
    expect(report.tasks[0]?.noakm.passRate).toBe(0);
    for (const cwd of cwdsObserved) {
      expect(fs.existsSync(cwd)).toBe(false);
    }
  });

  test("trajectory splice: correctAssetLoaded + feedbackRecorded fill from akm-arm runs", async () => {
    const akmStdout = "tool: akm show skill:foo\nFEEDBACK emitted\n";
    const { spawn } = fakeSpawnFactory({ noakm: "ok", akm: akmStdout });
    const report = await runUtility({
      tasks: [fakeTask(taskDir, { goldRef: "skill:foo" })],
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 2,
      spawn,
      materialiseStash: false,
    });
    expect(report.trajectoryAkm.correctAssetLoaded).toBe(1);
    expect(report.trajectoryAkm.feedbackRecorded).toBe(1);
  });

  test("workspace template files are copied into per-run cwd", async () => {
    // Drop a sentinel file into the task's workspace/ template.
    const wsTemplate = path.join(taskDir, "workspace");
    fs.mkdirSync(wsTemplate, { recursive: true });
    fs.writeFileSync(path.join(wsTemplate, "marker.txt"), "hello");
    const seenContents: string[] = [];
    const spawn: SpawnFn = (cmd, opts) => {
      if (cmd[0] === "opencode" && opts.cwd) {
        const p = path.join(opts.cwd, "marker.txt");
        if (fs.existsSync(p)) seenContents.push(fs.readFileSync(p, "utf8"));
      }
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("ok"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    try {
      await runUtility({
        tasks: [fakeTask(taskDir)],
        arms: ["noakm"],
        model: "test",
        seedsPerArm: 1,
        spawn,
        materialiseStash: false,
      });
      expect(seenContents).toEqual(["hello"]);
    } finally {
      fs.rmSync(wsTemplate, { recursive: true, force: true });
    }
  });

  test("default seedsPerArm is 5", async () => {
    const { spawn, observed } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm"],
      model: "test",
      spawn,
      materialiseStash: false,
    });
    expect(observed.armSeen.length).toBe(5);
  });

  test("multi-task: each task lands in tasks[] in input order", async () => {
    const { spawn } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    const taskA = fakeTask(taskDir, { id: "alpha/x", domain: "alpha" });
    const taskB = fakeTask(taskDir, { id: "beta/y", domain: "beta" });
    const report = await runUtility({
      tasks: [taskA, taskB],
      arms: ["noakm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
    });
    expect(report.tasks.map((t) => t.id)).toEqual(["alpha/x", "beta/y"]);
    expect(report.corpus.domains).toBe(2);
    expect(report.corpus.tasks).toBe(2);
  });
});
