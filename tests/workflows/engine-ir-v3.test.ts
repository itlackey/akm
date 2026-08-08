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
import { parseWorkflow } from "../../src/workflows/parser";
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
import { classifyWorkflowRunPlan, requireExecutableWorkflowPlan } from "../../src/workflows/runtime/plan-classifier";

/**
 * RUNTIME-02: gates the CPU-heavy 10k-item map-expansion boundary test below
 * (measured 4.7s solo — the file's inline comment claiming "~8s alone, up to
 * 60s on a loaded box" was inflated). Matches the existing `AKM_*_TESTS ===
 * "1"` opt-in gates in the tree (strict equality, not `!!process.env`); also
 * gates the ≥1000-case cutover-rekey property gate
 * (`tests/migrate/legacy/cutover-rekey-property-gate.test.ts`), and both are
 * given a dedicated CI invocation (the `slow-gated-tests` job in
 * `.github/workflows/ci.yml`) so gating does not silently retire them.
 */
const RUN_SLOW_TESTS = process.env.AKM_RUN_SLOW_TESTS === "1";

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
          templating: "verbatim",
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
  test("unified frontmatter accepts defaults.engine and rejects unsupported keys", () => {
    // Ported from a pre-unification YAML-program test asserting the same
    // property against retired program-format selectors ("runner"/"profile").
    // Those selectors never existed in the unified frontmatter grammar, so
    // the equivalent proof is: `defaults.engine` / per-unit `engine` are
    // accepted, and an unknown key at either level is rejected by name.
    const accepted = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: fast }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n",
      SOURCE,
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.document.defaults?.engine).toBe("fast");

    const retired = parseWorkflow(
      "---\ntype: workflow\ndefaults: { runner: llm }\nsteps:\n  - id: review\n    unit: { profile: fast }\n---\n\n## review\n\nReview\n",
      SOURCE,
    );
    expect(retired.ok).toBe(false);
    if (!retired.ok) {
      const messages = retired.errors.map((e) => e.message).join(" ");
      expect(messages).toContain('Unknown "defaults" key "runner"');
      expect(messages).toContain('key "profile"');
    }
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
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: fast }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n",
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
        document: parsed.document,
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

  test("classification distinguishes missing, unsupported, and corrupt plans before mutation", () => {
    expect(classifyWorkflowRunPlan({ plan_json: null, plan_hash: null, plan_ir_version: null }).support).toBe(
      "missing-plan",
    );
    expect(classifyWorkflowRunPlan({ plan_json: '{"irVersion":2}', plan_hash: null, plan_ir_version: 3 }).support).toBe(
      "corrupt-plan",
    );
    expect(classifyWorkflowRunPlan({ plan_json: '{"irVersion":2}', plan_hash: null, plan_ir_version: 2 }).support).toBe(
      "unsupported-version",
    );

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

  test("decoder enforces resource, retry, topology, route, removed-key, and expression bounds", () => {
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

    // SEMANTIC CHANGE (workflow-format-unification, spec §2.3): the
    // pre-unification "self-referential expression" candidate embedded
    // `${{ steps.review.output }}` in INSTRUCTIONS text with `templating:
    // "expressions"`. Instructions are byte-exact prose now and are never
    // parsed/validated as a reference regardless of `templating` — so that
    // candidate no longer fails decode. Ported onto a map step whose `over`
    // self-references its own step (still validated: `map.over` is one of
    // the two positions the closed reference grammar occupies).
    const selfExpression = frozenPlan();
    const selfExpressionUnit = selfExpression.steps[0]?.root;
    if (selfExpressionUnit?.kind === "unit") {
      selfExpression.steps[0]!.root = {
        kind: "map",
        id: "review.map",
        over: "steps.review.output",
        reducer: "collect",
        template: { ...selfExpressionUnit, id: "review.unit" },
      };
    }
    invalid.push(selfExpression);

    // `dependsOn` is REMOVED from `IrStepPlan` (ordering is `sequenceIndex`;
    // data dependencies are `inputs:` / `steps.<id>.output` references). No
    // frontend ever emitted it, so the only way it can appear is a hand-crafted
    // plan — which the strict decoder now rejects as an unknown step key.
    const removedDependsOn = secondStep(frozenPlan());
    Object.assign(stepAt(removedDependsOn, 0), { dependsOn: ["second"] });
    invalid.push(removedDependsOn);

    // `templating: "expressions"` is likewise removed: the `${{ … }}`
    // interpolation language is gone and nothing could ever emit the value, so
    // the only remaining alternative is `"verbatim"`.
    const removedTemplating = frozenPlan();
    Object.assign(stepAt(removedTemplating, 0).root as object, { templating: "expressions" });
    invalid.push(removedTemplating);

    const backwardRoute = secondStep(frozenPlan());
    const backwardRouteStep = stepAt(backwardRoute, 1);
    delete backwardRouteStep.root;
    backwardRouteStep.route = { input: "steps.review.output", when: { pass: "review" } };
    invalid.push(backwardRoute);

    const routeUnknownKey = secondStep(frozenPlan());
    const routeUnknownStep = stepAt(routeUnknownKey, 0);
    delete routeUnknownStep.root;
    routeUnknownStep.route = { input: "params.mode", when: { pass: "second" } };
    Object.assign(routeUnknownStep.route, { surprise: true });
    invalid.push(routeUnknownKey);

    for (const candidate of invalid) expect(() => decodeWorkflowPlanV3(candidate)).toThrow();
  });

  test("all non-executable plan classifications retain the current rejection contract", () => {
    const invalid = [
      [{ plan_json: "{malformed", plan_hash: null, plan_ir_version: null, id: "null-version" }, "corrupt-plan"],
      [{ plan_json: "{malformed", plan_hash: null, plan_ir_version: 2, id: "v2" }, "unsupported-version"],
      [{ plan_json: "{malformed", plan_hash: null, plan_ir_version: 4, id: "future" }, "unsupported-version"],
      [{ plan_json: null, plan_hash: null, plan_ir_version: 2, id: "missing-v2" }, "missing-plan"],
      [{ plan_json: "{malformed", plan_hash: null, plan_ir_version: 3, id: "stored-v3" }, "corrupt-plan"],
      [{ plan_json: '{"irVersion":3}', plan_hash: null, plan_ir_version: null, id: "content-v3" }, "corrupt-plan"],
      [
        { plan_json: '{"irVersion":3}', plan_hash: null, plan_ir_version: 2, id: "mismatched-v3" },
        "unsupported-version",
      ],
      [{ plan_json: null, plan_hash: null, plan_ir_version: 3, id: "missing-v3" }, "missing-plan"],
    ] as const;
    for (const [row, support] of invalid) {
      expect(classifyWorkflowRunPlan(row).support).toBe(support);
      try {
        requireExecutableWorkflowPlan(row);
        throw new Error("expected current-plan rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).code).toBe("INVALID_JSON_ARGUMENT");
      }
    }
  });

  test("freeze captures canonical platform lowering including builder identity", () => {
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: shell }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n",
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
        document: parsed.document,
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
    // Gate CONTROL fields stay in frontmatter; the rubric moves to the body
    // "### gate" sub-section (spec §2.4) — its text becomes the ONE criterion
    // string (`gate.criteria`), replacing the pre-unification `gate: {
    // criteria: [approved] }`.
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n\n### gate\n\napproved\n",
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
        document: parsed.document,
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
        workflow: { judgeEngine: "sdk" },
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
      engine: "sdk",
      model: "agent/exact",
      timeoutMs: 600_000,
    });
    expect(() => decodeWorkflowPlanV3(frozen.plan)).not.toThrow();
  });

  test("SDK engines without a model freeze their effective fallback model into the invocation", () => {
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n",
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
        document: parsed.document,
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
    const work = computeStepWorkList(frozen.plan.steps[0]!, {
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
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: sdk }\nsteps:\n  - id: review\n---\n\n## review\n\nReview\n",
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
        document: parsed.document,
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
    const parsed = parseWorkflow(
      "---\ntype: workflow\ndefaults: { engine: direct, timeout: none, llm: { temperature: 0.2, extra_params: { seed: 7 } } }\nsteps:\n  - id: review\n    unit: { llm: { max_tokens: 77, enable_thinking: true } }\n---\n\n## review\n\nReview\n",
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
        document: parsed.document,
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
    // Padding lives in the free PREAMBLE (before the first "## <id>" heading)
    // rather than inside a step's instructions — the per-step instructions
    // block has its own 256 KiB cap (WORKFLOW_MAX_INSTRUCTION_BYTES),
    // independent of the whole-source 1 MiB cap this test targets.
    const template = (pad: string) => `---\ntype: workflow\nsteps:\n  - id: work\n---\n\n${pad}\n\n## work\n\nWork\n`;
    const sourceBase = template("");
    const exactSource = template("x".repeat(WORKFLOW_MAX_SOURCE_BYTES - utf8Bytes(sourceBase)));
    expect(utf8Bytes(exactSource)).toBe(WORKFLOW_MAX_SOURCE_BYTES);
    expect(parseWorkflow(exactSource, SOURCE).ok).toBe(true);
    const oversizedSource = parseWorkflow(`${exactSource}x`, SOURCE);
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
      input: "params.mode",
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

  test.skipIf(!RUN_SLOW_TESTS)(
    "map expansion binds at 10k independently of the dispatch budget",
    () => {
      const plan = frozenPlan();
      const root = stepAt(plan, 0).root;
      if (!root || root.kind === "map") throw new Error("fixture requires unit");
      stepAt(plan, 0).root = {
        kind: "map",
        id: "review.map",
        over: "params.items",
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
      // 10k-item expansion is CPU-heavy — measured 4.7s solo (RUNTIME-02); the
      // 180s budget guards against a hang, not a performance contract, and
      // stays generous for contended/shared hardware. Gated behind
      // AKM_RUN_SLOW_TESTS (see the RUN_SLOW_TESTS doc comment above) so this
      // does not add to the default unit-target wall clock; it still runs in
      // the `slow-gated-tests` CI job.
    },
    180_000,
  );
});
