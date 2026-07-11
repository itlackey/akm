// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for #463: stable plugin entry-point for hook-driven
 * config writes.
 *
 * - `akm config set --silent <key> <value>` suppresses the post-write config
 *   dump on stdout so plugin hooks don't pollute their host stream, while
 *   still surfacing errors and performing the actual write.
 * - `akm config set --layer user` is the only accepted layer in 0.8.0; any
 *   other value fails fast with INVALID_FLAG_VALUE so plugins can encode
 *   intent and the surface stays stable if project-layer writes return.
 *
 * Migrated from per-test spawnSync("bun", [cliPath, ...]) to the shared
 * in-process harness (tests/_helpers/cli.ts). `config set/get/unset` resolve
 * their config target from XDG_CONFIG_HOME, not process.cwd(), so these tests
 * run faithfully in-process against a sandboxed XDG triple. Env/temp-dir
 * mutation goes through the allowlisted sandbox helpers (withEnv / makeSandboxDir).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-cfg-silent-");
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

/** A fresh XDG/HOME env override so writes from one test don't bleed into another. */
function freshEnv(): Record<string, string | undefined> {
  return {
    AKM_STASH_DIR: undefined,
    HOME: makeTempDir(),
    XDG_CONFIG_HOME: makeTempDir(),
    XDG_CACHE_HOME: makeTempDir(),
    XDG_DATA_HOME: makeTempDir(),
    XDG_STATE_HOME: makeTempDir(),
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await withEnv(freshEnv(), () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm config set --silent / --layer (#463)", () => {
  const claudeEngine = '{"kind":"agent","platform":"claude"}';
  const opencodeEngine = '{"kind":"agent","platform":"opencode"}';

  test("--silent suppresses stdout but still writes the value", async () => {
    const { result, getResult } = await withEnv(freshEnv(), async () => {
      const result = await runCliCapture(["config", "set", "--silent", "engines.claude", claudeEngine]);
      // The write happened — verify by re-reading via `akm config get`.
      const getResult = await runCliCapture(["config", "get", "engines.claude"]);
      return { result, getResult };
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(getResult.code).toBe(0);
    expect(getResult.stdout).toContain("claude");
  });

  test("without --silent, the post-write config dump appears on stdout", async () => {
    const { stdout, status } = await runCli(["config", "set", "engines.claude", claudeEngine]);
    expect(status).toBe(0);
    expect(stdout).toContain("claude");
  });

  test("--layer user is accepted (no-op alias for the current user-only model)", async () => {
    const { status } = await runCli([
      "config",
      "set",
      "--layer",
      "user",
      "--silent",
      "engines.opencode",
      opencodeEngine,
    ]);
    expect(status).toBe(0);
  });

  test("--layer project (or anything other than user) fails with INVALID_FLAG_VALUE", async () => {
    const { stderr, status } = await runCli([
      "config",
      "set",
      "--layer",
      "project",
      "--silent",
      "engines.claude",
      claudeEngine,
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("INVALID_FLAG_VALUE");
    expect(stderr).toContain("Unsupported --layer");
  });

  test("--silent still reports errors (apiKey rejection #454 is visible on stderr)", async () => {
    const { stderr, status } = await runCli(["config", "set", "--silent", "llm.apiKey", "sk-test"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("AKM_LLM_API_KEY");
  });

  test("config unset --silent --layer user also suppresses stdout", async () => {
    const { setResult, unsetResult } = await withEnv(freshEnv(), async () => {
      // Set, then unset.
      const setResult = await runCliCapture(["config", "set", "--silent", "engines.claude", claudeEngine]);
      const unsetResult = await runCliCapture(["config", "unset", "--silent", "--layer", "user", "engines.claude"]);
      return { setResult, unsetResult };
    });
    expect(setResult.code).toBe(0);
    expect(unsetResult.code).toBe(0);
    expect(unsetResult.stdout).toBe("");
  });
});
