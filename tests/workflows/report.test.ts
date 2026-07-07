// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `\${{ … }}` is the
// workflow expression grammar under test, not a JS template literal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowRunStatus } from "../../src/sources/types";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { buildWorkflowBrief } from "../../src/workflows/exec/brief";
import { reportWorkflowUnit } from "../../src/workflows/exec/report";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { compileWorkflowProgram } from "../../src/workflows/ir/compile";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { getWorkflowStatus } from "../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../src/workflows/validate-summary";

/**
 * `akm workflow report` (redesign addendum R3, task step 3). Proves report:
 *   - drives a 2-step fan-out run to completion purely via report (artifact
 *     promoted + schema-validated, gate judged via the injected seam, gate rows
 *     journaled, spine advances);
 *   - a gate rejection leaves the step active and the next brief shows loop 2
 *     with the recovered feedback;
 *   - honors on_error (continue vs fail);
 *   - idempotent re-report (same hash) vs replay-divergent re-report;
 *   - --status running claims/heartbeats a unit and stale claims surface in brief;
 *   - refuses under a live engine lease and when a budget ceiling is reached;
 *   - two concurrent reports for the same unit cannot corrupt state.
 */

let tmpDir = "";
let prevDataDir: string | undefined;
const RUN_ID = "abcdef01-2345-4678-8abc-def012345678";

function dbPath(): string {
  return path.join(tmpDir, "workflow.db");
}

function plan(yamlText: string): WorkflowPlanGraph {
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/demo.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
}

interface SeedStep {
  id: string;
  criteria?: string[];
  status?: "pending" | "completed" | "failed" | "blocked" | "skipped";
  evidence?: Record<string, unknown>;
}

interface SeedUnit {
  unitId: string;
  stepId: string;
  nodeId: string;
  phase?: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  inputHash?: string | null;
  resultJson?: string | null;
  tokens?: number | null;
  startedAt?: string | null;
  lastCheckinAt?: string | null;
}

function seedRun(opts: {
  plan: WorkflowPlanGraph;
  status?: WorkflowRunStatus;
  currentStepId?: string | null;
  params?: Record<string, unknown>;
  steps: SeedStep[];
  units?: SeedUnit[];
  lease?: { holder: string; until: string };
}): void {
  const db = openWorkflowDatabase(dbPath());
  try {
    const now = new Date().toISOString();
    const planJson = canonicalPlanJson(opts.plan);
    const planHash = computePlanHash(opts.plan);
    const current =
      opts.currentStepId !== undefined
        ? opts.currentStepId
        : (opts.steps.find((s) => (s.status ?? "pending") === "pending")?.id ?? null);
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, plan_json, plan_hash,
          engine_lease_holder, engine_lease_until)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      opts.status ?? "active",
      JSON.stringify(opts.params ?? {}),
      current,
      now,
      now,
      planJson,
      planHash,
      opts.lease?.holder ?? null,
      opts.lease?.until ?? null,
    );
    opts.steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status, evidence_json)
         VALUES (?, ?, ?, 'instructions', ?, ?, ?, ?)`,
      ).run(
        RUN_ID,
        step.id,
        step.id,
        step.criteria ? JSON.stringify(step.criteria) : null,
        i,
        step.status ?? "pending",
        step.evidence ? JSON.stringify(step.evidence) : null,
      );
    });
    for (const u of opts.units ?? []) {
      db.prepare(
        `INSERT INTO workflow_run_units
           (run_id, unit_id, step_id, node_id, parent_unit_id, phase, runner, model, status,
            input_hash, result_json, tokens, failure_reason, worktree_path, started_at, finished_at, last_checkin_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'sdk', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      ).run(
        RUN_ID,
        u.unitId,
        u.stepId,
        u.nodeId,
        u.phase ?? null,
        u.status,
        u.inputHash ?? null,
        u.resultJson ?? null,
        u.tokens ?? null,
        u.startedAt ?? now,
        u.status === "completed" || u.status === "failed" ? now : null,
        u.lastCheckinAt ?? null,
      );
    }
  } finally {
    closeWorkflowDatabase(db);
  }
}

/** The content-derived unit ids the engine (and brief) would compute for a step. */
function unitIds(p: WorkflowPlanGraph, stepIndex: number, params: Record<string, unknown>): string[] {
  const computed = computeStepWorkList(p.steps[stepIndex], { runId: RUN_ID, params, stepOutputs: {} });
  if (!computed.ok) throw new Error(computed.error);
  return computed.list.units.map((u) => u.unitId);
}

