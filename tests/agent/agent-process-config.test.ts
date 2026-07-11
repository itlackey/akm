import { describe, expect, test } from "bun:test";
import type { AkmConfig, ImproveProfileConfig } from "../../src/core/config/config";
import { resolveImproveProcessRunner } from "../../src/integrations/agent/runner";

function makeConfig(strategy: ImproveProfileConfig): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    engines: {
      default: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "default-model" },
      judge: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "judge-model" },
      reviewer: { kind: "agent", platform: "opencode" },
    },
    defaults: { llmEngine: "default", improveStrategy: "test" },
    improve: { strategies: { test: strategy } },
  };
}

describe("resolveImproveProcessRunner (0.9.0 engines)", () => {
  test("uses defaults.llmEngine when the process has no engine", () => {
    const strategy: ImproveProfileConfig = { processes: { reflect: {} } };
    const runner = resolveImproveProcessRunner(strategy, "reflect", makeConfig(strategy));
    expect(runner?.engine).toBe("default");
    expect(runner?.connection.model).toBe("default-model");
  });

  test("process engine overrides defaults.llmEngine", () => {
    const strategy: ImproveProfileConfig = { processes: { reflect: { engine: "judge" } } };
    const runner = resolveImproveProcessRunner(strategy, "reflect", makeConfig(strategy));
    expect(runner?.engine).toBe("judge");
    expect(runner?.connection.model).toBe("judge-model");
  });

  test("process timeoutMs null remains unlimited", () => {
    const strategy: ImproveProfileConfig = { processes: { reflect: { timeoutMs: null } } };
    expect(resolveImproveProcessRunner(strategy, "reflect", makeConfig(strategy))?.timeoutMs).toBeNull();
  });

  test("process timeoutMs overrides the engine timeout", () => {
    const strategy: ImproveProfileConfig = { processes: { reflect: { timeoutMs: 5_000 } } };
    expect(resolveImproveProcessRunner(strategy, "reflect", makeConfig(strategy))?.timeoutMs).toBe(5_000);
  });

  test("an explicit agent engine is rejected instead of falling back to the LLM default", () => {
    const strategy: ImproveProfileConfig = { processes: { reflect: { engine: "reviewer" } } };
    expect(() => resolveImproveProcessRunner(strategy, "reflect", makeConfig(strategy))).toThrow(
      'Engine "reviewer" is not an LLM engine.',
    );
  });
});
