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
 * The CLI tests below exercise both guards end-to-end via `bun src/cli.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-vtrav-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-vtrav-cache-");
const xdgConfig = makeTempDir("akm-vtrav-config-");
const isolatedHome = makeTempDir("akm-vtrav-home-");

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
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
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      AKM_STASH_DIR: stashDir,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ── Directory traversal rejection tests ──────────────────────────────────────

describe("vault set: directory traversal rejection", () => {
  test("rejects ../../evil as vault name in vault set", () => {
    const stashDir = makeTempDir("akm-vtrav-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = runCli(["vault", "set", "../../evil", "KEY"], stashDir, "value");

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

  test("rejects vault:../../evil (with type prefix) in vault set", () => {
    const stashDir = makeTempDir("akm-vtrav-stash2-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = runCli(["vault", "set", "vault:../../evil", "KEY"], stashDir, "value");

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects nested traversal foo/../../evil in vault set", () => {
    const stashDir = makeTempDir("akm-vtrav-stash3-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = runCli(["vault", "set", "foo/../../evil", "KEY"], stashDir, "value");

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault path", () => {
    const stashDir = makeTempDir("akm-vtrav-stash4-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = runCli(["vault", "path", "../../evil"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("rejects ../../evil in vault create", () => {
    const stashDir = makeTempDir("akm-vtrav-stash5-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { status, stderr } = runCli(["vault", "create", "../../evil"], stashDir);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/traversal|escapes|relative path|invalid/i);
  });

  test("legitimate vault name succeeds", () => {
    const stashDir = makeTempDir("akm-vtrav-stash6-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const { status, stderr } = runCli(["vault", "set", "vault:prod", "MY_KEY"], stashDir, "myvalue");

    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    // Confirm the value was actually written inside the stash
    const contents = fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8");
    expect(contents).toContain("MY_KEY=");
  });
});