const acceptJudge: SummaryJudge = async () => '{"complete": true, "missing": []}';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-report-"));
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

// ── Workflows ────────────────────────────────────────────────────────────────

const TWO_STEP_WF = `version: 1
name: TwoStep
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
    output:
      type: array
      items: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
      minItems: 1
    gate:
      criteria: [every file was reviewed]
  - id: summarize
    title: Summarize
    unit:
      instructions: Summarize the review.
`;

const LOOP_WF = `version: 1
name: Loop
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 3
`;

// ── Happy path: 2-step fan-out driven to completion via report ───────────────

describe("workflow report — full happy path (2-step fan-out to completion)", () => {
  test("promotes + schema-validates the artifact, judges the gate, journals gate rows, advances the spine", async () => {
    const p = plan(TWO_STEP_WF);
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review", criteria: ["every file was reviewed"] }, { id: "summarize" }] });
    const [ua, ub] = unitIds(p, 0, params);

    // First unit: step stays active, one still outstanding.
    const r1 = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ua,
      status: "completed",
      resultRaw: JSON.stringify({ verdict: "ok" }),
      tokens: 10,
      summaryJudge: acceptJudge,
    });
    expect(r1.recorded).toBe("written");
    expect(r1.remainingUnits).toBe(1);
    expect(r1.stepOutcome).toBeUndefined();
    expect(r1.runStatus).toBe("active");

    // Second unit completes the work-list → step finalizes and advances.
    const r2 = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ub,
      status: "completed",
      resultRaw: JSON.stringify({ verdict: "great" }),
      tokens: 20,
      summaryJudge: acceptJudge,
    });
    expect(r2.stepOutcome?.kind).toBe("advanced");
    expect(r2.runStatus).toBe("active"); // step 2 (summarize) now pending

    const afterStep1 = await getWorkflowStatus(RUN_ID);
    expect(afterStep1.workflow.steps[0].status).toBe("completed");
    // Promoted + schema-validated collect artifact.
    expect(afterStep1.workflow.steps[0].evidence?.output).toEqual([{ verdict: "ok" }, { verdict: "great" }]);

    // The gate was judged and journaled as a unit row (llm runner, l1).
    await withWorkflowRunsRepo((repo) => {
      const gate = repo.getUnitsForStep(RUN_ID, "review").filter((u) => u.node_id === "review.gate");
      expect(gate).toHaveLength(1);
      expect(gate[0].unit_id).toBe("review.gate:l1");
      expect(gate[0].runner).toBe("llm");
      expect(JSON.parse(gate[0].result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });

    // Step 2 (solo, free text, no gate): reporting its unit completes the run.
    const summarizeUnit = unitIds(p, 1, params)[0];
    const r3 = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: summarizeUnit,
      status: "completed",
      resultRaw: "All good.",
      summaryJudge: null,
    });
    expect(r3.stepOutcome?.kind).toBe("advanced");
    expect(r3.runStatus).toBe("completed");

    const done = await getWorkflowStatus(RUN_ID);
    expect(done.run.status).toBe("completed");
    expect(done.workflow.steps.every((s) => s.status === "completed")).toBe(true);
  });
});

// ── Gate rejection leaves the step active; next brief shows loop 2 ───────────

describe("workflow report — gate rejection with loops remaining", () => {
  test("rejects, leaves the step active, and the next brief emits loop 2 with recovered feedback", async () => {
    const p = plan(LOOP_WF);
    seedRun({ plan: p, steps: [{ id: "work", criteria: ["the work is thorough"] }] });
    const unit = unitIds(p, 0, {})[0];

    const rejectJudge: SummaryJudge = async () =>
      '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the analysis section."}';

    const r = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: unit,
      status: "completed",
      resultRaw: "Did some work.",
      summaryJudge: rejectJudge,
    });
    expect(r.stepOutcome?.kind).toBe("gate-rejected");
    expect(r.stepOutcome?.loopsRemaining).toBe(true);
    expect(r.stepOutcome?.feedback).toContain("Add the analysis section.");
    expect(r.runStatus).toBe("active");

    // Step stays pending; a gate rejection was journaled.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].status).toBe("pending");

    // The next brief emits loop 2 with the feedback recovered from the journal.
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.step?.gate.currentLoop).toBe(2);
    expect(brief.gateFeedback?.feedback).toContain("Add the analysis section.");
    expect(brief.workList.units[0].resolved.ok).toBe(true);
  });
});

