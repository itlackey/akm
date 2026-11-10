// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

/**
 * `--help` of the commands that take `--no-probe`: probing is the default, so
 * only the opt-out is offered. (The in-process harness answers `--help` with
 * the root overview, so the real CLI is spawned.)
 */

const cli = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const helpOf = (...args: string[]) =>
  spawnSync("bun", [cli, ...args, "--help"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "";

describe("--no-probe in --help", () => {
  for (const command of [["setup"], ["models"], ["models", "set"]]) {
    test(`akm ${command.join(" ")} lists --no-probe and no --probe`, () => {
      const help = helpOf(...command);
      expect(help).toContain("--no-probe");
      expect(help).not.toContain("--probe");
    });
  }
});

{
  /**
   * A retired flag still parses, so a scheduled command written for 0.9 keeps
   * running, and `--help` does not advertise it. (The in-process harness answers
   * `--help` with the root overview, so the real CLI is spawned.)
   */

  const cli = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
  const helpOf = (...args: string[]) =>
    spawnSync("bun", [cli, ...args, "--help"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "";

  describe("--help leaves out the retired flags and lists their replacements", () => {
    test("akm improve leaves out --require-engines, which has no replacement", () => {
      const help = helpOf("improve");
      expect(help).not.toContain("--require-engines");
      expect(help).not.toContain("--require-targets");
    });

    test.each([
      [["agent"], "--engine", "--harness"],
      [["command"], "--engine", "--harness"],
      [["proposal", "new"], "--engine", "--harness"],
      [["proposal", "extract"], "--engine", "--harness"],
      [["task", "add"], "--engine", "--harness"],
    ])("akm %p", (command, retired, replacement) => {
      const help = helpOf(...command);
      expect(help).toContain(replacement);
      expect(help).not.toContain(retired);
    });
  });
}

/**
 * `help` and `hints` are pure-text surfaces — the embedded agent-guide text
 * and command usage rendered from `meta` alone — none of their run bodies
 * read config. But before this fix, `shouldBypassConfigStartup`
 * (src/cli.ts) only allowlisted `setup`/`migrate`/`config path`/`task run
 * --id`/`--help`/`--version`, so the CLI's own startup config load ran first
 * and threw `UNSUPPORTED_CONFIG_VERSION` against any pre-0.9 (or otherwise
 * invalid) config — taking down `akm help` and `akm hints`.
 */

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
    env: { ...process.env },
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
      ["bun", "cli.ts", "hints"],
      ["bun", "cli.ts", "hints", "--detail", "brief"],
    ]) {
      expect(shouldBypassConfigStartup(args), args.join(" ")).toBe(true);
    }
  });

  test("a command that needs config is NOT bypassed", async () => {
    const { shouldBypassConfigStartup } = await import("../../src/cli");
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "search", "anything"])).toBe(false);
    // `akm info` deliberately reads config the same way every other command
    // does (a10-info follow-up): bypassing it here would also skip a user's
    // configured `output.format`/`output.detail` for it specifically. It
    // still can't error on a config it can't load — assembleInfo() and
    // infoCommand's own try/catch (stash-cli.ts) degrade that instead of
    // throwing, so this is NOT a blanket "info always succeeds" claim, only
    // "info does not get special startup treatment".
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "info"])).toBe(false);
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

  // a10-info follow-up: `akm info`'s startup config read (src/cli.ts) was
  // briefly made best-effort for EVERY command, not just `info` — which
  // silently let ordinary commands run against a broken config instead of
  // refusing at startup (some then failed later with a misleading error,
  // some just ran; `health`/`index`/`config set`/`feedback` still failed,
  // but only after already taking a lock, opening a database read-write, or
  // making a network call). This pins that startup refuses BEFORE any of
  // that: the same `search` sanity check as above, plus two more commands
  // with no config dependency of their own in their body (so a regression
  // that reintroduces the blanket bypass would make these two exit 0/2
  // instead, while `search`'s own `loadConfig()` call would still mask it).
  test.each([
    "search anything",
    "proposal list",
    "health",
  ])("a command that does not special-case config still reports the config error at startup: akm %s", async (command) => {
    const { code, stderr } = await runCliCapture(command.split(" "));
    expect(code, stderr).toBe(78);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.code).toBe("INVALID_CONFIG_FILE");
  });
});
