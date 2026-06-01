// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret `path` and `run`.
 *
 *   - `secret path` / error / traversal cases run in-process.
 *   - `secret run` spawns the target command with stdout inherited to the real
 *     fd, so the injected-env output is the CHILD's — only a real process
 *     boundary can observe it. Those cases use spawnCli.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../src/commands/secret";
import { resetGraphBoostCache } from "../src/indexer/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "..");
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

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});
afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

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

describe("secret path", () => {
  test("prints the absolute path on stdout when the secret exists", async () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    setSecret(fp, Buffer.from("v"));

    const { stdout, stderr, status } = await runCli(["secret", "path", "secret:demo"], { AKM_STASH_DIR: stashDir });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(fp);
    expect(stderr.trim()).toBe("");
  });

  test("returns {ok:false} on stderr and exits 1 when the secret does not exist", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    const { stdout, stderr, status } = await runCli(["secret", "path", "secret:nope"], { AKM_STASH_DIR: stashDir });
    expect(status).toBe(1);
    expect(JSON.parse(stderr.trim()).error).toContain("Secret not found");
    expect(stdout.trim()).toBe("");
  });

  test("rejects a traversal name that escapes the secrets dir", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    const { status, stderr } = await runCli(["secret", "path", "secret:../../etc/passwd"], {
      AKM_STASH_DIR: stashDir,
    });
    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).ok).toBe(false);
  });
});

describe("secret run", () => {
  // KEPT AS A SUBPROCESS: the value is injected into the CHILD process env.
  test("injects the secret value into the named env var of the child", () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("super-secret-token"));

    const { stdout, status } = spawnCli(
      ["secret", "run", "secret:demo", "TOKEN", "--", "bash", "-lc", 'printf "%s" "$TOKEN"'],
      { AKM_STASH_DIR: stashDir },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("super-secret-token");
  });

  test("rejects a dangerous target variable name (process hijacking)", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status, stderr } = await runCli(["secret", "run", "secret:demo", "LD_PRELOAD", "--", "true"], {
      AKM_STASH_DIR: stashDir,
    });
    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).error).toContain("LD_PRELOAD");
  });

  test("rejects an invalid env var name", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status } = await runCli(["secret", "run", "secret:demo", "not a var", "--", "true"], {
      AKM_STASH_DIR: stashDir,
    });
    expect(status).toBe(2);
  });

  test("errors when no command is supplied after --", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status } = await runCli(["secret", "run", "secret:demo", "TOKEN"], { AKM_STASH_DIR: stashDir });
    expect(status).toBe(2);
  });
});
