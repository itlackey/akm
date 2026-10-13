/**
 * Security tests: directory traversal via env name.
 *
 * A user supplying `../../.bashrc` (or any traversal pattern) as the env name
 * must be rejected before any I/O occurs. Two complementary guards are
 * exercised here:
 *
 *   Fix A — validateName (asset-ref.ts): rejects traversal patterns such as
 *            "../../foo", "foo/../../bar", and ".." during ref parsing.
 *
 *   Fix B — isWithin guard in resolveEnvironmentPath (cli.ts): even if the name
 *            somehow survived validateName, the resolved absolute path is
 *            asserted to stay inside <stash>/env/ before any read/write.
 *
 * The traversal-rejection cases throw before any I/O, so they run in-process.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_BUNDLE_DIR: stashDir, AKM_CONFIG_DIR: undefined }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
});

afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
});

/**
 * VALUE-17: pin the exact classified failure (exit code + machine-readable
 * `code` from the JSON error envelope), not merely "some failure". A bare
 * `expect(status).not.toBe(0)` passes just as happily on an unrelated crash
 * as on the intended traversal rejection — see
 * tests/config-cli-silent-layer.test.ts:131-139 for the established pattern.
 * All traversal rejections here are USAGE (exit 2); the `code` distinguishes
 * "asset name has relative-path segments" (MISSING_REQUIRED_ARGUMENT, thrown
 * by validateName in src/core/asset/asset-ref.ts) from INVALID_FLAG_VALUE.
 */
function expectRejection(
  result: { status: number; stderr: string },
  code: "MISSING_REQUIRED_ARGUMENT" | "INVALID_FLAG_VALUE",
): void {
  expect(result.status).toBe(2);
  const envelope = JSON.parse(result.stderr) as { code?: string };
  expect(envelope.code).toBe(code);
}

function freshStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  fs.mkdirSync(path.join(stash.dir, "env"), { recursive: true });
  return stash.dir;
}

// ── Directory traversal rejection tests ──────────────────────────────────────

describe("env: directory traversal rejection", () => {
  test("rejects ../../evil as env name in env create", async () => {
    const stashDir = freshStash();

    const result = await runCli(["env", "create", "../../evil"], stashDir);

    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");

    // The file must NOT have been created at the traversal destination
    const escapedPath = path.join(stashDir, "evil.env");
    const parentEscapedPath = path.join(path.dirname(stashDir), "evil.env");
    expect(fs.existsSync(escapedPath)).toBe(false);
    expect(fs.existsSync(parentEscapedPath)).toBe(false);
  });

  test("rejects env/../../evil (conceptId form) in env create", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "create", "env/../../evil"], stashDir);
    // F5 new grammar: the traversal normalizes back inside the bundle (no escape)
    // and is then rejected as an unrecognized conceptId — still a hard rejection.
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("rejects nested traversal foo/../../evil in env create", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "create", "foo/../../evil"], stashDir);
    // F5 new grammar: the traversal normalizes back inside the bundle (no escape)
    // and is then rejected as an unrecognized conceptId — still a hard rejection.
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("rejects ../../evil in env path", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "path", "../../evil"], stashDir);
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("rejects ../../evil in env export", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "export", "../../evil", "--out", path.join(stashDir, "o.sh")], stashDir);
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("rejects ../../evil in env run", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "run", "../../evil", "--", "echo", "hi"], stashDir);
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("rejects traversal hidden behind a colon prefix", async () => {
    const stashDir = freshStash();
    const result = await runCli(["env", "path", "vault:../../evil"], stashDir);
    expectRejection(result, "MISSING_REQUIRED_ARGUMENT");
  });

  test("legitimate env name succeeds", async () => {
    const stashDir = freshStash();

    const { status } = await runCli(["env", "create", "prod"], stashDir);

    expect(status).toBe(0);
    // Confirm the file was created inside the stash's env/ dir.
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(true);
  });
});
