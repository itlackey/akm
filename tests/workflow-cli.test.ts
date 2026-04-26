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
  return {
    ...process.env,
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
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
  });

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
  });

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
});
