// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { cpuDerivedUnitConcurrency } from "../../src/workflows/concurrency-policy";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { compileResolveFreezeWorkflow } from "../../src/workflows/ir/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV3, type WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_INSTRUCTION_BYTES,
  WORKFLOW_MAX_MAP_EXPANSION,
  WORKFLOW_MAX_PLAN_BYTES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_SOURCE_BYTES,
} from "../../src/workflows/resource-limits";
import {
  classifyWorkflowRunPlan,
  requireAbandonableWorkflowPlan,
  requireExecutableWorkflowPlan,
} from "../../src/workflows/runtime/plan-classifier";

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

function jsonObjectAtBytes(limit: number): Record<string, unknown> {
  const value = { value: "" };
  value.value = "x".repeat(limit - jsonBytes(value));
  expect(jsonBytes(value)).toBe(limit);
  return value;
}

function planAtBytes(limit: number): WorkflowPlanGraph {
  const plan = frozenPlan();
  const engine = plan.execution?.engines.fast;
  if (!engine || engine.kind !== "llm") throw new Error("fixture requires an LLM engine");
  for (const target of [
    { get: () => plan.title, set: (value: string) => (plan.title = value) },
    { get: () => engine.provider ?? "", set: (value: string) => (engine.provider = value) },
    { get: () => engine.model, set: (value: string) => (engine.model = value) },
  ]) {
    const remaining = limit - jsonBytes(plan);
    if (remaining <= 0) break;
    target.set(target.get() + "x".repeat(Math.min(remaining, 900_000)));
  }
  const remaining = limit - jsonBytes(plan);
  if (remaining > 0) plan.title += "x".repeat(remaining);
  expect(jsonBytes(plan)).toBe(limit);
  return plan;
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
        ref: "workflows/review",
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
    expect(frozen.plan.execution?.maxConcurrency).toBe(cpuDerivedUnitConcurrency());
    expect(frozen.plan.execution?.engines.fast).not.toHaveProperty("timeoutMs");
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
    budget.budget = { maxUnits: 10_000 };
    expect(() => decodeWorkflowPlanV3(budget)).not.toThrow();
    budget.budget = { maxUnits: 10_001 };
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

  test("malformed null, v2, and future historical plans remain abandonable while every attributable v3 is protected", () => {
    const historical = [
      { plan_json: "{malformed", plan_hash: null, plan_ir_version: null, id: "null-version" },
      { plan_json: "{malformed", plan_hash: null, plan_ir_version: 2, id: "v2" },
      { plan_json: "{malformed", plan_hash: null, plan_ir_version: 4, id: "future" },
      { plan_json: null, plan_hash: null, plan_ir_version: 2, id: "missing-v2" },
    ];
    expect(historical.map((row) => classifyWorkflowRunPlan(row).support)).toEqual([
      "missing-plan",
      "unsupported-version",
      "unsupported-version",
      "unsupported-version",
    ]);
    for (const row of historical) expect(() => requireAbandonableWorkflowPlan(row)).not.toThrow();

    const attributableV3 = [
      { plan_json: "{malformed", plan_hash: null, plan_ir_version: 3, id: "stored-v3" },
      { plan_json: '{"irVersion":3}', plan_hash: null, plan_ir_version: null, id: "content-v3" },
      { plan_json: '{"irVersion":3}', plan_hash: null, plan_ir_version: 2, id: "mismatched-v3" },
      { plan_json: null, plan_hash: null, plan_ir_version: 3, id: "missing-v3" },
    ];
    for (const row of attributableV3) {
      expect(classifyWorkflowRunPlan(row).support).toBe("corrupt-plan");
      expect(() => requireAbandonableWorkflowPlan(row)).toThrow();
    }
  });

  test("freeze captures canonical platform lowering including builder identity", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: shell }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflows/review",
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
        ref: "workflows/review",
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
    expect(root.invocation).toEqual({ engine: "sdk", model: "agent/exact", timeoutMs: 600_000 });
    expect(frozen.plan.execution?.engines.fallback).toMatchObject({ kind: "llm", model: "fallback/exact" });
    expect(frozen.plan.execution?.engines.fallback).not.toHaveProperty("timeoutMs");
    expect(frozen.plan.steps[0]?.gate.judge).toEqual({
      engine: "fallback",
      model: "fallback/exact",
      timeoutMs: 600_000,
    });
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });

  test("SDK engines without a model freeze their effective fallback model into the invocation", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflows/review",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "review",
        steps: [],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
          fallback: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "economy" },
        },
        defaults: { engine: "sdk", llmEngine: "fallback" },
        modelAliases: { economy: { fallback: "fallback/exact" } },
      } as never,
    );
    const root = frozen.plan.steps[0]?.root;
    expect(root?.kind).toBe("unit");
    if (!root || root.kind !== "unit") throw new Error("fixture root must be unit");

    expect(root.invocation?.model).toBe("fallback/exact");
    const work = computeStepWorkList(frozen.plan.steps[0], {
      runId: "run-sdk-fallback",
      params: {},
      stepOutputs: {},
      engines: frozen.plan.execution?.engines,
    });
    expect(work.ok).toBe(true);
    if (!work.ok) throw new Error(work.error);
    expect(work.list.units[0]?.invocation?.model).toBe("fallback/exact");
  });

  test("direct and frozen fallback paths use the shared llm alias tier with exact attribution", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: review\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n    unit: { instructions: Review }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflows/review",
        path: SOURCE.path,
        sourcePath: "/tmp",
        title: "review",
        steps: [],
        program: parsed.program,
      },
      {
        configVersion: "0.9.0",
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
          fallback: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "economy" },
        },
        defaults: { engine: "sdk", llmEngine: "fallback" },
        modelAliases: { economy: { llm: "provider/exact-fallback", "*": "wrong" } },
      } as never,
    );
    const root = frozen.plan.steps[0]?.root;
    if (!root || root.kind !== "unit") throw new Error("fixture root must be unit");

    expect(root.invocation).toMatchObject({ engine: "sdk", model: "provider/exact-fallback" });
    expect(frozen.plan.execution?.engines.fallback).toMatchObject({
      name: "fallback",
      kind: "llm",
      model: "provider/exact-fallback",
    });
  });

  test("freeze preserves merged per-invocation LLM settings and explicit null timeout", () => {
    const parsed = parseWorkflowProgram(
      "version: 2\nname: direct\ndefaults:\n  engine: direct\n  timeout: none\n  llm: { temperature: 0.2, extra_params: { seed: 7 } }\nsteps:\n  - id: review\n    unit:\n      instructions: Review\n      llm: { max_tokens: 77, enable_thinking: true }\n",
      SOURCE,
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const frozen = compileResolveFreezeWorkflow(
      {
        ref: "workflows/direct",
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

  test("source and frozen plan byte limits accept the exact boundary and reject one byte over", () => {
    const sourceBase = "version: 2\nname: bounded\nsteps:\n  - id: work\n    unit: { instructions: Work }\n";
    const exactSource = `${sourceBase}#${"x".repeat(WORKFLOW_MAX_SOURCE_BYTES - utf8Bytes(sourceBase) - 1)}`;
    expect(utf8Bytes(exactSource)).toBe(WORKFLOW_MAX_SOURCE_BYTES);
    expect(parseWorkflowProgram(exactSource, SOURCE).ok).toBe(true);
    const oversizedSource = parseWorkflowProgram(`${exactSource}x`, SOURCE);
    expect(oversizedSource.ok).toBe(false);
    if (!oversizedSource.ok) expect(oversizedSource.errors[0]?.message).toContain("1 MiB");

    const exactPlan = planAtBytes(WORKFLOW_MAX_PLAN_BYTES);
    expect(() => decodeWorkflowPlanV3(exactPlan)).not.toThrow();
    exactPlan.title += "x";
    expect(() => decodeWorkflowPlanV3(exactPlan)).toThrow("2 MiB");
  });

  test("step, engine, param, and route cardinalities bind at their exact limits", () => {
    const steps = frozenPlan();
    const template = stepAt(steps, 0);
    steps.steps = Array.from({ length: 256 }, (_, index) => ({
      ...structuredClone(template),
      stepId: `step-${index}`,
      title: `step-${index}`,
      sequenceIndex: index,
      root: { ...structuredClone(template.root as object), id: `step-${index}` } as never,
      gate: { ...structuredClone(template.gate), id: `step-${index}.gate`, stepId: `step-${index}` },
    }));
    expect(() => decodeWorkflowPlanV3(steps)).not.toThrow();
    const lastStep = steps.steps[255];
    if (!lastStep) throw new Error("fixture requires 256 steps");
    steps.steps.push({
      ...structuredClone(lastStep),
      stepId: "step-256",
      title: "step-256",
      sequenceIndex: 256,
      root: { ...structuredClone(lastStep.root as object), id: "step-256" } as never,
      gate: { ...structuredClone(lastStep.gate), id: "step-256.gate", stepId: "step-256" },
    });
    expect(() => decodeWorkflowPlanV3(steps)).toThrow("1 through 256");

    const params = frozenPlan();
    params.params = Array.from({ length: 128 }, (_, index) => `p${index}`);
    expect(() => decodeWorkflowPlanV3(params)).not.toThrow();
    params.params.push("p128");
    expect(() => decodeWorkflowPlanV3(params)).toThrow("params is invalid");

    const route = secondStep(frozenPlan());
    const routeStep = stepAt(route, 0);
    delete routeStep.root;
    routeStep.route = {
      input: `\${{ params.mode }}`,
      when: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`match-${index}`, "second"])),
    };
    expect(() => decodeWorkflowPlanV3(route)).not.toThrow();
    routeStep.route.when.overflow = "second";
    expect(() => decodeWorkflowPlanV3(route)).toThrow("route for step review is invalid");

    const engines = frozenPlan();
    const first = stepAt(engines, 0);
    engines.execution = { maxConcurrency: 1, engines: {} };
    engines.steps = Array.from({ length: 64 }, (_, index) => {
      const name = `engine-${index}`;
      if (!engines.execution) throw new Error("fixture requires execution");
      engines.execution.engines[name] = {
        name,
        kind: "llm",
        endpoint: "https://example.test/v1/chat/completions",
        model: "qwen",
        concurrency: 1,
      };
      return {
        ...structuredClone(first),
        stepId: `work-${index}`,
        title: `work-${index}`,
        sequenceIndex: index,
        root: {
          ...structuredClone(first.root as object),
          id: `work-${index}`,
          invocation: { engine: name, model: "qwen", timeoutMs: null },
        } as never,
        gate: { ...structuredClone(first.gate), id: `work-${index}.gate`, stepId: `work-${index}` },
      };
    });
    expect(() => decodeWorkflowPlanV3(engines)).not.toThrow();
    if (!engines.execution) throw new Error("fixture requires execution");
    engines.execution.engines.overflow = {
      name: "overflow",
      kind: "llm",
      endpoint: "https://example.test/v1/chat/completions",
      model: "qwen",
      concurrency: 1,
    };
    expect(() => decodeWorkflowPlanV3(engines)).toThrow("exceeds 64 entries");
  });

  test("instruction, schema, extraParams, and depth limits are exact and expose the policy hook", () => {
    const instructions = frozenPlan();
    const root = stepAt(instructions, 0).root;
    if (!root || root.kind === "map") throw new Error("fixture requires unit");
    root.instructions = "x".repeat(WORKFLOW_MAX_INSTRUCTION_BYTES);
    expect(() => decodeWorkflowPlanV3(instructions)).not.toThrow();
    root.instructions += "x";
    expect(() => decodeWorkflowPlanV3(instructions)).toThrow("256 KiB");

    const schema = frozenPlan();
    const schemaRoot = stepAt(schema, 0).root;
    if (!schemaRoot || schemaRoot.kind === "map") throw new Error("fixture requires unit");
    schemaRoot.schema = jsonObjectAtBytes(WORKFLOW_MAX_SCHEMA_BYTES);
    expect(() => decodeWorkflowPlanV3(schema)).not.toThrow();
    (schemaRoot.schema as { value: string }).value += "x";
    expect(() => decodeWorkflowPlanV3(schema)).toThrow("256 KiB");

    const extras = frozenPlan();
    const engine = extras.execution?.engines.fast;
    if (!engine || engine.kind !== "llm") throw new Error("fixture requires LLM");
    engine.extraParams = jsonObjectAtBytes(WORKFLOW_MAX_EXTRA_PARAMS_BYTES);
    const seen: string[] = [];
    expect(() =>
      decodeWorkflowPlanV3(extras, {
        validateExtraParams: (_value, location) => {
          seen.push(location);
          return undefined;
        },
      }),
    ).not.toThrow();
    expect(seen).toEqual(["LLM engine fast extraParams"]);
    (engine.extraParams as { value: string }).value += "x";
    expect(() => decodeWorkflowPlanV3(extras)).toThrow("64 KiB");

    const atDepth = frozenPlan();
    const depthEngine = atDepth.execution?.engines.fast;
    if (!depthEngine || depthEngine.kind !== "llm") throw new Error("fixture requires LLM");
    let nested: Record<string, unknown> = {};
    depthEngine.extraParams = nested;
    for (let depth = 0; depth < 59; depth++) nested = nested.child = {};
    nested.child = {};
    expect(() => decodeWorkflowPlanV3(atDepth)).not.toThrow();
    nested = nested.child as Record<string, unknown>;
    nested.child = {};
    expect(() => decodeWorkflowPlanV3(atDepth)).toThrow("depth limit of 64");
  });

  test("map expansion binds at 10k independently of the dispatch budget", () => {
    const plan = frozenPlan();
    const root = stepAt(plan, 0).root;
    if (!root || root.kind === "map") throw new Error("fixture requires unit");
    stepAt(plan, 0).root = {
      kind: "map",
      id: "review.map",
      over: `\${{ params.items }}`,
      template: { ...root, id: "review.unit" },
      concurrency: 1,
      reducer: "collect",
    };
    const input = (count: number) =>
      computeStepWorkList(stepAt(plan, 0), {
        runId: "run",
        params: { items: Array.from({ length: count }, (_, index) => index) },
        stepOutputs: {},
        engines: plan.execution?.engines,
      });
    expect(input(WORKFLOW_MAX_MAP_EXPANSION).ok).toBe(true);
    expect(input(WORKFLOW_MAX_MAP_EXPANSION + 1).ok).toBe(false);
    // 10k-item expansion is CPU-heavy (~8s alone, ~18s under 4-way shard
    // contention in sandboxed CI containers); the timeout guards against a
    // hang, not a performance contract — keep it clear of contended runs.
  // 180s: this 10k-fan-out contract runs ~60s solo on a loaded 4-core box
  // (comfortably faster on CI); the budget exists to catch hangs, not to
  // police throughput on shared hardware.
  }, 180_000);
});
