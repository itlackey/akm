import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitRepoUrl } from "../../src/sources/providers/git";
import { type CliResult, runCliCapture } from "../_helpers/cli";
import { withEnv } from "../_helpers/sandbox";

// INTEGRATION TEST — lives in tests/integration/ because real subprocesses are
// inherent to every test here. The `akm` invocations use the in-process
// harness (tests/_helpers/cli.ts), but every test builds and asserts against
// real git fixture repos: the raw `git` helpers below (initGitRepo,
// gitHeadSubject, gitRevCount, plus the assertion `git status` calls) spawn
// real git, and `akm sync` itself shells out to git even when driven
// in-process. There is nothing left to harness away.
// Env mutation goes through the allowlisted withEnv wrapper; temp dirs are
// created via makeTempDir (kept local) and tracked for cleanup.

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

async function runCli(args: string[], stashDir: string): Promise<CliResult> {
  const xdgCache = makeTempDir("akm-save-cache-");
  const xdgConfig = makeTempDir("akm-save-cfg-");
  const xdgData = makeTempDir("akm-save-data-");
  const xdgState = makeTempDir("akm-save-state-");
  return withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
    () => runCliCapture(args),
  );
}

async function runCliWithEnv(
  args: string[],
  stashDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const xdgCache = makeTempDir("akm-save-cache-");
  const xdgConfig = makeTempDir("akm-save-cfg-");
  const xdgData = makeTempDir("akm-save-data-");
  const xdgState = makeTempDir("akm-save-state-");
  return withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      ...extraEnv,
    },
    () => runCliCapture(args),
  );
}

function parseSaveOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/** Initialise a bare git repo in `dir` so akm save can commit. */
function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [
    ["init", dir],
    ["-C", dir, "config", "commit.gpgsign", "false"],
  ]) {
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

describe("akm sync", () => {
  test("returns skipped when stash is not a git repo", async () => {
    const stashDir = makeTempDir("akm-save-nongit-");
    const result = await runCli(["sync"], stashDir);
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.skipped).toBe(true);
    expect(json.committed).toBe(false);
    expect(json.pushed).toBe(false);
  });

  test("reports nothing to commit on a clean git repo", async () => {
    const stashDir = makeTempDir("akm-save-clean-");
    initGitRepo(stashDir);
    // Create an initial commit so the repo is not bare
    const f = path.join(stashDir, "README.md");
    fs.writeFileSync(f, "hello");
    spawnSync("git", ["-C", stashDir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", stashDir, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-m", "init"], {
      encoding: "utf8",
    });

    const result = await runCli(["sync"], stashDir);
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(false);
    expect(json.skipped).toBe(false);
    expect(json.output).toContain("nothing to commit");
  });

  test("commits changes in a git repo with no remote", async () => {
    const stashDir = makeTempDir("akm-save-commit-");
    initGitRepo(stashDir);

    // Write a file so there's something to commit
    fs.mkdirSync(path.join(stashDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "skills", "skill.md"), "# Test");

    const result = await runCli(["sync", "-m", "test commit"], stashDir);
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);
    expect(json.pushed).toBe(false);
    expect(json.skipped).toBe(false);

    // Verify the commit actually landed
    const log = spawnSync("git", ["-C", stashDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("test commit");
  });

  test("uses timestamp message when -m is omitted", async () => {
    const stashDir = makeTempDir("akm-save-ts-");
    initGitRepo(stashDir);
    fs.mkdirSync(path.join(stashDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "skills", "skill.md"), "# Test");

    const result = await runCli(["sync"], stashDir);
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("akm save");
  });

  test("--no-push commits but does not push even with writable remote", async () => {
    // Bare upstream to push to, plus a working clone marked writable.
    const upstream = makeTempDir("akm-sync-upstream-");
    spawnSync("git", ["init", "--bare", upstream], { encoding: "utf8" });

    const xdgCacheHome = makeTempDir("akm-sync-cache-");
    const xdgConfigHome = makeTempDir("akm-sync-config-");
    const repoUrl = "https://github.com/acme/nopush-stash";
    const repoDir = getGitCacheRepoDir(xdgCacheHome, repoUrl);
    initGitRepo(repoDir);
    // Seed an initial commit so a branch + upstream tracking exist.
    fs.writeFileSync(path.join(repoDir, "seed.md"), "# seed\n");
    spawnSync("git", ["-C", repoDir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", repoDir, "remote", "add", "origin", upstream], { encoding: "utf8" });
    spawnSync("git", ["-C", repoDir, "push", "-u", "origin", "HEAD"], { encoding: "utf8" });

    writeJson(path.join(xdgConfigHome, "akm", "config.json"), {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { "nopush-stash": { git: repoUrl, writable: true } },
    });

    const upstreamCountBefore = spawnSync("git", ["-C", upstream, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();

    // Make a new change and sync with --no-push.
    fs.mkdirSync(path.join(repoDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "s.md"), "# s\n");

    const result = await runCliWithEnv(["sync", "nopush-stash", "-m", "no push commit", "--no-push"], upstream, {
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_CONFIG_HOME: xdgConfigHome,
    });
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);
    expect(json.pushed).toBe(false);

    // Upstream HEAD count is unchanged — nothing was pushed.
    const upstreamCountAfter = spawnSync("git", ["-C", upstream, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(upstreamCountAfter).toBe(upstreamCountBefore);
    expect(gitHeadSubject(repoDir)).toBe("no push commit");
  });

  test("named git-backed save targets the named repo instead of the primary stash", async () => {
    const primaryStashDir = makeTempDir("akm-save-primary-");
    initGitRepo(primaryStashDir);

    const namedRepoUrl = "https://github.com/acme/named-stash";
    const xdgCacheHome = makeTempDir("akm-save-cache-root-");
    const xdgConfigHome = makeTempDir("akm-save-config-root-");
    const namedRepoDir = getGitCacheRepoDir(xdgCacheHome, namedRepoUrl);
    initGitRepo(namedRepoDir);

    fs.writeFileSync(path.join(primaryStashDir, "primary.md"), "# primary\n");
    fs.mkdirSync(path.join(namedRepoDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(namedRepoDir, "skills", "named.md"), "# named\n");

    writeJson(path.join(xdgConfigHome, "akm", "config.json"), {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { "named-stash": { git: namedRepoUrl } },
    });

    const result = await runCliWithEnv(["sync", "named-stash", "-m", "named target commit"], primaryStashDir, {
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_CONFIG_HOME: xdgConfigHome,
    });

    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);
    expect(json.pushed).toBe(false);

    expect(gitHeadSubject(namedRepoDir)).toBe("named target commit");
    expect(spawnSync("git", ["-C", primaryStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "primary.md",
    );
  });

  test("named save accepts slash-containing repo names and still targets the named repo", async () => {
    const primaryStashDir = makeTempDir("akm-save-primary-slash-");
    initGitRepo(primaryStashDir);

    const namedRepoName = "itlackey/akm-stash";
    const namedRepoUrl = "https://github.com/itlackey/akm-stash";
    const xdgCacheHome = makeTempDir("akm-save-cache-root-");
    const configRoot = makeTempDir("akm-save-config-root-");
    const namedRepoDir = getGitCacheRepoDir(xdgCacheHome, namedRepoUrl);
    initGitRepo(namedRepoDir);

    fs.writeFileSync(path.join(primaryStashDir, "primary.md"), "# primary\n");
    fs.mkdirSync(path.join(namedRepoDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(namedRepoDir, "skills", "named.md"), "# named\n");

    writeJson(path.join(configRoot, "akm", "config.json"), {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { "akm-stash": { git: namedRepoUrl, registryId: namedRepoName } },
    });

    const result = await withEnv(
      {
        AKM_STASH_DIR: primaryStashDir,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: makeTempDir("akm-save-data-"),
        XDG_STATE_HOME: makeTempDir("akm-save-state-"),
      },
      () => runCliCapture(["sync", namedRepoName, "-m", "slash target commit"]),
    );

    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);

    expect(gitHeadSubject(namedRepoDir)).toBe("slash target commit");
    expect(gitRevCount(namedRepoDir)).toBe(1);
    expect(spawnSync("git", ["-C", primaryStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "primary.md",
    );
  });

  test("named save does not resolve installed filesystem entries as git-backed save targets", async () => {
    const primaryStashDir = makeTempDir("akm-save-primary-installed-");
    initGitRepo(primaryStashDir);

    const installedStashDir = makeTempDir("akm-save-installed-");
    initGitRepo(installedStashDir);
    fs.writeFileSync(path.join(installedStashDir, "installed.md"), "# installed\n");

    const configRoot = makeTempDir("akm-save-config-installed-");
    writeJson(path.join(configRoot, "akm", "config.json"), {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { "installed-stash": { path: installedStashDir } },
    });

    const result = await withEnv(
      {
        AKM_STASH_DIR: primaryStashDir,
        XDG_CONFIG_HOME: configRoot,
        XDG_CACHE_HOME: makeTempDir("akm-save-cache-installed-"),
        XDG_DATA_HOME: makeTempDir("akm-save-data-installed-"),
        XDG_STATE_HOME: makeTempDir("akm-save-state-installed-"),
      },
      () => runCliCapture(["sync", "installed-stash"]),
    );

    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr.trim()) as { error?: string };
    expect(error.error).toContain('No git stash found with name "installed-stash"');
    expect(spawnSync("git", ["-C", installedStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "installed.md",
    );
  });
});