// ── on_error: continue vs fail ───────────────────────────────────────────────

const ONERROR_WF = (mode: "fail" | "continue") => `version: 1
name: OnError
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
        on_error: ${mode}
`;

describe("workflow report — on_error policy", () => {
  test("on_error: fail — one failed unit fails the step", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    const [ua, ub] = unitIds(p, 0, params);

    await reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null });
    const r = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ub,
      status: "failed",
      failureReason: "timeout",
      summaryJudge: null,
    });
    expect(r.stepOutcome?.kind).toBe("failed");
    expect(r.runStatus).toBe("failed");
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].status).toBe("failed");
  });

  test("on_error: continue — a failed unit is tolerated and the step completes", async () => {
    const p = plan(ONERROR_WF("continue"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    const [ua, ub] = unitIds(p, 0, params);

    await reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null });
    const r = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ub,
      status: "failed",
      failureReason: "timeout",
      summaryJudge: null,
    });
    expect(r.stepOutcome?.kind).toBe("advanced");
    expect(r.runStatus).toBe("completed");
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].status).toBe("completed");
  });
});

// ── Idempotent vs divergent re-report ────────────────────────────────────────

describe("workflow report — re-report semantics", () => {
  test("re-reporting a completed unit with the same input hash is an idempotent no-op", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    const [ua] = unitIds(p, 0, params);

    const first = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ua,
      status: "completed",
      resultRaw: "ok",
      summaryJudge: null,
    });
    expect(first.recorded).toBe("written");
    const again = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: ua,
      status: "completed",
      resultRaw: "ok",
      summaryJudge: null,
    });
    expect(again.recorded).toBe("idempotent");
    // Exactly one journaled row for the unit.
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review").filter((u) => u.unit_id === ua)).toHaveLength(1);
    });
  });

  test("re-reporting a completed unit whose journaled input hash differs is a replay-divergence error", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    const [ua, ub] = unitIds(p, 0, params);
    // Seed ua already completed with a WRONG input hash (as if tampered).
    seedRun({
      plan: p,
      params,
      steps: [{ id: "review" }],
      units: [{ unitId: ua, stepId: "review", nodeId: "review", status: "completed", inputHash: "deadbeef" }],
    });
    // Reporting a DIFFERENT unit (ub) still works; only ua diverges.
    void ub;
    await expect(
      reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null }),
    ).rejects.toThrow(/[Rr]eplay divergence/);
  });
});

// ── Unit check-in (running) + stale surfacing ────────────────────────────────

