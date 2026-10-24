// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the machine-friendly hook entry point for config
 * writes.
 *
 * - `akm config set --silent <key> <value>` suppresses the post-write config
 *   dump on stdout so plugin hooks don't pollute their host stream, while
 *   still surfacing errors and performing the actual write.
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
    AKM_BUNDLE_DIR: undefined,
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

describe("akm config set --silent", () => {
  const claudeHarness = '{"bin":"claude-cli"}';

  test("--silent suppresses stdout but still writes the value", async () => {
    const { result, getResult } = await withEnv(freshEnv(), async () => {
      const result = await runCliCapture(["config", "set", "--silent", "harnesses.claude", claudeHarness]);
      // The write happened — verify by re-reading via `akm config get`.
      const getResult = await runCliCapture(["config", "get", "harnesses.claude"]);
      return { result, getResult };
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(getResult.code).toBe(0);
    expect(getResult.stdout).toContain("claude-cli");
  });

  test("without --silent, the post-write config dump appears on stdout", async () => {
    const { stdout, status } = await runCli(["config", "set", "harnesses.claude", claudeHarness]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).harnesses).toEqual({ claude: { bin: "claude-cli" } });
  });

  test("--silent still reports errors (apiKey rejection #454 is visible on stderr)", async () => {
    const { stderr, status } = await runCli(["config", "set", "--silent", "llm.apiKey", "sk-test"]);
    // VALUE-17: pin the exact classified failure (UsageError -> exit 2, code
    // INVALID_FLAG_VALUE — see `rejectApiKeyPath` in
    // src/core/config/config-walker.ts and `classifyExitCode` in
    // src/cli/shared.ts), not merely "some failure". `not.toBe(0)` would also
    // pass for a crash, which defeats the point of this test.
    expect(status).toBe(2);
    const envelope = JSON.parse(stderr) as { code?: string };
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(stderr).toContain("akm setup");
  });

  test("config unset --silent also suppresses stdout", async () => {
    const { setResult, unsetResult } = await withEnv(freshEnv(), async () => {
      // Set, then unset.
      const setResult = await runCliCapture(["config", "set", "--silent", "harnesses.claude", claudeHarness]);
      const unsetResult = await runCliCapture(["config", "unset", "--silent", "harnesses.claude"]);
      return { setResult, unsetResult };
    });
    expect(setResult.code).toBe(0);
    expect(unsetResult.code).toBe(0);
    expect(unsetResult.stdout).toBe("");
  });
});
