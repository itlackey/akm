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
import { resetGraphBoostCache } from "../src/indexer/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_STASH_DIR: stashDir, AKM_CONFIG_DIR: undefined }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

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

    const { status, stderr } = await runCli(["env", "create", "../../evil"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);

    // The file must NOT have been created at the traversal destination
    const escapedPath = path.join(stashDir, "evil.env");
    const parentEscapedPath = path.join(path.dirname(stashDir), "evil.env");
    expect(fs.existsSync(escapedPath)).toBe(false);
    expect(fs.existsSync(parentEscapedPath)).toBe(false);
  });

  test("rejects env:../../evil (with type prefix) in env create", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(["env", "create", "env:../../evil"], stashDir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects nested traversal foo/../../evil in env create", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(["env", "create", "foo/../../evil"], stashDir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in env path", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(["env", "path", "../../evil"], stashDir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in env export", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(
      ["env", "export", "../../evil", "--out", path.join(stashDir, "o.sh")],
      stashDir,
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in env run", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(["env", "run", "../../evil", "--", "echo", "hi"], stashDir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil via the deprecated vault: prefix too", async () => {
    const stashDir = freshStash();
    const { status, stderr } = await runCli(["env", "path", "vault:../../evil"], stashDir);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("legitimate env name succeeds", async () => {
    const stashDir = freshStash();

    const { status } = await runCli(["env", "create", "prod"], stashDir);

    expect(status).toBe(0);
    // Confirm the file was created inside the stash's env/ dir.
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(true);
  });
});
