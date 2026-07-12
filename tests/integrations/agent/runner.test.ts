import { describe, expect, test } from "bun:test";
import { resolveProcessEnabled } from "../../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../../src/core/config/config";
import { resolveEngine } from "../../../src/integrations/agent/engine-resolution";
import {
  isProcessEnabled,
  resolveDefaultLlmRunner,
  resolveImproveProcessRunner,
} from "../../../src/integrations/agent/runner";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    ...overrides,
  };
}

function makeEngineConfig(): AkmConfig {
  return makeConfig({
    configVersion: "0.9.0",
    engines: {
      "openai-mini": {
        kind: "llm",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
        temperature: 0.3,
        supportsJsonSchema: true,
      },
      "openai-judge": {
        kind: "llm",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o",
      },
      "opencode-default": { kind: "agent", platform: "opencode", bin: "opencode", args: ["run"] },
      "opencode-sdk": {
        kind: "agent",
        platform: "opencode-sdk",
        workspace: "/tmp",
        model: "anthropic/claude-sonnet-4-5",
        llmEngine: "openai-mini",
      },
      "claude-cli": { kind: "agent", platform: "claude", bin: "claude", args: ["--print"] },
    },
    improve: {
      strategies: {
        default: {
          processes: {
            reflect: { enabled: true, engine: "openai-mini", timeoutMs: 60000 },
            distill: { enabled: true, engine: "openai-judge" },
            consolidate: { enabled: false },
            memoryInference: { enabled: true },
            graphExtraction: { enabled: false },
          },
        },
      },
    },
    defaults: { llmEngine: "openai-mini", engine: "opencode-default", improveStrategy: "default" },
  });
}

describe("resolveImproveProcessRunner", () => {
  test("returns an LLM runner for an explicit process engine", () => {
    const config = makeEngineConfig();
    const strategy = config.improve?.strategies?.default;
    const spec = resolveImproveProcessRunner(strategy, "reflect", config);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o-mini");
      expect(spec.timeoutMs).toBe(60000);
    }
  });

  test("inherits defaults.llmEngine when the process has no engine", () => {
    const config = makeEngineConfig();
    const strategy = { processes: { reflect: { enabled: true } } };
    const spec = resolveImproveProcessRunner(strategy, "reflect", config);
    expect(spec?.engine).toBe("openai-mini");
  });

  test("applies strategy overlays before process overlays", () => {
    const config = makeEngineConfig();
    const strategy = {
      engine: "openai-mini",
      model: "strategy-model",
      timeoutMs: 1000,
      llm: { temperature: 0.5 },
      processes: {
        reflect: { model: "process-model", timeoutMs: 2000, llm: { temperature: 0.7 } },
      },
    };
    const spec = resolveImproveProcessRunner(strategy, "reflect", config);
    expect(spec?.connection.model).toBe("process-model");
    expect(spec?.connection.temperature).toBe(0.7);
    expect(spec?.timeoutMs).toBe(2000);
  });

  test("rejects an explicit non-LLM process engine instead of falling back", () => {
    const config = makeEngineConfig();
    expect(() =>
      resolveImproveProcessRunner({ processes: { reflect: { engine: "opencode-default" } } }, "reflect", config),
    ).toThrow('Engine "opencode-default" is not an LLM engine.');
  });
});

describe("resolveEngine", () => {
  test("builds an agent runner for a configured named opencode engine", () => {
    const config = makeEngineConfig();
    const spec = resolveEngine("opencode-default", config);
    expect(spec.kind).toBe("agent");
    if (spec.kind === "agent") {
      expect(spec.profile.bin).toBe("opencode");
    }
  });

  test("builds an sdk runner for a configured named opencode-sdk engine", () => {
    const config = makeEngineConfig();
    const spec = resolveEngine("opencode-sdk", config);
    expect(spec.kind).toBe("sdk");
  });
});

describe("validation engine selection", () => {
  test("falls back to defaults.llmEngine when no validation process is configured", () => {
    const config = makeEngineConfig();
    const spec = resolveDefaultLlmRunner(config);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o-mini");
    }
  });

  test("returns the configured validation runner when set", () => {
    const config = makeEngineConfig();
    const enriched: AkmConfig = {
      ...config,
      improve: {
        ...config.improve,
        strategies: {
          ...config.improve?.strategies,
          default: {
            ...config.improve?.strategies?.default,
            processes: {
              ...config.improve?.strategies?.default?.processes,
              validation: { enabled: true, engine: "openai-judge" },
            },
          },
        },
      },
    };
    const spec = resolveImproveProcessRunner(enriched.improve?.strategies?.default, "validation", enriched);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o");
    }
  });
});

describe("isProcessEnabled", () => {
  test("reflects the configured enabled flag on improve strategy processes", () => {
    const strategy = makeEngineConfig().improve?.strategies?.default ?? {};
    expect(resolveProcessEnabled("reflect", strategy)).toBe(true);
    expect(resolveProcessEnabled("consolidate", strategy)).toBe(false);
    expect(resolveProcessEnabled("distill", strategy)).toBe(true);
  });

  test("reflects the configured enabled flag on improve processes", () => {
    const config = makeEngineConfig();
    expect(isProcessEnabled("index", "metadataEnhance", config)).toBe(true);
    const off: AkmConfig = { ...config, index: { metadataEnhance: { enabled: false } } };
    expect(isProcessEnabled("index", "metadataEnhance", off)).toBe(false);
  });
});
