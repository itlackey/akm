// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { reduceStepOutcomes, type UnitOutcome, unitSchemaWarning } from "../../src/workflows/exec/step-work";
import type { WorkflowPlanStep } from "../../src/workflows/plan";

const SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    research_path: { type: "string", minLength: 1 },
  },
  required: ["verified", "research_path"],
};

function planWithUnitSchema(schema?: Record<string, unknown>): WorkflowPlanStep {
  return {
    stepId: "research",
    title: "research",
    sequenceIndex: 0,
    gate: { kind: "gate", id: "research.gate", stepId: "research", criteria: [] },
    root: { kind: "agent", id: "research.unit", instructions: "", onError: "fail", ...(schema ? { schema } : {}) },
  } as unknown as WorkflowPlanStep;
}

describe("unitSchemaWarning — advisory per-unit output check", () => {
  test("no declared unit schema: nothing to check", () => {
    const plan = planWithUnitSchema(undefined);
    const units: UnitOutcome[] = [{ unitId: "u1", ok: true, text: "anything at all" }];
    expect(unitSchemaWarning(plan, units)).toBeUndefined();
  });

  test("a compliant structured result produces no warning", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [{ unitId: "u1", ok: true, result: { verified: true, research_path: "WORK/r.json" } }];
    expect(unitSchemaWarning(plan, units)).toBeUndefined();
  });

  test("free text embedding JSON that omits a required field is caught and named", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [
      {
        unitId: "research",
        ok: true,
        text: 'Dispatched but could not find manifest.json.\n```json\n{"verified": true, "positions_covered": 0}\n```',
      },
    ];
    const warning = unitSchemaWarning(plan, units);
    expect(warning).toBeDefined();
    expect(warning).toContain('unit "research"');
    expect(warning).toContain("research_path");
    expect(warning).toContain("advisory");
  });

  test("output with no parseable structure at all is flagged too", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [{ unitId: "u1", ok: true, text: "report creation was blocked" }];
    const warning = unitSchemaWarning(plan, units);
    expect(warning).toContain('unit "u1" produced no structured output');
  });

  test("a failed unit is never checked against the schema", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [{ unitId: "u1", ok: false, failureReason: "dispatch_error" }];
    expect(unitSchemaWarning(plan, units)).toBeUndefined();
  });
});

describe("reduceStepOutcomes — the schema warning never fails the run", () => {
  test("a mismatching unit's step still completes ok, with the warning appended to the summary", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [{ unitId: "research", ok: true, result: { verified: true, positions_covered: 0 } }];
    const outcome = reduceStepOutcomes(plan, "collect", false, "fail", units);
    expect(outcome.ok).toBe(true);
    expect(outcome.artifactSchemaFailure).toBeUndefined();
    expect(outcome.summary).toContain("research_path");
    expect(outcome.summary).toContain("advisory");
  });

  test("a matching unit's step completes ok with no warning text in the summary", () => {
    const plan = planWithUnitSchema(SCHEMA);
    const units: UnitOutcome[] = [{ unitId: "research", ok: true, result: { verified: true, research_path: "x" } }];
    const outcome = reduceStepOutcomes(plan, "collect", false, "fail", units);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).not.toContain("advisory");
  });

  test("a step with no declared unit schema is unchanged", () => {
    const plan = planWithUnitSchema(undefined);
    const units: UnitOutcome[] = [{ unitId: "u1", ok: true, result: { anything: 1 } }];
    const outcome = reduceStepOutcomes(plan, "collect", false, "fail", units);
    expect(outcome.summary).not.toContain("advisory");
  });
});
