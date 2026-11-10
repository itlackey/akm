import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { getBuiltinAgentProfile, listBuiltinAgentProfiles } from "../../src/integrations/agent/profiles";
import { resolveTarget } from "../../src/integrations/agent/resolution";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function makeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return { semanticSearchMode: "auto", ...overrides };
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

describe("agent-config-loader", () => {
  /**
   * Integration test: the AkmConfig loader preserves harness definitions.
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => {
    storage.cleanup();
  });

  describe("AkmConfig loader — harnesses", () => {
    test("loads harnesses, the lone one being the default", async () => {
      const { defaultHarness, loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
      const { getConfigPath } = await import("../../src/core/paths");
      const cfgPath = getConfigPath();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            semanticSearchMode: "auto",
            harnesses: { claude: { args: ["--print"], timeoutMs: 45000 } },
          },
          null,
          2,
        ),
      );
      resetConfigCache();
      const cfg = loadUserConfig();
      expect(cfg.harnesses?.claude).toMatchObject({ args: ["--print"], timeoutMs: 45000 });
      expect(defaultHarness(cfg)?.name).toBe("claude");
    });

    test("the harness named default is the default among several", async () => {
      const { defaultHarness, loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
      const { getConfigPath } = await import("../../src/core/paths");
      const cfgPath = getConfigPath();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          semanticSearchMode: "auto",
          harnesses: { default: { platform: "opencode", bin: "opencode-cli" }, claude: {} },
        }),
      );
      resetConfigCache();
      const cfg = loadUserConfig();
      expect(defaultHarness(cfg)).toMatchObject({ name: "default", harness: { platform: "opencode" } });
    });
  });
});
