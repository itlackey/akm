/**
 * Integration test: the AkmConfig loader propagates legacy `agent` blocks
 * through the 0.8.0 auto-migration so they materialize as the new
 * `profiles.agent` + `defaults.agent` shape after load.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME / XDG_CONFIG_HOME are snapshotted and restored by tests/_preload.ts.
// This file only owns the per-test tmp dir lifecycle.
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-agent-cfg-"));
  process.env.HOME = tmpHome;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
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
