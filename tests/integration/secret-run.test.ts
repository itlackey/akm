// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `secret run` happy path — REQUIRES a real subprocess.
 *
 * `secret run` spawns the target command with stdout inherited to the real fd;
 * the secret value is injected into the CHILD process's environment. That
 * injection is unobservable from an in-process harness (the value never enters
 * this process's env or capture buffers), so this test spawns the real CLI and
 * reads what the child prints. Moved here from tests/secret-path-run.test.ts;
 * the validation-failure `secret run` cases (which fail before any spawn)
 * remain in-process in that file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import { makeStashDir, type SandboxedDir } from "../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

const disposers: SandboxedDir[] = [];
function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

function spawnCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: { ...process.env, AKM_STASH_DIR: undefined, ...extraEnv },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("secret run", () => {
  // KEPT AS A SUBPROCESS: the value is injected into the CHILD process env.
  test("injects the secret value into the named env var of the child", () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("super-secret-token"));

    const { stdout, status } = spawnCli(
      ["secret", "run", "secrets/demo", "TOKEN", "--", "bash", "-lc", 'printf "%s" "$TOKEN"'],
      { AKM_STASH_DIR: stashDir },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("super-secret-token");
  });
});
