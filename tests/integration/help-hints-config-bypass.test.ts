// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `help` and `hints` are pure-text surfaces — bundled release notes, the
 * embedded agent-guide text, and command usage rendered from `meta` alone —
 * none of their run bodies read config. But before this fix, `shouldBypassConfigStartup`
 * (src/cli.ts) only allowlisted `setup`/`migrate`/`config path`/`task run
 * --id`/`--help`/`--version`, so the CLI's own startup config load ran first
 * and threw `UNSUPPORTED_CONFIG_VERSION` against any pre-0.9 (or otherwise
 * invalid) config — taking down `akm help`, `akm hints`, and even the
 * documented recovery command the 0.9.0 release notes tell users to run
 * first: "Run `akm help migrate 0.9.0` for the storage and command-surface
 * checklist." That instruction was unreachable in exactly the state anyone
 * would need it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

const repoRoot = path.resolve(import.meta.dir, "..", "..");

/**
 * Real subprocess, used ONLY for the bare-invocation case: the in-process
 * harness (`runCliCapture`) drives `runCommand` directly and does not
 * replicate `src/cli.ts`'s `rawArgs.length === 0` special case (printing the
 * sectioned root help before citty's own dispatch ever runs) — every other
 * case in this file goes through `runCliCapture`, matching the harness's own
 * documented fidelity.
 */
function spawnCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: repoRoot,
    env: { ...process.env, AKM_BUNDLE_DIR: undefined },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("shouldBypassConfigStartup allowlists help and hints", () => {
  // Exercised indirectly below via the real CLI process (runCliCapture); this
  // block pins the direct contract too, matching the style of the existing
  // setup/migrate/config-path bypass tests.
  test("help, hints, bare invocation, and their subcommands bypass the startup config load", async () => {
    const { shouldBypassConfigStartup } = await import("../../src/cli");
    for (const args of [
      ["bun", "cli.ts"],
      ["bun", "cli.ts", "help"],
      ["bun", "cli.ts", "help", "migrate", "0.9.0"],
      ["bun", "cli.ts", "help", "search"],
      ["bun", "cli.ts", "help", "agents"],
      ["bun", "cli.ts", "hints"],
      ["bun", "cli.ts", "hints", "--detail", "brief"],
    ]) {
      expect(shouldBypassConfigStartup(args), args.join(" ")).toBe(true);
    }
  });

  test("a command that needs config is NOT bypassed", async () => {
    const { shouldBypassConfigStartup } = await import("../../src/cli");
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "search", "anything"])).toBe(false);
  });
});

describe("akm help / akm hints against a config akm 0.9 cannot load", () => {
  let cleanup: Cleanup | undefined;

  beforeEach(() => {
    const home = sandboxHome();
    const config = sandboxXdgConfigHome(home.cleanup);
    const cache = sandboxXdgCacheHome(config.cleanup);
    cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
    fs.writeFileSync(getConfigPath(), "{ not valid json\n");
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("akm help renders the sectioned overview instead of a config error", async () => {
    const { code, stdout, stderr } = await runCliCapture(["help"]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("AGENT LOOP");
    expect(stdout).toContain("SYSTEM");
    expect(stderr).toBe("");
  });

  test("akm help migrate 0.9.0 — the documented recovery command — actually runs", async () => {
    const { code, stdout, stderr } = await runCliCapture(["help", "migrate", "0.9.0"]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("Migration notes for akm v0.9.0");
    expect(stdout).toContain("akm migrate status");
  });

  test("akm help <command> renders that command's usage", async () => {
    const { code, stdout, stderr } = await runCliCapture(["help", "search"]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("akm search");
    expect(stdout).toContain("USAGE");
  });

  test("akm hints prints the embedded agent guide", async () => {
    const { code, stdout, stderr } = await runCliCapture(["hints"]);
    expect(code, stderr).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("bare akm (no subcommand) also renders help instead of a config error", () => {
    const { status, stdout, stderr } = spawnCli([]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("AGENT LOOP");
  });

  test("a command that DOES need config still reports the config error", async () => {
    // Sanity check the fix is scoped to help/hints, not a blanket bypass.
    const { code, stderr } = await runCliCapture(["search", "anything"]);
    expect(code).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.code).toBe("INVALID_CONFIG_FILE");
  });
});
