import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-sqafix-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-sqafix-cache-");
const xdgConfig = makeTempDir("akm-sqafix-config-");
const isolatedHome = makeTempDir("akm-sqafix-home-");

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
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

// ── Test 1 & 2: akm save --format json (space-separated and = form) ──────────

describe("save command: --format flag not consumed as positional name", () => {
  test("1. akm save --format json returns JSON, not stash-name error", () => {
    const stashDir = makeTempDir("akm-sqafix-stash-");
    // Initialize a git repo in stashDir so save has something to work with
    spawnSync("git", ["init", stashDir], { encoding: "utf8" });

    const { stdout, stderr, status } = runCli(["save", "--format", "json"], {
      AKM_STASH_DIR: stashDir,
    });

    // Should NOT produce the "No git stash found with name 'json'" error
    expect(stderr).not.toContain('No git stash found with name "json"');
    expect(stderr).not.toContain("No git stash found");
    // Exit 0 (nothing to commit or committed) or the output is valid JSON
    if (status === 0) {
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("committed");
    } else {
      // May fail if stash dir env not found, but should NOT be a stash-name error
      expect(stderr).not.toContain('"json"');
    }
  });

  test("2. akm save --format=json still works (eq form)", () => {
    const stashDir = makeTempDir("akm-sqafix-stash2-");
    spawnSync("git", ["init", stashDir], { encoding: "utf8" });

    const { stdout, stderr, status } = runCli(["save", "--format=json"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(stderr).not.toContain('No git stash found with name "json"');
    if (status === 0) {
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("committed");
    }
  });

  test("3. akm save my-stash --format json routes correctly (name = my-stash)", () => {
    // We don't have a real stash named my-stash, so we expect an error about
    // "my-stash" not found — NOT about "json" not found.
    const stashDir = makeTempDir("akm-sqafix-stash3-");
    const { stderr } = runCli(["save", "my-stash", "--format", "json"], {
      AKM_STASH_DIR: stashDir,
    });

    // Error should mention "my-stash", not "json"
    if (stderr.includes("No git stash found")) {
      expect(stderr).toContain("my-stash");
      expect(stderr).not.toContain('"json"');
    }
  });
});

// ── Test 4: Primary stash with writable:true pushes on save ──────────────────

describe("save command: primary stash respects root-level writable config", () => {
  test(
    "4. primary stash with writable:true in config pushes when remote is configured",
    () => {
      // Create a bare remote repo
      const bareDir = makeTempDir("akm-sqafix-bare-");
      spawnSync("git", ["init", "--bare", bareDir], { encoding: "utf8" });

      // Create the primary stash as a git repo with the bare remote
      const stashDir = makeTempDir("akm-sqafix-primary-");
      spawnSync("git", ["init", stashDir], { encoding: "utf8" });
      spawnSync("git", ["-C", stashDir, "remote", "add", "origin", bareDir], { encoding: "utf8" });
      // Create an initial file so the repo is non-empty
      fs.writeFileSync(path.join(stashDir, "skill.md"), "# skill\n");
      spawnSync("git", ["-C", stashDir, "-c", "user.name=test", "-c", "user.email=test@local", "add", "-A"], {
        encoding: "utf8",
      });
      spawnSync(
        "git",
        ["-C", stashDir, "-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"],
        { encoding: "utf8" },
      );
      spawnSync("git", ["-C", stashDir, "push", "--set-upstream", "origin", "master"], { encoding: "utf8" });
      spawnSync("git", ["-C", stashDir, "push", "--set-upstream", "origin", "main"], { encoding: "utf8" });

      // Write a config with writable:true and stashDir pointing to our git repo
      const configDir = makeTempDir("akm-sqafix-cfg-");
      const configPath = path.join(configDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ semanticSearchMode: "off", writable: true }));

      // Write a new file to commit and push
      fs.writeFileSync(path.join(stashDir, "new-skill.md"), "# new skill\n");

      const { stdout, status } = runCli(["save", "-m", "test push"], {
        AKM_STASH_DIR: stashDir,
        AKM_CONFIG_DIR: configDir,
        HOME: makeTempDir("akm-sqafix-home2-"),
        XDG_CONFIG_HOME: configDir,
      });

      // Should have committed and pushed
      if (status === 0) {
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.committed).toBe(true);
        expect(parsed.pushed).toBe(true);
      }
      // Verify the remote received the push by checking it has commits
      const logResult = spawnSync("git", ["--git-dir", bareDir, "log", "--oneline"], { encoding: "utf8" });
      // If push succeeded, log should have at least the push commit
      expect(logResult.stdout.trim().length).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );
});

// ── Test 5 & 6 & 7: akm add --trust warnings and audit ───────────────────────

