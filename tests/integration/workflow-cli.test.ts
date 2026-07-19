import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { createMigrationBackup } from "../../src/core/migration-backup";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { parseWorkflow } from "../../src/workflows/parser";
import { runCliCapture } from "../_helpers/cli";
import { withEnvSync } from "../_helpers/sandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createWorkflowEnv(): NodeJS.ProcessEnv {
  const stashDir = makeTempDir("akm-workflow-stash-");
  const xdgCache = makeTempDir("akm-workflow-cache-");
  const xdgConfig = makeTempDir("akm-workflow-config-");
  const xdgData = makeTempDir("akm-workflow-data-");
  const xdgState = makeTempDir("akm-workflow-state-");
  const env = {
    ...process.env,
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
  };
  writeConfig(env, { semanticSearchMode: "off" });
  return env;
}

function writeConfig(env: NodeJS.ProcessEnv, config: Record<string, unknown>) {
  const configDir = path.join(String(env.XDG_CONFIG_HOME), "akm");
  fs.mkdirSync(configDir, { recursive: true });
  withEnvSync(
    {
      AKM_STASH_DIR: env.AKM_STASH_DIR,
      XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_STATE_HOME: env.XDG_STATE_HOME,
    },
    () => createMigrationBackup(),
  );
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    `${JSON.stringify(
      {
        configVersion: "0.9.0",
        engines: {
          "test-agent": { kind: "agent", platform: "opencode-sdk" },
          "test-llm": {
            kind: "llm",
            endpoint: "http://localhost:1/v1/chat/completions",
            model: "test-model",
          },
        },
        defaults: { engine: "test-agent", llmEngine: "test-llm" },
        ...config,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * Pull the JSON error envelope out of stderr. Stderr may contain
 * preceding `warn(...)` lines (e.g. the "Importing workflow content
 * from outside the stash" notice) before the (possibly multi-line) JSON
 * envelope. We slice from the last `{` at column 0 to the end and parse
 * that.
 */
function parseLastJsonLine(stderr: string): unknown {
  const lines = stderr.split("\n");
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) throw new Error(`stderr did not contain a JSON envelope: ${stderr}`);
  const tail = lines.slice(startIdx).join("\n").trim();
  return JSON.parse(tail);
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; status: number }> {
  // In-process replacement for the former spawnSync("bun", [CLI, ...]). Driving
  // the CLI in-process (via runCliCapture) instead of spawning a fresh Bun
  // process per assertion is the large speedup. To match what each spawned
  // subprocess got for free we must, per call:
  //   1. Point process.env at THIS test's isolated XDG dirs (passed in `env`)
  //      so the workflow-state DB (workflow.db under XDG_DATA_HOME) and config
  //      resolve into the test's tempdirs — making each test's run state empty.
  //   2. Reset the module-level singletons (config / embedder / graph caches)
  //      so they re-read against the env we just installed rather than a prior
  //      call's dirs. (state-db / workflow-db open fresh per call and resolve
  //      their path from the env at call time, so they need no reset hook.)
  //   3. chdir to `cwd` when provided: the workflow run scope key derives from
  //      process.cwd() (src/workflows/scope-key.ts), which is how the subprocess
  //      `cwd` option scoped runs across the workA/workB tests.
  // Every env/cwd mutation is reverted in `finally` so the per-test sandbox
  // tripwire in tests/_preload.ts stays satisfied.
  const ENV_KEYS = [
    "AKM_STASH_DIR",
    "AKM_CONFIG_DIR",
    "AKM_CACHE_DIR",
    "AKM_DATA_DIR",
    "AKM_STATE_DIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    prevEnv[k] = process.env[k];
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();

  const prevCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const res = await runCliCapture(args);
    return { stdout: res.stdout, stderr: res.stderr, status: res.code };
  } finally {
    if (cwd) process.chdir(prevCwd);
    for (const k of ENV_KEYS) {
      const orig = prevEnv[k];
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const RELEASE_WORKFLOW = `---
description: Ship a release
tags:
  - release
params:
  version: Version being released
---

# Workflow: Ship Release

## Step: Validate Release Inputs
Step ID: validate

### Instructions
Confirm release notes, tag, and version are present.

### Completion Criteria
- Release notes reviewed
- Version matches tag

## Step: Deploy Release
Step ID: deploy

### Instructions
Run the deployment command and watch health checks.
`;

const TWO_STEP_WORKFLOW = `---
description: Test workflow
---

# Workflow: Test Flow

## Step: First Step
Step ID: first

### Instructions
Do the first thing.

### Completion Criteria
- First thing done

## Step: Second Step
Step ID: second

### Instructions
Do the second thing.
`;

async function setupWorkflow(env: NodeJS.ProcessEnv, name = "test-flow"): Promise<void> {
  const sourceDir = makeTempDir("akm-wfqa-src-");
  const sourcePath = path.join(sourceDir, "wf.md");
  fs.writeFileSync(sourcePath, TWO_STEP_WORKFLOW, "utf8");
  const result = await runCli(["workflow", "create", name, "--from", sourcePath], env);
  if (result.status !== 0) {
    throw new Error(`Failed to create workflow: ${result.stderr}`);
  }
}

describe("workflow CLI", async () => {
  test("template prints a valid workflow document", async () => {
    const env = createWorkflowEnv();
    const result = await runCli(["workflow", "template"], env);

    expect(result.status).toBe(0);
    const parsed = parseWorkflow(result.stdout, { path: "<template>" });
    if (!parsed.ok) {
      throw new Error(`template did not parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    expect(parsed.document.steps.length).toBeGreaterThan(0);
  });

  test("create writes a workflow and show returns structured step data", async () => {
    const env = createWorkflowEnv();
    const result = await runCli(["workflow", "create", "release-flow"], env);

    expect(result.status).toBe(0);
    const created = JSON.parse(result.stdout) as { ref: string; path: string };
    expect(created.ref).toBe("workflow:release-flow");
    expect(fs.existsSync(created.path)).toBe(true);

    const shown = await runCli(["show", "workflow:release-flow"], env);
    expect(shown.status).toBe(0);
    const json = JSON.parse(shown.stdout) as {
      type: string;
      workflowTitle: string;
      steps: Array<{ id: string; title: string }>;
    };
    expect(json.type).toBe("workflow");
    expect(json.workflowTitle).toBe("Release Flow");
    expect(json.steps[0]?.id).toBe("release-flow-setup");
  });

  test("create --from rejects invalid workflow documents", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "invalid.md");
    fs.writeFileSync(sourcePath, "# Workflow: Broken\n\n## Step: Missing Instructions\nStep ID: broken\n", "utf8");

    const result = await runCli(["workflow", "create", "broken", "--from", sourcePath], env);
    expect(result.status).toBe(2);

    const error = parseLastJsonLine(result.stderr) as { error: string };
    expect(error.error).toContain('"### Instructions" section');
  });

  test("create --from rejects duplicate step ids", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "duplicate.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW.replace("Step ID: deploy", "Step ID: validate"), "utf8");

    const result = await runCli(["workflow", "create", "duplicate", "--from", sourcePath], env);
    expect(result.status).toBe(2);

    const error = parseLastJsonLine(result.stderr) as { error: string };
    expect(error.error).toContain('"validate"');
    expect(error.error).toContain("already used");
  });

  test("start, next, complete, list, and status manage persisted workflow runs", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const started = await runCli(["workflow", "start", "workflow:release", "--params", '{"version":"1.2.3"}'], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as {
      run: { id: string; currentStepId: string; params: Record<string, unknown> };
    };
    expect(startJson.run.currentStepId).toBe("validate");
    expect(startJson.run.params.version).toBe("1.2.3");

    const next = await runCli(["workflow", "next", startJson.run.id], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { step: { id: string; title: string; completionCriteria: string[] } };
    expect(nextJson.step.id).toBe("validate");
    expect(nextJson.step.completionCriteria).toEqual(["Release notes reviewed", "Version matches tag"]);

    const completed = await runCli(
      [
        "workflow",
        "complete",
        startJson.run.id,
        "--step",
        "validate",
        "--notes",
        "Inputs verified",
        "--summary",
        "Release notes reviewed and version matches tag.",
        "--evidence",
        '{"checkedBy":"copilot"}',
      ],
      env,
    );
    expect(completed.status).toBe(0);
    const completedJson = JSON.parse(completed.stdout) as {
      run: { currentStepId: string };
      workflow: { steps: unknown[] };
    };
    expect(completedJson.run.currentStepId).toBe("deploy");
    expect(completedJson.workflow.steps).toHaveLength(2);

    const status = await runCli(["workflow", "status", startJson.run.id], env);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout) as {
      run: { status: string; currentStepId: string };
      workflow: { steps: Array<{ id: string; status: string; notes?: string; evidence?: Record<string, unknown> }> };
    };
    expect(statusJson.run.status).toBe("active");
    expect(statusJson.run.currentStepId).toBe("deploy");
    expect(statusJson.workflow.steps[0]).toMatchObject({
      id: "validate",
      status: "completed",
      notes: "Inputs verified",
      evidence: { checkedBy: "copilot" },
    });

    const listed = await runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env);
    expect(listed.status).toBe(0);
    const listJson = JSON.parse(listed.stdout) as { runs: Array<{ id: string; workflowRef: string }> };
    expect(listJson.runs).toHaveLength(1);
    expect(listJson.runs[0]?.workflowRef).toBe("workflow:release");

    expect(
      (
        await runCli(
          ["workflow", "complete", startJson.run.id, "--step", "deploy", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);

    const afterComplete = await runCli(["workflow", "status", startJson.run.id], env);
    const finalStatus = JSON.parse(afterComplete.stdout) as { run: { status: string; currentStepId?: string | null } };
    expect(finalStatus.run.status).toBe("completed");
    expect(finalStatus.run.currentStepId ?? null).toBeNull();
  }, 30_000);

  // WS5.1: the `--dry-run` arg declaration was removed from `workflow next`
  // (so it no longer appears in --help) but the runtime guard remains, reading
  // the flag straight from process.argv so callers still get a clear message.
  test("next rejects --dry-run with a clear usage error", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");
    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const result = await runCli(["workflow", "next", "workflow:release", "--dry-run"], env);
    expect(result.status).toBe(2);
    const error = parseLastJsonLine(result.stderr) as { error: string; code?: string };
    expect(error.error).toContain("does not support --dry-run");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
  });

  test("next auto-starts a workflow and run state survives full index rebuilds", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const indexed = await runCli(["index", "--full"], env);
    expect(indexed.status).toBe(0);

    const search = await runCli(["search", "health checks", "--type", "workflow", "--detail", "full"], env);
    expect(search.status).toBe(0);
    const searchJson = JSON.parse(search.stdout) as {
      hits: Array<{ ref: string; action: string }>;
    };
    // F4b: search hits emit the 0.9.0 conceptId spelling; the workflow input
    // recognition (workflow-cli.ts:365, `startsWith("workflows/")`) accepts it,
    // so the action hint stays runnable.
    expect(searchJson.hits[0]?.ref).toBe("workflows/release");
    expect(searchJson.hits[0]?.action).toContain("akm workflow next 'workflows/release'");

    const next = await runCli(["workflow", "next", "workflow:release"], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { id: string; status: string }; step: { id: string } };
    expect(nextJson.run.status).toBe("active");
    expect(nextJson.step.id).toBe("validate");

    const rebuilt = await runCli(["index", "--full"], env);
    expect(rebuilt.status).toBe(0);

    const status = await runCli(["workflow", "status", nextJson.run.id], env);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout) as { run: { id: string; status: string; currentStepId: string } };
    expect(statusJson.run.id).toBe(nextJson.run.id);
    expect(statusJson.run.status).toBe("active");
    expect(statusJson.run.currentStepId).toBe("validate");
  }, 30_000);

  test("complete rejects non-current and finalized step updates", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const started = await runCli(["workflow", "start", "workflow:release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { id: string } };

    const wrongStep = await runCli(["workflow", "complete", startJson.run.id, "--step", "deploy"], env);
    expect(wrongStep.status).toBe(2);
    expect(JSON.parse(wrongStep.stderr).error).toContain("is not the current step");

    expect(
      (
        await runCli(
          ["workflow", "complete", startJson.run.id, "--step", "validate", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);

    const repeated = await runCli(
      ["workflow", "complete", startJson.run.id, "--step", "validate", "--summary", "Work completed and verified."],
      env,
    );
    expect(repeated.status).toBe(2);
    expect(JSON.parse(repeated.stderr).error).toContain("already completed");

    expect(
      (await runCli(["workflow", "complete", startJson.run.id, "--step", "deploy", "--state", "blocked"], env)).status,
    ).toBe(0);

    const blockedRun = await runCli(["workflow", "complete", startJson.run.id, "--step", "deploy"], env);
    expect(blockedRun.status).toBe(2);
    expect(JSON.parse(blockedRun.stderr).error).toContain("is blocked and cannot be updated");
  });

  test("next on a blocked run starts a new run for workflow refs", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const started = await runCli(["workflow", "start", "workflow:release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (
        await runCli(
          ["workflow", "complete", startJson.run.id, "--step", "validate", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);
    expect(
      (await runCli(["workflow", "complete", startJson.run.id, "--step", "deploy", "--state", "blocked"], env)).status,
    ).toBe(0);

    const next = await runCli(["workflow", "next", "workflow:release"], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { id: string; status: string }; step: { id: string } };
    expect(nextJson.run.id).not.toBe(startJson.run.id);
    expect(nextJson.run.status).toBe("active");
    expect(nextJson.step.id).toBe("validate");
  });

  test("start links workflow_entry_id for workflows from an additional stash source", async () => {
    const env = createWorkflowEnv();
    const extraStash = makeTempDir("akm-workflow-extra-stash-");
    const workflowPath = path.join(extraStash, "workflows", "shared-release.md");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, RELEASE_WORKFLOW, "utf8");

    writeConfig(env, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: extraStash, name: "extra" }],
    });

    expect((await runCli(["index", "--full"], env)).status).toBe(0);

    const started = await runCli(["workflow", "start", "extra//workflow:shared-release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { workflowEntryId?: number | null; workflowRef: string } };
    expect(startJson.run.workflowRef).toBe("extra//workflow:shared-release");
    expect(typeof startJson.run.workflowEntryId).toBe("number");
  });

  test("workflow runs are isolated across non-repo working directories", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    const workA = makeTempDir("akm-workflow-scope-a-");
    const workB = makeTempDir("akm-workflow-scope-b-");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);

    const startedA = await runCli(["workflow", "start", "workflow:release"], env, workA);
    expect(startedA.status).toBe(0);
    const startJsonA = JSON.parse(startedA.stdout) as { run: { id: string; scopeKey?: string | null } };

    const nextB = await runCli(["workflow", "next", "workflow:release", "--params", '{"version":"2.0.0"}'], env, workB);
    expect(nextB.status).toBe(0);
    const nextJsonB = JSON.parse(nextB.stdout) as {
      autoStarted?: boolean;
      run: { id: string; params?: Record<string, unknown>; scopeKey?: string | null };
    };
    expect(nextJsonB.autoStarted).toBe(true);
    expect(nextJsonB.run.id).not.toBe(startJsonA.run.id);
    expect(nextJsonB.run.params?.version).toBe("2.0.0");
    expect(nextJsonB.run.scopeKey).toBeDefined();
    expect(nextJsonB.run.scopeKey).not.toBe(startJsonA.run.scopeKey);

    const listA = await runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env, workA);
    expect(listA.status).toBe(0);
    const listJsonA = JSON.parse(listA.stdout) as { runs: Array<{ id: string }> };
    expect(listJsonA.runs.map((run) => run.id)).toEqual([startJsonA.run.id]);

    const listB = await runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env, workB);
    expect(listB.status).toBe(0);
    const listJsonB = JSON.parse(listB.stdout) as { runs: Array<{ id: string }> };
    expect(listJsonB.runs.map((run) => run.id)).toEqual([nextJsonB.run.id]);

    const statusA = await runCli(["workflow", "status", "workflow:release"], env, workA);
    expect(statusA.status).toBe(0);
    const statusJsonA = JSON.parse(statusA.stdout) as { run: { id: string } };
    expect(statusJsonA.run.id).toBe(startJsonA.run.id);

    const statusB = await runCli(["workflow", "status", "workflow:release"], env, workB);
    expect(statusB.status).toBe(0);
    const statusJsonB = JSON.parse(statusB.stdout) as { run: { id: string } };
    expect(statusJsonB.run.id).toBe(nextJsonB.run.id);

    const directStatus = await runCli(["workflow", "status", startJsonA.run.id], env, workB);
    expect(directStatus.status).toBe(0);
    const directStatusJson = JSON.parse(directStatus.stdout) as { run: { id: string } };
    expect(directStatusJson.run.id).toBe(startJsonA.run.id);
  });

  test("show only exposes the active workflow run for the current working directory", async () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    const workA = makeTempDir("akm-workflow-show-a-");
    const workB = makeTempDir("akm-workflow-show-b-");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect((await runCli(["workflow", "create", "release", "--from", sourcePath], env)).status).toBe(0);
    const started = await runCli(["workflow", "start", "workflow:release"], env, workA);
    expect(started.status).toBe(0);
    const startedJson = JSON.parse(started.stdout) as { run: { id: string } };

    const shownA = await runCli(["show", "workflow:release"], env, workA);
    expect(shownA.status).toBe(0);
    const shownJsonA = JSON.parse(shownA.stdout) as { activeRun?: { runId: string } };
    expect(shownJsonA.activeRun?.runId).toBe(startedJson.run.id);

    const shownB = await runCli(["show", "workflow:release"], env, workB);
    expect(shownB.status).toBe(0);
    const shownJsonB = JSON.parse(shownB.stdout) as { activeRun?: { runId: string } };
    expect(shownJsonB.activeRun).toBeUndefined();
  });
});

