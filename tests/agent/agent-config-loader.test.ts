/**
 * Integration test: the AkmConfig loader propagates legacy `agent` blocks
 * through the 0.8.0 auto-migration so they materialize as the new
 * `profiles.agent` + `defaults.agent` shape after load.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// All AKM storage paths (HOME/XDG/stash) are isolated under one temp root and
// every env override is restored by the helper's cleanup. The config path the
// loader resolves (getConfigPath()) lands under the isolated XDG_CONFIG_HOME.
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("AkmConfig loader — agent block migration", () => {
  test("legacy agent.default + agent.profiles migrates into profiles.agent + defaults.agent", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
    const { getConfigPath } = await import("../../src/core/paths");
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          semanticSearchMode: "auto",
          agent: {
            default: "claude",
            timeoutMs: 45000,
            profiles: {
              claude: { args: ["--print"] },
              opencode: { bin: "opencode-cli" },
            },
          },
        },
        null,
        2,
      ),
    );
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.defaults?.agent).toBe("claude");
    expect(cfg.profiles?.agent?.claude?.args).toEqual(["--print"]);
    expect(cfg.profiles?.agent?.opencode?.bin).toBe("opencode-cli");
  });

  test("agent block absent → no default agent → requireAgentProfile throws", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.defaults?.agent).toBeUndefined();
    expect(() => requireAgentProfile(cfg)).toThrow(ConfigError);
  });
});
