/**
 * Integration test: the AkmConfig loader preserves current engine definitions.
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

describe("AkmConfig loader — agent engines", () => {
  test("loads agent engines and defaults.engine", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
    const { getConfigPath } = await import("../../src/core/paths");
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          configVersion: "0.9.0",
          semanticSearchMode: "auto",
          engines: {
            claude: { kind: "agent", platform: "claude", args: ["--print"], timeoutMs: 45000 },
            opencode: { kind: "agent", platform: "opencode", bin: "opencode-cli" },
          },
          defaults: { engine: "claude" },
        },
        null,
        2,
      ),
    );
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.defaults?.engine).toBe("claude");
    expect(cfg.engines?.claude).toMatchObject({ kind: "agent", platform: "claude", args: ["--print"] });
    expect(cfg.engines?.opencode).toMatchObject({ kind: "agent", platform: "opencode", bin: "opencode-cli" });
  });

  test("missing defaults.engine is rejected without selecting an arbitrary agent engine", async () => {
    const { loadUserConfig, resetConfigCache } = await import("../../src/core/config/config");
    const { resolveDefaultEngine } = await import("../../src/integrations/agent/engine-resolution");
    const { ConfigError } = await import("../../src/core/errors");
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(cfg.defaults?.engine).toBeUndefined();
    expect(() => resolveDefaultEngine(cfg)).toThrow(ConfigError);
  });
});
