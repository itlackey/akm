// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan, resolveImproveStrategy } from "../src/commands/improve/improve-strategies";
import { ConfigError } from "../src/core/errors";

describe("resolveImproveStrategy", () => {
  test("deep-merges the default baseline, selected built-in, and user strategy", () => {
    const selected = resolveImproveStrategy("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      improve: {
        strategies: {
          quick: {
            processes: { reflect: { enabled: false, allowedTypes: ["memory"] } },
          },
        },
      },
    });

    expect(selected.name).toBe("quick");
    expect(selected.config.processes?.reflect).toMatchObject({ enabled: false, allowedTypes: ["memory"] });
    expect(selected.config.processes?.distill).toBeDefined();
  });

  test("uses defaults.improveStrategy before the built-in default", () => {
    const selected = resolveImproveStrategy(undefined, {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      defaults: { improveStrategy: "quick" },
    });
    expect(selected.name).toBe("quick");
  });

  test("rejects an unknown strategy instead of silently falling back", () => {
    expect(() =>
      resolveImproveStrategy("does-not-exist", { configVersion: "0.9.0", semanticSearchMode: "auto" }),
    ).toThrow(ConfigError);
  });
});

describe("resolveImprovePlan", () => {
  const llm = { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "base" };

  test("materializes one fallback connection for every enabled process before dispatch", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { default: llm, validation: { ...llm, model: "repair" } },
      defaults: { llmEngine: "default" },
      improve: { strategies: { quick: { processes: { validation: { engine: "validation" } } } } },
    });

    expect(plan.strategy.name).toBe("quick");
    expect(plan.processes.reflect?.engine).toBe("default");
    expect(plan.processes.validation?.engine).toBe("validation");
    expect(plan.processes.validation?.connection.model).toBe("repair");
    expect(plan.processes.distill).toBeUndefined();
  });

  test("preflights default fallbacks and accepts an agent triage judgment", () => {
    const plan = resolveImprovePlan("reflect-distill", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: {
        default: llm,
        reviewer: { kind: "agent", platform: "pi", model: "review" },
      },
      defaults: { llmEngine: "default" },
      improve: {
        strategies: {
          "reflect-distill": { processes: { triage: { judgment: { engine: "reviewer", timeoutMs: null } } } },
        },
      },
    });

    expect(plan.processes.reflect?.engine).toBe("default");
    expect(plan.processes.distill?.engine).toBe("default");
    expect(plan.triageJudgment?.kind).toBe("agent");
    expect(plan.triageJudgment?.timeoutMs).toBeNull();
  });

  test("rejects model-only and incompatible fallbacks before dispatch", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { quick: { processes: { reflect: { model: "model-without-engine" } } } } },
      }),
    ).toThrow('Improve process "reflect" configures model/llm overrides but has no fallback LLM engine.');
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { wrong: { kind: "agent", platform: "pi" } },
        defaults: { llmEngine: "wrong" },
      }),
    ).toThrow('Engine "wrong" is not an LLM engine.');
  });

  test("does not require a validation engine when repair is disabled", () => {
    const plan = resolveImprovePlan(
      "quick",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { default: llm },
        defaults: { llmEngine: "default" },
      },
      { repairValidationFailures: false },
    );
    expect(plan.processes.reflect?.engine).toBe("default");
    expect(plan.processes.validation).toBeUndefined();
  });

  test("rejects LLM-only overrides on an agent triage judgment", () => {
    expect(() =>
      resolveImprovePlan("reflect-distill", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          llm: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "base" },
          reviewer: { kind: "agent", platform: "pi" },
        },
        defaults: { llmEngine: "llm" },
        improve: {
          strategies: {
            "reflect-distill": {
              processes: { triage: { judgment: { engine: "reviewer", llm: { temperature: 0 } } } },
            },
          },
        },
      }),
    ).toThrow("cannot receive llm overrides");
  });
});
