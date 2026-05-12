import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-vault-run-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-vpr-cache-");
const xdgConfig = makeTempDir("akm-vpr-config-");
const xdgData = makeTempDir("akm-vpr-data-");
const xdgState = makeTempDir("akm-vpr-state-");
const isolatedHome = makeTempDir("akm-vpr-home-");

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
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

describe("vault path", () => {
  test("returns {ok:false, error} JSON on stderr and exits 1 when vault does not exist", () => {
    const stashDir = makeTempDir("akm-vpr-stash-missing-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { stdout, stderr, status } = runCli(["vault", "path", "vault:does-not-exist"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("Vault not found");
    expect(stdout.trim()).toBe("");
  });

  test("prints the absolute vault path on stdout when the vault exists", () => {
    const stashDir = makeTempDir("akm-vpr-stash-path-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "myvault.env");
    fs.writeFileSync(vaultPath, "FOO=bar\n", "utf8");

    const { stdout, stderr, status } = runCli(["vault", "path", "vault:myvault"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(vaultPath);
    expect(stderr.trim()).toBe("");
  });
});

describe("vault run", () => {
  test("runs a command with all vault vars injected", () => {
    const stashDir = makeTempDir("akm-vpr-stash-all-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { stdout, stderr, status } = runCli(
      ["vault", "run", "vault:prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'],
      {
        AKM_STASH_DIR: stashDir,
      },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar baz");
    expect(stderr.trim()).toBe("");
  });

  test("runs a command with only the requested key injected", () => {
    const stashDir = makeTempDir("akm-vpr-stash-key-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { stdout, stderr, status } = runCli(
      [
        "vault",
        "run",
        "vault:prod/FOO",
        "--",
        "bash",
        "-lc",
        `printf '%s|%s' "{FOO-}" "{BAR-}"`.replace(/\u007f/g, "$"),
      ],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar|");
    expect(stderr.trim()).toBe("");
  });
});
