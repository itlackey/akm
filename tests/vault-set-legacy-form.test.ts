/**
 * Tests for the legacy `vault set` 3-positional / KEY=VALUE form trap.
 *
 * In 0.7.x, `akm vault set <ref> <KEY> <VALUE>` accepted the value via argv
 * and the `KEY=VALUE` combined form was also accepted. 0.8.0 removes both
 * forms for security (avoids /proc/cmdline exposure). Without an explicit
 * trap, citty silently accepts the surplus positional and the command falls
 * through to read stdin — which in cron/CI silently overwrites the existing
 * secret with an empty string.
 *
 * These tests pin the trap behaviour:
 *   1. `akm vault set <ref> <KEY> <VALUE>` exits non-zero with code 2
 *      (UsageError) and a migration hint, without touching the vault file.
 *   2. `akm vault set <ref> KEY=VALUE` exits non-zero with code 2 and a
 *      migration hint, without touching the vault file.
 *   3. The supported forms (`--from-env` and stdin) still work.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-vault-legacy-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-vault-legacy-cache-");
const xdgConfig = makeTempDir("akm-vault-legacy-config-");
const xdgData = makeTempDir("akm-vault-legacy-data-");
const xdgState = makeTempDir("akm-vault-legacy-state-");
const isolatedHome = makeTempDir("akm-vault-legacy-home-");

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: repoRoot,
    input: stdinInput,
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      AKM_STASH_DIR: undefined,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

describe("vault set: legacy form trap (0.8.0)", () => {
  test("rejects 3-positional form `vault set <ref> <KEY> <VALUE>` with exit 2 and migration hint", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    // Pre-existing secret — must NOT be clobbered by the rejected call.
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    const originalContent = "API_KEY=preexisting-secret\n";
    fs.writeFileSync(vaultPath, originalContent, "utf8");

    const result = runCli(
      ["vault", "set", "prod", "API_KEY", "newvalue"],
      { AKM_STASH_DIR: stashDir },
      // No stdin — simulates cron/CI invocation.
      "",
    );

    expect(result.status).toBe(2);
    // Migration hint must mention the supported alternatives.
    expect(result.stderr).toContain("no longer accepts the value via argv");
    expect(result.stderr).toContain("--from-env");
    // Vault file must be byte-identical to before the call.
    expect(fs.readFileSync(vaultPath, "utf8")).toBe(originalContent);
  });

  test("rejects KEY=VALUE form `vault set <ref> KEY=VALUE` with exit 2 and migration hint", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    const originalContent = "API_KEY=preexisting-secret\n";
    fs.writeFileSync(vaultPath, originalContent, "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY=newvalue"], { AKM_STASH_DIR: stashDir }, "");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no longer accepts the value via argv");
    expect(result.stderr).toContain("--from-env");
    // Vault file unchanged — the rejected call must not write through stdin.
    expect(fs.readFileSync(vaultPath, "utf8")).toBe(originalContent);
  });

  test("supported --from-env form still succeeds", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY", "--from-env", "AKM_TEST_VALUE"], {
      AKM_STASH_DIR: stashDir,
      AKM_TEST_VALUE: "supplied-via-env",
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8")).toContain("API_KEY=supplied-via-env");
  });

  test("supported stdin form still succeeds", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY"], { AKM_STASH_DIR: stashDir }, "supplied-via-stdin");

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8")).toContain("API_KEY=supplied-via-stdin");
  });
});
