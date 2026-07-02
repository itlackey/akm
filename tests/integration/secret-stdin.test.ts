// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret CLI — stdin path.
 *
 * These tests MUST spawn a real Bun subprocess: the default `secret set`
 * reads the value from process.stdin, and the in-process harness
 * (runCliCapture) has no way to feed stdin. Everything else about the
 * secret surface is covered in-process in tests/secret.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    input: stdinInput,
    env: { ...process.env, AKM_STASH_DIR: undefined, ...extraEnv },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("secret set (stdin)", () => {
  test("reads the value from stdin and stores it", () => {
    const stashDir = makeStash();
    const { stderr, status } = spawnCli(
      ["secret", "set", "secret:demo"],
      { AKM_STASH_DIR: stashDir },
      "tok-from-stdin",
    );
    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    const fp = path.join(stashDir, "secrets", "demo");
    expect(fs.readFileSync(fp, "utf8")).toBe("tok-from-stdin");
  });

  test("strips a single trailing newline from the stdin value", () => {
    const stashDir = makeStash();
    spawnCli(["secret", "set", "secret:demo"], { AKM_STASH_DIR: stashDir }, "tok\n");
    expect(fs.readFileSync(path.join(stashDir, "secrets", "demo"), "utf8")).toBe("tok");
  });
});
