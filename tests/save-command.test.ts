import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], stashDir: string) {
  const xdgCache = makeTempDir("akm-save-cache-");
  const xdgConfig = makeTempDir("akm-save-cfg-");
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
    },
  });
}

function parseSaveOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/** Initialise a bare git repo in `dir` so akm save can commit. */
function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { encoding: "utf8" });
}

describe("akm save", () => {
  test("returns skipped when stash is not a git repo", () => {
    const stashDir = makeTempDir("akm-save-nongit-");
    const result = runCli(["save"], stashDir);
    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.skipped).toBe(true);
    expect(json.committed).toBe(false);
    expect(json.pushed).toBe(false);
  });

  test("reports nothing to commit on a clean git repo", () => {
    const stashDir = makeTempDir("akm-save-clean-");
    initGitRepo(stashDir);
    // Create an initial commit so the repo is not bare
    const f = path.join(stashDir, "README.md");
    fs.writeFileSync(f, "hello");
    spawnSync("git", ["-C", stashDir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", stashDir, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-m", "init"], {
      encoding: "utf8",
    });

    const result = runCli(["save"], stashDir);
    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(false);
    expect(json.skipped).toBe(false);
    expect(json.output).toContain("nothing to commit");
  });

  test("commits changes in a git repo with no remote", () => {
    const stashDir = makeTempDir("akm-save-commit-");
    initGitRepo(stashDir);

    // Write a file so there's something to commit
    fs.writeFileSync(path.join(stashDir, "skill.md"), "# Test");

    const result = runCli(["save", "-m", "test commit"], stashDir);
    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);
    expect(json.pushed).toBe(false);
    expect(json.skipped).toBe(false);

    // Verify the commit actually landed
    const log = spawnSync("git", ["-C", stashDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("test commit");
  });

  test("uses timestamp message when -m is omitted", () => {
    const stashDir = makeTempDir("akm-save-ts-");
    initGitRepo(stashDir);
    fs.writeFileSync(path.join(stashDir, "skill.md"), "# Test");

    const result = runCli(["save"], stashDir);
    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("akm save");
  });
});
