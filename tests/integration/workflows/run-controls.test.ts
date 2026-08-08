// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { getWorkflowStatus, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", `${name}.md`),
    [
      "---",
      "type: workflow",
      "description: Run control test",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the work.",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("workflow invocation controls", () => {
  test("maxRetries resumes the failed step and reuses the same run", async () => {
    writeWorkflow("retry");
    const started = await startWorkflowRun("workflows/retry");
    let calls = 0;
    const dispatcher: UnitDispatcher = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, text: "", failureReason: "spawn_failed", error: "temporary failure" }
        : { ok: true, text: "completed on retry" };
    };

    const result = await runWorkflowSteps({ target: started.run.id, maxRetries: 1, dispatcher });

    expect(result.run).toMatchObject({ id: started.run.id, status: "completed" });
    expect(result.done).toBe(true);
    expect(result.executed).toHaveLength(2);
    expect(calls).toBe(2);
    const units = await getWorkflowStatus(started.run.id, { includeUnits: true });
    expect(units.units?.[0]).toMatchObject({ status: "completed", attempts: 2 });
  });

  test("maxSteps counts a step's WHOLE bounded gate loop as ONE step (bug 4 regression)", async () => {
    // Pre-fix, `executed.push(...)` per gate-loop iteration was what the
    // maxSteps guard counted: a step with max_loops 3 that rejected twice
    // consumed the whole `--max-steps 3` budget mid-step. The budget counts
    // DISTINCT processed spine steps now.
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "workflows", "looped.md"),
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: work",
        "    gate: { max_loops: 3 }",
        "  - id: wrap-up",
        "---",
        "",
        "## work",
        "",
        "Do the work.",
        "",
        "### gate",
        "",
        "the work is thorough",
        "",
        "## wrap-up",
        "",
        "Wrap up.",
        "",
      ].join("\n"),
      "utf8",
    );
    const started = await startWorkflowRun("workflows/looped");
    let judgeCalls = 0;
    const nodes: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      maxSteps: 2,
      dispatcher: async (req) => {
        nodes.push(req.nodeId);
        return { ok: true, text: `did ${req.unitId}` };
      },
      // Reject twice, pass on the third loop — the step's whole
      // evaluator-optimizer cycle must cost ONE step of the budget.
      summaryJudge: async () => {
        judgeCalls++;
        return judgeCalls <= 2
          ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Deeper."}'
          : '{"complete": true, "missing": []}';
      },
    });

    expect(judgeCalls).toBe(3);
    expect(nodes).toEqual(["work", "work", "work", "wrap-up"]);
    // The per-loop `executed` report keeps every attempt (telemetry), but the
    // step budget counted work once: both spine steps fit in --max-steps 2.
    expect(result.executed.map((s) => s.stepId)).toEqual(["work", "work", "work", "wrap-up"]);
    expect(result.stepsProcessed).toBe(2);
    expect(result.done).toBe(true);
    expect(result.run.status).toBe("completed");
  });

  test("route-skipped steps do not consume the maxSteps budget (bug 4 regression)", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "workflows", "routed.md"),
      [
        "---",
        "type: workflow",
        "params:",
        "  pick: { type: string }",
        "steps:",
        "  - id: choose",
        "    route:",
        "      input: params.pick",
        "      when: [{ match: left, step: left }, { match: right, step: right }]",
        "  - id: left",
        "  - id: right",
        "---",
        "",
        "## choose",
        "",
        "Choose.",
        "",
        "## left",
        "",
        "Left branch.",
        "",
        "## right",
        "",
        "Right branch.",
        "",
      ].join("\n"),
      "utf8",
    );
    const started = await startWorkflowRun("workflows/routed", { pick: "right" });
    const nodes: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      maxSteps: 2,
      dispatcher: async (req) => {
        nodes.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      summaryJudge: null,
    });

    // choose (route decision) is step 1, right is step 2; the skipped `left`
    // costs nothing — pre-fix it ate the budget and the run stalled before
    // `right` despite --max-steps 2 covering both real steps.
    expect(nodes).toEqual(["right"]);
    expect(result.executed.map((s) => s.stepId)).toEqual(["choose", "left", "right"]);
    expect(result.stepsProcessed).toBe(2);
    expect(result.done).toBe(true);
    const status = await getWorkflowStatus(started.run.id);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
    expect(byId.get("choose")).toBe("completed");
    expect(byId.get("left")).toBe("skipped");
    expect(byId.get("right")).toBe("completed");
  });

  test("an aborted invocation leaves the step active and releases its lease", async () => {
    writeWorkflow("timeout");
    const started = await startWorkflowRun("workflows/timeout");
    const controller = new AbortController();
    const dispatcher: UnitDispatcher = async (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => resolve({ ok: false, text: "", failureReason: "aborted", error: "interrupted" }),
          { once: true },
        );
      });
    const timer = setTimeout(() => controller.abort(new Error("test timeout")), 10);

    try {
      const result = await runWorkflowSteps({ target: started.run.id, signal: controller.signal, dispatcher });
      expect(result).toMatchObject({ aborted: true, run: { status: "active", currentStepId: "work" } });
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
      expect(row?.engine_lease_holder).toBeNull();
      expect(row?.engine_lease_until).toBeNull();
    } finally {
      clearTimeout(timer);
    }
  });
});
