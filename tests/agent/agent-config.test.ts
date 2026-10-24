import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { getBuiltinAgentProfile, listBuiltinAgentProfiles } from "../../src/integrations/agent/profiles";
import { resolveTarget } from "../../src/integrations/agent/resolution";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return { configVersion: "0.9.0", semanticSearchMode: "auto", ...overrides };
}

describe("built-in agent harness profiles", () => {
  test("all built-in agent CLIs remain available to harness lowering", () => {
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

  test("a harness inherits platform defaults and applies overrides", () => {
    const runner = resolveTarget({
      config: makeConfig({
        harnesses: { reviewer: { platform: "opencode", args: ["--scripted"], timeoutMs: 6_000_000 } },
      }),
      layers: [{ harness: "reviewer" }],
    });
    expect(runner).toMatchObject({
      kind: "harness",
      name: "reviewer",
      platform: "opencode",
      bin: "opencode",
      args: ["--scripted"],
      timeoutMs: 6_000_000,
    });
  });

  test("a harness with no override of its own runs its platform's binary and arguments", () => {
    const runner = resolveTarget({ config: makeConfig({ harnesses: { opencode: {} } }), layers: [] });
    expect(runner).toMatchObject({
      kind: "harness",
      name: "opencode",
      platform: "opencode",
      bin: "opencode",
      args: ["run"],
    });
  });

  test("a custom harness bin is honored", () => {
    const runner = resolveTarget({
      config: makeConfig({ harnesses: { rover: { platform: "opencode", bin: "rover-cli" } } }),
      layers: [{ harness: "rover" }],
    });
    expect(runner.kind === "harness" && runner.bin).toBe("rover-cli");
  });
});
