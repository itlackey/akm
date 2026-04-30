/**
 * Tests for the workflow compliance evaluator (issue #256).
 *
 * Cases covered (per acceptance criteria):
 *   - pass, partial, fail, not_applicable, harness_error
 *   - wrong-order, missing-event, forbidden-event
 *   - wrong-feedback-polarity, irrelevant-asset-loaded
 *   - violation cap, schemaVersion stability, applies_to filter,
 *     evaluateRunAgainstAllSpecs orchestration, pure-function guarantees.
 */

import { describe, expect, test } from "bun:test";

import {
  evaluateRunAgainstAllSpecs,
  evaluateRunAgainstSpec,
  MAX_VIOLATIONS_PER_CHECK,
  type WorkflowEvalRunContext,
  type WorkflowEvalTaskMetadata,
} from "./workflow-evaluator";
import type { WorkflowForbiddenStep, WorkflowSequenceStep, WorkflowSpec } from "./workflow-spec";
import type { WorkflowTraceEvent, WorkflowTraceEventType, WorkflowTraceResult } from "./workflow-trace";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function makeRun(overrides: Partial<WorkflowEvalRunContext> = {}): WorkflowEvalRunContext {
  return { arm: "akm", taskId: "docker-homelab/redis", seed: 1, outcome: "pass", ...overrides };
}

let nextEventId = 0;
function ev(type: WorkflowTraceEventType, extra: Partial<WorkflowTraceEvent> = {}): WorkflowTraceEvent {
  return {
    id: extra.id ?? nextEventId++,
    taskId: "docker-homelab/redis",
    arm: "akm",
    seed: 1,
    type,
    source: "akm_events",
    ...extra,
  };
}

