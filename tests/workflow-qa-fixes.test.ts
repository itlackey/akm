import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createWorkflowEnv(): NodeJS.ProcessEnv {
  const stashDir = makeTempDir("akm-wfqa-stash-");
  const xdgCache = makeTempDir("akm-wfqa-cache-");
  const xdgConfig = makeTempDir("akm-wfqa-config-");
  return {
    ...process.env,
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

// ---------------------------------------------------------------------------
// 1. resumeWorkflowRun — blocked → active; fails on completed
// ---------------------------------------------------------------------------
describe("workflow resume command", () => {
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

// ---------------------------------------------------------------------------
// 6. workflow status workflow:<name> resolves to most-recent run
// ---------------------------------------------------------------------------
describe("workflow status with workflow ref", () => {
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
