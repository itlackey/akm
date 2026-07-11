import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { resolveDefaultEngine, resolveEngine } from "../../src/integrations/agent/engine-resolution";
import { BUILTIN_AGENT_PROFILE_NAMES, getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return { configVersion: "0.9.0", semanticSearchMode: "auto", ...overrides };
}

describe("built-in agent harness profiles", () => {
  test("all built-in agent CLIs remain available to engine lowering", () => {
    expect(BUILTIN_AGENT_PROFILE_NAMES).toEqual([
      "aider",
      "amazonq",
      "claude",
      "codex",
      "copilot",
      "gemini",
      "opencode",
      "openhands",
      "pi",
    ]);
    for (const name of BUILTIN_AGENT_PROFILE_NAMES) {
      const profile = getBuiltinAgentProfile(name);
      expect(profile?.bin).toBeTruthy();
      expect(profile?.envPassthrough).toContain("PATH");
    }
  });

  test("an agent engine inherits platform defaults and applies overrides", () => {
    const runner = resolveEngine(
      "reviewer",
      makeConfig({
        engines: {
          reviewer: { kind: "agent", platform: "opencode", args: ["--scripted"], timeoutMs: 6_000_000 },
        },
      }),
    );
    expect(runner.kind).toBe("agent");
    if (runner.kind !== "agent") throw new Error("expected agent runner");
    expect(runner.profile.name).toBe("reviewer");
    expect(runner.profile.bin).toBe("opencode");
    expect(runner.profile.commandBuilder).toBe("opencode");
    expect(runner.profile.envPassthrough).toContain("PATH");
    expect(runner.profile.args).toEqual(["--scripted"]);
    expect(runner.timeoutMs).toBe(6_000_000);
  });

  test("a custom engine bin is honored", () => {
    const runner = resolveEngine(
      "rover",
      makeConfig({ engines: { rover: { kind: "agent", platform: "opencode", bin: "rover-cli" } } }),
    );
    expect(runner.kind === "agent" && runner.profile.bin).toBe("rover-cli");
  });

  test("opencode-sdk resolves through its named LLM fallback", () => {
    const runner = resolveEngine(
      "sdk",
      makeConfig({
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "local", model: "gpt-4o" },
          local: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "fallback" },
        },
      }),
    );
    expect(runner.kind).toBe("sdk");
    if (runner.kind !== "sdk") throw new Error("expected SDK runner");
    expect(runner.profile.sdkMode).toBe(true);
    expect(runner.profile.model).toBe("gpt-4o");
    expect(runner.fallbackConnection?.model).toBe("fallback");
  });
});

describe("default engine resolution", () => {
  test("throws when no default engine is selected", () => {
    expect(() => resolveDefaultEngine(makeConfig())).toThrow(ConfigError);
  });

  test("resolves defaults.engine exactly", () => {
    const runner = resolveDefaultEngine(
      makeConfig({
        engines: { claude: { kind: "agent", platform: "claude" } },
        defaults: { engine: "claude" },
      }),
    );
    expect(runner.engine).toBe("claude");
  });

  test("a missing requested engine does not fall back to defaults.engine", () => {
    const config = makeConfig({
      engines: { claude: { kind: "agent", platform: "claude" } },
      defaults: { engine: "claude" },
    });
    expect(() => resolveEngine("codex", config)).toThrow('Engine "codex" is not configured.');
  });
});
