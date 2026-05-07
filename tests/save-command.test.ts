import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitRepoUrl } from "../src/sources/providers/git";

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

function runCliWithEnv(args: string[], stashDir: string, extraEnv: Record<string, string | undefined> = {}) {
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
      ...extraEnv,
    },
  });
}

function parseSaveOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/** Initialise a bare git repo in `dir` so akm save can commit. */
function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [["init", dir], ["-C", dir, "config", "commit.gpgsign", "false"]]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    expect(result.status).toBe(0);
  }
}

function gitHeadSubject(dir: string): string {
  const result = spawnSync("git", ["-C", dir, "log", "--format=%s", "-1"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function gitRevCount(dir: string): number {
  const result = spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getGitCacheRepoDir(xdgCacheHome: string, repoUrl: string): string {
  const canonicalUrl = parseGitRepoUrl(repoUrl).canonicalUrl;
  const key = createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
  return path.join(xdgCacheHome, "akm", "registry-index", `git-${key}`, "repo");
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

  test("named git-backed save targets the named repo instead of the primary stash", () => {
    const primaryStashDir = makeTempDir("akm-save-primary-");
    initGitRepo(primaryStashDir);

    const namedRepoUrl = "https://github.com/acme/named-stash";
    const xdgCacheHome = makeTempDir("akm-save-cache-root-");
    const xdgConfigHome = makeTempDir("akm-save-config-root-");
    const namedRepoDir = getGitCacheRepoDir(xdgCacheHome, namedRepoUrl);
    initGitRepo(namedRepoDir);

    fs.writeFileSync(path.join(primaryStashDir, "primary.md"), "# primary\n");
    fs.writeFileSync(path.join(namedRepoDir, "named.md"), "# named\n");

    writeJson(path.join(xdgConfigHome, "akm", "config.json"), {
      semanticSearchMode: "off",
      sources: [{ type: "git", name: "named-stash", url: namedRepoUrl }],
    });

    const result = runCliWithEnv(["save", "named-stash", "-m", "named target commit"], primaryStashDir, {
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_CONFIG_HOME: xdgConfigHome,
    });

    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);
    expect(json.pushed).toBe(false);

    expect(gitHeadSubject(namedRepoDir)).toBe("named target commit");
    expect(spawnSync("git", ["-C", primaryStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "primary.md",
    );
  });

  test("named save accepts slash-containing repo names and still targets the named repo", () => {
    const primaryStashDir = makeTempDir("akm-save-primary-slash-");
    initGitRepo(primaryStashDir);

    const namedRepoName = "itlackey/akm-stash";
    const namedRepoUrl = "https://github.com/itlackey/akm-stash";
    const xdgCacheHome = makeTempDir("akm-save-cache-root-");
    const configRoot = makeTempDir("akm-save-config-root-");
    const namedRepoDir = getGitCacheRepoDir(xdgCacheHome, namedRepoUrl);
    initGitRepo(namedRepoDir);

    fs.writeFileSync(path.join(primaryStashDir, "primary.md"), "# primary\n");
    fs.writeFileSync(path.join(namedRepoDir, "named.md"), "# named\n");

    writeJson(path.join(configRoot, "akm", "config.json"), {
      semanticSearchMode: "off",
      sources: [{ type: "git", name: namedRepoName, url: namedRepoUrl }],
    });

    const result = spawnSync("bun", [CLI, "save", namedRepoName, "-m", "slash target commit"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AKM_STASH_DIR: primaryStashDir,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_CONFIG_HOME: configRoot,
      },
    });

    expect(result.status).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);

    expect(gitHeadSubject(namedRepoDir)).toBe("slash target commit");
    expect(gitRevCount(namedRepoDir)).toBe(1);
    expect(spawnSync("git", ["-C", primaryStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "primary.md",
    );
  });

  test("named save does not resolve installed filesystem entries as git-backed save targets", () => {
    const primaryStashDir = makeTempDir("akm-save-primary-installed-");
    initGitRepo(primaryStashDir);

    const installedStashDir = makeTempDir("akm-save-installed-");
    initGitRepo(installedStashDir);
    fs.writeFileSync(path.join(installedStashDir, "installed.md"), "# installed\n");

    const configRoot = makeTempDir("akm-save-config-installed-");
    writeJson(path.join(configRoot, "akm", "config.json"), {
      semanticSearchMode: "off",
      installed: [
        {
          id: "installed-stash",
          source: "filesystem",
          ref: "file:/tmp/installed-stash",
          artifactUrl: "file:/tmp/installed-stash.tgz",
          stashRoot: installedStashDir,
          cacheDir: installedStashDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = spawnSync("bun", [CLI, "save", "installed-stash"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AKM_STASH_DIR: primaryStashDir,
        XDG_CONFIG_HOME: configRoot,
        XDG_CACHE_HOME: makeTempDir("akm-save-cache-installed-"),
      },
    });

    expect(result.status).toBe(2);
    const error = JSON.parse(result.stderr.trim()) as { error?: string };
    expect(error.error).toContain('No git stash found with name "installed-stash"');
    expect(spawnSync("git", ["-C", installedStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "installed.md",
    );
  });
});
