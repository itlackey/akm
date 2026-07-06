// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import {
  executeStepPlan,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { parseWorkflow } from "../../src/workflows/parser";
import { getWorkflowStatus } from "../../src/workflows/runtime/runs";

/**
 * Native executor (orchestration plan P1): fan-out via the scheduler,
 * schema-validated structured output with retry, per-unit persistence, and
 * the engine loop that advances the gated step spine strictly through
 * `completeWorkflowStep`.
 *
 * All dispatch goes through an injected fake dispatcher — no agent binaries,
 * no LLM. The workflow DB is a sandboxed tmp dir via AKM_DATA_DIR.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "44444444-4444-4444-8444-444444444444";

function seedRun(opts: { params?: Record<string, unknown>; steps: Array<{ id: string; title: string }> }): void {
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(opts.params ?? {}), opts.steps[0].id, now, now);
    opts.steps.forEach((step, i) => {
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

function plan(markdown: string) {
  const result = parseWorkflow(markdown, { path: "workflows/demo.md" });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join(" | "));
  return compileWorkflowPlan(result.document);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-native-exec-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const FAN_OUT_WF = `# Workflow: Review

## Step: Review files
Step ID: review

### Fan-out
over: files
concurrency: 4

### Instructions
Review {{item}} carefully.
`;

describe("executeStepPlan — fan-out", () => {
  test("dispatches one unit per item, interpolates {{item}}, persists unit rows", async () => {
    seedRun({ params: { files: ["a.ts", "b.ts", "c.ts"] }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      prompts.push(req.prompt);
      return { ok: true, text: `reviewed ${req.unitId}` };
    };

    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a.ts", "b.ts", "c.ts"] },
      evidence: {},
      dispatcher,
    });

    expect(result.ok).toBe(true);
    expect(result.units).toHaveLength(3);
    expect(prompts.some((p) => p.includes("Review a.ts carefully."))).toBe(true);
    expect(prompts.every((p) => p.includes(RUN_ID))).toBe(true); // preamble carries the run id

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      expect(rows.every((r) => r.node_id === "review.unit")).toBe(true);
    });
  });

  test("items can come from a prior step's evidence", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const dispatcher = async (): Promise<UnitDispatchResult> => ({ ok: true, text: "done" });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: { discover: { files: ["x.ts", "y.ts"] } },
      dispatcher,
    });
    expect(result.units).toHaveLength(2);
  });

  test("a non-array fan-out source fails the step with a clear error", async () => {
    seedRun({ params: { files: "not-a-list" }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: "not-a-list" },
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "unused" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("files");
  });

  test("unit failures are recorded with their failure reason and fail the step", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> =>
      req.prompt.includes("Review a")
        ? { ok: true, text: "fine" }
        : { ok: false, text: "", failureReason: "timeout", error: "timed out" };

    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a", "b"] },
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(false);
    expect(result.units.filter((u) => !u.ok)).toHaveLength(1);
    await withWorkflowRunsRepo((repo) => {
      const failed = repo.getUnitsForStep(RUN_ID, "review").filter((r) => r.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].failure_reason).toBe("timeout");
    });
  });
});

const SCHEMA_WF = `# Workflow: Extract

## Step: Extract facts
Step ID: extract

### Instructions
Extract facts.

### Schema
\`\`\`json
{ "type": "object", "properties": { "fact": { "type": "string" } }, "required": ["fact"] }
\`\`\`
`;

describe("executeStepPlan — structured output", () => {
  test("valid JSON on first attempt is parsed and stored", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
    });
    expect(result.ok).toBe(true);
    expect(result.units[0].result).toEqual({ fact: "bun is fast" });
  });

  test("schema violation retries once with corrective feedback, then succeeds", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const feedbacks: Array<string | undefined> = [];
    let call = 0;
    const dispatcher = async (_req: UnitDispatchRequest, feedback?: string): Promise<UnitDispatchResult> => {
      feedbacks.push(feedback);
      call++;
      return call === 1 ? { ok: true, text: '{"wrong": true}' } : { ok: true, text: '{"fact": "fixed"}' };
    };
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(true);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("fact");
    expect(result.units[0].result).toEqual({ fact: "fixed" });
  });

  test("persistent schema violation records a validation failure", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"nope": 1}' }),
    });
    expect(result.ok).toBe(false);
    expect(result.units[0].failureReason).toBe("validation_error");
  });
});

const VOTE_WF = `# Workflow: Vote

## Step: Judge
Step ID: judge

### Fan-out
over: attempts
reducer: vote

### Instructions
Judge attempt {{item}}.

### Schema
\`\`\`json
{ "type": "object", "properties": { "verdict": { "type": "string" } }, "required": ["verdict"] }
\`\`\`
`;

describe("executeStepPlan — vote reducer", () => {
  test("majority verdict wins", async () => {
    seedRun({ params: { attempts: [1, 2, 3] }, steps: [{ id: "judge", title: "Judge" }] });
    let call = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      call++;
      return { ok: true, text: call === 2 ? '{"verdict": "fail"}' : '{"verdict": "pass"}' };
    };
    const stepPlan = plan(VOTE_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { attempts: [1, 2, 3] },
      evidence: {},
      dispatcher,
      maxConcurrency: 1,
    });
    expect(result.ok).toBe(true);
    expect((result.evidence.vote as { winner: unknown }).winner).toEqual({ verdict: "pass" });
  });
});

describe("runWorkflowSteps — engine loop over the gated spine", () => {
  const TWO_STEP_WF = `# Workflow: Demo

## Step: First
Step ID: first

### Instructions
Do first.

## Step: Second
Step ID: second

### Instructions
Do second with {{params.flavor}}.
`;

  test("executes every step through completeWorkflowStep until the run completes", async () => {
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: `did ${req.nodeId}` };
      },
      loadPlan: async () => plan(TWO_STEP_WF),
    });

    expect(result.executed.map((s) => s.stepId)).toEqual(["first", "second"]);
    expect(result.done).toBe(true);
    expect(prompts[1]).toContain("vanilla");

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("completed");
    expect(status.workflow.steps.every((s) => s.status === "completed")).toBe(true);
    // Evidence carries the unit outcomes for downstream steps/consumers.
    expect(status.workflow.steps[0].evidence?.units).toBeDefined();
  });

  test("a failing step marks the run failed and stops the loop", async () => {
    seedRun({
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.nodeId === "first"
          ? { ok: false, text: "", failureReason: "non_zero_exit", error: "exit 1" }
          : { ok: true, text: "unreachable" },
      loadPlan: async () => plan(TWO_STEP_WF),
    });

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0].ok).toBe(false);
    expect(result.done).toBeUndefined();
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
  });

  test("maxSteps bounds the loop", async () => {
    seedRun({
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 1,
      dispatcher: async () => ({ ok: true, text: "ok" }),
      loadPlan: async () => plan(TWO_STEP_WF),
    });
    expect(result.executed).toHaveLength(1);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.run.currentStepId).toBe("second");
  });
});
