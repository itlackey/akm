// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `readRunPlan` — the tolerant read of a run row's frozen plan. A plan of the
 * current irVersion that decodes runs whatever `plan_hash` says; an older one,
 * or one that cannot be decoded, comes back as a problem sentence naming the
 * run (the engine then abandons the run — `tests/integration/workflows/frozen-plan.test.ts`).
 * Pure in-memory logic (no db/network/spawn).
 */

import { describe, expect, test } from "bun:test";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalPlanJson } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_PLAN_VERSION, type WorkflowPlanStep } from "../../src/workflows/plan";
import { readRunPlan } from "../../src/workflows/runtime/run-plan";
import { freezeWorkflow } from "../_helpers/workflow";

const plan = freezeWorkflow(`---
type: workflow
steps:
  - id: only-step
---

## only-step

Do the work.
`);

interface ExecPlanJson {
  irVersion: number;
  steps: Array<{ root: { frozenTarget: Record<string, unknown>; environment: unknown[] } }>;
}

describe("readRunPlan — only the current irVersion runs", () => {
  test("a current plan decodes, with or without a recorded row version", () => {
    for (const version of [null, WORKFLOW_PLAN_VERSION]) {
      const read = readRunPlan({
        id: `run-${version}`,
        plan_json: canonicalPlanJson(plan),
        plan_ir_version: version,
      });
      if (!read.ok) throw new Error(read.problem);
      expect(read.plan.steps.map((step) => step.stepId)).toEqual(["only-step"]);
    }
  });

  test("a plan frozen by an older irVersion is a problem naming the version, so the run starts afresh", () => {
    for (const version of [3, 5, 6, 7]) {
      const planJson = JSON.stringify({ ...JSON.parse(canonicalPlanJson(plan)), irVersion: version });
      const read = readRunPlan({ id: `old-${version}`, plan_json: planJson, plan_ir_version: version });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.newer).toBe(false);
      expect(read.problem).toContain(`old-${version}`);
      expect(read.problem).toContain(`frozen as plan irVersion ${version}`);
    }
  });

  test("non-canonical bytes (whitespace, key order) decode — nothing re-hashes the stored plan", () => {
    const reordered = Object.fromEntries(Object.entries(JSON.parse(canonicalPlanJson(plan))).reverse());
    const read = readRunPlan({
      id: "pretty",
      plan_json: JSON.stringify(reordered, null, 2),
      plan_ir_version: WORKFLOW_PLAN_VERSION,
    });
    expect(read.ok).toBe(true);
  });
});

/** The unit input hash of a step's only unit, as `computeStepWorkList` derives it. */
function unitInputHash(step: WorkflowPlanStep): string {
  const work = computeStepWorkList(step, { runId: "run", params: {}, stepOutputs: {} });
  if (!work.ok) throw new Error(work.error);
  return work.list.units[0]!.inputHash;
}

describe("readRunPlan — a stored plan keeps its stored targets", () => {
  test("a command target's cwdIdentity of {} decodes and is carried, unread, so its hashes survive", () => {
    // Freeze writes it so 0.10.0 and earlier, which decode a command-only plan, refuse it at dispatch.
    const raw = JSON.parse(canonicalPlanJson(plan)) as ExecPlanJson;
    raw.steps[0]!.root.frozenTarget.cwdIdentity = {};
    const read = readRunPlan({ id: "cmd", plan_json: JSON.stringify(raw), plan_ir_version: WORKFLOW_PLAN_VERSION });
    if (!read.ok) throw new Error(read.problem);
    expect(JSON.parse(canonicalPlanJson(read.plan))).toEqual(raw as never);
    expect(unitInputHash(read.plan.steps[0]!)).toBe(unitInputHash(raw.steps[0] as unknown as WorkflowPlanStep));
  });
});

describe("readRunPlan — a newer akm's plan is refused", () => {
  test("a plan a newer akm froze is refused even when it decodes, naming the upgrade", () => {
    const planJson = JSON.stringify({ ...JSON.parse(canonicalPlanJson(plan)), irVersion: WORKFLOW_PLAN_VERSION + 1 });
    const read = readRunPlan({
      id: "future-ok",
      plan_json: planJson,
      plan_ir_version: WORKFLOW_PLAN_VERSION + 1,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.newer).toBe(true);
    expect(read.problem).toContain("future-ok");
    expect(read.problem).toContain(`frozen by a newer akm (plan irVersion ${WORKFLOW_PLAN_VERSION + 1})`);
    expect(read.problem).toContain("Upgrade akm");
  });
});

describe("readRunPlan — an undecodable plan is a problem, not an exception", () => {
  test("invalid JSON names the run", () => {
    const read = readRunPlan({ id: "corrupt-run", plan_json: "{not json", plan_ir_version: WORKFLOW_PLAN_VERSION });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("Workflow run corrupt-run has a frozen plan this akm cannot decode");
  });

  test("a shape this akm cannot decode names the run and the version it was frozen as", () => {
    const read = readRunPlan({
      id: "odd-run",
      plan_json: `{"irVersion":${WORKFLOW_PLAN_VERSION}}`,
      plan_ir_version: WORKFLOW_PLAN_VERSION,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("odd-run");
    expect(read.problem).toContain(`frozen as plan irVersion ${WORKFLOW_PLAN_VERSION}`);
  });

  test("a missing plan names the run", () => {
    const read = readRunPlan({ id: "planless", plan_json: null, plan_ir_version: null });
    expect(read).toEqual({ ok: false, newer: false, problem: "Workflow run planless has no frozen workflow plan." });
  });

  test("a newer akm's plan that does not decode names upgrading akm as the remedy", () => {
    const read = readRunPlan({
      id: "future-run",
      plan_json: `{"irVersion":${WORKFLOW_PLAN_VERSION + 1},"novel":true}`,
      plan_ir_version: WORKFLOW_PLAN_VERSION + 1,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.newer).toBe(true);
    expect(read.problem).toContain(`frozen by a newer akm (plan irVersion ${WORKFLOW_PLAN_VERSION + 1})`);
    expect(read.problem).toContain("Upgrade akm");
  });
});
