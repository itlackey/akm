import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config";
import {
  getProcessOptions,
  isProcessEnabled,
  resolveProcessRunner,
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
    configVersion: 2,
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
    },
    defaults: { llm: "openai-mini", agent: "opencode-default" },
    features: {
      improve: {
        reflect: { mode: "llm", profile: "openai-mini", timeoutMs: 60000 },
        distill: { mode: "llm", profile: "openai-judge" },
        propose: { mode: "sdk", profile: "opencode-sdk" },
        memory_consolidation: false,
        feedback_distillation: true,
      },
      index: {
        memory_inference: true,
        graph_extraction: { profile: "openai-mini" },
        metadata_enhance: false,
      },
      search: {
        curate_rerank: false,
      },
    },
  });
}

describe("resolveProcessRunner", () => {
  test("resolves llm mode from explicit entry", () => {
    const config = makeV2Config();
    const runner = resolveProcessRunner("improve", "reflect", config);
    expect(runner.kind).toBe("llm");
    if (runner.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o-mini");
      expect(runner.timeoutMs).toBe(60000);
    }
  });

  test("resolves llm mode with different profile", () => {
    const config = makeV2Config();
    const runner = resolveProcessRunner("improve", "distill", config);
    expect(runner.kind).toBe("llm");
    if (runner.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o");
    }
  });

  test("resolves sdk mode", () => {
    const config = makeV2Config();
    const runner = resolveProcessRunner("improve", "propose", config);
    expect(runner.kind).toBe("sdk");
    if (runner.kind === "sdk") {
      expect(runner.profile.name).toBe("opencode-sdk");
    }
  });

  test("resolves from shorthand true using default llm profile", () => {
    const config = makeV2Config();
    const runner = resolveProcessRunner("improve", "feedback_distillation", config);
    expect(runner.kind).toBe("llm");
    if (runner.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o-mini");
    }
  });

  test("throws when process is disabled (false)", () => {
    const config = makeV2Config();
    expect(() => resolveProcessRunner("improve", "memory_consolidation", config)).toThrow();
  });

  test("resolves index.graph_extraction with profile inference", () => {
    const config = makeV2Config();
    const runner = resolveProcessRunner("index", "graph_extraction", config);
    expect(runner.kind).toBe("llm");
  });

  test("throws on mode/pool mismatch: sdk mode pointing to llm profile", () => {
    const config = makeConfig({
      profiles: {
        llm: { "openai-mini": { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" } },
        agent: { "opencode-sdk": { platform: "opencode-sdk", workspace: "/tmp", model: "claude-3" } },
      },
      defaults: { llm: "openai-mini", agent: "opencode-sdk" },
      features: {
        improve: { reflect: { mode: "sdk", profile: "opencode-default" } },
        agent: { "opencode-default": { platform: "opencode", bin: "opencode" } },
      } as AkmConfig["features"],
    });
    expect(() => resolveProcessRunner("improve", "reflect", config)).toThrow();
  });

  test("falls back to legacy config.llm when profiles.llm absent but config.llm present", () => {
    // When profiles.llm is absent, resolveRunner("llm", ...) falls back to config.llm
    const config = makeConfig({
      llm: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5" },
    });
    const runner = resolveRunner("llm", "any-profile", config);
    expect(runner.kind).toBe("llm");
    if (runner.kind === "llm") {
      expect(runner.connection.model).toBe("qwen2.5");
    }
  });
});

describe("resolveRunner (lower-level)", () => {
  test("resolves llm mode by name", () => {
    const config = makeV2Config();
    const runner = resolveRunner("llm", "openai-judge", config);
    expect(runner.kind).toBe("llm");
    if (runner.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o");
    }
  });

  test("resolves agent mode by name", () => {
    const config = makeV2Config();
    const runner = resolveRunner("agent", "opencode-default", config);
    expect(runner.kind).toBe("agent");
    if (runner.kind === "agent") {
      expect(runner.profile.name).toBe("opencode-default");
    }
  });

  test("resolves sdk mode by name", () => {
    const config = makeV2Config();
    const runner = resolveRunner("sdk", "opencode-sdk", config);
    expect(runner.kind).toBe("sdk");
  });

  test("throws when llm profile not found", () => {
    const config = makeV2Config();
    expect(() => resolveRunner("llm", "nonexistent", config)).toThrow();
  });

  test("throws when agent profile not found", () => {
    const config = makeV2Config();
    expect(() => resolveRunner("agent", "nonexistent", config)).toThrow();
  });
});

describe("isProcessEnabled", () => {
  test("returns true for boolean true entry", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("improve", "feedback_distillation", config)).toBe(true);
  });

  test("returns false for boolean false entry", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("improve", "memory_consolidation", config)).toBe(false);
  });

  test("returns true for object entry without enabled field", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("improve", "reflect", config)).toBe(true);
  });

  test("returns false for missing entry", () => {
    const config = makeV2Config();
    expect(isProcessEnabled("improve", "nonexistent_process", config)).toBe(false);
  });

  test("returns false when features not configured", () => {
    const config = makeConfig();
    expect(isProcessEnabled("improve", "reflect", config)).toBe(false);
  });
});

