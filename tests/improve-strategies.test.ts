// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan, resolveImproveStrategy } from "../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { withEnvSync } from "./_helpers/sandbox";

describe("resolveImproveStrategy", () => {
  test("deep-merges a user override into the selected built-in without default leakage", () => {
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
    expect(selected.config.processes?.validation).toBeUndefined();
    expect(selected.config.processes?.proactiveMaintenance).toBeUndefined();
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

  test("resolves one frozen fallback connection for every enabled process before dispatch", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { default: llm, validation: { ...llm, model: "repair" } },
      defaults: { llmEngine: "default" },
      improve: { strategies: { quick: { processes: { validation: { enabled: true, engine: "validation" } } } } },
    });

    expect(plan.strategy.name).toBe("quick");
    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.validation.runner?.engine).toBe("validation");
    expect(plan.processes.validation.runner?.connection.model).toBe("repair");
    expect(plan.processes.distill).toMatchObject({ enabled: false, runner: null });
    expect(Object.keys(plan.processes).sort()).toEqual([
      "consolidate",
      "distill",
      "extract",
      "graphExtraction",
      "memoryInference",
      "proactiveMaintenance",
      "procedural",
      "recombine",
      "reflect",
      "triage",
      "validation",
    ]);
    expect(Object.isFrozen(plan.processes)).toBe(true);
    expect(Object.isFrozen(plan.processes.reflect.config)).toBe(true);
  });

  test("preflights every enabled model-backed process and deeply freezes nested behavior", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { default: llm },
      defaults: { llmEngine: "default" },
      improve: {
        strategies: {
          all: {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
              consolidate: { enabled: true },
              memoryInference: { enabled: true },
              graphExtraction: { enabled: true },
              extract: { enabled: true, hotProbation: { enabled: true } },
              validation: { enabled: true },
              recombine: { enabled: true },
              procedural: { enabled: true },
            },
          },
        },
      },
    };
    const plan = resolveImprovePlan("all", config);
    for (const name of [
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "graphExtraction",
      "extract",
      "validation",
      "recombine",
      "procedural",
    ] as const) {
      expect(plan.processes[name].runner?.engine).toBe("default");
    }
    expect(Object.isFrozen(plan.processes.extract.config.hotProbation)).toBe(true);
    const sourceExtract = config.improve?.strategies?.all?.processes?.extract;
    if (sourceExtract?.hotProbation) sourceExtract.hotProbation.enabled = false;
    expect(plan.processes.extract.config.hotProbation?.enabled).toBe(true);
  });

  test("retains symbolic credentials in the frozen improve plan", () => {
    withEnvSync({ IMPROVE_PLAN_API_KEY: "plan-secret-sentinel" }, () => {
      const plan = resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: {
          default: {
            ...llm,
            apiKey: "$IMPROVE_PLAN_API_KEY",
          },
        },
        defaults: { llmEngine: "default" },
      });

      expect(plan.processes.reflect.runner?.credential).toEqual({
        names: ["IMPROVE_PLAN_API_KEY"],
        required: true,
      });
      expect(plan.processes.reflect.runner?.connection.apiKey).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain("plan-secret-sentinel");
    });
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

    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.distill.runner?.engine).toBe("default");
    expect(plan.triageJudgment?.kind).toBe("agent");
    expect(plan.triageJudgment?.timeoutMs).toBeNull();
  });

  test("requires an explicit judgment block before folded improve enables judgment", () => {
    const plan = resolveImprovePlan("no-judgment", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      engines: { default: llm },
      defaults: { llmEngine: "default" },
      improve: { strategies: { "no-judgment": { processes: { triage: { enabled: true } } } } },
    });

    expect(plan.triageJudgment).toBeNull();
  });

  test("uses judgment then triage then strategy then defaults.llmEngine precedence", () => {
    const engines: AkmConfig["engines"] = {
      default: { ...llm, model: "default" },
      strategy: { ...llm, model: "strategy" },
      judgment: { ...llm, model: "judgment" },
      reviewer: { kind: "agent" as const, platform: "pi", model: "agent-base" },
    };
    const base = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      engines,
      defaults: { llmEngine: "default" },
    };

    const explicit = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: {
            engine: "strategy",
            processes: {
              triage: {
                enabled: true,
                engine: "reviewer",
                judgment: { engine: "judgment" },
              },
            },
          },
        },
      },
    });
    expect(explicit.triageJudgment).toMatchObject({ kind: "llm", engine: "judgment" });

    const triage = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: {
            engine: "strategy",
            processes: {
              triage: {
                enabled: true,
                engine: "reviewer",
                model: "agent-override",
                judgment: { timeoutMs: null },
              },
            },
          },
        },
      },
    });
    expect(triage.triageJudgment).toMatchObject({
      kind: "agent",
      engine: "reviewer",
      timeoutMs: null,
      profile: { model: "agent-override" },
    });

    const strategy = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        strategies: {
          precedence: { engine: "strategy", processes: { triage: { enabled: true, judgment: {} } } },
        },
      },
    });
    expect(strategy.triageJudgment).toMatchObject({ kind: "llm", engine: "strategy" });

    const fallback = resolveImprovePlan("precedence", {
      ...base,
      improve: { strategies: { precedence: { processes: { triage: { enabled: true, judgment: {} } } } } },
    });
    expect(fallback.triageJudgment).toMatchObject({ kind: "llm", engine: "default" });
  });

  test("rejects model-only and incompatible fallbacks before dispatch", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { quick: { processes: { reflect: { model: "model-without-engine" } } } } },
      }),
    ).toThrow('Enabled improve process "reflect" requires an LLM engine.');
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { wrong: { kind: "agent", platform: "pi" } },
        defaults: { llmEngine: "wrong" },
      }),
    ).toThrow('Engine "wrong" is not an LLM engine.');
  });

  test("rejects an enabled model-backed process with no runner even when no model fields express intent", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
      }),
    ).toThrow('Enabled improve process "reflect" requires an LLM engine.');
  });

  test("does not require a validation engine when repair is disabled", () => {
    const plan = resolveImprovePlan(
      "default",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: { default: llm },
        defaults: { llmEngine: "default" },
      },
      { repairValidationFailures: false },
    );
    expect(plan.processes.reflect.runner?.engine).toBe("default");
    expect(plan.processes.validation).toMatchObject({ enabled: true, runner: null });
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
