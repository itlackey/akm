// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli";
import { parseWorkflow } from "../src/workflows/parser";
import { parseWorkflowRefInput } from "../src/workflows/runtime/workflow-asset-loader";
import { runCliCapture } from "./_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeWorkflowTestConfig,
} from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
const sourceDirs: SandboxedDir[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => {
  for (const source of sourceDirs.splice(0)) source.cleanup();
  storage.cleanup();
});

function sourceFile(name: string, content: string): string {
  const source = makeSandboxDir("akm-workflow-source-");
  sourceDirs.push(source);
  const file = path.join(source.dir, `${name}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

async function createWorkflow(name: string, content: string): Promise<void> {
  const result = await runCliCapture(["workflow", "create", name, "--from", sourceFile(name, content)]);
  if (result.code !== 0) throw new Error(`workflow create failed: ${result.stderr}`);
}

function errorEnvelope(stderr: string): { ok: false; code: string; error: string; hint?: string } {
  const start = stderr.lastIndexOf("\n{");
  return JSON.parse(start >= 0 ? stderr.slice(start + 1) : stderr);
}

const ROUTED_WORKFLOW = `---
type: workflow
description: Typed parameter workflow
params:
  include_processes: { type: boolean }
  count: { type: integer, minimum: 1 }
  labels: { type: array, items: { type: string } }
steps:
  - id: choose
    route:
      input: params.include_processes
      when: [{ match: "true", step: finish }]
      default: finish
  - id: finish
---

## choose

## finish

Finish the workflow.
`;

/** A one-step workflow whose unit is a shell command — no engine required. */
function execWorkflow(command: string[]): string {
  return [
    "---",
    "type: workflow",
    "description: Exec workflow",
    "steps:",
    "  - id: work",
    "    unit:",
    "      exec:",
    `        command: ${JSON.stringify(command)}`,
    "---",
    "",
    "## work",
    "",
    "Do it.",
    "",
  ].join("\n");
}

describe("workflow CLI", () => {
  test("runtime accepts only canonical conceptId refs", () => {
    expect(parseWorkflowRefInput("workflows/release")).toEqual({
      conceptId: "workflows/release",
      bundle: undefined,
    });
    expect(parseWorkflowRefInput("team//workflows/release")).toEqual({
      conceptId: "workflows/release",
      bundle: "team",
    });
    expect(() => parseWorkflowRefInput("workflow:release")).toThrow();
  });

  test("create --print emits a valid raw document without writing", async () => {
    const result = await runCliCapture(["workflow", "create", "print-test", "--print"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
    const parsed = parseWorkflow(result.stdout, { path: "<template>" });
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "print-test.md"))).toBe(false);
  });

  test("create --force alone replaces an existing workflow with a fresh template", async () => {
    await createWorkflow("template-target", ROUTED_WORKFLOW);
    const assetPath = path.join(storage.stashDir, "workflows", "template-target.md");
    expect(fs.readFileSync(assetPath, "utf8")).toContain("route:");

    const result = await runCliCapture(["workflow", "create", "template-target", "--force"]);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(assetPath, "utf8")).not.toContain("route:");
  });

  test("create --from rejects invalid and duplicate-step documents", async () => {
    const invalid = await runCliCapture([
      "workflow",
      "create",
      "invalid",
      "--from",
      sourceFile("invalid", "---\ntype: workflow\nsteps:\n  - id: broken\n---\n"),
    ]);
    expect(invalid.code).toBe(2);
    expect(errorEnvelope(invalid.stderr).error).toContain('"## broken" body section');

    const duplicate = ROUTED_WORKFLOW.replace("- id: finish", "- id: choose");
    const duplicated = await runCliCapture([
      "workflow",
      "create",
      "duplicate",
      "--from",
      sourceFile("duplicate", duplicate),
    ]);
    expect(duplicated.code).toBe(2);
    expect(errorEnvelope(duplicated.stderr).error).toContain("Duplicate step id");
  });

  test("run materializes exact typed flags and persists a resumable partial run", async () => {
    await createWorkflow("typed", ROUTED_WORKFLOW);

    const result = await runCliCapture([
      "workflow",
      "run",
      "workflows/typed",
      "--include_processes=true",
      "--count",
      "2",
      "--labels=api",
      "--labels",
      "worker",
      "--max-steps",
      "1",
    ]);
    expect(result.code).toBe(0);
    const run = JSON.parse(result.stdout) as {
      run: { id: string; status: string; currentStepId: string; params: Record<string, unknown> };
      executed: Array<{ stepId: string }>;
    };
    expect(run.run).toMatchObject({
      status: "active",
      currentStepId: "finish",
      params: { include_processes: true, count: 2, labels: ["api", "worker"] },
    });
    expect(run.executed.map((step) => step.stepId)).toEqual(["choose"]);

    const status = await runCliCapture(["workflow", "status", run.run.id]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ run: { id: run.run.id, currentStepId: "finish" } });

    const listed = await runCliCapture(["workflow", "list", "--active"]);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.stdout) as { runs: Array<{ id: string }> }).runs.map((item) => item.id)).toEqual([
      run.run.id,
    ]);
  });

  test("--timeout tags an unfinished run, and never a run that reached completed", async () => {
    // An exec unit needs no engine, so both runs below execute for real.
    await createWorkflow("wedged", execWorkflow(["bun", "-e", "await Bun.sleep(30000)"]));
    const wedged = await runCliCapture(["workflow", "run", "workflows/wedged", "--timeout=150ms"]);
    expect(wedged.code).toBe(1);
    // #918: `ok` must mirror the same failed/blocked/gateRejection/aborted
    // predicate that already drives the nonzero exit code — an aborted run
    // must never read as ok:true.
    expect(JSON.parse(wedged.stdout)).toMatchObject({
      run: { status: "active" },
      aborted: true,
      timedOut: true,
      ok: false,
    });

    await createWorkflow("quick", execWorkflow(["bun", "-e", "process.stdout.write('ok')"]));
    const completed = await runCliCapture(["workflow", "run", "workflows/quick"]);
    expect(completed.code).toBe(0);
    const completedEnvelope = JSON.parse(completed.stdout) as { run: { id: string; status: string }; ok: boolean };
    const finished = completedEnvelope.run;
    expect(finished.status).toBe("completed");
    expect(completedEnvelope.ok).toBe(true);

    // Re-running a completed run is a no-op that returns `done`; a deadline
    // that fires around it describes nothing an operator could resume.
    const rerun = await runCliCapture(["workflow", "run", finished.id, "--timeout=1ms"]);
    expect(rerun.code).toBe(0);
    const rendered = JSON.parse(rerun.stdout) as { run: { status: string }; done?: true; timedOut?: true };
    expect(rendered.run.status).toBe("completed");
    expect(rendered.done).toBe(true);
    expect(rendered.timedOut).toBeUndefined();
  });

  test("run rejects aliases, retired JSON params, and params on an active run", async () => {
    await createWorkflow("strict", ROUTED_WORKFLOW);

    const alias = await runCliCapture([
      "workflow",
      "run",
      "workflows/strict",
      "--include-processes=true",
      "--count=1",
      "--labels=x",
      "--max-steps=1",
    ]);
    expect(alias.code).toBe(2);
    expect(errorEnvelope(alias.stderr).error).toContain("must exactly match");

    const jsonParams = await runCliCapture([
      "workflow",
      "run",
      "workflows/strict",
      "--params",
      '{"include_processes":true}',
    ]);
    expect(jsonParams.code).toBe(2);
    expect(errorEnvelope(jsonParams.stderr).error).toContain("--params was removed");

    const started = await runCliCapture([
      "workflow",
      "run",
      "workflows/strict",
      "--include_processes=true",
      "--count=1",
      "--labels=x",
      "--max-steps=1",
    ]);
    expect(started.code).toBe(0);
    const activeWithParams = await runCliCapture([
      "workflow",
      "run",
      "workflows/strict",
      "--include_processes=false",
      "--max-steps=1",
    ]);
    expect(activeWithParams.code).toBe(2);
    expect(errorEnvelope(activeWithParams.stderr).error).toContain("only be set on a new run");
  });

  test("removed manual lifecycle commands fail with explicit migration hints", async () => {
    // brief/report joined the retired set when the external-driver protocol
    // was removed, so every hint here must name a command that still exists.
    for (const command of ["start", "next", "complete", "brief", "report"]) {
      const result = await runCliCapture(["workflow", command, "workflows/demo"]);
      expect(result.code).toBe(2);
      const envelope = errorEnvelope(result.stderr);
      expect(envelope.code).toBe("UNKNOWN_COMMAND");
      expect(envelope.hint).toContain(command === "next" ? "workflow status" : "workflow run");
    }
  });

  test("the workflow command tree exposes canonical controls and omits removed commands", () => {
    const commands = main.subCommands as unknown as Record<
      string,
      { subCommands?: Record<string, { args?: Record<string, unknown> }> }
    >;
    const workflow = commands.workflow;
    const names = Object.keys(workflow?.subCommands ?? {});
    expect(names).toContain("run");
    expect(names).not.toContain("start");
    expect(names).not.toContain("next");
    expect(names).not.toContain("complete");
    expect(names).not.toContain("brief");
    expect(names).not.toContain("report");
    const args = Object.keys(workflow?.subCommands?.run?.args ?? {});
    expect(args).toContain("max-steps");
    expect(args).toContain("max-retries");
    expect(args).toContain("timeout");
    expect(args).not.toContain("params");
  });
});
