// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{ … }}` is the
// workflow expression grammar under test, not a JS template literal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowRunUnitRow } from "../../src/storage/repositories/workflow-runs-repository";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import {
  activeGateLoop,
  buildEvidence,
  canonicalJson,
  computeStepWorkList,
  recoverGateFeedback,
  type UnitOutcome,
  unitOutcomeFromRow,
} from "../../src/workflows/exec/step-work";
import { compileWorkflowProgram } from "../../src/workflows/ir/compile";
import type { IrStepPlan, WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import type { SummaryJudge } from "../../src/workflows/validate-summary";

/**
 * The shared step-semantics core (redesign addendum R3, task step 1). Proves:
 *
 *   1. `computeStepWorkList` is PURE — same inputs ⇒ byte-identical unit ids,
 *      input hashes, and resolved prompts. This is the guarantee `brief` (R3)
 *      relies on to predict exactly what the engine will dispatch.
 *   2. gate-feedback recovery (`recoverGateFeedback` / `activeGateLoop`) reads
 *      the `{ feedback, missing }` the engine journaled, and — the anti-drift
 *      proof — recomputing a gate loop's work-list from the journal-recovered
 *      feedback reproduces the engine's ACTUAL loop-2 prompt + input hash
 *      byte-for-byte.
 */

// ── Hand-built plans for the pure work-list tests ────────────────────────────

function soloStep(instructions: string, templating: "expressions" | "verbatim" = "expressions"): IrStepPlan {
  return {
    stepId: "s1",
    title: "S1",
    sequenceIndex: 0,
    root: { kind: "agent", id: "s1", instructions, templating, runner: "sdk", onError: "fail" },
    gate: { kind: "gate", id: "s1.gate", stepId: "s1", criteria: [] },
  };
}

function mapStep(instructions: string, over = "${{ params.files }}"): IrStepPlan {
  return {
    stepId: "review",
    title: "Review",
    sequenceIndex: 0,
    root: {
      kind: "map",
      id: "review",
      over,
      reducer: "collect",
      template: {
        kind: "agent",
        id: "review",
        instructions,
        templating: "expressions",
        runner: "sdk",
        onError: "fail",
      },
    },
    gate: { kind: "gate", id: "review.gate", stepId: "review", criteria: [] },
  };
}

describe("computeStepWorkList — purity + content-derived identity", () => {
  test("same inputs ⇒ byte-identical unit ids, input hashes, and prompts", () => {
    const step = soloStep("Do ${{ params.x }} for ${{ params.y }}.");
    const input = { runId: "run-1", params: { x: "alpha", y: "beta" }, stepOutputs: {} };

    const a = computeStepWorkList(step, input);
    const b = computeStepWorkList(step, input);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Deep equality across two independent computations is the purity proof.
    expect(a.list.units).toEqual(b.list.units);

    const u = a.list.units[0];
    expect(u.unitId).toBe("s1:solo");
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) {
      expect(u.resolved.prompt).toContain("Do alpha for beta.");
      // 64-hex sha256.
      expect(u.resolved.inputHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("fan-out identity is content-derived — independent of item order", () => {
    const step = mapStep("Review ${{ item }}.");
    const forward = computeStepWorkList(step, { runId: "r", params: { files: ["a.ts", "b.ts"] }, stepOutputs: {} });
    const reversed = computeStepWorkList(step, { runId: "r", params: { files: ["b.ts", "a.ts"] }, stepOutputs: {} });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;

    const byItem = (list: typeof forward.list, item: string) => list.units.find((u) => u.item === item);
    const fwdA = byItem(forward.list, "a.ts");
    const revA = byItem(reversed.list, "a.ts");
    // The SAME item derives the SAME content-derived id regardless of position
    // — the R2 identity guarantee that survives list reordering/regeneration.
    expect(fwdA?.unitId).toBe(revA?.unitId);
    expect(fwdA?.unitId).toMatch(/^review:[0-9a-f]{12}$/);
    expect(fwdA?.resolved.ok).toBe(true);
  });

  test("duplicate fan-out items are a whole-list failure naming the collision", () => {
    const step = mapStep("Review ${{ item }}.");
    const result = computeStepWorkList(step, { runId: "r", params: { files: ["dup", "dup"] }, stepOutputs: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate items (indices 0 and 1");
  });

  test("a non-array `over` is a whole-list failure", () => {
    const step = mapStep("Review ${{ item }}.");
    const result = computeStepWorkList(step, { runId: "r", params: { files: "not-a-list" }, stepOutputs: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an array");
  });

  test("a resolution error is carried on the unit's `resolved`, not a whole-list failure", () => {
    // The template parses (valid `steps.<id>.output.<path>` grammar) but the
    // referenced producer isn't in scope, so it fails at RESOLUTION — carried
    // per unit (the engine's `expression_error` outcome), never a step failure.
    const step = mapStep("Review ${{ steps.prior.output.name }} for ${{ item }}.");
    const result = computeStepWorkList(step, { runId: "r", params: { files: ["a", "b"] }, stepOutputs: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.units).toHaveLength(2);
    for (const u of result.list.units) {
      expect(u.resolved.ok).toBe(false);
      if (!u.resolved.ok) expect(u.resolved.error).toContain("failed to resolve");
    }
  });

  test("verbatim instructions pass `${{ … }}` through as literal content (no parse, no failure)", () => {
    const step = soloStep("Literal ${{ not.parsed }} here.", "verbatim");
    const result = computeStepWorkList(step, { runId: "r", params: {}, stepOutputs: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const u = result.list.units[0];
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) expect(u.resolved.prompt).toContain("Literal ${{ not.parsed }} here.");
  });

  test("gate feedback changes the prompt AND the input hash (natural re-dispatch), and the journal id", () => {
    const step = soloStep("Do the work.");
    const base = { runId: "r", params: {}, stepOutputs: {} };
    const loop1 = computeStepWorkList(step, base);
    const loop2 = computeStepWorkList(step, {
      ...base,
      gateLoop: 2,
      gateFeedback: { feedback: "Add analysis.", missing: ["thoroughness"] },
    });
    expect(loop1.ok && loop2.ok).toBe(true);
    if (!loop1.ok || !loop2.ok) return;

    const u1 = loop1.list.units[0];
    const u2 = loop2.list.units[0];
    expect(u1.journalBaseId).toBe("s1:solo");
    expect(u2.journalBaseId).toBe("s1:solo~l2");
    expect(u1.resolved.ok && u2.resolved.ok).toBe(true);
    if (u1.resolved.ok && u2.resolved.ok) {
      expect(u2.resolved.prompt).toContain("Add analysis.");
      expect(u2.resolved.prompt).toContain("- thoroughness");
      expect(u1.resolved.prompt).not.toContain("Add analysis.");
      expect(u2.resolved.inputHash).not.toBe(u1.resolved.inputHash);
    }
  });
});

// ── Gate-feedback recovery (pure, synthetic journal rows) ────────────────────

function gateRow(stepId: string, loop: number, verdict: unknown): WorkflowRunUnitRow {
  return {
    run_id: "r",
    unit_id: `${stepId}.gate:l${loop}`,
    step_id: stepId,
    node_id: `${stepId}.gate`,
    parent_unit_id: null,
    phase: "gate",
    runner: "llm",
    model: null,
    status: "completed",
    input_hash: null,
    result_json: JSON.stringify(verdict),
    tokens: null,
    failure_reason: null,
    session_id: null,
    worktree_path: null,
    started_at: null,
    finished_at: null,
    last_checkin_at: null,
    attempts: 1,
  };
}

describe("recoverGateFeedback / activeGateLoop — pure journal derivation", () => {
  const reject = { complete: false, missing: ["thoroughness"], feedback: "Add analysis." };

  test("recovers the previous loop's rejection feedback for loop N", () => {
    const rows = [gateRow("work", 1, reject)];
    expect(recoverGateFeedback(rows, "work", 2)).toEqual({ feedback: "Add analysis.", missing: ["thoroughness"] });
  });

  test("loop 1 has no prior feedback", () => {
    expect(recoverGateFeedback([gateRow("work", 1, reject)], "work", 1)).toBeUndefined();
  });

  test("a PASSED previous gate carries no feedback", () => {
    const rows = [gateRow("work", 1, { complete: true, missing: [] })];
    expect(recoverGateFeedback(rows, "work", 2)).toBeUndefined();
  });

  test("activeGateLoop is one past the highest journaled rejection", () => {
    expect(activeGateLoop([], "work")).toBe(1);
    expect(activeGateLoop([gateRow("work", 1, reject)], "work")).toBe(2);
    expect(activeGateLoop([gateRow("work", 1, reject), gateRow("work", 2, reject)], "work")).toBe(3);
  });

  test("activeGateLoop ignores other steps' gate rows and non-gate phases", () => {
    const rows = [
      gateRow("other", 1, reject),
      { ...gateRow("work", 1, reject), phase: null }, // a (hypothetical) non-gate row
    ];
    expect(activeGateLoop(rows, "work")).toBe(1);
  });
});

// ── Anti-drift proof: journal-recovered feedback reproduces the engine's loop-2 dispatch ──

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

const RUN_ID = "77777777-7777-4777-8777-777777777777";
let tmpDir = "";
let prevDataDir: string | undefined;

function plan(yamlText: string): WorkflowPlanGraph {
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/demo.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
}

function seedRun(steps: Array<{ id: string; criteria?: string[] }>): void {
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', ?, ?, ?)`,
    ).run(RUN_ID, steps[0].id, now, now);
    steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', ?, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.id, step.criteria ? JSON.stringify(step.criteria) : null, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-step-work-"));
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

describe("anti-drift — recomputing loop 2 from the journal reproduces the engine's dispatch", () => {
  test("recovered feedback yields the SAME prompt + input hash the engine actually dispatched", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }, { id: "wrap-up" }]);

    const workPrompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.nodeId === "work") workPrompts.push(req.prompt);
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
    expect(workPrompts).toHaveLength(2); // loop 1 (rejected) + loop 2 (feedback)

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));

    // 1. The engine journaled the EXACT feedback it threaded into loop 2.
    const recovered = recoverGateFeedback(rows, "work", 2);
    expect(recovered).toEqual({ feedback: "Add the frobnicator analysis.", missing: ["the work is thorough"] });

    // 2. Recomputing loop 2's work-list from the frozen plan + journal-recovered
    //    feedback reproduces the engine's loop-2 dispatch BYTE-FOR-BYTE — the
    //    guarantee that `brief` predicts exactly what the engine ran.
    const workStep = plan(LOOPED_WF).steps.find((s) => s.stepId === "work");
    expect(workStep).toBeDefined();
    if (!workStep || !recovered) return;
    const list = computeStepWorkList(workStep, {
      runId: RUN_ID,
      params: {},
      stepOutputs: {},
      gateLoop: 2,
      gateFeedback: recovered,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const u = list.list.units[0];
    expect(u.journalBaseId).toBe("work:solo~l2");
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) {
      expect(u.resolved.prompt).toBe(workPrompts[1]);
      const journaled = rows.find((r) => r.unit_id === "work:solo~l2");
      expect(journaled?.input_hash).toBe(u.resolved.inputHash);
    }
  });
});

/**
 * Regression (R4 conformance, peer-review finding): the DURABLE per-unit
 * projection `buildEvidence` writes must be surface-INDEPENDENT — the exact byte
 * identity the conformance suite compares. The engine reduces from an in-memory
 * dispatch outcome (a failed unit carries a residual `text` and an internal
 * `error` diagnostic); the report surface reduces from a journal row (a
 * driver-reported failure carries neither). If `buildEvidence` copied those
 * engine-only fields through, `evidence.units` — hence the durable unit graph —
 * would diverge between the two surfaces even though every other row matched.
 */
describe("buildEvidence — surface-independent unit projection (R4 anti-drift)", () => {
  /** Shape a journal row the report surface would rehydrate from. */
  function row(overrides: Partial<WorkflowRunUnitRow>): WorkflowRunUnitRow {
    return {
      run_id: RUN_ID,
      unit_id: "u",
      step_id: "s1",
      node_id: "s1",
      parent_unit_id: null,
      phase: null,
      runner: "sdk",
      model: null,
      input_hash: "h",
      result_json: null,
      status: "failed",
      failure_reason: null,
      tokens: null,
      session_id: null,
      worktree_path: null,
      started_at: null,
      finished_at: null,
      last_checkin_at: null,
      ...overrides,
    } as WorkflowRunUnitRow;
  }

  test("a failed unit's evidence is identical whether the engine or a driver produced it", () => {
    // Engine-shaped: dispatchUnit's UnitTransportError path fills text + error.
    const engineOutcome: UnitOutcome = {
      unitId: "s1:solo",
      ok: false,
      failureReason: "timeout",
      text: "",
      error: "unit dispatch failed",
    };
    // Report-shaped: rehydrated from a driver-reported failed row (no text/error).
    const reportOutcome = unitOutcomeFromRow(
      "s1:solo",
      row({ unit_id: "s1:solo", status: "failed", failure_reason: "timeout" }),
      false,
    );

    const engineEvidence = buildEvidence([engineOutcome], "collect", false);
    const reportEvidence = buildEvidence([reportOutcome], "collect", false);

    // Byte-identical durable projection — the load-bearing R4 invariant.
    expect(canonicalJson(engineEvidence.units)).toBe(canonicalJson(reportEvidence.units));
    // And it carries ONLY the surface-independent fields (no engine-only leakage).
    expect(engineEvidence.units).toEqual([{ unitId: "s1:solo", ok: false, failureReason: "timeout" }]);
  });

  test("a successful unit keeps its promoted contribution on BOTH surfaces", () => {
    const engineOutcome: UnitOutcome = { unitId: "s1:solo", ok: true, text: "did the work", tokens: 42 };
    const reportOutcome = unitOutcomeFromRow(
      "s1:solo",
      row({ unit_id: "s1:solo", status: "completed", result_json: JSON.stringify("did the work"), tokens: 42 }),
      false,
    );
    const engineEvidence = buildEvidence([engineOutcome], "collect", false);
    const reportEvidence = buildEvidence([reportOutcome], "collect", false);
    expect(canonicalJson(engineEvidence.units)).toBe(canonicalJson(reportEvidence.units));
    expect(engineEvidence.units).toEqual([{ unitId: "s1:solo", ok: true, text: "did the work" }]);
  });
});
