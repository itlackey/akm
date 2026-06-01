/**
 * Security tests: directory traversal via vault name.
 *
 * A user supplying `../../.bashrc` (or any traversal pattern) as the vault
 * name must be rejected before any I/O occurs.  Two complementary guards are
 * exercised here:
 *
 *   Fix A — validateName (asset-ref.ts): rejects traversal patterns such as
 *            "../../foo", "foo/../../bar", and ".." during ref parsing.
 *
 *   Fix B — isWithin guard (cli.ts): even if the name somehow survived
 *            validateName, the resolved absolute path is asserted to stay
 *            inside <stash>/vaults/ before any read/write is attempted.
 *
 * Migrated from per-test spawnSync("bun", ["src/cli.ts", ...]) to the shared
 * in-process harness (tests/_helpers/cli.ts). The traversal-rejection cases all
 * throw before any stdin read or child spawn, so they run in-process. The one
 * happy-path case ("legitimate vault name succeeds") still spawns a real
 * subprocess because `vault set` reads its value from process.stdin, which the
 * in-process console-capture harness cannot feed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/**
 * In-process CLI runner. Pins AKM_STASH_DIR to the supplied stash for the
 * duration of the call (via the allowlisted withEnv helper) and resets the
 * embedder/graph singletons so the run reads the pinned env, matching what a
 * fresh subprocess got for free. runCliCapture itself resets the config and
 * output-mode singletons.
 */
async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_STASH_DIR: stashDir, AKM_CONFIG_DIR: undefined }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

/**
 * Subprocess runner, retained for the one happy-path test. `vault set` reads
 * its value from process.stdin; the in-process harness has no stdin, so this
 * case must spawn a real Bun process to pipe the value in.
 */
function spawnCli(
  args: string[],
  stashDir: string,
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    input: stdinInput,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
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

// ── Directory traversal rejection tests ──────────────────────────────────────

describe("vault set: directory traversal rejection", () => {
  test("rejects ../../evil as vault name in vault set", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "set", "../../evil", "KEY"], stashDir);

    // Must fail — never succeed
    expect(status).not.toBe(0);
    // Error output should reference traversal or path escaping
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);

    // The file must NOT have been created at the traversal destination
    const escapedPath = path.join(stashDir, "evil.env");
    const parentEscapedPath = path.join(path.dirname(stashDir), "evil.env");
    expect(fs.existsSync(escapedPath)).toBe(false);
    expect(fs.existsSync(parentEscapedPath)).toBe(false);
  });

  test("rejects vault:../../evil (with type prefix) in vault set", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "set", "vault:../../evil", "KEY"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects nested traversal foo/../../evil in vault set", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "set", "foo/../../evil", "KEY"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault path", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "path", "../../evil"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault create", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "create", "../../evil"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault unset", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "unset", "../../evil", "KEY"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault run", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = await runCli(["vault", "run", "../../evil", "--", "echo", "hi"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  // KEPT AS A SUBPROCESS: `vault set` reads its value from process.stdin, which
  // the in-process console-capture harness cannot feed. Spawning a real Bun
  // process is the faithful way to exercise the happy-path write.
  test("legitimate vault name succeeds", () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const stashDir = stash.dir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const { status, stderr } = spawnCli(["vault", "set", "vault:prod", "MY_KEY"], stashDir, "myvalue");

    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    // Confirm the value was actually written inside the stash
    const contents = fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8");
    expect(contents).toContain("MY_KEY=");
  });
});