describe("workflow CLI — qa fixes", async () => {
  test("resume flips a blocked run back to active", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    // Complete first step as blocked
    expect(
      (await runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env)).status,
    ).toBe(0);

    // Verify it's blocked
    const statusBlocked = await runCli(["workflow", "status", startRun.id], env);
    expect(statusBlocked.status).toBe(0);
    const { run: blockedRun } = JSON.parse(statusBlocked.stdout) as { run: { status: string } };
    expect(blockedRun.status).toBe("blocked");

    // Resume it
    const resumed = await runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(0);
    const { run: resumedRun } = JSON.parse(resumed.stdout) as { run: { status: string } };
    expect(resumedRun.status).toBe("active");
  });

  test("resume on a completed run returns an error", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "first", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "second", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);

    const resumed = await runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(2);
    const err = JSON.parse(resumed.stderr) as { error: string };
    expect(err.error).toContain("already completed");
  });

  test("resume on a failed run flips it to active", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (await runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "failed"], env)).status,
    ).toBe(0);

    const resumed = await runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(0);
    const { run: resumedRun } = JSON.parse(resumed.stdout) as { run: { status: string } };
    expect(resumedRun.status).toBe("active");
  });

  // Issue #156: after resuming a blocked run, the previously-blocked step must be
  // re-actionable so it can be reclassified to completed/failed/skipped.
  for (const newState of ["completed", "failed", "skipped"] as const) {
    test(`resume re-opens a blocked step so it can be reclassified to ${newState}`, async () => {
      const env = createWorkflowEnv();
      await setupWorkflow(env);

      const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
      expect(started.status).toBe(0);
      const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

      expect(
        (await runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env)).status,
      ).toBe(0);
      expect((await runCli(["workflow", "resume", startRun.id], env)).status).toBe(0);

      const reclassified = await runCli(
        [
          "workflow",
          "complete",
          startRun.id,
          "--step",
          "first",
          "--state",
          newState,
          "--notes",
          "resolved",
          "--summary",
          "Resolved.",
        ],
        env,
      );
      expect(reclassified.status).toBe(0);
      const parsed = JSON.parse(reclassified.stdout) as {
        workflow: { steps: Array<{ id: string; status: string }> };
      };
      const firstStep = parsed.workflow.steps.find((s) => s.id === "first");
      expect(firstStep?.status).toBe(newState);
    });
  }

  test("resume does not disturb already-completed earlier steps", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "first", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);
    expect(
      (await runCli(["workflow", "complete", startRun.id, "--step", "second", "--state", "blocked"], env)).status,
    ).toBe(0);
    expect((await runCli(["workflow", "resume", startRun.id], env)).status).toBe(0);

    const status = await runCli(["workflow", "status", startRun.id], env);
    expect(status.status).toBe(0);
    const detail = JSON.parse(status.stdout) as {
      workflow: { steps: Array<{ id: string; status: string }> };
    };
    expect(detail.workflow.steps.find((s) => s.id === "first")?.status).toBe("completed");
    expect(detail.workflow.steps.find((s) => s.id === "second")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 2. listWorkflowRuns --active is status-'active' ONLY (owner manual-validation
//    finding 1): a blocked run is NOT executable work, so --active must not
//    return it — it stays visible (with its blocked status) in the plain list.
// ---------------------------------------------------------------------------
describe("workflow list --active excludes blocked", async () => {
  test("blocked run is absent from --active but present (blocked) in the plain list", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (await runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env)).status,
    ).toBe(0);

    const listed = await runCli(["workflow", "list", "--ref", "workflow:test-flow", "--active"], env);
    expect(listed.status).toBe(0);
    const { runs } = JSON.parse(listed.stdout) as { runs: Array<{ id: string; status: string }> };
    expect(runs.some((r) => r.id === startRun.id)).toBe(false);

    const plain = await runCli(["workflow", "list", "--ref", "workflow:test-flow"], env);
    expect(plain.status).toBe(0);
    const { runs: allRuns } = JSON.parse(plain.stdout) as { runs: Array<{ id: string; status: string }> };
    expect(allRuns.some((r) => r.id === startRun.id && r.status === "blocked")).toBe(true);
  });

  test("completed run does NOT appear in --active list", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "first", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "second", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);

    const listed = await runCli(["workflow", "list", "--active"], env);
    expect(listed.status).toBe(0);
    const { runs } = JSON.parse(listed.stdout) as { runs: Array<{ id: string }> };
    expect(runs.some((r) => r.id === startRun.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 08-F6: `akm workflow abandon <run-id>` — the run-level give-up verb the
// concurrency-guard error message always advertised. Marks the run failed
// (resume can reopen it) so it stops counting as active.
// ---------------------------------------------------------------------------
describe("workflow abandon", async () => {
  test("abandon marks an active run failed and removes it from --active", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    const abandoned = await runCli(["workflow", "abandon", startRun.id], env);
    expect(abandoned.status).toBe(0);
    const { run: abandonedRun } = JSON.parse(abandoned.stdout) as { run: { status: string } };
    expect(abandonedRun.status).toBe("failed");

    const listed = await runCli(["workflow", "list", "--active"], env);
    expect(listed.status).toBe(0);
    const { runs } = JSON.parse(listed.stdout) as { runs: Array<{ id: string }> };
    expect(runs.some((r) => r.id === startRun.id)).toBe(false);
  });

  test("abandon on a completed run returns an error", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    for (const step of ["first", "second"]) {
      expect(
        (
          await runCli(
            ["workflow", "complete", startRun.id, "--step", step, "--summary", "Work completed and verified."],
            env,
          )
        ).status,
      ).toBe(0);
    }

    const abandoned = await runCli(["workflow", "abandon", startRun.id], env);
    expect(abandoned.status).toBe(2);
    const err = JSON.parse(abandoned.stderr) as { error: string };
    expect(err.error).toContain("already");
  });

  test("an abandoned run can be resumed back to active", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect((await runCli(["workflow", "abandon", startRun.id], env)).status).toBe(0);

    const resumed = await runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(0);
    const { run: resumedRun } = JSON.parse(resumed.stdout) as { run: { status: string } };
    expect(resumedRun.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 3. workflow next on a completed run: done:true, step:null
// ---------------------------------------------------------------------------
describe("workflow next — completed run signals done", async () => {
  test("next on a completed run-id returns done:true and step:null", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "first", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workflow", "complete", startRun.id, "--step", "second", "--summary", "Work completed and verified."],
          env,
        )
      ).status,
    ).toBe(0);

    const next = await runCli(["workflow", "next", startRun.id], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { done?: boolean; step: unknown };
    expect(nextJson.done).toBe(true);
    expect(nextJson.step).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. workflow next <ref> auto-start: autoStarted:true
// ---------------------------------------------------------------------------
describe("workflow next — auto-start flags autoStarted", async () => {
  test("next on a ref with no existing run returns autoStarted:true", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const next = await runCli(["workflow", "next", "workflow:test-flow"], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as {
      autoStarted?: boolean;
      run: { status: string };
      step: { id: string };
    };
    expect(nextJson.autoStarted).toBe(true);
    expect(nextJson.run.status).toBe("active");
    expect(nextJson.step.id).toBe("first");
  });

  test("next on a ref with existing active run does NOT set autoStarted", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    // First call auto-starts
    const first = await runCli(["workflow", "next", "workflow:test-flow"], env);
    expect(first.status).toBe(0);

    // Second call resumes existing — no autoStarted
    const second = await runCli(["workflow", "next", "workflow:test-flow"], env);
    expect(second.status).toBe(0);
    const secondJson = JSON.parse(second.stdout) as { autoStarted?: boolean };
    expect(secondJson.autoStarted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. workflow next --params: sets params on auto-start; fails on existing run
// ---------------------------------------------------------------------------
describe("workflow next --params", async () => {
  test("--params is accepted when auto-starting a new run", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const next = await runCli(["workflow", "next", "workflow:test-flow", "--params", '{"x":1}'], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { params?: Record<string, unknown> }; autoStarted?: boolean };
    expect(nextJson.autoStarted).toBe(true);
    expect(nextJson.run.params?.x).toBe(1);
  });

  test("--params fails when an active run already exists (ref specifier)", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    // Start a run first
    expect((await runCli(["workflow", "start", "workflow:test-flow"], env)).status).toBe(0);

    const next = await runCli(["workflow", "next", "workflow:test-flow", "--params", '{"x":1}'], env);
    expect(next.status).toBe(2);
    const err = JSON.parse(next.stderr) as { error: string };
    expect(err.error).toContain("--params can only be set on a new run");
  });

  test("--params fails when given a direct run-id (existing run)", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    const next = await runCli(["workflow", "next", startRun.id, "--params", '{"x":1}'], env);
    expect(next.status).toBe(2);
    const err = JSON.parse(next.stderr) as { error: string };
    expect(err.error).toContain("--params can only be used when starting a new run from a workflow ref");
    expect(err.error).toContain("existing run id");
  });
});

describe("workflow CLI — status create", async () => {
  test("status workflow:<name> resolves to the most-recently-updated run", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    const status = await runCli(["workflow", "status", "workflow:test-flow"], env);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout) as { run: { id: string; status: string } };
    expect(statusJson.run.id).toBe(startRun.id);
    expect(statusJson.run.status).toBe("active");
  });

  test("status workflow:<name> returns NotFoundError when no runs exist", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const status = await runCli(["workflow", "status", "workflow:test-flow"], env);
    // No runs created yet — should fail with not-found (exit 1)
    expect(status.status).toBe(1);
    const err = JSON.parse(status.stderr) as { error: string };
    expect(err.error).toContain("No workflow runs found");
  });

  test("status workflow:<name> resolves within the current working-directory scope", async () => {
    const env = createWorkflowEnv();
    const workA = makeTempDir("akm-wfqa-scope-a-");
    const workB = makeTempDir("akm-wfqa-scope-b-");
    await setupWorkflow(env);

    const startedA = await runCli(["workflow", "start", "workflow:test-flow"], env, workA);
    expect(startedA.status).toBe(0);
    const { run: runA } = JSON.parse(startedA.stdout) as { run: { id: string } };

    const startedB = await runCli(["workflow", "start", "workflow:test-flow"], env, workB);
    expect(startedB.status).toBe(0);
    const { run: runB } = JSON.parse(startedB.stdout) as { run: { id: string } };

    const statusA = await runCli(["workflow", "status", "workflow:test-flow"], env, workA);
    expect(statusA.status).toBe(0);
    expect((JSON.parse(statusA.stdout) as { run: { id: string } }).run.id).toBe(runA.id);

    const statusB = await runCli(["workflow", "status", "workflow:test-flow"], env, workB);
    expect(statusB.status).toBe(0);
    expect((JSON.parse(statusB.stdout) as { run: { id: string } }).run.id).toBe(runB.id);
  });

  test("next with an unknown run id returns WORKFLOW_NOT_FOUND", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const next = await runCli(["workflow", "next", "bogus-run-id"], env);
    expect(next.status).toBe(1);
    const err = JSON.parse(next.stderr) as { code: string; hint?: string };
    expect(err.code).toBe("WORKFLOW_NOT_FOUND");
    expect(err.hint).toContain("akm workflow list --active");
  });

  test("status with an unknown run id returns WORKFLOW_NOT_FOUND", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const status = await runCli(["workflow", "status", "bogus-run-id"], env);
    expect(status.status).toBe(1);
    const err = JSON.parse(status.stderr) as { code: string; hint?: string };
    expect(err.code).toBe("WORKFLOW_NOT_FOUND");
    expect(err.hint).toContain("akm workflow list --active");
  });
});

// ---------------------------------------------------------------------------
// 7. workflow create name validation
// ---------------------------------------------------------------------------
describe("workflow create — name validation", async () => {
  test("name with spaces is rejected", async () => {
    const env = createWorkflowEnv();

    const result = await runCli(["workflow", "create", "name with spaces"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Workflow name must start with a lowercase letter");
  });

  test("name with uppercase is rejected", async () => {
    const env = createWorkflowEnv();

    const result = await runCli(["workflow", "create", "MyWorkflow"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Workflow name must start with a lowercase letter");
  });

  test("valid lowercase name is accepted", async () => {
    const env = createWorkflowEnv();

    const result = await runCli(["workflow", "create", "my-workflow"], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string };
    expect(json.ref).toBe("workflow:my-workflow");
  });

  test("hierarchical placement uses --path; a slash in the name positional is rejected", async () => {
    const env = createWorkflowEnv();

    // --path provides the subdirectory under workflows/; the name stays flat.
    const ok = await runCli(["workflow", "create", "ship", "--path", "release"], env);
    expect(ok.status).toBe(0);
    expect((JSON.parse(ok.stdout) as { ref: string }).ref).toBe("workflow:release/ship");

    // A '/' in the name positional is rejected and points at --path.
    const bad = await runCli(["workflow", "create", "release/ship"], env);
    expect(bad.status).toBe(2);
    expect((JSON.parse(bad.stderr) as { error: string }).error).toMatch(/--path/);
  });

  test("name validation error message mentions slashes", async () => {
    const env = createWorkflowEnv();

    const result = await runCli(["workflow", "create", "BAD NAME"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("slashes");
  });
});

// ---------------------------------------------------------------------------
// 8. workflow create --force without --from/--reset is rejected
// ---------------------------------------------------------------------------
describe("workflow create --force guard", async () => {
  test("--force without --from or --reset is rejected", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const result = await runCli(["workflow", "create", "test-flow", "--force"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Refusing to overwrite with template");
  });

  test("--force --reset succeeds and overwrites with template", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const result = await runCli(["workflow", "create", "test-flow", "--force", "--reset"], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("workflow:test-flow");
  });

  test("--force --from <file> succeeds and overwrites with file content", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const sourceDir = makeTempDir("akm-wfqa-src2-");
    const sourcePath = path.join(sourceDir, "new.md");
    fs.writeFileSync(sourcePath, TWO_STEP_WORKFLOW, "utf8");

    const result = await runCli(["workflow", "create", "test-flow", "--force", "--from", sourcePath], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. complete --state help text documents default (just ensure it runs)
// ---------------------------------------------------------------------------
describe("workflow complete --state default", async () => {
  test("complete without --state defaults to completed", async () => {
    const env = createWorkflowEnv();
    await setupWorkflow(env);

    const started = await runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    // No --state flag → should default to 'completed'
    const completed = await runCli(
      ["workflow", "complete", startRun.id, "--step", "first", "--summary", "Work completed and verified."],
      env,
    );
    expect(completed.status).toBe(0);
    const json = JSON.parse(completed.stdout) as { workflow: { steps: Array<{ id: string; status: string }> } };
    const step = json.workflow.steps.find((s) => s.id === "first");
    expect(step?.status).toBe("completed");
  });
});
