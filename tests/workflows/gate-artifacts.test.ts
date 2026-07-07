// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { compileWorkflowPlan, compileWorkflowProgram } from "../../src/workflows/ir/compile";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { getWorkflowStatus } from "../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../src/workflows/validate-summary";

/**
 * R2: typed artifacts + artifact-judging gates + bounded gate loops.
 *
 *   - `IrStepPlan.outputSchema` validates the PROMOTED artifact before the
 *     step can complete (fail-fast; errors in the summary).
 *   - Engine-driven completion of a criteria-bearing step passes a summary
 *     BUILT FROM the artifact (canonical JSON, 4000-char clip, one-line unit
 *     count) to the completion-criteria judge — real results, never the
 *     machine "Executed N unit(s)…" prose.
 *   - Every engine-driven judge call is journaled as a unit row
 *     (`<stepId>.gate:l<loop>`, node_id `<stepId>.gate`, runner "llm").
 *   - `gate.max_loops` re-executes the step subgraph with the judge feedback
 *     appended to unit prompts: the input hash changes, so loop 2 dispatches
 *     fresh work, journaled under `<unitId>~l2`.
 *
 * All dispatch goes through an injected fake dispatcher; the judge is the
 * `summaryJudge` seam on RunWorkflowOptions. Sandboxed workflow.db via
 * AKM_DATA_DIR.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "66666666-6666-4666-8666-666666666666";

function seedRun(opts: {
  params?: Record<string, unknown>;
  steps: Array<{ id: string; title?: string; criteria?: string[] }>;
}): void {
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
         VALUES (?, ?, ?, 'instructions', ?, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.title ?? step.id, step.criteria ? JSON.stringify(step.criteria) : null, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

function plan(yamlText: string): WorkflowPlanGraph {
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/demo.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-gate-artifacts-"));
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

// ── Typed artifacts: IrStepPlan.outputSchema ─────────────────────────────────

const TYPED_WF = `version: 1
name: Typed
steps:
  - id: discover
    title: Discover
    unit:
      instructions: Find files.
      output:
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
    output:
      type: object
      properties: { files: { type: array, items: { type: string } } }
      required: [files]
`;

describe("typed artifacts — outputSchema validates the promoted artifact before completion", () => {
  test("a schema-valid artifact completes the step and stays addressable", async () => {
    seedRun({ steps: [{ id: "discover" }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"files": ["a.ts", "b.ts"]}' }),
      loadPlan: async () => plan(TYPED_WF),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    expect(result.executed[0].ok).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].status).toBe("completed");
    expect(status.workflow.steps[0].evidence?.output).toEqual({ files: ["a.ts", "b.ts"] });
  });

  test("a schema-violating artifact fails the step with the validation errors in the summary", async () => {
    // The unit itself has NO schema (free text), so the promoted artifact is
    // a string — the STEP's declared output schema (object with files[])
    // must reject it before completion.
    const INVALID_WF = TYPED_WF.replace(
      `      output:
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
    output:`,
      "    output:",
    );
    seedRun({ steps: [{ id: "discover" }] });
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "just some prose, not the contract" };
      },
      loadPlan: async () => plan(INVALID_WF),
      summaryJudge: null,
    });
    expect(dispatches).toBe(1);
    expect(result.done).toBeUndefined();
    expect(result.executed[0].ok).toBe(false);
    expect(result.executed[0].summary).toContain('Step "discover" artifact failed validation');
    expect(result.executed[0].summary).toContain("expected type object, got string");
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
    expect(status.workflow.steps[0].status).toBe("failed");
  });

  test("a fan-out collect artifact is validated as a whole (array schema)", async () => {
    const MAP_TYPED_WF = `version: 1
name: Typed
params:
  files: { type: array }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      unit:
        instructions: Review \${{ item }}.
    output:
      type: array
      items: { type: string }
      minItems: 3
`;
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review" }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: "fine" }),
      loadPlan: async () => plan(MAP_TYPED_WF),
      summaryJudge: null,
    });
    // Two items < minItems: 3 → the collect artifact fails its schema.
    expect(result.executed[0].ok).toBe(false);
    expect(result.executed[0].summary).toContain("output schema");
  });
});

// ── Artifact-judging gates ───────────────────────────────────────────────────

const GATED_WF = `version: 1
name: Gated
steps:
  - id: extract
    title: Extract facts
    unit:
      instructions: Extract facts.
      output:
        type: object
        properties: { fact: { type: string } }
        required: [fact]
    gate:
      criteria: [a fact was extracted]
`;

describe("artifact-judging gates — the judge receives the artifact, not machine prose", () => {
  test("the judged summary is built from the artifact: unit-count line + canonical JSON", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judged: string[] = [];
    const judge: SummaryJudge = async ({ user }) => {
      judged.push(user);
      return '{"complete": true, "missing": []}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: async () => plan(GATED_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(judged).toHaveLength(1);
    // The judge sees the REAL artifact (canonical JSON) with a one-line unit
    // count — never the "via the native executor" machine summary.
    expect(judged[0]).toContain('Step "extract" executed 1 unit(s) (1 succeeded, 0 failed).');
    expect(judged[0]).toContain('{"fact":"bun is fast"}');
    expect(judged[0]).not.toContain("via the native executor");
    // The persisted step summary is the judged artifact summary.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].summary).toContain('{"fact":"bun is fast"}');
  });

  test("the artifact JSON handed to the judge is clipped at 4000 chars", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judged: string[] = [];
    const judge: SummaryJudge = async ({ user }) => {
      judged.push(user);
      return '{"complete": true, "missing": []}';
    };
    const huge = "x".repeat(10_000);
    await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: `{"fact": "${huge}"}` }),
      loadPlan: async () => plan(GATED_WF),
      summaryJudge: judge,
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain("clipped at 4000 chars");
    // The full 10k-char fact must NOT reach the judge.
    expect(judged[0]).not.toContain(huge);
  });

  test("steps WITHOUT criteria keep the machine summary and never invoke the judge", async () => {
    seedRun({ steps: [{ id: "extract" }] }); // no completion criteria
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return '{"complete": true, "missing": []}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: async () => plan(GATED_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(judgeCalls).toBe(0);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].summary).toContain("via the native executor");
    // No judge ran → no gate unit rows journaled.
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "extract").filter((r) => r.node_id === "extract.gate")).toHaveLength(0);
    });
  });

  test("gate evaluations are journaled as unit rows (node <stepId>.gate, unit <stepId>.gate:l<loop>, runner llm)", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const judge: SummaryJudge = async () => '{"complete": true, "missing": []}';
    await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: async () => plan(GATED_WF),
      summaryJudge: judge,
    });
    await withWorkflowRunsRepo((repo) => {
      const gateRows = repo.getUnitsForStep(RUN_ID, "extract").filter((r) => r.node_id === "extract.gate");
      expect(gateRows).toHaveLength(1);
      expect(gateRows[0].unit_id).toBe("extract.gate:l1");
      expect(gateRows[0].runner).toBe("llm");
      expect(gateRows[0].status).toBe("completed");
      expect(JSON.parse(gateRows[0].result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });
  });

  test("no judge (summaryJudge: null) → fail-open completion, no gate rows — offline behavior unchanged", async () => {
    seedRun({ steps: [{ id: "extract", criteria: ["a fact was extracted"] }] });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
      loadPlan: async () => plan(GATED_WF),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "extract");
      expect(rows.map((r) => r.unit_id)).toEqual(["extract:solo"]); // no gate rows
    });
  });
});

// ── Bounded gate loops (gate.max_loops) ──────────────────────────────────────

const LOOPED_WF = `version: 1
name: Looped
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 2
  - id: wrap-up
    title: Wrap up
    unit:
      instructions: Wrap up.
`;

const LOOPED_STEPS = [{ id: "work", criteria: ["the work is thorough"] }, { id: "wrap-up" }];

describe("gate max_loops — evaluator-optimizer re-execution with feedback", () => {
  test("reject-then-accept: loop 2 re-dispatches with the feedback in the prompt, because the input hash changed", async () => {
    seedRun({ steps: LOOPED_STEPS });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.nodeId === "work") prompts.push(req.prompt);
      return { ok: true, text: `did ${req.unitId}` };
    };
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the frobnicator analysis."}'
        : '{"complete": true, "missing": []}';
    };

    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher,
      loadPlan: async () => plan(LOOPED_WF),
      summaryJudge: judge,
    });

    expect(result.done).toBe(true);
    expect(result.gateRejection).toBeUndefined();
    expect(judgeCalls).toBe(2);

    // TWO executions of the work unit: the rejected first attempt and the
    // feedback-carrying second one.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Completion-gate feedback");
    expect(prompts[1]).toContain("Add the frobnicator analysis.");
    expect(prompts[1]).toContain("- the work is thorough");

    // Both attempts are recorded in the executed report, in loop order.
    expect(result.executed.map((s) => s.stepId)).toEqual(["work", "work", "wrap-up"]);

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "work");
      const byId = new Map(rows.map((r) => [r.unit_id, r]));
      // Loop 2 journals under the ~l2 suffix — loop 1's row is not clobbered.
      const first = byId.get("work:solo");
      const second = byId.get("work:solo~l2");
      expect(first?.status).toBe("completed");
      expect(second?.status).toBe("completed");
      // PROOF the re-dispatch was hash-driven: the feedback changed the
      // prompt, so the two attempts journal DIFFERENT input hashes.
      expect(first?.input_hash).toBeTruthy();
      expect(second?.input_hash).toBeTruthy();
      expect(second?.input_hash).not.toBe(first?.input_hash);
      // Both gate evaluations journaled with their verdicts.
      expect(JSON.parse(byId.get("work.gate:l1")?.result_json ?? "null")).toEqual({
        complete: false,
        missing: ["the work is thorough"],
        feedback: "Add the frobnicator analysis.",
      });
      expect(JSON.parse(byId.get("work.gate:l2")?.result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });
  });

  test("the loop bound is respected: an always-rejecting judge yields gateRejection after maxLoops attempts", async () => {
    seedRun({ steps: LOOPED_STEPS });
    let dispatches = 0;
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return '{"complete": false, "missing": ["the work is thorough"], "feedback": "Still not thorough."}';
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      loadPlan: async () => plan(LOOPED_WF),
      summaryJudge: judge,
    });

    expect(dispatches).toBe(2); // maxLoops attempts, then stop — never a third
    expect(judgeCalls).toBe(2);
    expect(result.done).toBeUndefined();
    expect(result.gateRejection).toEqual({
      stepId: "work",
      missing: ["the work is thorough"],
      feedback: "Still not thorough.",
    });
    // A gate rejection leaves the step pending and the run active — the gate
    // spine is authoritative, even against the engine.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.workflow.steps[0].status).toBe("pending");
    // wrap-up never ran.
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "wrap-up")).toHaveLength(0);
    });
  });

  test("without maxLoops (default 1), a rejection stops the engine on the first attempt — no silent looping", async () => {
    const ONE_SHOT_WF = LOOPED_WF.replace("      max_loops: 2\n", "");
    seedRun({ steps: LOOPED_STEPS });
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      loadPlan: async () => plan(ONE_SHOT_WF),
      summaryJudge: async () => '{"complete": false, "missing": ["the work is thorough"], "feedback": "Nope."}',
    });
    expect(dispatches).toBe(1);
    expect(result.gateRejection?.stepId).toBe("work");
  });

  test("fan-out gate loops re-dispatch every item with feedback under ~l2 ids", async () => {
    const LOOPED_MAP_WF = `version: 1
name: Looped
params:
  files: { type: array }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      unit:
        instructions: Review \${{ item }}.
    gate:
      criteria: [every file reviewed thoroughly]
      max_loops: 2
`;
    seedRun({
      params: { files: ["a", "b"] },
      steps: [{ id: "review", criteria: ["every file reviewed thoroughly"] }],
    });
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": [], "feedback": "Look deeper."}'
        : '{"complete": true, "missing": []}';
    };
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
      loadPlan: async () => plan(LOOPED_MAP_WF),
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(4); // 2 items × 2 loops
    expect(prompts.filter((p) => p.includes("Look deeper.")).length).toBe(2);
    await withWorkflowRunsRepo((repo) => {
      const ids = repo
        .getUnitsForStep(RUN_ID, "review")
        .map((r) => r.unit_id)
        .sort();
      expect(ids).toEqual([
        "review.gate:l1",
        "review.gate:l2",
        "review.unit:ac8d8342bbb2", // "a"
        "review.unit:ac8d8342bbb2~l2",
        "review.unit:c100f95c1913", // "b"
        "review.unit:c100f95c1913~l2",
      ]);
    });
  });
});

// ── Verbatim linear markdown stays untouched ─────────────────────────────────

const LINEAR_MD = `# Workflow: Classic

## Step: Build
Step ID: build

### Instructions
Build it. Literal \${{ params.secret }} is content here.

## Step: Deploy
Step ID: deploy

### Instructions
Deploy it.
`;

describe("classic linear markdown path (stable contract)", () => {
  test("verbatim instructions pass through byte-exact and steps keep machine summaries", async () => {
    const parsed = parseWorkflow(LINEAR_MD, { path: "workflows/classic.md" });
    if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join(" | "));
    const mdPlan = compileWorkflowPlan(parsed.document);

    seedRun({ params: { secret: "LEAKED" }, steps: [{ id: "build" }, { id: "deploy" }] });
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
      loadPlan: async () => mdPlan,
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    // Markdown instructions are opaque data: the `${{ … }}` text is content,
    // never grammar — no expression resolution, no param substitution.
    expect(prompts[0]).toContain("Literal ${{ params.secret }} is content here.");
    expect(prompts[0]).not.toContain("LEAKED — resolved");
    // No gate feedback block on first executions, machine summaries intact.
    expect(prompts.every((p) => !p.includes("Completion-gate feedback"))).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps.every((s) => (s.summary ?? "").includes("via the native executor"))).toBe(true);
  });
});
