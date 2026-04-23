import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-vault-load-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-vle-cache-");
const xdgConfig = makeTempDir("akm-vle-config-");
const isolatedHome = makeTempDir("akm-vle-home-");

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("vault load: error envelope", () => {
  test("returns {ok:false, error} JSON on stderr and exits 1 when vault does not exist", () => {
    const stashDir = makeTempDir("akm-vle-stash-");
    // Create the vaults sub-directory so akm resolves paths but the specific
    // vault file is absent.
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { stdout, stderr, status } = runCli(["vault", "load", "vault:does-not-exist"], {
      AKM_STASH_DIR: stashDir,
    });

    // Must exit with code 1 (NotFoundError → EXIT_GENERAL).
    expect(status).toBe(1);

    // The JSON error envelope must appear on stderr (runWithJsonErrors writes
    // to console.error).
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("Vault not found");

    // stdout must be empty — no shell snippet should leak on error.
    expect(stdout.trim()).toBe("");
  });

  test("emits a shell snippet on stdout (not JSON) when the vault exists", () => {
    const stashDir = makeTempDir("akm-vle-stash-ok-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "myvault.env"), "FOO=bar\n", "utf8");

    const { stdout, stderr, status } = runCli(["vault", "load", "vault:myvault"], {
      AKM_STASH_DIR: stashDir,
    });

    // Success path: exit 0 and a sourcing shell snippet on stdout.
    expect(status).toBe(0);
    expect(stdout).toContain(". ");
    expect(stdout).toContain("rm -f");
    // No error envelope on stderr.
    expect(stderr.trim()).toBe("");
  });
});
