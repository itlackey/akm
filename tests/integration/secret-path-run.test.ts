// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret `path` and `run` (in-process cases only).
 *
 *   - `secret path` / error / traversal cases run in-process.
 *   - `secret run` validation failures (LD_PRELOAD rejection, invalid var
 *     name, missing command) also run in-process — they fail before any child
 *     spawn.
 *   - The happy-path `secret run` injection test lives in
 *     tests/integration/secret-run.test.ts: it needs a real process boundary
 *     to observe the CHILD's env.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { runCliCapture } from "../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

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
  // The happy-path injection test (secret value visible in the CHILD's env)
  // lives in tests/integration/secret-run.test.ts — it requires a real
  // subprocess. The cases below fail validation before any child spawn.
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
