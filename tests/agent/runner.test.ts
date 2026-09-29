import { describe, expect, test } from "bun:test";
import { resolveProcessEnabled } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import { isProcessEnabled } from "../../src/llm/feature-gate";

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
          },
        },
      },
    },
    defaults: { llmEngine: "openai-mini", engine: "opencode-default", improveStrategy: "default" },
  });
}

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

describe("isProcessEnabled", () => {
  test("reflects the configured enabled flag on improve strategy processes", () => {
    const strategy = makeEngineConfig().improve?.strategies?.default ?? {};
    expect(resolveProcessEnabled("reflect", strategy)).toBe(true);
    expect(resolveProcessEnabled("consolidate", strategy)).toBe(false);
    expect(resolveProcessEnabled("distill", strategy)).toBe(true);
  });

  test("reflects the configured enabled flag on improve processes", () => {
    const config = makeEngineConfig();
    expect(isProcessEnabled("index", "memoryInference", config)).toBe(true);
    const off: AkmConfig = { ...config, index: { memory: { enabled: false } } };
    expect(isProcessEnabled("index", "memoryInference", off)).toBe(false);
  });

  // 0.9.17-alpha.9: the LLM entity-graph extraction pass this once gated is
  // retired — graphExtraction/graph_extraction are no longer recognized names.
  test("graphExtraction is no longer a recognized isProcessEnabled process name (retired 0.9.17-alpha.9)", () => {
    const config = makeEngineConfig();
    expect(isProcessEnabled("index", "graphExtraction", config)).toBe(false);
    expect(isProcessEnabled("index", "graph_extraction", config)).toBe(false);
  });
});