function makeTrace(events: WorkflowTraceEvent[], overrides: Partial<WorkflowTraceResult> = {}): WorkflowTraceResult {
  // Re-stamp ids so the array's order is the canonical "first occurrence" order.
  const stamped = events.map((e, i) => ({ ...e, id: i }));
  return {
    schemaVersion: 1,
    taskId: "docker-homelab/redis",
    arm: "akm",
    seed: 1,
    events: stamped,
    truncated: false,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  const required: WorkflowSequenceStep[] = overrides.required_sequence ?? [
    { event: "agent_started" },
    { event: "akm_search", before: "first_workspace_write" },
    { event: "first_workspace_write" },
    { event: "agent_finished" },
  ];
  const forbidden: WorkflowForbiddenStep[] | undefined = overrides.forbidden ?? [
    { event: "first_workspace_write", before: "akm_search" },
  ];
  const base: WorkflowSpec = {
    id: "test-spec",
    title: "Test spec",
    required_sequence: required,
    scoring: { required_steps_weight: 0.6, forbidden_steps_weight: 0.2, evidence_quality_weight: 0.2 },
    sourcePath: "/virtual/test-spec.yaml",
  };
  if (forbidden !== undefined) base.forbidden = forbidden;
  return { ...base, ...overrides, required_sequence: required, forbidden };
}

/* ── Status: pass ─────────────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — pass", () => {
  test("all required steps present, no forbidden, in order", () => {
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_search"),
      ev("first_workspace_write"),
      ev("verifier_run", { exitCode: 0 }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, makeSpec(), makeRun());
    expect(result.status).toBe("pass");
    expect(result.requiredPassed).toBe(result.requiredTotal);
    expect(result.violations).toEqual([]);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.schemaVersion).toBe(1);
    expect(result.workflowId).toBe("test-spec");
  });
});

/* ── Status: missing required event ───────────────────────────────────────── */

describe("evaluateRunAgainstSpec — missing required event", () => {
  test("flags missing_required_event when akm_search absent", () => {
    const trace = makeTrace([ev("agent_started"), ev("first_workspace_write"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, makeSpec(), makeRun());
    expect(result.status).toBe("partial"); // some required steps still passed
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("missing_required_event");
    expect(result.requiredPassed).toBeLessThan(result.requiredTotal);
  });

  test("status=fail when zero required steps pass", () => {
    const trace = makeTrace([]);
    const result = evaluateRunAgainstSpec(trace, makeSpec(), makeRun());
    expect(result.status).toBe("fail");
    expect(result.requiredPassed).toBe(0);
  });
});

/* ── Status: wrong order ──────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — wrong order", () => {
  test("flags wrong_order when first_workspace_write precedes akm_search", () => {
    const trace = makeTrace([ev("agent_started"), ev("first_workspace_write"), ev("akm_search"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, makeSpec(), makeRun());
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("wrong_order");
    expect(result.status).not.toBe("pass");
  });

  test("step.after order check fires when this-event precedes guard", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_feedback", after: "verifier_run" },
        { event: "verifier_run" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_feedback", { args: ["+1", "skill:foo"] }),
      ev("verifier_run", { exitCode: 0 }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.violations.some((v) => v.code === "wrong_order")).toBe(true);
  });
});

/* ── Status: forbidden event ──────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — forbidden event", () => {
  test("flags forbidden_event for unconditional forbidden step", () => {
    const spec = makeSpec({
      required_sequence: [{ event: "agent_started" }, { event: "agent_finished" }],
      forbidden: [{ event: "akm_distill" }],
    });
    const trace = makeTrace([ev("agent_started"), ev("akm_distill"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("forbidden_event");
  });

  test("classifies reflection_without_failure for akm_reflect before feedback", () => {
    const spec = makeSpec({
      required_sequence: [{ event: "agent_started" }, { event: "agent_finished" }],
      forbidden: [{ event: "akm_reflect", before: "akm_feedback" }],
    });
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_reflect"),
      ev("akm_feedback", { args: ["-1", "skill:foo"] }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.violations.some((v) => v.code === "reflection_without_failure")).toBe(true);
  });

  test("classifies proposal_accepted_without_validation", () => {
    const spec = makeSpec({
      required_sequence: [{ event: "agent_started" }, { event: "agent_finished" }],
      forbidden: [{ event: "akm_proposal_accept", before: "verifier_run" }],
    });
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_proposal_accept"),
      ev("verifier_run", { exitCode: 0 }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.violations.some((v) => v.code === "proposal_accepted_without_validation")).toBe(true);
  });
});

/* ── Wrong feedback polarity ──────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — wrong feedback polarity", () => {
  test("verifier failed but agent recorded only positive feedback", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_feedback", polarity: "negative" },
        { event: "agent_finished" },
      ],
      forbidden: [{ event: "akm_feedback", polarity: "positive" }],
    });
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_feedback", { args: ["+1", "skill:foo"] }),
      ev("verifier_run", { exitCode: 1 }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun({ outcome: "fail", verifierFailed: true }));
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("wrong_feedback_polarity");
    // The negative-polarity required step should also be missing.
    expect(codes).toContain("missing_required_event");
    expect(result.status).not.toBe("pass");
  });

  test("polarity: positive step matches +1 args", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_feedback", polarity: "positive" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([
      ev("agent_started"),
      ev("akm_feedback", { args: ["+1", "skill:foo"] }),
      ev("verifier_run", { exitCode: 0 }),
      ev("agent_finished"),
    ]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.status).toBe("pass");
  });
});

/* ── Irrelevant asset loaded ──────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — irrelevant_asset_loaded", () => {
  test("flags when akm_show ref doesn't match gold_ref", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_show", ref_must_equal: "gold_ref" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([ev("agent_started"), ev("akm_show", { assetRef: "skill:wrong" }), ev("agent_finished")]);
    const task: WorkflowEvalTaskMetadata = { goldRef: "skill:deploy" };
    const result = evaluateRunAgainstSpec(trace, spec, makeRun(), task);
    const v = result.violations.find((x) => x.code === "irrelevant_asset_loaded");
    expect(v).toBeDefined();
    expect(v?.expected).toBe("skill:deploy");
    expect(v?.observed).toBe("skill:wrong");
  });

  test("top-level gold-ref check fires when spec cares but akm_show never loaded gold", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_show", ref_must_equal: "gold_ref" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([ev("agent_started"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun(), { goldRef: "skill:deploy" });
    // Either the per-step `irrelevant_asset_loaded` OR the spec-level gold check should fire.
    const codes = result.violations.map((v) => v.code);
    expect(codes.some((c) => c === "irrelevant_asset_loaded" || c === "missing_required_event")).toBe(true);
  });

  test("passes when akm_show loads the gold_ref", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_show", ref_must_equal: "gold_ref" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([ev("agent_started"), ev("akm_show", { assetRef: "skill:deploy" }), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun(), { goldRef: "skill:deploy" });
    expect(result.status).toBe("pass");
    expect(result.evidence.goldAssetLoaded).toBe(true);
  });
});

/* ── applies_to filter / not_applicable ───────────────────────────────────── */

describe("evaluateRunAgainstAllSpecs — applies_to", () => {
  test("returns not_applicable when arm filter excludes the run", () => {
    const spec = makeSpec({ applies_to: { arms: ["control"] } });
    const trace = makeTrace([ev("agent_started"), ev("agent_finished")]);
    const results = evaluateRunAgainstAllSpecs(trace, [spec], makeRun({ arm: "akm" }));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("not_applicable");
    expect(results[0].violations).toEqual([]);
    expect(results[0].score).toBe(0);
  });

  test("evaluates spec when applies_to matches", () => {
    const spec = makeSpec({ applies_to: { arms: ["akm"] } });
    const trace = makeTrace([ev("agent_started"), ev("akm_search"), ev("first_workspace_write"), ev("agent_finished")]);
    const results = evaluateRunAgainstAllSpecs(trace, [spec], makeRun());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("pass");
  });

  test("requires_gold_ref filter checks task.goldRef", () => {
    const spec = makeSpec({ applies_to: { requires_gold_ref: true } });
    const trace = makeTrace([ev("agent_started"), ev("akm_search"), ev("first_workspace_write"), ev("agent_finished")]);
    // No goldRef → not_applicable.
    const r1 = evaluateRunAgainstAllSpecs(trace, [spec], makeRun());
    expect(r1[0].status).toBe("not_applicable");
    // With goldRef → applies.
    const r2 = evaluateRunAgainstAllSpecs(trace, [spec], makeRun(), { goldRef: "skill:deploy" });
    expect(r2[0].status).not.toBe("not_applicable");
  });
});

/* ── Harness error ────────────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — harness_error", () => {
  test("malformed trace yields harness_error and does not throw", () => {
    const result = evaluateRunAgainstSpec(undefined, makeSpec(), makeRun());
    expect(result.status).toBe("harness_error");
    expect(result.violations[0].code).toBe("missing_evidence");
    expect(result.score).toBe(0);
    expect(result.schemaVersion).toBe(1);
  });

  test("malformed spec yields harness_error", () => {
    const trace = makeTrace([ev("agent_started")]);
    // @ts-expect-error — intentionally malformed
    const result = evaluateRunAgainstSpec(trace, { id: "x" }, makeRun());
    expect(result.status).toBe("harness_error");
  });

  test("trace with non-array events does not throw", () => {
    // @ts-expect-error — intentional misuse
    const bad: WorkflowTraceResult = { schemaVersion: 1, taskId: "x", arm: "akm", seed: 1, events: null };
    const result = evaluateRunAgainstSpec(bad, makeSpec(), makeRun());
    expect(result.status).toBe("harness_error");
  });

  test("evaluator does not mutate inputs", () => {
    const trace = makeTrace([ev("agent_started"), ev("akm_search"), ev("first_workspace_write"), ev("agent_finished")]);
    const traceJson = JSON.stringify(trace);
    const spec = makeSpec();
    const specJson = JSON.stringify(spec);
    const task: WorkflowEvalTaskMetadata = { goldRef: "skill:deploy", flags: { foo: true } };
    const taskJson = JSON.stringify(task);
    evaluateRunAgainstSpec(trace, spec, makeRun(), task);
    expect(JSON.stringify(trace)).toBe(traceJson);
    expect(JSON.stringify(spec)).toBe(specJson);
    expect(JSON.stringify(task)).toBe(taskJson);
  });
});

/* ── required_if ──────────────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — required_if guards", () => {
  test("step is skipped when required_if flag is false/missing", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_show", required_if: "search_has_relevant_result" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([ev("agent_started"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.status).toBe("pass");
    // requiredTotal should NOT include the gated step.
    expect(result.requiredTotal).toBe(2);
  });

  test("step is enforced when required_if flag is true", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_show", required_if: "search_has_relevant_result" },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const trace = makeTrace([ev("agent_started"), ev("agent_finished")]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun(), {
      flags: { search_has_relevant_result: true },
    });
    expect(result.status).not.toBe("pass");
    expect(result.violations.some((v) => v.code === "missing_required_event")).toBe(true);
  });
});

/* ── min_count ────────────────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — min_count", () => {
  test("requires N matching events with the right polarity", () => {
    const spec = makeSpec({
      required_sequence: [
        { event: "agent_started" },
        { event: "akm_feedback", polarity: "negative", min_count: 2 },
        { event: "agent_finished" },
      ],
      forbidden: [],
    });
    const traceOne = makeTrace([
      ev("agent_started"),
      ev("akm_feedback", { args: ["-1", "skill:foo"] }),
      ev("agent_finished"),
    ]);
    const r1 = evaluateRunAgainstSpec(traceOne, spec, makeRun({ outcome: "fail", verifierFailed: true }));
    expect(r1.violations.some((v) => v.code === "missing_required_event")).toBe(true);

    const traceTwo = makeTrace([
      ev("agent_started"),
      ev("akm_feedback", { args: ["-1", "skill:foo"] }),
      ev("akm_feedback", { args: ["-1", "skill:bar"] }),
      ev("agent_finished"),
    ]);
    const r2 = evaluateRunAgainstSpec(traceTwo, spec, makeRun({ outcome: "fail", verifierFailed: true }));
    expect(r2.status).toBe("pass");
  });
});

/* ── violation cap ────────────────────────────────────────────────────────── */

describe("evaluateRunAgainstSpec — violation cap", () => {
  test("caps violations at MAX_VIOLATIONS_PER_CHECK", () => {
    const required: WorkflowSequenceStep[] = [];
    for (let i = 0; i < MAX_VIOLATIONS_PER_CHECK + 10; i += 1) {
      // Use a known event name (akm_search) so the spec passes loader-style validation
      // even though required_sequence here is constructed in-memory.
      required.push({ event: "akm_search" });
    }
    // Each required step will fail with missing_required_event because trace is empty.
    const spec = makeSpec({ required_sequence: required, forbidden: [] });
    const trace = makeTrace([]);
    const result = evaluateRunAgainstSpec(trace, spec, makeRun());
    expect(result.violations.length).toBe(MAX_VIOLATIONS_PER_CHECK);
  });
});

/* ── schemaVersion stability ──────────────────────────────────────────────── */

describe("WorkflowCheckResult shape", () => {
  test("envelope always carries schemaVersion: 1", () => {
    const trace = makeTrace([ev("agent_started"), ev("agent_finished")]);
    const r = evaluateRunAgainstSpec(trace, makeSpec(), makeRun());
    expect(r.schemaVersion).toBe(1);
    // Check key envelope fields exist.
    expect(typeof r.workflowId).toBe("string");
    expect(typeof r.taskId).toBe("string");
    expect(typeof r.arm).toBe("string");
    expect(typeof r.seed).toBe("number");
    expect(Array.isArray(r.violations)).toBe(true);
    expect(r.evidence).toMatchObject({
      matchedEvents: expect.any(Number),
      feedbackRecorded: expect.any(Boolean),
      goldAssetLoaded: expect.any(Boolean),
      traceTruncated: expect.any(Boolean),
    });
  });
});
