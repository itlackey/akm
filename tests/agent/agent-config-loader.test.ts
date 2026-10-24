/**
 * Integration test: the AkmConfig loader preserves harness definitions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

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
          configVersion: "0.9.0",
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
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        harnesses: { default: { platform: "opencode", bin: "opencode-cli" }, claude: {} },
      }),
    );
    resetConfigCache();
    const cfg = loadUserConfig();
    expect(defaultHarness(cfg)).toMatchObject({ name: "default", harness: { platform: "opencode" } });
  });
});
