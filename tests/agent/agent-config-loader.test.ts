/**
 * Integration test: the AkmConfig loader propagates the `agent` block
 * through `loadConfig()` (and through the on-disk JSONC parser, exercising
 * the `pickKnownKeys` path).
 *
 * The acceptance criterion "config schema accepts an optional agent block"
 * lives at the loader boundary, not just the parser; this test pins the
 * end-to-end shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-agent-cfg-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("AkmConfig loader — agent block", () => {
  test("loads agent.default + agent.profiles from disk", async () => {
    const { getConfigPath, loadUserConfig, resetConfigCache } = await import("../../src/core/config");
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
              rover: { bin: "rover-cli", parseOutput: "json" },
            },
            // Unknown key — must not throw at load.
            mystery: 1,
          },
        },
        null,
        2,
      ),
    );
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.agent?.default).toBe("claude");
    expect(cfg.agent?.timeoutMs).toBe(45000);
    expect(cfg.agent?.profiles?.claude?.args).toEqual(["--print"]);
    expect(cfg.agent?.profiles?.rover?.bin).toBe("rover-cli");
    expect(cfg.agent?.profiles?.rover?.parseOutput).toBe("json");
  });

  test("agent block absent → cfg.agent is undefined → requireAgentProfile throws", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config");
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.agent).toBeUndefined();
    expect(() => requireAgentProfile(cfg.agent)).toThrow(ConfigError);
  });
});
