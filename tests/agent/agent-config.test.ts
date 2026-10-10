import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import { getBuiltinAgentProfile, listBuiltinAgentProfiles } from "../../src/integrations/agent/profiles";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return { configVersion: "0.9.0", semanticSearchMode: "auto", ...overrides };
}

describe("built-in agent harness profiles", () => {
  test("all built-in agent CLIs remain available to engine lowering", () => {
    const expected = HARNESS_REGISTRY.filter((h) => h.profile)
      .map((h) => h.id as string)
      .sort();
    expect(Object.keys(listBuiltinAgentProfiles()).sort()).toEqual(expected);
    expect(expected).toContain("opencode");
    expect(expected).not.toContain("opencode-sdk");
    for (const name of expected) {
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
    expect(runner.profile.platform).toBe("opencode");
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
    expect(runner.kind).toBe("sdk");
    expect(runner.profile.model).toBe("gpt-4o");
    expect(runner.fallbackConnection?.model).toBe("fallback");
  });
});

describe("engine resolution", () => {
  test("a missing requested engine does not fall back to defaults.engine", () => {
    const config = makeConfig({
      engines: { claude: { kind: "agent", platform: "claude" } },
      defaults: { engine: "claude" },
    });
    expect(() => resolveEngine("codex", config)).toThrow('Engine "codex" is not configured.');
  });
});
