// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Worktree isolation (redesign addendum, R2 `isolation: worktree`):
 *
 *   - each attempt of an isolated agent/sdk unit dispatches in a FRESH
 *     detached git worktree of the step's base repo (cwd visible to the
 *     dispatcher, a real checkout of the committed tree);
 *   - the worktree path is journaled on the unit row (`worktree_path`);
 *   - a CLEAN worktree is auto-removed after the unit; a DIRTY one is
 *     retained (uncollected work is never destroyed);
 *   - a non-git base directory fails the step cleanly BEFORE any dispatch;
 *   - isolation on an llm unit fails loudly (no child process to isolate).
 *
 * Uses a temp git repo fixture; the whole suite skips gracefully when git is
 * unavailable. Dispatch goes through an injected fake dispatcher — no agent
 * binaries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setServerFactory, closeServer } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import {
  defaultUnitDispatcher,
  executeStepPlan,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../src/workflows/exec/native-executor";
import { isGitAvailable, runWorktreeRoot } from "../../src/workflows/exec/worktree";
import { compileResolveFreezeWorkflow } from "../../src/workflows/ir/freeze";
import type { FrozenAgentEngine, FrozenLlmEngine, WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { makeSandboxDir, withEnv, writeSandboxConfig } from "../_helpers/sandbox";

const GIT = isGitAvailable();

const RUN_ID = "77777777-7777-4777-8777-777777777777";

let tmpDir = "";
let prevDataDir: string | undefined;
/** Temp dirs (repo fixtures + retained worktrees) removed in afterEach. */
let scratch: string[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-exec-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
  scratch = [tmpDir, runWorktreeRoot(RUN_ID)];
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  for (const dir of scratch) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** Init a temp git repo with one committed file (`README.md`). */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-repo-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@akm.invalid"]);
  git(dir, ["config", "user.name", "akm-test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

function seedRun(steps: Array<{ id: string; title: string }>, params: Record<string, unknown> = {}): void {
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), steps[0].id, now, now);
    steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', NULL, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.title, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

function plan(yamlText: string): WorkflowPlanGraph {
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/demo.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compileResolveFreezeWorkflow(
    {
      ref: "workflow:demo",
      path: "workflows/demo.yaml",
      sourcePath: "/tmp",
      title: parsed.program.name,
      steps: [],
      program: parsed.program,
    },
    {
      configVersion: "0.9.0",
      engines: {
        "test-agent": { kind: "agent", platform: "opencode-sdk" },
        "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test" },
      },
      defaults: { engine: "test-agent", llmEngine: "test-llm" },
    } as never,
  ).plan;
}

const SOLO_ISOLATED_WF = `version: 2
name: Isolated
defaults: { engine: test-agent }
steps:
  - id: work
    title: Work
    unit:
      isolation: worktree
      instructions: Do the work.
`;

const FAN_OUT_ISOLATED_WF = `version: 2
name: Isolated fan-out
defaults: { engine: test-agent }
params:
  files: { type: array }
steps:
  - id: work
    title: Work
    map:
      over: \${{ params.files }}
      concurrency: 2
      unit:
        isolation: worktree
        instructions: Edit \${{ item }}.
`;

describe.skipIf(!GIT)("executeStepPlan — isolation: worktree", () => {
  test("dispatches in a fresh detached worktree (cwd visible to the dispatcher), journals worktree_path, removes the clean worktree", async () => {
    seedRun([{ id: "work", title: "Work" }]);
    const repo = makeGitRepo();

    let seenCwd: string | undefined;
    let readmeInWorktree = false;
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      seenCwd = req.cwd;
      // The worktree is a REAL checkout of the committed tree.
      readmeInWorktree = req.cwd !== undefined && fs.existsSync(path.join(req.cwd, "README.md"));
      return { ok: true, text: "done" };
    };

    const workflow = plan(SOLO_ISOLATED_WF);
    expect(workflow.irVersion).toBe(3);
    const result = await executeStepPlan(workflow.steps[0], {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
      workDir: repo,
      engines: workflow.execution?.engines,
    });

    expect(result.ok).toBe(true);
    expect(seenCwd).toBeDefined();
    const cwd = seenCwd as string;
    // A per-attempt worktree under the run-scoped tmp root — never the repo itself.
    expect(cwd.startsWith(runWorktreeRoot(RUN_ID) + path.sep)).toBe(true);
    expect(cwd).not.toBe(repo);
    expect(readmeInWorktree).toBe(true);

    // worktree_path is journaled on the unit row.
    await withWorkflowRunsRepo((repoDb) => {
      const rows = repoDb.getUnitsForStep(RUN_ID, "work");
      expect(rows).toHaveLength(1);
      expect(rows[0].worktree_path).toBe(cwd);
      expect(rows[0].status).toBe("completed");
    });

    // The unit left the worktree clean → it was auto-removed.
    expect(fs.existsSync(cwd)).toBe(false);
  });

  test("a dirty worktree is RETAINED after the unit finishes", async () => {
    seedRun([{ id: "work", title: "Work" }]);
    const repo = makeGitRepo();

    let seenCwd: string | undefined;
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      seenCwd = req.cwd;
      if (req.cwd) fs.writeFileSync(path.join(req.cwd, "uncollected-work.txt"), "important\n");
      return { ok: true, text: "done" };
    };

    const workflow = plan(SOLO_ISOLATED_WF);
    expect(workflow.irVersion).toBe(3);
    const result = await executeStepPlan(workflow.steps[0], {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
      workDir: repo,
      engines: workflow.execution?.engines,
    });

    expect(result.ok).toBe(true);
    const cwd = seenCwd as string;
    // Dirty → retained, with the uncollected work intact.
    expect(fs.existsSync(path.join(cwd, "uncollected-work.txt"))).toBe(true);
    // …and locatable from the journal.
    await withWorkflowRunsRepo((repoDb) => {
      expect(repoDb.getUnitsForStep(RUN_ID, "work")[0].worktree_path).toBe(cwd);
    });
  });

  test("fan-out units get DISTINCT worktrees (parallel isolation)", async () => {
    seedRun([{ id: "work", title: "Work" }], { files: ["a.ts", "b.ts"] });
    const repo = makeGitRepo();

    const cwds: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.cwd) cwds.push(req.cwd);
      return { ok: true, text: "done" };
    };

    const workflow = plan(FAN_OUT_ISOLATED_WF);
    expect(workflow.irVersion).toBe(3);
    const result = await executeStepPlan(workflow.steps[0], {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a.ts", "b.ts"] },
      evidence: {},
      dispatcher,
      workDir: repo,
      engines: workflow.execution?.engines,
    });

    expect(result.ok).toBe(true);
    expect(cwds).toHaveLength(2);
    expect(new Set(cwds).size).toBe(2);
    for (const cwd of cwds) {
      expect(cwd.startsWith(runWorktreeRoot(RUN_ID) + path.sep)).toBe(true);
    }
  });

  test("a non-git base directory fails the step cleanly before any dispatch", async () => {
    seedRun([{ id: "work", title: "Work" }]);
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-plain-"));
    scratch.push(plainDir);

    let dispatched = 0;
    const workflow = plan(SOLO_ISOLATED_WF);
    expect(workflow.irVersion).toBe(3);
    const result = await executeStepPlan(workflow.steps[0], {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher: async () => {
        dispatched++;
        return { ok: true, text: "must not run" };
      },
      workDir: plainDir,
      engines: workflow.execution?.engines,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("isolation: worktree");
    expect(result.summary).toContain("not a git repository");
    expect(dispatched).toBe(0);
    // Nothing journaled — no dispatch ever happened.
    await withWorkflowRunsRepo((repoDb) => {
      expect(repoDb.getUnitsForStep(RUN_ID, "work")).toHaveLength(0);
    });
  });
});

// The llm guard is git-independent (it rejects before touching git at all),
// so it runs even where git is unavailable.
describe("frozen plan — isolation: worktree on the llm runner", () => {
  const LLM_ISOLATED_WF = `version: 2
name: Bad isolation
defaults: { engine: test-llm }
steps:
  - id: work
    title: Work
    unit:
      isolation: worktree
      instructions: Do the work.
`;

  test("rejects before persistence or dispatch — the llm runner has no working directory to isolate", () => {
    seedRun([{ id: "work", title: "Work" }]);
    expect(() => plan(LLM_ISOLATED_WF)).toThrow("LLM unit work cannot use env injection or worktree isolation");
  });
});

// ── defaultUnitDispatcher — the runner-substrate seam (R2) ───────────────────
//
// The env_unsupported hard-fail is GONE for the sdk runner: env bindings now
// genuinely reach the child via the env-keyed opencode server (sdk-runner.ts
// module doc), and worktree cwds ride the per-call `query.directory`. The llm
// runner keeps failing loudly for both — it has no child process at all.

describe("defaultUnitDispatcher — sdk env bindings + cwd (R2)", () => {
  afterEach(() => {
    __setServerFactory(null);
    closeServer();
  });

  const ENV_KEY = "OPENCODE_SDK_DISPATCH_TEST";
  const SDK_ENGINE: FrozenAgentEngine = {
    name: "mysdk",
    kind: "agent",
    runnerKind: "sdk",
    platform: "opencode-sdk",
    bin: "opencode",
    args: [],
    workspace: null,
    envPassthrough: [],
    commandBuilder: "opencode-sdk",
    fallbackLlmEngine: null,
  };
  const LLM_ENGINE: FrozenLlmEngine = {
    name: "test-llm",
    kind: "llm",
    endpoint: "http://localhost:1/v1/chat/completions",
    model: "test-model",
    concurrency: 1,
  };

  function baseRequest(overrides: Partial<UnitDispatchRequest>): UnitDispatchRequest {
    return {
      runId: RUN_ID,
      stepId: "work",
      unitId: "work:solo",
      nodeId: "work",
      prompt: "do the thing",
      engine: SDK_ENGINE,
      invocation: { engine: "mysdk", model: null, timeoutMs: 600_000 },
      timeoutMs: null,
      ...overrides,
    };
  }

  test("sdk units with env bindings dispatch (no env_unsupported) and the bindings reach the server spawn; cwd reaches the session", async () => {
    const cfg = makeSandboxDir("akm-wt-cfg");
    try {
      await withEnv({ XDG_CONFIG_HOME: cfg.dir }, async () => {
        writeSandboxConfig({
          configVersion: "0.9.0",
          engines: { mysdk: { kind: "agent", platform: "opencode-sdk" } },
          defaults: { engine: "mysdk" },
        });

        let injectedAtSpawn: string | undefined;
        let promptDirectory: string | undefined;
        __setServerFactory(((options: { config?: Record<string, unknown>; env: Record<string, string> }) => {
          injectedAtSpawn = options.env[ENV_KEY];
          return Promise.resolve({
            client: {
              session: {
                create: async () => ({ data: { id: "sess-d" } }),
                prompt: async (args: { query?: { directory?: string } }) => {
                  promptDirectory = args.query?.directory;
                  return { data: { parts: [{ type: "text", text: "sdk-ok" }] } };
                },
                delete: async () => ({}),
              },
            },
            server: { close() {} },
          });
        }) as never);

        const result = await defaultUnitDispatcher(
          baseRequest({ env: { [ENV_KEY]: "injected" }, cwd: "/tmp/akm-worktrees/r/u" }),
        );

        expect(result.ok).toBe(true);
        expect(result.text).toBe("sdk-ok");
        expect(result.failureReason).toBeUndefined();
        expect(injectedAtSpawn).toBe("injected");
        expect(process.env[ENV_KEY]).toBeUndefined(); // process-wide env was never mutated
        expect(promptDirectory).toBe("/tmp/akm-worktrees/r/u");
      });
    } finally {
      cfg.cleanup();
    }
  });

  test("llm units with env bindings still fail loudly (env_unsupported)", async () => {
    const cfg = makeSandboxDir("akm-wt-cfg-llm");
    try {
      await withEnv({ XDG_CONFIG_HOME: cfg.dir }, async () => {
        writeSandboxConfig({
          configVersion: "0.9.0",
          engines: { "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "t" } },
          defaults: { engine: "test-llm", llmEngine: "test-llm" },
        });
        const result = await defaultUnitDispatcher(
          baseRequest({
            engine: LLM_ENGINE,
            invocation: { engine: "test-llm", model: "t", timeoutMs: 600_000 },
            env: { FOO: "bar" },
          }),
        );
        expect(result.ok).toBe(false);
        expect(result.failureReason).toBe("env_unsupported");
        expect(result.error).toContain('"llm" runner cannot inject');
      });
    } finally {
      cfg.cleanup();
    }
  });

  test("a cwd reaching a resolved-llm dispatch (isolation via inherit) fails loudly", async () => {
    const cfg = makeSandboxDir("akm-wt-cfg-llm2");
    try {
      await withEnv({ XDG_CONFIG_HOME: cfg.dir }, async () => {
        writeSandboxConfig({
          configVersion: "0.9.0",
          engines: { "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "t" } },
          defaults: { engine: "test-llm", llmEngine: "test-llm" },
        });
        const result = await defaultUnitDispatcher(
          baseRequest({
            engine: LLM_ENGINE,
            invocation: { engine: "test-llm", model: "t", timeoutMs: 600_000 },
            cwd: "/tmp/somewhere",
          }),
        );
        expect(result.ok).toBe(false);
        expect(result.failureReason).toBe("isolation_unsupported");
        expect(result.error).toContain("no working directory to isolate");
      });
    } finally {
      cfg.cleanup();
    }
  });
});
