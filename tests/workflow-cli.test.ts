import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflow } from "../src/workflows/parser";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
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
  return {
    ...process.env,
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
  };
}

function writeConfig(env: NodeJS.ProcessEnv, config: Record<string, unknown>) {
  const configDir = path.join(String(env.XDG_CONFIG_HOME), "akm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env,
    ...(cwd ? { cwd } : {}),
  });
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

function setupWorkflow(env: NodeJS.ProcessEnv, name = "test-flow"): void {
  const sourceDir = makeTempDir("akm-wfqa-src-");
  const sourcePath = path.join(sourceDir, "wf.md");
  fs.writeFileSync(sourcePath, TWO_STEP_WORKFLOW, "utf8");
  const result = runCli(["workflow", "create", name, "--from", sourcePath], env);
  if (result.status !== 0) {
    throw new Error(`Failed to create workflow: ${result.stderr}`);
  }
}

describe("workflow CLI", () => {
  test("template prints a valid workflow document", () => {
    const env = createWorkflowEnv();
    const result = runCli(["workflow", "template"], env);

    expect(result.status).toBe(0);
    const parsed = parseWorkflow(result.stdout, { path: "<template>" });
    if (!parsed.ok) {
      throw new Error(`template did not parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    expect(parsed.document.steps.length).toBeGreaterThan(0);
  });

  test("create writes a workflow and show returns structured step data", () => {
    const env = createWorkflowEnv();
    const result = runCli(["workflow", "create", "release-flow"], env);

    expect(result.status).toBe(0);
    const created = JSON.parse(result.stdout) as { ref: string; path: string };
    expect(created.ref).toBe("workflow:release-flow");
    expect(fs.existsSync(created.path)).toBe(true);

    const shown = runCli(["show", "workflow:release-flow"], env);
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

  test("create --from rejects invalid workflow documents", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "invalid.md");
    fs.writeFileSync(sourcePath, "# Workflow: Broken\n\n## Step: Missing Instructions\nStep ID: broken\n", "utf8");

    const result = runCli(["workflow", "create", "broken", "--from", sourcePath], env);
    expect(result.status).toBe(2);

    const error = parseLastJsonLine(result.stderr) as { error: string };
    expect(error.error).toContain('"### Instructions" section');
  });

  test("create --from rejects duplicate step ids", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "duplicate.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW.replace("Step ID: deploy", "Step ID: validate"), "utf8");

    const result = runCli(["workflow", "create", "duplicate", "--from", sourcePath], env);
    expect(result.status).toBe(2);

    const error = parseLastJsonLine(result.stderr) as { error: string };
    expect(error.error).toContain('"validate"');
    expect(error.error).toContain("already used");
  });

  test("start, next, complete, list, and status manage persisted workflow runs", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);

    const started = runCli(["workflow", "start", "workflow:release", "--params", '{"version":"1.2.3"}'], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as {
      run: { id: string; currentStepId: string; params: Record<string, unknown> };
    };
    expect(startJson.run.currentStepId).toBe("validate");
    expect(startJson.run.params.version).toBe("1.2.3");

    const next = runCli(["workflow", "next", startJson.run.id], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { step: { id: string; title: string; completionCriteria: string[] } };
    expect(nextJson.step.id).toBe("validate");
    expect(nextJson.step.completionCriteria).toEqual(["Release notes reviewed", "Version matches tag"]);

    const completed = runCli(
      [
        "workflow",
        "complete",
        startJson.run.id,
        "--step",
        "validate",
        "--notes",
        "Inputs verified",
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

    const status = runCli(["workflow", "status", startJson.run.id], env);
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

    const listed = runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env);
    expect(listed.status).toBe(0);
    const listJson = JSON.parse(listed.stdout) as { runs: Array<{ id: string; workflowRef: string }> };
    expect(listJson.runs).toHaveLength(1);
    expect(listJson.runs[0]?.workflowRef).toBe("workflow:release");

    expect(runCli(["workflow", "complete", startJson.run.id, "--step", "deploy"], env).status).toBe(0);

    const afterComplete = runCli(["workflow", "status", startJson.run.id], env);
    const finalStatus = JSON.parse(afterComplete.stdout) as { run: { status: string; currentStepId?: string | null } };
    expect(finalStatus.run.status).toBe("completed");
    expect(finalStatus.run.currentStepId ?? null).toBeNull();
  }, 30_000);

  test("next auto-starts a workflow and run state survives full index rebuilds", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);

    const indexed = runCli(["index", "--full"], env);
    expect(indexed.status).toBe(0);

    const search = runCli(["search", "health checks", "--type", "workflow", "--detail", "full"], env);
    expect(search.status).toBe(0);
    const searchJson = JSON.parse(search.stdout) as {
      hits: Array<{ ref: string; action: string }>;
    };
    expect(searchJson.hits[0]?.ref).toBe("workflow:release");
    expect(searchJson.hits[0]?.action).toContain("akm workflow next 'workflow:release'");

    const next = runCli(["workflow", "next", "workflow:release"], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { id: string; status: string }; step: { id: string } };
    expect(nextJson.run.status).toBe("active");
    expect(nextJson.step.id).toBe("validate");

    const rebuilt = runCli(["index", "--full"], env);
    expect(rebuilt.status).toBe(0);

    const status = runCli(["workflow", "status", nextJson.run.id], env);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout) as { run: { id: string; status: string; currentStepId: string } };
    expect(statusJson.run.id).toBe(nextJson.run.id);
    expect(statusJson.run.status).toBe("active");
    expect(statusJson.run.currentStepId).toBe("validate");
  }, 30_000);

  test("complete rejects non-current and finalized step updates", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);

    const started = runCli(["workflow", "start", "workflow:release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { id: string } };

    const wrongStep = runCli(["workflow", "complete", startJson.run.id, "--step", "deploy"], env);
    expect(wrongStep.status).toBe(2);
    expect(JSON.parse(wrongStep.stderr).error).toContain("is not the current step");

    expect(runCli(["workflow", "complete", startJson.run.id, "--step", "validate"], env).status).toBe(0);

    const repeated = runCli(["workflow", "complete", startJson.run.id, "--step", "validate"], env);
    expect(repeated.status).toBe(2);
    expect(JSON.parse(repeated.stderr).error).toContain("already completed");

    expect(
      runCli(["workflow", "complete", startJson.run.id, "--step", "deploy", "--state", "blocked"], env).status,
    ).toBe(0);

    const blockedRun = runCli(["workflow", "complete", startJson.run.id, "--step", "deploy"], env);
    expect(blockedRun.status).toBe(2);
    expect(JSON.parse(blockedRun.stderr).error).toContain("is blocked and cannot be updated");
  });

  test("next on a blocked run starts a new run for workflow refs", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);

    const started = runCli(["workflow", "start", "workflow:release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startJson.run.id, "--step", "validate"], env).status).toBe(0);
    expect(
      runCli(["workflow", "complete", startJson.run.id, "--step", "deploy", "--state", "blocked"], env).status,
    ).toBe(0);

    const next = runCli(["workflow", "next", "workflow:release"], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { id: string; status: string }; step: { id: string } };
    expect(nextJson.run.id).not.toBe(startJson.run.id);
    expect(nextJson.run.status).toBe("active");
    expect(nextJson.step.id).toBe("validate");
  });

  test("start links workflow_entry_id for workflows from an additional stash source", () => {
    const env = createWorkflowEnv();
    const extraStash = makeTempDir("akm-workflow-extra-stash-");
    const workflowPath = path.join(extraStash, "workflows", "shared-release.md");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, RELEASE_WORKFLOW, "utf8");

    writeConfig(env, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: extraStash, name: "extra" }],
    });

    expect(runCli(["index", "--full"], env).status).toBe(0);

    const started = runCli(["workflow", "start", "extra//workflow:shared-release"], env);
    expect(started.status).toBe(0);
    const startJson = JSON.parse(started.stdout) as { run: { workflowEntryId?: number | null; workflowRef: string } };
    expect(startJson.run.workflowRef).toBe("extra//workflow:shared-release");
    expect(typeof startJson.run.workflowEntryId).toBe("number");
  });

  test("workflow runs are isolated across non-repo working directories", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    const workA = makeTempDir("akm-workflow-scope-a-");
    const workB = makeTempDir("akm-workflow-scope-b-");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);

    const startedA = runCli(["workflow", "start", "workflow:release"], env, workA);
    expect(startedA.status).toBe(0);
    const startJsonA = JSON.parse(startedA.stdout) as { run: { id: string; scopeKey?: string | null } };

    const nextB = runCli(["workflow", "next", "workflow:release", "--params", '{"version":"2.0.0"}'], env, workB);
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

    const listA = runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env, workA);
    expect(listA.status).toBe(0);
    const listJsonA = JSON.parse(listA.stdout) as { runs: Array<{ id: string }> };
    expect(listJsonA.runs.map((run) => run.id)).toEqual([startJsonA.run.id]);

    const listB = runCli(["workflow", "list", "--ref", "workflow:release", "--active"], env, workB);
    expect(listB.status).toBe(0);
    const listJsonB = JSON.parse(listB.stdout) as { runs: Array<{ id: string }> };
    expect(listJsonB.runs.map((run) => run.id)).toEqual([nextJsonB.run.id]);

    const statusA = runCli(["workflow", "status", "workflow:release"], env, workA);
    expect(statusA.status).toBe(0);
    const statusJsonA = JSON.parse(statusA.stdout) as { run: { id: string } };
    expect(statusJsonA.run.id).toBe(startJsonA.run.id);

    const statusB = runCli(["workflow", "status", "workflow:release"], env, workB);
    expect(statusB.status).toBe(0);
    const statusJsonB = JSON.parse(statusB.stdout) as { run: { id: string } };
    expect(statusJsonB.run.id).toBe(nextJsonB.run.id);

    const directStatus = runCli(["workflow", "status", startJsonA.run.id], env, workB);
    expect(directStatus.status).toBe(0);
    const directStatusJson = JSON.parse(directStatus.stdout) as { run: { id: string } };
    expect(directStatusJson.run.id).toBe(startJsonA.run.id);
  });

  test("show only exposes the active workflow run for the current working directory", () => {
    const env = createWorkflowEnv();
    const sourceDir = makeTempDir("akm-workflow-source-");
    const sourcePath = path.join(sourceDir, "release.md");
    const workA = makeTempDir("akm-workflow-show-a-");
    const workB = makeTempDir("akm-workflow-show-b-");
    fs.writeFileSync(sourcePath, RELEASE_WORKFLOW, "utf8");

    expect(runCli(["workflow", "create", "release", "--from", sourcePath], env).status).toBe(0);
    const started = runCli(["workflow", "start", "workflow:release"], env, workA);
    expect(started.status).toBe(0);
    const startedJson = JSON.parse(started.stdout) as { run: { id: string } };

    const shownA = runCli(["show", "workflow:release"], env, workA);
    expect(shownA.status).toBe(0);
    const shownJsonA = JSON.parse(shownA.stdout) as { activeRun?: { runId: string } };
    expect(shownJsonA.activeRun?.runId).toBe(startedJson.run.id);

    const shownB = runCli(["show", "workflow:release"], env, workB);
    expect(shownB.status).toBe(0);
    const shownJsonB = JSON.parse(shownB.stdout) as { activeRun?: { runId: string } };
    expect(shownJsonB.activeRun).toBeUndefined();
  });
});

describe("workflow CLI — qa fixes", () => {
  test("resume flips a blocked run back to active", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    // Complete first step as blocked
    expect(runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env).status).toBe(0);

    // Verify it's blocked
    const statusBlocked = runCli(["workflow", "status", startRun.id], env);
    expect(statusBlocked.status).toBe(0);
    const { run: blockedRun } = JSON.parse(statusBlocked.stdout) as { run: { status: string } };
    expect(blockedRun.status).toBe("blocked");

    // Resume it
    const resumed = runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(0);
    const { run: resumedRun } = JSON.parse(resumed.stdout) as { run: { status: string } };
    expect(resumedRun.status).toBe("active");
  });

  test("resume on a completed run returns an error", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first"], env).status).toBe(0);
    expect(runCli(["workflow", "complete", startRun.id, "--step", "second"], env).status).toBe(0);

    const resumed = runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(2);
    const err = JSON.parse(resumed.stderr) as { error: string };
    expect(err.error).toContain("already completed");
  });

  test("resume on a failed run flips it to active", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "failed"], env).status).toBe(0);

    const resumed = runCli(["workflow", "resume", startRun.id], env);
    expect(resumed.status).toBe(0);
    const { run: resumedRun } = JSON.parse(resumed.stdout) as { run: { status: string } };
    expect(resumedRun.status).toBe("active");
  });

  // Issue #156: after resuming a blocked run, the previously-blocked step must be
  // re-actionable so it can be reclassified to completed/failed/skipped.
  for (const newState of ["completed", "failed", "skipped"] as const) {
    test(`resume re-opens a blocked step so it can be reclassified to ${newState}`, () => {
      const env = createWorkflowEnv();
      setupWorkflow(env);

      const started = runCli(["workflow", "start", "workflow:test-flow"], env);
      expect(started.status).toBe(0);
      const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

      expect(runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env).status).toBe(
        0,
      );
      expect(runCli(["workflow", "resume", startRun.id], env).status).toBe(0);

      const reclassified = runCli(
        ["workflow", "complete", startRun.id, "--step", "first", "--state", newState, "--notes", "resolved"],
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

  test("resume does not disturb already-completed earlier steps", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first"], env).status).toBe(0);
    expect(runCli(["workflow", "complete", startRun.id, "--step", "second", "--state", "blocked"], env).status).toBe(0);
    expect(runCli(["workflow", "resume", startRun.id], env).status).toBe(0);

    const status = runCli(["workflow", "status", startRun.id], env);
    expect(status.status).toBe(0);
    const detail = JSON.parse(status.stdout) as {
      workflow: { steps: Array<{ id: string; status: string }> };
    };
    expect(detail.workflow.steps.find((s) => s.id === "first")?.status).toBe("completed");
    expect(detail.workflow.steps.find((s) => s.id === "second")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 2. listWorkflowRuns --active includes blocked runs
// ---------------------------------------------------------------------------
describe("workflow list --active includes blocked", () => {
  test("blocked run appears in --active list", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first", "--state", "blocked"], env).status).toBe(0);

    const listed = runCli(["workflow", "list", "--ref", "workflow:test-flow", "--active"], env);
    expect(listed.status).toBe(0);
    const { runs } = JSON.parse(listed.stdout) as { runs: Array<{ id: string; status: string }> };
    expect(runs.some((r) => r.id === startRun.id && r.status === "blocked")).toBe(true);
  });

  test("completed run does NOT appear in --active list", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first"], env).status).toBe(0);
    expect(runCli(["workflow", "complete", startRun.id, "--step", "second"], env).status).toBe(0);

    const listed = runCli(["workflow", "list", "--active"], env);
    expect(listed.status).toBe(0);
    const { runs } = JSON.parse(listed.stdout) as { runs: Array<{ id: string }> };
    expect(runs.some((r) => r.id === startRun.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. workflow next on a completed run: done:true, step:null
// ---------------------------------------------------------------------------
describe("workflow next — completed run signals done", () => {
  test("next on a completed run-id returns done:true and step:null", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    expect(runCli(["workflow", "complete", startRun.id, "--step", "first"], env).status).toBe(0);
    expect(runCli(["workflow", "complete", startRun.id, "--step", "second"], env).status).toBe(0);

    const next = runCli(["workflow", "next", startRun.id], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { done?: boolean; step: unknown };
    expect(nextJson.done).toBe(true);
    expect(nextJson.step).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. workflow next <ref> auto-start: autoStarted:true
// ---------------------------------------------------------------------------
describe("workflow next — auto-start flags autoStarted", () => {
  test("next on a ref with no existing run returns autoStarted:true", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const next = runCli(["workflow", "next", "workflow:test-flow"], env);
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

  test("next on a ref with existing active run does NOT set autoStarted", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    // First call auto-starts
    const first = runCli(["workflow", "next", "workflow:test-flow"], env);
    expect(first.status).toBe(0);

    // Second call resumes existing — no autoStarted
    const second = runCli(["workflow", "next", "workflow:test-flow"], env);
    expect(second.status).toBe(0);
    const secondJson = JSON.parse(second.stdout) as { autoStarted?: boolean };
    expect(secondJson.autoStarted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. workflow next --params: sets params on auto-start; fails on existing run
// ---------------------------------------------------------------------------
describe("workflow next --params", () => {
  test("--params is accepted when auto-starting a new run", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const next = runCli(["workflow", "next", "workflow:test-flow", "--params", '{"x":1}'], env);
    expect(next.status).toBe(0);
    const nextJson = JSON.parse(next.stdout) as { run: { params?: Record<string, unknown> }; autoStarted?: boolean };
    expect(nextJson.autoStarted).toBe(true);
    expect(nextJson.run.params?.x).toBe(1);
  });

  test("--params fails when an active run already exists (ref specifier)", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    // Start a run first
    expect(runCli(["workflow", "start", "workflow:test-flow"], env).status).toBe(0);

    const next = runCli(["workflow", "next", "workflow:test-flow", "--params", '{"x":1}'], env);
    expect(next.status).toBe(2);
    const err = JSON.parse(next.stderr) as { error: string };
    expect(err.error).toContain("--params can only be set on a new run");
  });

  test("--params fails when given a direct run-id (existing run)", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    const next = runCli(["workflow", "next", startRun.id, "--params", '{"x":1}'], env);
    expect(next.status).toBe(2);
    const err = JSON.parse(next.stderr) as { error: string };
    expect(err.error).toContain("--params can only be used when starting a new run from a workflow ref");
    expect(err.error).toContain("existing run id");
  });
});

describe("workflow CLI — status create", () => {
  test("status workflow:<name> resolves to the most-recently-updated run", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    const status = runCli(["workflow", "status", "workflow:test-flow"], env);
    expect(status.status).toBe(0);
    const statusJson = JSON.parse(status.stdout) as { run: { id: string; status: string } };
    expect(statusJson.run.id).toBe(startRun.id);
    expect(statusJson.run.status).toBe("active");
  });

  test("status workflow:<name> returns NotFoundError when no runs exist", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const status = runCli(["workflow", "status", "workflow:test-flow"], env);
    // No runs created yet — should fail with not-found (exit 1)
    expect(status.status).toBe(1);
    const err = JSON.parse(status.stderr) as { error: string };
    expect(err.error).toContain("No workflow runs found");
  });

  test("status workflow:<name> resolves within the current working-directory scope", () => {
    const env = createWorkflowEnv();
    const workA = makeTempDir("akm-wfqa-scope-a-");
    const workB = makeTempDir("akm-wfqa-scope-b-");
    setupWorkflow(env);

    const startedA = runCli(["workflow", "start", "workflow:test-flow"], env, workA);
    expect(startedA.status).toBe(0);
    const { run: runA } = JSON.parse(startedA.stdout) as { run: { id: string } };

    const startedB = runCli(["workflow", "start", "workflow:test-flow"], env, workB);
    expect(startedB.status).toBe(0);
    const { run: runB } = JSON.parse(startedB.stdout) as { run: { id: string } };

    const statusA = runCli(["workflow", "status", "workflow:test-flow"], env, workA);
    expect(statusA.status).toBe(0);
    expect((JSON.parse(statusA.stdout) as { run: { id: string } }).run.id).toBe(runA.id);

    const statusB = runCli(["workflow", "status", "workflow:test-flow"], env, workB);
    expect(statusB.status).toBe(0);
    expect((JSON.parse(statusB.stdout) as { run: { id: string } }).run.id).toBe(runB.id);
  });

  test("next with an unknown run id returns WORKFLOW_NOT_FOUND", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const next = runCli(["workflow", "next", "bogus-run-id"], env);
    expect(next.status).toBe(1);
    const err = JSON.parse(next.stderr) as { code: string; hint?: string };
    expect(err.code).toBe("WORKFLOW_NOT_FOUND");
    expect(err.hint).toContain("akm workflow list --active");
  });

  test("status with an unknown run id returns WORKFLOW_NOT_FOUND", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const status = runCli(["workflow", "status", "bogus-run-id"], env);
    expect(status.status).toBe(1);
    const err = JSON.parse(status.stderr) as { code: string; hint?: string };
    expect(err.code).toBe("WORKFLOW_NOT_FOUND");
    expect(err.hint).toContain("akm workflow list --active");
  });
});

// ---------------------------------------------------------------------------
// 7. workflow create name validation
// ---------------------------------------------------------------------------
describe("workflow create — name validation", () => {
  test("name with spaces is rejected", () => {
    const env = createWorkflowEnv();

    const result = runCli(["workflow", "create", "name with spaces"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Workflow name must start with a lowercase letter");
  });

  test("name with uppercase is rejected", () => {
    const env = createWorkflowEnv();

    const result = runCli(["workflow", "create", "MyWorkflow"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Workflow name must start with a lowercase letter");
  });

  test("valid lowercase name is accepted", () => {
    const env = createWorkflowEnv();

    const result = runCli(["workflow", "create", "my-workflow"], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string };
    expect(json.ref).toBe("workflow:my-workflow");
  });

  test("hierarchical name with forward slash is accepted", () => {
    // Slashes are allowed for hierarchical naming (e.g. release/ship)
    const env = createWorkflowEnv();

    const result = runCli(["workflow", "create", "release/ship"], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string };
    expect(json.ref).toBe("workflow:release/ship");
  });

  test("name validation error message mentions slashes", () => {
    const env = createWorkflowEnv();

    const result = runCli(["workflow", "create", "BAD NAME"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("slashes");
  });
});

// ---------------------------------------------------------------------------
// 8. workflow create --force without --from/--reset is rejected
// ---------------------------------------------------------------------------
describe("workflow create --force guard", () => {
  test("--force without --from or --reset is rejected", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const result = runCli(["workflow", "create", "test-flow", "--force"], env);
    expect(result.status).toBe(2);
    const err = JSON.parse(result.stderr) as { error: string };
    expect(err.error).toContain("Refusing to overwrite with template");
  });

  test("--force --reset succeeds and overwrites with template", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const result = runCli(["workflow", "create", "test-flow", "--force", "--reset"], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("workflow:test-flow");
  });

  test("--force --from <file> succeeds and overwrites with file content", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const sourceDir = makeTempDir("akm-wfqa-src2-");
    const sourcePath = path.join(sourceDir, "new.md");
    fs.writeFileSync(sourcePath, TWO_STEP_WORKFLOW, "utf8");

    const result = runCli(["workflow", "create", "test-flow", "--force", "--from", sourcePath], env);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. complete --state help text documents default (just ensure it runs)
// ---------------------------------------------------------------------------
describe("workflow complete --state default", () => {
  test("complete without --state defaults to completed", () => {
    const env = createWorkflowEnv();
    setupWorkflow(env);

    const started = runCli(["workflow", "start", "workflow:test-flow"], env);
    expect(started.status).toBe(0);
    const { run: startRun } = JSON.parse(started.stdout) as { run: { id: string } };

    // No --state flag → should default to 'completed'
    const completed = runCli(["workflow", "complete", startRun.id, "--step", "first"], env);
    expect(completed.status).toBe(0);
    const json = JSON.parse(completed.stdout) as { workflow: { steps: Array<{ id: string; status: string }> } };
    const step = json.workflow.steps.find((s) => s.id === "first");
    expect(step?.status).toBe("completed");
  });
});
