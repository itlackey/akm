// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Child workflows (Experimental, #1096): a markdown step declares
 * `unit: { workflow: workflows/<name>, with: {...} }`; the engine starts the
 * child as its own run, drives it to completion, and the child's last step
 * output is the composing step's output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { parseWorkflow } from "../../../src/workflows/parser";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function write(name: string, lines: readonly string[]): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

/** A child declaring one param and one structured step; its output is the child's result. */
function writeChild(name = "child"): void {
  write(name, [
    "---",
    "type: workflow",
    "defaults: { engine: test-agent }",
    "params:",
    "  topic: { type: string }",
    "steps:",
    "  - id: research",
    "    unit:",
    "      output: { type: object, properties: { finding: { type: string } }, required: [finding] }",
    "---",
    "",
    "## research",
    "",
    "CHILD-RESEARCH: investigate the topic.",
  ]);
}

/** The dispatcher answers the child's step with a finding, and echoes the parent's step prompt for inspection. */
function dispatcher(prompts: string[]): UnitDispatcher {
  return async (request) => {
    prompts.push(request.prompt);
    if (request.prompt.includes("CHILD-RESEARCH")) {
      return { ok: true, text: JSON.stringify({ finding: "widgets are fine" }) };
    }
    return { ok: true, text: "parent done" };
  };
}

describe("child workflows — markdown form", () => {
  test("a parent step runs the child with bound params and the child's last output reaches the next step", async () => {
    writeChild();
    write("parent", [
      "---",
      "type: workflow",
      "defaults: { engine: test-agent }",
      "params:",
      "  topic: { type: string }",
      "steps:",
      "  - id: investigate",
      "    unit:",
      "      workflow: workflows/child",
      "      with:",
      "        topic: { from: params.topic }",
      "  - id: report",
      "    inputs: [steps.investigate.output]",
      "---",
      "",
      "## investigate",
      "",
      "Run the child.",
      "",
      "## report",
      "",
      "PARENT-REPORT: summarise the finding.",
    ]);

    const started = await startWorkflowRun("workflows/parent", { topic: "widgets" });
    const prompts: string[] = [];
    const result = await runWorkflowSteps({ target: started.run.id, dispatcher: dispatcher(prompts) });

    expect(result.run.status).toBe("completed");
    // The child is its own run, linked to the parent, with the bound params.
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(started.run.id));
    expect(children).toHaveLength(1);
    expect(children[0]?.workflow_ref).toMatch(/workflows\/child$/);
    expect(children[0]?.status).toBe("completed");
    expect(JSON.parse(children[0]?.params_json ?? "{}")).toEqual({ topic: "widgets" });
    // The child's step prompt carried the bound param; the parent's next step got the child's output.
    expect(prompts.some((p) => p.includes("CHILD-RESEARCH") && p.includes("widgets"))).toBe(true);
    const report = prompts.find((p) => p.includes("PARENT-REPORT")) ?? "";
    expect(report).toContain("widgets are fine");
  });

  test("a failing child fails the composing step and the parent stops", async () => {
    writeChild();
    write("parent-fails", [
      "---",
      "type: workflow",
      "defaults: { engine: test-agent }",
      "steps:",
      "  - id: investigate",
      "    unit:",
      "      workflow: workflows/child",
      "      with: { topic: x }",
      "  - id: report",
      "---",
      "",
      "## investigate",
      "",
      "Run the child.",
      "",
      "## report",
      "",
      "PARENT-REPORT: never reached.",
    ]);

    const started = await startWorkflowRun("workflows/parent-fails");
    const prompts: string[] = [];
    const failing: UnitDispatcher = async (request) => {
      prompts.push(request.prompt);
      return { ok: false, text: "", failureReason: "spawn_failed", error: "child engine down" };
    };
    const result = await runWorkflowSteps({ target: started.run.id, dispatcher: failing });

    expect(result.run.status).toBe("failed");
    expect(prompts.some((p) => p.includes("PARENT-REPORT"))).toBe(false);
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(started.run.id));
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("failed");
  });

  test("a workflow that composes itself is refused at start as a cycle", async () => {
    write("loop", [
      "---",
      "type: workflow",
      "steps:",
      "  - id: again",
      "    unit: { workflow: workflows/loop }",
      "---",
      "",
      "## again",
      "",
      "Run myself.",
    ]);
    await expect(startWorkflowRun("workflows/loop")).rejects.toThrow(/cycle/i);
  });
});

describe("child workflows — parsing", () => {
  const parse = (unitLines: string) =>
    parseWorkflow(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: s",
        "    unit:",
        unitLines,
        "---",
        "",
        "## s",
        "",
        "Run it.",
        "",
      ].join("\n"),
      { path: "workflows/p.md" },
    );

  test("accepts a canonical ref with a with: mapping", () => {
    const result = parse("      workflow: workflows/child\n      with: { topic: x }");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[0]?.spec).toMatchObject({
      workflow: "workflows/child",
      with: { topic: "x" },
      instructions: "Run it.",
    });
  });

  test.each([
    ["a non-canonical ref", "      workflow: child", "canonical workflow ref"],
    ["a non-workflow ref", "      workflow: commands/child", "canonical workflow ref"],
    ["with: without workflow", "      with: { topic: x }", 'declares "with" without "workflow"'],
    ["exec beside workflow", "      workflow: workflows/c\n      exec: { command: [true] }", '"exec" and "workflow"'],
    ["engine beside workflow", "      workflow: workflows/c\n      engine: e", 'both "workflow" and "engine"'],
    ["env beside workflow", "      workflow: workflows/c\n      env: [env/x]", 'both "workflow" and "env"'],
  ])("rejects %s", (_label, unitLines, message) => {
    const result = parse(unitLines);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.message).join("\n")).toContain(message);
  });

  test("rejects workflow inside map.unit", () => {
    const result = parseWorkflow(
      [
        "---",
        "type: workflow",
        "params:",
        "  xs: { type: array }",
        "steps:",
        "  - id: s",
        "    map:",
        "      over: params.xs",
        "      unit: { workflow: workflows/child }",
        "---",
        "",
        "## s",
        "",
        "Run it.",
        "",
      ].join("\n"),
      { path: "workflows/p.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.message).join("\n")).toContain("not supported inside");
  });
});