describe("resolveValidationRunner (Phase 4B / Advantage D3)", () => {
  test("returns explicit features.improve.validation runner when set", () => {
    const config = makeV2Config();
    // Inject a validation entry pointing at the judge profile.
    const improve = config.features?.improve;
    if (!improve) throw new Error("expected features.improve to be defined");
    improve.validation = {
      mode: "llm",
      profile: "openai-judge",
      timeoutMs: 30000,
    };
    const runner = resolveValidationRunner(config);
    expect(runner).not.toBeNull();
    expect(runner?.kind).toBe("llm");
    if (runner?.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o");
      expect(runner.timeoutMs).toBe(30000);
    }
  });

  test("falls back to defaults.llm when validation entry is absent", () => {
    const config = makeV2Config();
    // Make sure no validation entry exists in features.improve.
    expect(config.features?.improve?.validation).toBeUndefined();
    const runner = resolveValidationRunner(config);
    expect(runner).not.toBeNull();
    expect(runner?.kind).toBe("llm");
    if (runner?.kind === "llm") {
      // defaults.llm = "openai-mini"
      expect(runner.connection.model).toBe("gpt-4o-mini");
    }
  });

  test("returns null when neither validation nor defaults.llm is configured", () => {
    const config = makeConfig();
    expect(resolveValidationRunner(config)).toBeNull();
  });

  test("falls back to defaults.llm when validation entry is explicitly disabled", () => {
    const config = makeV2Config();
    const improve = config.features?.improve;
    if (!improve) throw new Error("expected features.improve to be defined");
    improve.validation = false;
    const runner = resolveValidationRunner(config);
    expect(runner).not.toBeNull();
    if (runner?.kind === "llm") {
      expect(runner.connection.model).toBe("gpt-4o-mini");
    }
  });

  test("falls back to legacy config.llm when validation and defaults.llm are unset", () => {
    // Legacy v1 config: no features.improve.validation, no defaults.llm, but
    // top-level `config.llm` is set. resolveValidationRunner should surface
    // the legacy connection directly rather than returning null.
    const config = makeConfig({
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "qwen2.5-legacy",
      },
    });
    expect(config.features?.improve?.validation).toBeUndefined();
    expect(config.defaults?.llm).toBeUndefined();

    const runner = resolveValidationRunner(config);
    expect(runner).not.toBeNull();
    expect(runner?.kind).toBe("llm");
    if (runner?.kind === "llm") {
      expect(runner.connection.model).toBe("qwen2.5-legacy");
      expect(runner.connection.endpoint).toBe("http://localhost:11434/v1/chat/completions");
    }
  });
});

describe("getProcessOptions", () => {
  test("returns options from object entry", () => {
    const config = makeConfig({
      features: {
        improve: {
          reflect: {
            mode: "llm",
            options: { cooldown: { memory: 2, lesson: 7 } },
          },
        },
      },
    });
    const opts = getProcessOptions<{ cooldown?: Record<string, number> }>("improve", "reflect", config);
    expect(opts?.cooldown?.memory).toBe(2);
    expect(opts?.cooldown?.lesson).toBe(7);
  });

  test("returns undefined for boolean entry", () => {
    const config = makeV2Config();
    expect(getProcessOptions("improve", "feedback_distillation", config)).toBeUndefined();
  });

  test("returns undefined for missing entry", () => {
    const config = makeV2Config();
    expect(getProcessOptions("improve", "nonexistent", config)).toBeUndefined();
  });
});
