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
  });

  test("items containing $-substitution patterns interpolate verbatim (peer review #1)", async () => {
    const items = ["src/a$&b.ts", "Makefile uses $$(CC)", "printf $'x'"];
    seedRun({ params: { files: items }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: items, note: "cost is $& today" },
      evidence: {},
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "ok" };
      },
    });
    expect(prompts.some((p) => p.includes("Review src/a$&b.ts carefully."))).toBe(true);
    expect(prompts.some((p) => p.includes("Review Makefile uses $$(CC) carefully."))).toBe(true);
    expect(prompts.some((p) => p.includes("Review printf $'x' carefully."))).toBe(true);
    // Preamble params JSON must also survive $-patterns un-mangled.
    expect(prompts.every((p) => p.includes("cost is $& today"))).toBe(true);
    expect(prompts.every((p) => !p.includes("{{item}}") && !p.includes("{{PARAMS_JSON}}"))).toBe(true);

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

  test("fan-out keys never resolve from Object.prototype (own properties only)", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const TOSTRING_WF = FAN_OUT_WF.replace("over: files", "over: toString");
    const stepPlan = plan(TOSTRING_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: { prior: { unrelated: true } },
      dispatcher: async () => ({ ok: true, text: "must not run" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not found");
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

describe("executeStepPlan — harness-native session id journaling (P2 peer review)", () => {
  test("a dispatcher-revealed sessionId is persisted on the unit row and rehydrated on reuse", async () => {
    // Peer-review regression: defaultUnitDispatcher extracts the harness
    // session id (e.g. codex `session_configured`), but it used to evaporate
    // inside dispatchUnit — never reaching workflow_run_units.session_id.
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const ctx = { runId: RUN_ID, workflowRef: "workflow:demo", params: {}, evidence: {} };

    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}', sessionId: "codex-abc-123" }),
    });
    expect(first.ok).toBe(true);
    expect(first.units[0].sessionId).toBe("codex-abc-123");

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "extract");
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("codex-abc-123");
    });

    // Durable-row reuse rehydrates the journaled session id without re-dispatch.
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        throw new Error("must not re-dispatch");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.units[0].sessionId).toBe("codex-abc-123");
  });

  test("a failed unit still journals the session id revealed before the failure", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => ({
        ok: false,
        text: "",
        failureReason: "timeout",
        error: "timed out",
        sessionId: "sess-before-crash",
      }),
    });
    expect(result.ok).toBe(false);
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows[0].status).toBe("failed");
      expect(rows[0].session_id).toBe("sess-before-crash");
    });
  });

  test("units whose dispatch reveals no sessionId journal NULL", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review")[0].session_id).toBeNull();
    });
  });
});

