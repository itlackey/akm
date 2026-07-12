// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { compileResolveFreezeWorkflow } from "../../src/workflows/ir/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV3, type WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { classifyWorkflowRunPlan, requireExecutableWorkflowPlan } from "../../src/workflows/runtime/plan-classifier";

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
          model: "qwen",
          timeoutMs: null,
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

function secondStep(plan: WorkflowPlanGraph): WorkflowPlanGraph {
  const next = structuredClone(plan);
  const first = next.steps[0];
  if (!first?.root || first.root.kind === "map") throw new Error("fixture root must be a unit");
  next.steps.push({
    ...structuredClone(first),
    stepId: "second",
    title: "second",
    sequenceIndex: 1,
    root: { ...structuredClone(first.root), id: "second" },
    gate: { ...structuredClone(first.gate), id: "second.gate", stepId: "second" },
  });
  return next;
}

function stepAt(plan: WorkflowPlanGraph, index: number) {
  const step = plan.steps[index];
  if (!step) throw new Error(`fixture requires step ${index}`);
  return step;
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
      model: "unused-model",
      timeoutMs: null,
      concurrency: 1,
    };
    expect(() => decodeWorkflowPlanV3(extra)).toThrow("not referenced");
  });

  test("strict decoder rejects unsafe extraParams in snapshots and invocation overlays", () => {
    const snapshot = frozenPlan();
    const engine = snapshot.execution?.engines.fast;
    if (!engine || engine.kind !== "llm") throw new Error("fixture engine must be LLM");
    engine.extraParams = { provider: [{ API_KEY: "leak" }] };
    expect(() => decodeWorkflowPlanV3(snapshot)).toThrow("cannot carry credentials");

    const invocation = frozenPlan();
    const root = invocation.steps[0]?.root;
    if (!root || root.kind !== "unit" || !root.invocation) throw new Error("fixture root must be a unit invocation");
    root.invocation.llm = { extraParams: { response_format: {} } };
    expect(() => decodeWorkflowPlanV3(invocation)).toThrow("protected by AKM");
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

  test("decoder is recursively strict for every structural object", () => {
    const cases: Array<(plan: WorkflowPlanGraph) => void> = [
      (plan) => Object.assign(plan.execution as object, { surprise: true }),
      (plan) => Object.assign(plan.execution?.engines.fast as object, { surprise: true }),
      (plan) => Object.assign((plan.execution?.engines.fast as { credential: object }).credential, { value: "secret" }),
      (plan) => Object.assign(plan.steps[0]?.gate as object, { surprise: true }),
      (plan) => Object.assign(plan.steps[0]?.root as object, { surprise: true }),
      (plan) => Object.assign((plan.steps[0]?.root as { invocation: object }).invocation, { llm: { surprise: true } }),
      (plan) =>
        Object.assign(plan.steps[0]?.root as object, {
          source: { path: "workflows/review.yaml", start: 1, end: 1, surprise: true },
        }),
      (plan) => Object.assign(plan, { budget: { maxUnits: 1, surprise: true } }),
    ];
    for (const mutate of cases) {
      const candidate = frozenPlan();
      mutate(candidate);
      expect(() => decodeWorkflowPlanV3(candidate)).toThrow();
    }
  });

  test("decoder enforces resource, retry, topology, route, dependency, and expression bounds", () => {
    const invalid: WorkflowPlanGraph[] = [];

    const concurrency = frozenPlan();
    if (concurrency.execution) concurrency.execution.maxConcurrency = 65;
    invalid.push(concurrency);

    const budget = frozenPlan();
    budget.budget = { maxUnits: 1001 };
    invalid.push(budget);

    const loops = frozenPlan();
    stepAt(loops, 0).gate.maxLoops = 101;
    invalid.push(loops);

    const retry = frozenPlan();
    if (retry.steps[0]?.root?.kind === "unit") retry.steps[0].root.retry = { max: 101, on: ["timeout"] };
    invalid.push(retry);

    const badReason = frozenPlan();
    if (badReason.steps[0]?.root?.kind === "unit") badReason.steps[0].root.retry = { max: 1, on: ["bogus"] };
    invalid.push(badReason);

    const selfExpression = frozenPlan();
    if (selfExpression.steps[0]?.root?.kind === "unit") {
      selfExpression.steps[0].root.instructions = `\${{ steps.review.output }}`;
      selfExpression.steps[0].root.templating = "expressions";
    }
    invalid.push(selfExpression);

    const forwardDependency = secondStep(frozenPlan());
    stepAt(forwardDependency, 0).dependsOn = ["second"];
    invalid.push(forwardDependency);

    const backwardRoute = secondStep(frozenPlan());
    const backwardRouteStep = stepAt(backwardRoute, 1);
    delete backwardRouteStep.root;
    backwardRouteStep.route = { input: `\${{ steps.review.output }}`, when: { pass: "review" } };
    invalid.push(backwardRoute);

    const routeUnknownKey = secondStep(frozenPlan());
    const routeUnknownStep = stepAt(routeUnknownKey, 0);
    delete routeUnknownStep.root;
    routeUnknownStep.route = { input: `\${{ params.mode }}`, when: { pass: "second" } };
    Object.assign(routeUnknownStep.route, { surprise: true });
    invalid.push(routeUnknownKey);

    for (const candidate of invalid) expect(() => decodeWorkflowPlanV3(candidate)).toThrow();
  });

  test("classification distinguishes unsupported versions from corrupt version metadata", () => {
    const unsupported = { plan_json: '{"irVersion":2}', plan_hash: null, plan_ir_version: 2, id: "old" };
    expect(classifyWorkflowRunPlan(unsupported).support).toBe("unsupported-version");
    try {
      requireExecutableWorkflowPlan(unsupported);
      throw new Error("expected unsupported plan rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("WORKFLOW_IR_VERSION_UNSUPPORTED");
    }

    const plan = frozenPlan();
    const canonical = canonicalPlanJson(plan);
    expect(
      classifyWorkflowRunPlan({ plan_json: canonical, plan_hash: computePlanHash(plan), plan_ir_version: 2 }).support,
    ).toBe("corrupt-plan");
    expect(
      classifyWorkflowRunPlan({ plan_json: '{"irVersion":"3"}', plan_hash: null, plan_ir_version: 3 }).support,
    ).toBe("corrupt-plan");
  });

  test("freeze captures canonical platform lowering including builder identity", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: shell }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflow:review",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "review",
        steps: [],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          shell: {
            kind: "agent",
            platform: "codex",
            bin: "codex-custom",
            args: ["exec", "--json"],
            workspace: "workspace",
          },
        },
        defaults: { engine: "shell" },
      } as never,
    );
    expect(frozen.plan.execution?.engines.shell).toMatchObject({
      kind: "agent",
      platform: "codex",
      bin: "codex-custom",
      args: ["exec", "--json"],
      workspace: path.resolve("workspace"),
      commandBuilder: "codex",
    });
    expect((frozen.plan.execution?.engines.shell as { envPassthrough: string[] }).envPassthrough).toContain("PATH");
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });

  test("freeze resolves exact SDK, fallback, and gate models with null timeouts", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n    gate: { criteria: [approved] }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflow:review",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "review",
        steps: [],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk", model: "premium", llmEngine: "fallback" },
          fallback: {
            kind: "llm",
            endpoint: "https://example.test/v1/chat/completions",
            model: "economy",
          },
        },
        defaults: { engine: "sdk", llmEngine: "fallback" },
        modelAliases: {
          premium: { "opencode-sdk": "agent/exact" },
          economy: { fallback: "fallback/exact" },
        },
      } as never,
    );
    const root = frozen.plan.steps[0]?.root;
    expect(root?.kind).toBe("unit");
    if (!root || root.kind !== "unit") throw new Error("fixture root must be unit");
    expect(root.invocation).toEqual({ engine: "sdk", model: "agent/exact", timeoutMs: null });
    expect(frozen.plan.execution?.engines.fallback).toMatchObject({ kind: "llm", model: "fallback/exact" });
    expect(frozen.plan.steps[0]?.gate.judge).toEqual({
      engine: "fallback",
      model: "fallback/exact",
      timeoutMs: null,
    });
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });

  test("freeze preserves merged per-invocation LLM settings and explicit null timeout", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: direct\ndefaults:\n  engine: direct\n  timeout: none\n  llm: { temperature: 0.2, extra_params: { seed: 7 } }\nsteps:\n  - id: review\n    unit:\n      instructions: Review\n      llm: { max_tokens: 77, enable_thinking: true }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflow:direct",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "direct",
        steps: [],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          direct: {
            kind: "llm",
            endpoint: "https://example.test/v1/chat/completions",
            model: "qwen",
          },
        },
        defaults: { engine: "direct" },
      } as never,
    );
    const root = frozen.plan.steps[0]?.root;
    if (!root || root.kind !== "unit") throw new Error("fixture root must be unit");
    expect(root.invocation).toEqual({
      engine: "direct",
      model: "qwen",
      timeoutMs: null,
      llm: { temperature: 0.2, extraParams: { seed: 7 }, maxTokens: 77, enableThinking: true },
    });
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });
});