describe("workflow report — running claim + stale surfacing", () => {
  test("--status running claims a unit (started_at + last_checkin_at) without advancing the spine", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    const [ua] = unitIds(p, 0, params);

    const r = await reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "running", note: "starting" });
    expect(r.status).toBe("running");
    expect(r.recorded).toBe("heartbeat");
    expect(r.runStatus).toBe("active");

    await withWorkflowRunsRepo((repo) => {
      const row = repo.getUnit(RUN_ID, ua);
      expect(row?.status).toBe("running");
      expect(row?.started_at).not.toBeNull();
      expect(row?.last_checkin_at).not.toBeNull();
    });
    // Step is untouched — still pending.
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0].status).toBe("pending");
  });

  test("a stale claimed unit surfaces in brief with a warning", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    const [ua] = unitIds(p, 0, params);
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    seedRun({
      plan: p,
      params,
      steps: [{ id: "review" }],
      units: [
        { unitId: ua, stepId: "review", nodeId: "review", status: "running", startedAt: old, lastCheckinAt: old },
      ],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.staleUnits.map((u) => u.unitId)).toContain(ua);
    expect(brief.warnings.some((w) => w.includes("gone silent") && w.includes(ua))).toBe(true);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("workflow report — refusals", () => {
  test("refuses while a live engine lease is held", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    const [ua] = unitIds(p, 0, params);
    seedRun({
      plan: p,
      params,
      steps: [{ id: "review" }],
      lease: { holder: "engine-xyz", until: new Date(Date.now() + 60_000).toISOString() },
    });
    await expect(
      reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null }),
    ).rejects.toThrow(/engine lease is live|being driven by engine/);
  });

  test("an unknown unit id is refused, naming the valid ids", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    await expect(
      reportWorkflowUnit({
        target: RUN_ID,
        unitId: "review:notreal",
        status: "completed",
        resultRaw: "x",
        summaryJudge: null,
      }),
    ).rejects.toThrow(/does not belong to the active step/);
  });

  test("a schema unit rejects a result that fails its output schema, with validator errors", async () => {
    const p = plan(TWO_STEP_WF);
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review", criteria: ["every file was reviewed"] }, { id: "summarize" }] });
    const [ua] = unitIds(p, 0, params);
    await expect(
      reportWorkflowUnit({
        target: RUN_ID,
        unitId: ua,
        status: "completed",
        resultRaw: JSON.stringify({ wrong: "shape" }),
        summaryJudge: acceptJudge,
      }),
    ).rejects.toThrow(/failed validation against its declared output schema/);
  });

  test("a budget max_units ceiling refuses recording a further unit", async () => {
    const BUDGET_WF = `version: 1
name: Budget
budget:
  max_units: 2
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
`;
    const p = plan(BUDGET_WF);
    const params = { files: ["a.ts", "b.ts", "c.ts"] };
    const [ua, ub, uc] = unitIds(p, 0, params);
    // Two units already dispatched (journaled) → the ceiling is reached.
    seedRun({
      plan: p,
      params,
      steps: [{ id: "review" }],
      units: [
        { unitId: ua, stepId: "review", nodeId: "review", status: "completed", resultJson: JSON.stringify("ok") },
        { unitId: ub, stepId: "review", nodeId: "review", status: "completed", resultJson: JSON.stringify("ok") },
      ],
    });
    await expect(
      reportWorkflowUnit({ target: RUN_ID, unitId: uc, status: "completed", resultRaw: "ok", summaryJudge: null }),
    ).rejects.toThrow(/budget exceeded \(max_units ceiling\)/);
  });

  test("a typed-artifact schema mismatch is a hard step failure on the report path (even with max_loops)", async () => {
    // The unit is free text but the STEP declares an output schema + max_loops:
    // the engine would gate-loop-retry, but report cannot recover the (un-
    // journaled) schema feedback across invocations, so it fails the step.
    const SCHEMA_LOOP_WF = `version: 1
name: SchemaLoop
steps:
  - id: discover
    title: Discover
    unit:
      instructions: Find files.
    output:
      type: object
      properties: { files: { type: array } }
      required: [files]
    gate:
      criteria: [files were found]
      max_loops: 3
`;
    const p = plan(SCHEMA_LOOP_WF);
    seedRun({ plan: p, steps: [{ id: "discover", criteria: ["files were found"] }] });
    const unit = unitIds(p, 0, {})[0];
    const r = await reportWorkflowUnit({
      target: RUN_ID,
      unitId: unit,
      status: "completed",
      resultRaw: "just prose, not the contract",
      summaryJudge: acceptJudge,
    });
    expect(r.stepOutcome?.kind).toBe("failed");
    expect(r.runStatus).toBe("failed");
    expect(r.stepOutcome?.summary).toContain("output schema");
  });

  test("a completed run refuses reports", async () => {
    const p = plan(ONERROR_WF("fail"));
    seedRun({
      plan: p,
      status: "completed",
      currentStepId: null,
      params: { files: ["a.ts"] },
      steps: [{ id: "review", status: "completed" }],
    });
    await expect(
      reportWorkflowUnit({
        target: RUN_ID,
        unitId: "review:whatever",
        status: "completed",
        resultRaw: "x",
        summaryJudge: null,
      }),
    ).rejects.toThrow(/is completed/);
  });
});

// ── Concurrency honesty ──────────────────────────────────────────────────────

describe("workflow report — concurrent reports for the same unit", () => {
  test("two concurrent completed reports for the same unit leave exactly one consistent row", async () => {
    const p = plan(ONERROR_WF("fail"));
    const params = { files: ["a.ts", "b.ts"] };
    seedRun({ plan: p, params, steps: [{ id: "review" }] });
    const [ua] = unitIds(p, 0, params);

    const results = await Promise.allSettled([
      reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null }),
      reportWorkflowUnit({ target: RUN_ID, unitId: ua, status: "completed", resultRaw: "ok", summaryJudge: null }),
    ]);
    // Neither corrupts state: both settle successfully (one write, one
    // idempotent no-op), and exactly one row exists for the unit.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const recorded = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reportWorkflowUnit>>> => r.status === "fulfilled",
      )
      .map((r) => r.value.recorded)
      .sort();
    expect(recorded).toEqual(["idempotent", "written"]);
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review").filter((u) => u.unit_id === ua);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
    });
  });
});