describe("executeStepPlan — durable-row reuse (peer review)", () => {
  test("re-executing a step reuses completed units with the same input hash instead of re-dispatching", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const ctx = {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a", "b"] },
      evidence: {},
    };

    let dispatches = 0;
    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async (req) => {
        dispatches++;
        return { ok: true, text: `run1 ${req.unitId}`, usage: { outputTokens: 7 } };
      },
    });
    expect(first.ok).toBe(true);
    expect(dispatches).toBe(2);

    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "run2 — must not happen" };
      },
    });
    expect(dispatches).toBe(2); // no re-dispatch
    expect(second.ok).toBe(true);
    expect(second.units.map((u) => u.text)).toEqual(["run1 review.unit[0]", "run1 review.unit[1]"]);
    expect(second.units.every((u) => u.tokens === 7)).toBe(true);

    // Journaled rows keep their original results (no OR REPLACE clobber).
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      expect(rows.every((r) => (r.result_json ?? "").includes("run1"))).toBe(true);
    });
  });

  test("a changed input hash re-dispatches instead of reusing", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    let dispatches = 0;
    const dispatcher = async () => {
      dispatches++;
      return { ok: true, text: "done" };
    };
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher,
    });
    // Same unit id (index 0) but a different item → different prompt hash.
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a-changed"] },
      evidence: {},
      dispatcher,
    });
    expect(dispatches).toBe(2);
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

  test("refuses a non-active run BEFORE dispatching any unit (peer review #2)", async () => {
    seedRun({ steps: [{ id: "first", title: "First" }] });
    const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
    try {
      db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(RUN_ID);
    } finally {
      closeWorkflowDatabase(db);
    }
    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan: async () => plan(TWO_STEP_WF),
      }),
    ).rejects.toThrow(/failed and cannot be executed/);
    expect(dispatches).toBe(0);
  });

  test("asserts Depends On edges before dispatching (peer review #6)", async () => {
    seedRun({
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const OUT_OF_ORDER = `# Workflow: D

## Step: First
Step ID: first

### Depends On
- second

### Instructions
x

## Step: Second
Step ID: second

### Instructions
y
`;
    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan: async () => plan(OUT_OF_ORDER),
      }),
    ).rejects.toThrow(/depends on step "second"/);
    expect(dispatches).toBe(0);
  });

  test("the lifetime unit cap is seeded from the run's journal (peer review #4)", async () => {
    seedRun({ steps: [{ id: "first", title: "First" }] });
    const { LIFETIME_UNIT_CAP } = await import("../../src/workflows/exec/scheduler");
    await withWorkflowRunsRepo((repo) => {
      for (let i = 0; i < LIFETIME_UNIT_CAP; i++) {
        repo.insertUnit({
          runId: RUN_ID,
          unitId: `prior[${i}]`,
          stepId: "warm-up",
          nodeId: "warm-up.unit",
          parentUnitId: null,
          phase: null,
          runner: null,
          model: null,
          inputHash: null,
          startedAt: new Date().toISOString(),
        });
      }
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: "should be blocked by the cap" }),
      loadPlan: async () => plan(TWO_STEP_WF),
    });
    expect(result.executed[0].ok).toBe(false);
    expect(result.executed[0].summary).toContain("lifetime unit cap");
    expect(result.run.status).toBe("failed");
  });

  test("routing: the selected branch runs, unselected targets are auto-skipped", async () => {
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "fix-bug", title: "Fix bug" },
        { id: "build-feature", title: "Build feature" },
        { id: "wrap-up", title: "Wrap up" },
      ],
    });
    const ROUTED_WF = `# Workflow: R

## Step: Classify
Step ID: classify

### Route
input: kind
when: bug => fix-bug
when: feature => build-feature

### Instructions
Classify.

### Schema
\`\`\`json
{ "type": "object", "properties": { "kind": { "type": "string" } }, "required": ["kind"] }
\`\`\`

## Step: Fix bug
Step ID: fix-bug

### Instructions
Fix it.

## Step: Build feature
Step ID: build-feature

### Instructions
Build it.

## Step: Wrap up
Step ID: wrap-up

### Instructions
Wrap up.
`;
    const dispatchedNodes: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatchedNodes.push(req.nodeId);
        return req.nodeId === "classify" ? { ok: true, text: '{"kind": "bug"}' } : { ok: true, text: "done" };
      },
      loadPlan: async () => plan(ROUTED_WF),
    });

    expect(result.done).toBe(true);
    // build-feature must never dispatch; classify, fix-bug, wrap-up do.
    expect(dispatchedNodes).toEqual(["classify", "fix-bug", "wrap-up"]);

    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("classify")?.status).toBe("completed");
    expect(byId.get("fix-bug")?.status).toBe("completed");
    expect(byId.get("build-feature")?.status).toBe("skipped");
    expect(byId.get("wrap-up")?.status).toBe("completed");
    // The routed step's evidence records the decision.
    expect(byId.get("classify")?.evidence?.route).toEqual({ input: "kind", value: "bug", selected: "fix-bug" });
  });

  test("routing: falls back to default, and an unroutable value fails the step", async () => {
    const ROUTED_WF = `# Workflow: R

## Step: Classify
Step ID: classify

### Route
input: kind
when: bug => fix-bug
default: triage

### Instructions
Classify.

### Schema
\`\`\`json
{ "type": "object", "properties": { "kind": { "type": "string" } }, "required": ["kind"] }
\`\`\`

## Step: Fix bug
Step ID: fix-bug

### Instructions
Fix it.

## Step: Triage
Step ID: triage

### Instructions
Triage it.
`;
    const NO_DEFAULT_WF = ROUTED_WF.replace("default: triage\n", "");

    // Default fallback: "question" matches no branch → triage runs, fix-bug skipped.
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "fix-bug", title: "Fix bug" },
        { id: "triage", title: "Triage" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.nodeId === "classify" ? { ok: true, text: '{"kind": "question"}' } : { ok: true, text: "done" },
      loadPlan: async () => plan(ROUTED_WF),
    });
    expect(result.done).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("fix-bug")?.status).toBe("skipped");
    expect(byId.get("triage")?.status).toBe("completed");

    // Unroutable: no matching branch and no default → the routing step fails.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "fix-bug", title: "Fix bug" },
      ],
    });
    const failed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"kind": "question"}' }),
      loadPlan: async () => plan(NO_DEFAULT_WF.replace(/## Step: Triage[\s\S]*$/, "")),
    });
    expect(failed.executed[0].ok).toBe(false);
    expect(failed.executed[0].summary).toContain("question");
    expect(failed.run.status).toBe("failed");
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
