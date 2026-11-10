// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { getWorkflowTemplate } from "../../src/workflows/authoring/authoring";
import { checkWorkflowPlan, compileWorkflowSource } from "../../src/workflows/compile";
import { reduceStepOutcomes, type UnitOutcome, unitSchemaWarning } from "../../src/workflows/exec/step-work";
import type { WorkflowPlanStep } from "../../src/workflows/plan";
import { type SummaryJudge, validateStepSummary } from "../../src/workflows/validate-summary";

/**
 * Pins that the shipped workflow template
 * (`src/assets/workflows/workflow-template.md`, printed by `akm workflow
 * create <name> --print`) actually parses AND compiles under the unified
 * workflow format (workflow-format-unification). One template now — the
 * pre-unification YAML-program template test is gone along with the format.
 *
 * NOTE: `src/assets/workflows/workflow-template.md` is owned by a parallel
 * agent updating it to the unified format; until that lands this test is
 * expected to fail (the file still uses the pre-unification grammar).
 */

describe("shipped workflow template", () => {
  test("parses and compiles cleanly", () => {
    const markdown = getWorkflowTemplate();

    const source = compileWorkflowSource(markdown, { path: "workflows/template.md" });
    if (!source.ok) {
      throw new Error(`template compile failed: ${source.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    const compiled = checkWorkflowPlan(source.plan);
    if (!compiled.ok) {
      throw new Error(`template compile failed: ${compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
    }

    expect(source.ok).toBe(true);
    expect(compiled.ok).toBe(true);
  });
});

const input = {
  stepTitle: "Validate release",
  completionCriteria: ["Release notes reviewed", "Version matches tag"],
  summary: "I reviewed the release notes and confirmed the version matches the tag.",
};

describe("validateStepSummary (#506 — completion-criteria gate)", () => {
  test("skips (fail-open) when there are no completion criteria", async () => {
    const result = await validateStepSummary({ ...input, completionCriteria: [] }, async () => "unused");
    expect(result).toEqual({ complete: true, missing: [], skipped: true });
  });

  test("rejects when no judge is available", async () => {
    const result = await validateStepSummary(input, undefined);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(input.completionCriteria);
  });

  test("passes when the judge returns complete:true", async () => {
    const judge: SummaryJudge = async () => '{"complete": true, "missing": [], "feedback": ""}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  test("fails with structured corrective feedback when the judge returns complete:false", async () => {
    const judge: SummaryJudge = async () =>
      '{"complete": false, "missing": ["Version matches tag"], "feedback": "Confirm the tagged version explicitly."}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["Version matches tag"]);
    expect(result.feedback).toBe("Confirm the tagged version explicitly.");
  });

  test("tolerates code-fenced JSON from the model", async () => {
    const judge: SummaryJudge = async () =>
      '```json\n{"complete": false, "missing": ["Release notes reviewed"], "feedback": "Review notes."}\n```';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["Release notes reviewed"]);
  });

  test("fails closed when the judge throws", async () => {
    const judge: SummaryJudge = async () => {
      throw new Error("network down");
    };
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(input.completionCriteria);
    expect(result.feedback).toContain("judge failed");
  });

  test("fails closed when the model returns unparseable output", async () => {
    const judge: SummaryJudge = async () => "totally not json";
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(input.completionCriteria);
    expect(result.feedback).toContain("malformed verdict");
  });

  test("synthesizes feedback when the model omits it", async () => {
    const judge: SummaryJudge = async () => '{"complete": false, "missing": ["X"]}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(typeof result.feedback).toBe("string");
    expect(result.feedback?.length).toBeGreaterThan(0);
  });
});

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
