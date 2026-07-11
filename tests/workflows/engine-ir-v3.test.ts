// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { compileResolveFreezeWorkflow } from "../../src/workflows/ir/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV3, type WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { classifyWorkflowRunPlan } from "../../src/workflows/runtime/plan-classifier";

const SOURCE = { path: "workflows/review.yaml" };

function frozenPlan(): WorkflowPlanGraph {
  return {
    irVersion: 3,
    title: "review",
    execution: {
      maxConcurrency: 2,
      engines: {
        fast: {
          name: "fast",
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          credential: { names: ["FAST_API_KEY"], required: true },
          concurrency: 1,
        },
      },
    },
    steps: [
      {
        stepId: "review",
        title: "review",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "review",
          instructions: "Review the change.",
          templating: "expressions",
          invocation: { engine: "fast", model: "qwen", timeoutMs: 600000 },
          onError: "fail",
          isolation: "none",
        },
        gate: {
          kind: "gate",
          id: "review.gate",
          stepId: "review",
          criteria: [],
          maxLoops: 1,
          required: false,
          judge: null,
        },
      },
    ],
  } as WorkflowPlanGraph;
}

describe("workflow engine v3 contracts", () => {
  test("YAML v2 accepts engine and rejects retired selectors", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: reviewer }\nsteps:\n  - id: review\n    unit: { engine: fast, instructions: Review }\n",
      SOURCE,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.program.steps[0]?.unit?.engine).toBe("fast");

    const retired = parseWorkflowProgram(
      "version: 1\nname: review\nsteps:\n  - id: review\n    unit: { runner: llm, profile: fast, instructions: Review }\n",
      SOURCE,
    );
    expect(retired.ok).toBe(false);
    if (!retired.ok) expect(retired.errors.map((e) => e.message).join(" ")).toContain("version 1 retired");
  });

  test("strict decoder accepts a canonical frozen catalog and rejects unreferenced entries", () => {
    const plan = frozenPlan();
    expect(decodeWorkflowPlanV3(plan).irVersion).toBe(3);
    expect(canonicalPlanJson(plan)).toContain('"credential":{"names":["FAST_API_KEY"],"required":true}');
    expect(computePlanHash(plan)).toHaveLength(64);

    const extra = structuredClone(plan);
    (extra.execution?.engines as Record<string, unknown>).unused = {
      name: "unused",
      kind: "llm",
      endpoint: "https://example.test/v1/chat/completions",
      concurrency: 1,
    };
    expect(() => decodeWorkflowPlanV3(extra)).toThrow("not referenced");
  });

  test("freeze resolves an engine once and keeps only symbolic credentials", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: fast }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflow:review",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "review",
        steps: [{ id: "review", title: "review", instructions: "Review", sequenceIndex: 0 }],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          fast: {
            kind: "llm",
            endpoint: "https://example.test/v1/chat/completions",
            model: "qwen",
            apiKey: `\${FAST_API_KEY}`,
          },
        },
        defaults: { engine: "fast" },
      } as never,
    );
    const unit = frozen.plan.steps[0]?.root;
    expect(unit?.kind).toBe("unit");
    expect(frozen.plan.execution?.engines.fast).toMatchObject({
      kind: "llm",
      credential: { names: ["FAST_API_KEY"], required: true },
    });
    expect(canonicalPlanJson(frozen.plan)).not.toContain(process.env.FAST_API_KEY ?? "unavailable-secret");
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });

  test("classification rejects null, v2, noncanonical, and bad-hash plans before mutation", () => {
    expect(classifyWorkflowRunPlan({ plan_json: null, plan_hash: null, plan_ir_version: null }).support).toBe(
      "missing-plan",
    );
    expect(
      classifyWorkflowRunPlan({ plan_json: '{"irVersion":2}', plan_hash: null, plan_ir_version: null }).support,
    ).toBe("unsupported-version");

    const plan = frozenPlan();
    const canonical = canonicalPlanJson(plan);
    expect(
      classifyWorkflowRunPlan({ plan_json: canonical, plan_hash: computePlanHash(plan), plan_ir_version: 3 }).support,
    ).toBe("supported");
    expect(
      classifyWorkflowRunPlan({ plan_json: JSON.stringify(plan), plan_hash: computePlanHash(plan), plan_ir_version: 3 })
        .support,
    ).toBe("corrupt-plan");
  });
});
