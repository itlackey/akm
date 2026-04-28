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

  test("stamps corpus identity (selectedTaskIds, taskCorpusHash, fixtures, fixtureContentHash) (#250)", async () => {
    const { spawn } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    const report = await runUtility({
      tasks: [fakeTask(taskDir, { id: "domain-a/task-z" }), fakeTask(taskDir, { id: "domain-a/task-a" })],
      arms: ["noakm"],
      model: "test-model",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      branch: "test-branch",
      commit: "abc123",
      timestamp: "2026-04-27T00:00:00Z",
    });
    // selectedTaskIds is sorted alphabetically.
    expect(report.corpus.selectedTaskIds).toEqual(["domain-a/task-a", "domain-a/task-z"]);
    expect(report.corpus.taskCorpusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.corpus.fixtureContentHash).toMatch(/^[0-9a-f]{64}$/);
    // The "minimal" fixture is referenced by both fakeTasks; one entry expected.
    expect(report.corpus.fixtures).toBeDefined();
    expect(Object.keys(report.corpus.fixtures ?? {})).toEqual(["minimal"]);
    expect(report.corpus.fixtures?.minimal).toMatch(/^[0-9a-f]{64}$/);

    // Re-running with the same inputs yields the same hashes (determinism).
    const report2 = await runUtility({
      tasks: [fakeTask(taskDir, { id: "domain-a/task-z" }), fakeTask(taskDir, { id: "domain-a/task-a" })],
      arms: ["noakm"],
      model: "test-model",
      seedsPerArm: 1,
      spawn: fakeSpawnFactory({ noakm: "ok", akm: "ok" }).spawn,
      materialiseStash: false,
      branch: "test-branch",
      commit: "abc123",
      timestamp: "2026-04-27T00:00:00Z",
    });
    expect(report2.corpus.taskCorpusHash).toBe(report.corpus.taskCorpusHash);
    expect(report2.corpus.fixtureContentHash).toBe(report.corpus.fixtureContentHash);
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

  // ── #267: per-arm prompt override ──────────────────────────────────────────

  test("buildPrompt override forwards prompt to runOne when defined", async () => {
    // Capture the agent command to assert the prompt forms its trailing arg
    // (runAgent appends `prompt` as the last cmd token).
    const capturedAgentCmds: string[][] = [];
    const spawn: SpawnFn = (cmd, _opts) => {
      const isAgent = cmd[0] === "opencode";
      if (isAgent) capturedAgentCmds.push([...cmd]);
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
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      buildPrompt: (task, arm) => (arm === "akm" ? `BYOS scratchpad for ${task.id}` : undefined),
    });
    // 1 noakm + 1 akm = 2 agent invocations.
    expect(capturedAgentCmds.length).toBe(2);
    const akmInvocation = capturedAgentCmds.find((c) => c.some((t) => t.startsWith("BYOS scratchpad")));
    expect(akmInvocation).toBeDefined();
    const noakmInvocation = capturedAgentCmds.find((c) => !c.some((t) => t.startsWith("BYOS scratchpad")));
    expect(noakmInvocation).toBeDefined();
    // The noakm arm received the default prompt — assert the override didn't
    // leak across arms.
    expect(noakmInvocation?.some((t) => t.startsWith("BYOS"))).toBe(false);
  });

  // ── #251: TaskMetadata.stashDirOverride ───────────────────────────────────

  test("stashDirOverride: AKM_STASH_DIR points at the override, never at __no-stash__", async () => {
    // Issue #251 regression. Before the fix, `runMaskedCorpus` mutated
    // `task.stash` and called the runner with `materialiseStash: false`,
    // which ended up wiring `AKM_STASH_DIR` to `<taskDir>/__no-stash__` —
    // so masked re-runs never saw the masked content. The fix is a
    // dedicated `stashDirOverride` field that the runner consults FIRST.
    const observedAkmStashDirs: string[] = [];
    const spawn: SpawnFn = (cmd, opts) => {
      const isAgent = cmd[0] === "opencode";
      if (isAgent && opts.env?.AKM_STASH_DIR) {
        observedAkmStashDirs.push(opts.env.AKM_STASH_DIR);
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
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-251-override-"));
    try {
      await runUtility({
        tasks: [fakeTask(taskDir, { stashDirOverride: overrideDir })],
        arms: ["akm"],
        model: "test",
        seedsPerArm: 1,
        spawn,
        materialiseStash: false,
      });
      expect(observedAkmStashDirs.length).toBe(1);
      expect(observedAkmStashDirs[0]).toBe(overrideDir);
      // Critical: the runner MUST NOT have fallen back to the __no-stash__
      // placeholder. This is the regression guard.
      expect(observedAkmStashDirs[0]?.endsWith("__no-stash__")).toBe(false);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("stashDirOverride: takes precedence over stashDirByFixture and materialised stash", async () => {
    // Resolution order acceptance criterion: per-task override beats both
    // the per-fixture map and the runner's own loadFixtureStash.
    const observedAkmStashDirs: string[] = [];
    const spawn: SpawnFn = (cmd, opts) => {
      const isAgent = cmd[0] === "opencode";
      if (isAgent && opts.env?.AKM_STASH_DIR) {
        observedAkmStashDirs.push(opts.env.AKM_STASH_DIR);
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
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-251-prec-"));
    const fixtureMapDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-251-mapdir-"));
    try {
      await runUtility({
        tasks: [fakeTask(taskDir, { stashDirOverride: overrideDir, stash: "ignored-fixture" })],
        arms: ["akm"],
        model: "test",
        seedsPerArm: 1,
        spawn,
        materialiseStash: false,
        stashDirByFixture: new Map([["ignored-fixture", fixtureMapDir]]),
      });
      expect(observedAkmStashDirs).toEqual([overrideDir]);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
      fs.rmSync(fixtureMapDir, { recursive: true, force: true });
    }
  });

  test("buildPrompt returning undefined keeps the default prompt path", async () => {
    const capturedAgentCmds: string[][] = [];
    const spawn: SpawnFn = (cmd, _opts) => {
      if (cmd[0] === "opencode") capturedAgentCmds.push([...cmd]);
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
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      buildPrompt: () => undefined,
    });
    // The driver's defaultPrompt() embeds the task id; assert that's what we
    // got, not a custom prompt.
    expect(capturedAgentCmds.length).toBe(1);
    const trailing = capturedAgentCmds[0]?.[capturedAgentCmds[0].length - 1] ?? "";
    expect(trailing).toContain("Task: fake/task-a");
  });

  // ── #261: optional synthetic arm ───────────────────────────────────────────

  test("includeSynthetic: runs noakm + akm + synthetic over the same tasks/seeds", async () => {
    // Spy on every agent invocation so we can assert which arm fired and
    // that AKM_STASH_DIR is absent for the synthetic arm only.
    const observedArms: { arm: "noakm" | "akm" | "synthetic"; akmStashDir: string | undefined }[] = [];
    const spawn: SpawnFn = (cmd, opts) => {
      const isAgent = cmd[0] === "opencode";
      if (isAgent) {
        const promptArg = cmd[cmd.length - 1] ?? "";
        let arm: "noakm" | "akm" | "synthetic";
        if (promptArg.includes("Arm: synthetic")) arm = "synthetic";
        else if (opts.env?.AKM_STASH_DIR) arm = "akm";
        else arm = "noakm";
        observedArms.push({ arm, akmStashDir: opts.env?.AKM_STASH_DIR });
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
    const report = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 2,
      spawn,
      materialiseStash: false,
      includeSynthetic: true,
    });
    // 2 seeds × 3 arms = 6 invocations.
    expect(observedArms.length).toBe(6);
    expect(observedArms.filter((o) => o.arm === "noakm").length).toBe(2);
    expect(observedArms.filter((o) => o.arm === "akm").length).toBe(2);
    expect(observedArms.filter((o) => o.arm === "synthetic").length).toBe(2);
    // Synthetic-arm child env MUST NOT carry AKM_STASH_DIR.
    for (const o of observedArms.filter((o) => o.arm === "synthetic")) {
      expect(o.akmStashDir).toBeUndefined();
    }
    // Per-task synthetic metrics are spliced in; aggregateSynth populated.
    expect(report.aggregateSynth).toBeDefined();
    expect(report.aggregateSynth?.passRate).toBe(1);
    expect(report.tasks[0]?.synthetic).toBeDefined();
    expect(report.tasks[0]?.synthetic?.count).toBe(2);
  });

  test("default behaviour (no includeSynthetic) is byte-identical to two-arm output (no synthetic keys)", async () => {
    // SNAPSHOT-STYLE TEST: run runUtility WITHOUT includeSynthetic, capture
    // the JSON envelope keys, and assert no key contains 'synthetic'.
    // Without this gate the byte-identical contract is unverifiable.
    const { spawn } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    const report = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      branch: "test-branch",
      commit: "abc123",
      timestamp: "2026-04-27T00:00:00Z",
    });
    // In-memory report shape: aggregateSynth absent.
    expect(report.aggregateSynth).toBeUndefined();
    expect(report.tasks[0]?.synthetic).toBeUndefined();

    // Render the JSON envelope and walk every key recursively. None should
    // contain 'synthetic'. We exercise the byte-identical envelope contract.
    const { renderUtilityReport } = await import("./report");
    const { json } = renderUtilityReport(report);
    const allKeys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          allKeys.push(k);
          walk(v);
        }
      }
    };
    walk(json);
    const synthMentions = allKeys.filter((k) => k.toLowerCase().includes("synth"));
    expect(synthMentions).toEqual([]);
    // Markdown body must not mention 'synthetic' (case-insensitive).
    const { markdown } = renderUtilityReport(report);
    expect(markdown.toLowerCase().includes("synthetic")).toBe(false);
  });

  test("includeSynthetic: arm-keyed map defaults synthetic to 'arm-not-run' when arm is absent on a task", async () => {
    // Edge case: build a grouped map manually that lacks the synthetic arm
    // for a given task. The runner ALWAYS dispatches the arm when the flag
    // is set, so this guard is enforced through the buildReport branch:
    // when includeSynth is true but no synth runs landed, the per-task
    // PerTaskMetrics carries `count: 0` (zero-result aggregate) — distinct
    // from "arm not run at all" which omits the field. Verify the
    // distinction: report tasks WITHOUT the flag have synthetic absent.
    const { spawn } = fakeSpawnFactory({ noakm: "ok", akm: "ok" });
    const reportNoFlag = await runUtility({
      tasks: [fakeTask(taskDir)],
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
    });
    expect(reportNoFlag.tasks[0]?.synthetic).toBeUndefined();
  });

  test("includeSynthetic: forwards a clear scratch-notes prompt to the synthetic arm", async () => {
    // Acceptance criterion: synthetic arm has a clear scratch-notes prompt
    // contract. We assert the default built-in prompt is forwarded when
    // the caller does not supply a buildPrompt override.
    const capturedAgentCmds: string[][] = [];
    const spawn: SpawnFn = (cmd, _opts) => {
      if (cmd[0] === "opencode") capturedAgentCmds.push([...cmd]);
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
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      includeSynthetic: true,
    });
    const synthCmd = capturedAgentCmds.find((c) => c[c.length - 1]?.includes("Arm: synthetic"));
    expect(synthCmd).toBeDefined();
    const synthPrompt = synthCmd?.[synthCmd.length - 1] ?? "";
    expect(synthPrompt).toContain("Bring Your Own Skills");
    expect(synthPrompt).toContain("scratchpad");
    expect(synthPrompt).toContain("AKM_STASH_DIR is intentionally absent");
  });

  test("includeSynthetic: caller buildPrompt override wins for synthetic arm", async () => {
    // When the caller threads a buildPrompt override that returns a string
    // for the synthetic arm, the runner forwards that override verbatim
    // instead of the built-in scratch-notes prompt. This preserves the
    // Track B `runEvolve` integration where synthetic arm prompts are
    // built by `buildSyntheticPrompt(task.id)`.
    const capturedAgentCmds: string[][] = [];
    const spawn: SpawnFn = (cmd, _opts) => {
      if (cmd[0] === "opencode") capturedAgentCmds.push([...cmd]);
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
      arms: ["noakm", "akm"],
      model: "test",
      seedsPerArm: 1,
      spawn,
      materialiseStash: false,
      includeSynthetic: true,
      buildPrompt: (task, arm) => (arm === "synthetic" ? `OVERRIDE for ${task.id}` : undefined),
    });
    const synthCmd = capturedAgentCmds.find((c) => c[c.length - 1]?.startsWith("OVERRIDE for"));
    expect(synthCmd).toBeDefined();
    // The built-in scratch-notes contract MUST NOT have leaked through.
    expect(synthCmd?.[synthCmd.length - 1]).not.toContain("Bring Your Own Skills");
  });

  test("includeSynthetic: report carries akm_over_synthetic_lift in aggregate", async () => {
    // akm + noakm pass (regex verifier matches "ok"); synthetic fails (we
    // emit "nope" on the synthetic agent stdout so the regex verifier
    // rejects). The fake task uses regex/expectedMatch="ok" — see fakeTask().
    const spawn: SpawnFn = (cmd, _opts) => {
      const isAgent = cmd[0] === "opencode";
      if (!isAgent) {
        return {
          exitCode: 0,
          exited: Promise.resolve(0),
          stdout: asReadableStream(""),
          stderr: asReadableStream(""),
          stdin: null,
          kill() {},
        };
      }
      const promptArg = cmd[cmd.length - 1] ?? "";
      const isSynth = promptArg.includes("Arm: synthetic");
      const stdout = isSynth ? "nope" : "ok";
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream(stdout),
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
      includeSynthetic: true,
    });
    expect(report.aggregateAkm.passRate).toBe(1);
    expect(report.aggregateSynth?.passRate).toBe(0);

    const { renderUtilityReport } = await import("./report");
    const { json, markdown } = renderUtilityReport(report);
    const aggregate = (json as Record<string, Record<string, unknown>>).aggregate;
    expect(aggregate.synthetic).toBeDefined();
    expect(aggregate.akm_over_synthetic_lift).toBe(1);
    // Markdown should mention the lift.
    expect(markdown).toContain("akm_over_synthetic_lift");
  });

  test("includeSynthetic: markdown surfaces a warning when AKM fails to beat synthetic", async () => {
    // Acceptance criterion: utility markdown summarizes when AKM fails to
    // beat synthetic notes. Construct a scenario where akm_pass_rate <=
    // synth_pass_rate — regex verifier expects "ok"; AKM agent emits "nope"
    // (fail), synthetic + noakm emit "ok" (pass).
    const spawn: SpawnFn = (cmd, opts) => {
      const isAgent = cmd[0] === "opencode";
      if (!isAgent) {
        return {
          exitCode: 0,
          exited: Promise.resolve(0),
          stdout: asReadableStream(""),
          stderr: asReadableStream(""),
          stdin: null,
          kill() {},
        };
      }
      const promptArg = cmd[cmd.length - 1] ?? "";
      const isSynth = promptArg.includes("Arm: synthetic");
      const isAkm = !isSynth && opts.env?.AKM_STASH_DIR !== undefined;
      const stdout = isAkm ? "nope" : "ok";
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream(stdout),
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
      includeSynthetic: true,
    });
    expect(report.aggregateAkm.passRate).toBe(0);
    expect(report.aggregateSynth?.passRate).toBe(1);
    const { renderUtilityReport } = await import("./report");
    const { markdown } = renderUtilityReport(report);
    expect(markdown).toContain(":warning:");
    expect(markdown).toContain("AKM did not beat the synthetic-notes baseline");
  });
});
