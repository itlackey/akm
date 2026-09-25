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
    expect(error).toContain("--config");
    expect(error).toContain("--from");
  });

  test("classifies malformed --config JSON as a usage error", async () => {
    const { code, stderr } = await runCliCapture(["setup", "--config", "not-json"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Invalid JSON in --config");
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
      ["setup", "--config", "{}"],
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
