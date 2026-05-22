import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config";
import {
  isProcessEnabled,
  resolveImproveProcessRunnerFromProfile,
  resolveRunner,
  resolveValidationRunner,
} from "../../../src/integrations/agent/runner";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    ...overrides,
  };
}

function makeV2Config(): AkmConfig {
  return makeConfig({
    configVersion: "0.8.0",
    profiles: {
      llm: {
        "openai-mini": {
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          temperature: 0.3,
          supportsJsonSchema: true,
        },
        "openai-judge": {
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o",
        },
      },
      agent: {
        "opencode-default": { platform: "opencode", bin: "opencode", args: ["run"] },
        "opencode-sdk": { platform: "opencode-sdk", workspace: "/tmp", model: "anthropic/claude-sonnet-4-5" },
        "claude-cli": { platform: "claude", bin: "claude", args: ["--print"] },
      },
      improve: {
        default: {
          processes: {
            reflect: { mode: "llm", profile: "openai-mini", timeoutMs: 60000 },
            distill: { mode: "llm", profile: "openai-judge" },
            consolidate: { enabled: false },
            feedbackDistillation: { enabled: true },
            memoryInference: { enabled: true },
            graphExtraction: { enabled: false },
          },
        },
      },
    },
    defaults: { llm: "openai-mini", agent: "opencode-default", improve: "default" },
    search: { curateRerank: { enabled: false } },
  });
}

describe("resolveImproveProcessRunnerFromProfile", () => {
  test("returns LLM runner spec for an explicit llm-mode process entry", () => {
    const config = makeV2Config();
    const entry = config.profiles?.improve?.default?.processes?.reflect;
    const spec = resolveImproveProcessRunnerFromProfile(entry, config);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o-mini");
      expect(spec.timeoutMs).toBe(60000);
    }
  });

  test("returns null when the process entry has no mode and no profile", () => {
    const config = makeV2Config();
    const spec = resolveImproveProcessRunnerFromProfile({ enabled: true }, config);
    expect(spec).toBeNull();
  });
});

describe("resolveRunner", () => {
  test("builds an agent runner for a configured opencode profile", () => {
    const config = makeV2Config();
    const spec = resolveRunner("agent", "opencode-default", config);
    expect(spec.kind).toBe("agent");
    if (spec.kind === "agent") {
      expect(spec.profile.bin).toBe("opencode");
    }
  });

  test("builds an sdk runner for a configured opencode-sdk profile", () => {
    const config = makeV2Config();
    const spec = resolveRunner("sdk", "opencode-sdk", config);
    expect(spec.kind).toBe("sdk");
  });
});

describe("resolveValidationRunner", () => {
  test("falls back to defaults.llm when no validation process is configured", () => {
    const config = makeV2Config();
    const spec = resolveValidationRunner(config);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o-mini");
    }
  });

  test("returns the configured validation runner when set", () => {
    const config = makeV2Config();
    const enriched: AkmConfig = {
      ...config,
      profiles: {
        ...config.profiles,
        improve: {
          ...config.profiles?.improve,
          default: {
            ...config.profiles?.improve?.default,
            processes: {
              ...config.profiles?.improve?.default?.processes,
              validation: { enabled: true, mode: "llm", profile: "openai-judge" },
            },
          },
        },
      },
    };
    const spec = resolveValidationRunner(enriched);
    expect(spec?.kind).toBe("llm");
    if (spec?.kind === "llm") {
      expect(spec.connection.model).toBe("gpt-4o");
    }
  });
});

describe("isProcessEnabled", () => {
  test("reflects the configured enabled flag on improve processes", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("improve", "reflect", config)).toBe(true);
    expect(isProcessEnabled("improve", "consolidate", config)).toBe(false);
    expect(isProcessEnabled("improve", "feedbackDistillation", config)).toBe(true);
  });

  test("reads metadataEnhance from index.metadataEnhance.enabled", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("index", "metadataEnhance", config)).toBe(true);
    const off: AkmConfig = { ...config, index: { metadataEnhance: { enabled: false } } };
    expect(isProcessEnabled("index", "metadataEnhance", off)).toBe(false);
  });

  test("reads curateRerank from search.curateRerank.enabled", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("search", "curateRerank", config)).toBe(false);
    const on: AkmConfig = { ...config, search: { curateRerank: { enabled: true } } };
    expect(isProcessEnabled("search", "curateRerank", on)).toBe(true);
  });
});