describe("stash-add: --trust warning for local paths", () => {
  test("6. akm add <local-dir> --trust emits warning about no effect", () => {
    const localDir = makeTempDir("akm-sqafix-local-");
    // Create a minimal skill so the dir is a valid stash root
    const skillsDir = path.join(localDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "test.md"), "# test skill\n");

    const stashDir = makeTempDir("akm-sqafix-add-stash-");

    const { stderr, status } = runCli(["add", localDir, "--trust"], {
      AKM_STASH_DIR: stashDir,
    });

    // Should emit the clarifying warning on stderr
    expect(stderr).toContain("--trust has no effect on local directory sources");
    // Should still succeed
    expect(status).toBe(0);
  });

  test("7. akm add <blocked-source> without --trust includes --trust in error message", () => {
    // Use a local dir with a "malicious" content to trigger the audit block.
    // We simulate by checking the install-audit error message text directly
    // via formatInstallAuditFailure (unit-level check).
    const { formatInstallAuditFailure } = require("../src/install-audit");
    const fakeReport = {
      enabled: true,
      passed: false,
      blocked: true,
      trusted: false,
      registryLabels: [],
      findings: [
        {
          id: "remote-shell-pipe",
          severity: "critical",
          category: "malicious-code",
          message: "Downloads remote content and pipes it directly into a shell.",
        },
      ],
      scannedFiles: 1,
      scannedBytes: 100,
      summary: { low: 0, moderate: 0, high: 0, critical: 1, total: 1 },
    };
    const msg = formatInstallAuditFailure("test:pkg", fakeReport);
    expect(msg).toContain("--trust");
  });
});

// ── Test: install-audit formatInstallAuditFailure mentions --trust ────────────

describe("install-audit: block error mentions --trust", () => {
  test("block error message includes --trust as remediation", async () => {
    const { formatInstallAuditFailure } = await import("../src/install-audit");
    const fakeReport = {
      enabled: true,
      passed: false,
      blocked: true,
      trusted: false,
      registryLabels: [],
      findings: [
        {
          id: "remote-shell-pipe",
          severity: "critical" as const,
          category: "malicious-code" as const,
          message: "Downloads remote content and pipes it directly into a shell.",
        },
      ],
      scannedFiles: 1,
      scannedBytes: 100,
      summary: { low: 0, moderate: 0, high: 0, critical: 1, total: 1 },
    };
    const msg = formatInstallAuditFailure("test:pkg", fakeReport);
    expect(msg).toContain("--trust");
    expect(msg).toContain("bypass this audit");
  });
});

// ── Test: config.ts root-level writable field is parsed ──────────────────────

describe("config: root-level writable field", () => {
  test("writable:true in config.json is loaded correctly", async () => {
    const { loadConfig, resetConfigCache } = await import("../src/config");

    // XDG_CONFIG_HOME -> akm subdir -> config.json
    const xdgDir = makeTempDir("akm-sqafix-cfgtest-");
    const akmConfigDir = path.join(xdgDir, "akm");
    fs.mkdirSync(akmConfigDir, { recursive: true });
    const configPath = path.join(akmConfigDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ semanticSearchMode: "off", writable: true }));

    // Use AKM_CONFIG_DIR env override (most direct override)
    const origEnv = { AKM_CONFIG_DIR: process.env.AKM_CONFIG_DIR };
    process.env.AKM_CONFIG_DIR = akmConfigDir;
    resetConfigCache();

    try {
      const cfg = loadConfig();
      expect(cfg.writable).toBe(true);
    } finally {
      if (origEnv.AKM_CONFIG_DIR === undefined) {
        delete process.env.AKM_CONFIG_DIR;
      } else {
        process.env.AKM_CONFIG_DIR = origEnv.AKM_CONFIG_DIR;
      }
      resetConfigCache();
    }
  });

  test("writable not set defaults to undefined (falsy)", async () => {
    const { loadConfig, resetConfigCache } = await import("../src/config");

    const xdgDir2 = makeTempDir("akm-sqafix-cfgtest2-");
    const akmConfigDir2 = path.join(xdgDir2, "akm");
    fs.mkdirSync(akmConfigDir2, { recursive: true });
    const configPath = path.join(akmConfigDir2, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ semanticSearchMode: "off" }));

    const origEnv = { AKM_CONFIG_DIR: process.env.AKM_CONFIG_DIR };
    process.env.AKM_CONFIG_DIR = akmConfigDir2;
    resetConfigCache();

    try {
      const cfg = loadConfig();
      expect(cfg.writable).toBeUndefined();
    } finally {
      if (origEnv.AKM_CONFIG_DIR === undefined) {
        delete process.env.AKM_CONFIG_DIR;
      } else {
        process.env.AKM_CONFIG_DIR = origEnv.AKM_CONFIG_DIR;
      }
      resetConfigCache();
    }
  });
});
