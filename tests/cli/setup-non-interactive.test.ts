// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm setup` must never block on a prompt without a TTY.
 *
 * The interactive wizard branch had no `process.stdin.isTTY` guard, so a
 * piped, redirected, or CI invocation rendered the first clack prompt and then
 * blocked forever (observed: exit 124 under `timeout`, no output). `akm setup`
 * is the first command users automate, so a hang there wedges the whole
 * pipeline. The guard fails fast with the documented non-interactive escape
 * hatches instead.
 *
 * `bun test` runs with a non-TTY stdin, which is exactly the condition under
 * test — no stdin stubbing required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { main as cliMain } from "../../src/cli";
import { consumeConfigFileFlag, type FlagScanCommand } from "../../src/cli/unknown-flags";
import { getConfigPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

describe("akm setup without a TTY", () => {
  test("fails fast instead of hanging on the wizard prompt", async () => {
    expect(process.stdin.isTTY).not.toBe(true);

    const { code, stderr } = await runCliCapture(["setup"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("NON_INTERACTIVE_REQUIRES_YES");
  });

  test("names every non-interactive escape hatch in the error", async () => {
    const { stderr } = await runCliCapture(["setup"]);
    const { error } = JSON.parse(stderr.trim()) as { error: string };

    expect(error).toContain("--yes");
    expect(error).toContain("--from");
  });

  test("flags that answer a question do not make setup non-interactive on their own", async () => {
    const { code, stderr } = await runCliCapture(["setup", "--endpoint", "http://localhost:11434/v1"]);

    expect(code).toBe(2);
    expect(JSON.parse(stderr.trim()).code).toBe("NON_INTERACTIVE_REQUIRES_YES");
  });

  test("a flag that cannot be right is a usage error before anything is asked or written", async () => {
    for (const args of [
      ["--endpoint", "not a url"],
      ["--api-key-env", "sk-this-is-a-key-not-a-name"],
      ["--harness", "cursor"],
      ["--embedding-endpoint", "https://emb.example.test/v1"],
    ]) {
      const { code, stderr } = await runCliCapture(["setup", "--yes", ...args]);
      expect(code, args.join(" ")).toBe(2);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.code, args.join(" ")).toBe("INVALID_FLAG_VALUE");
      expect(stderr).not.toContain("sk-this-is-a-key-not-a-name");
    }
  });

  test("the removed --probe flag is unknown", async () => {
    const { code, stderr } = await runCliCapture(["setup", "--yes", "--probe"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--probe");
  });

  // The in-process harness skips the startup selector, so assert it directly:
  // the global --config file selector must not swallow the retired inline JSON.
  test("the retired inline-JSON --config is rejected with the --endpoint hint, not read as a file path", () => {
    for (const argv of [
      ["setup", "--yes", "--config", "{}"],
      ["setup", "--yes", "--config={}"],
      ["--config", '{"a":1}', "setup"],
    ]) {
      expect(() => consumeConfigFileFlag(cliMain as FlagScanCommand, argv)).toThrow(/Unknown flag "--config"/);
    }
    try {
      consumeConfigFileFlag(cliMain as FlagScanCommand, ["setup", "--config", "{}"]);
    } catch (error) {
      expect((error as { hint(): string }).hint()).toContain("--endpoint <url> --yes");
    }
    // A real file path still selects a config file for setup.
    expect(consumeConfigFileFlag(cliMain as FlagScanCommand, ["setup", "--config", "/tmp/x.json"]).file).toBe(
      "/tmp/x.json",
    );
  });
});

/**
 * `setup` is allowlisted in `shouldBypassConfigStartup` (src/cli.ts) so the
 * CLI's own startup config load never blocks it — but its FIRST action is
 * still `assertSetupConfigPreflight()` re-reading and re-validating that same
 * config, dying with the same `INVALID_CONFIG_FILE` error the normal startup
 * path throws for a config that fails schema validation. Setup must fail with
 * an actionable current-schema message without interpreting or changing the
 * obsolete file.
 */
describe("akm setup against a config akm 0.9 cannot load", () => {
  let cleanup: Cleanup | undefined;

  beforeEach(() => {
    const home = sandboxHome();
    const config = sandboxXdgConfigHome(home.cleanup);
    const cache = sandboxXdgCacheHome(config.cleanup);
    cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("--yes refuses a schema-invalid config with a setup-specific, actionable hint", async () => {
    const configPath = getConfigPath();
    const original = '{"configVersion":"0.9.0","bundles":{"primary":{"path":42}}}\n';
    fs.writeFileSync(configPath, original);

    const { code, stderr } = await runCliCapture(["setup", "--yes"]);

    expect(code).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_CONFIG_FILE");
    expect(parsed.error).toContain("did not load");
    expect(parsed.error).toContain("left untouched");
    expect(parsed.hint).toContain("current config schema");

    // The file itself is never modified.
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  test("an unparseable config refuses the same way", async () => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, "{ not valid json");

    const { code, stderr } = await runCliCapture(["setup", "--yes"]);

    expect(code).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.code).toBe("INVALID_CONFIG_FILE");
    expect(parsed.hint).toContain("current config schema");
  });

  test("every non-interactive entry point refuses before doing any work", async () => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, '{"configVersion":"0.9.0","bundles":{"primary":{"path":42}}}\n');

    for (const args of [
      ["setup", "--yes"],
      ["setup", "--yes", "--endpoint", "http://localhost:11434/v1"],
    ]) {
      const { code, stderr } = await runCliCapture(args);
      expect(code, args.join(" ")).toBe(78);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.hint, args.join(" ")).toContain("current config schema");
    }
  });

  test("never creates a bundle directory or writes a config backup", async () => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, '{"configVersion":"0.9.0","bundles":{"primary":{"path":42}}}\n');
    const stash = path.join(process.env.HOME as string, "akm");

    await runCliCapture(["setup", "--yes"]);

    expect(fs.existsSync(stash)).toBe(false);
    expect(fs.existsSync(path.join(process.env.XDG_CACHE_HOME as string, "akm", "config-backups"))).toBe(false);
  });
});
