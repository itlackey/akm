import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitRepoUrl } from "../src/sources/providers/git";
import { type CliResult, runCliCapture } from "./_helpers/cli";
import { withEnv } from "./_helpers/sandbox";

// Migrated the `akm save` invocations from spawnSync("bun", [CLI, …]) to the
// shared in-process harness (tests/_helpers/cli.ts). `akm save` resolves its
// target stash from AKM_STASH_DIR / named-source config (XDG), not
// process.cwd(), so it runs faithfully in-process — the git operations it
// performs are spawned by the command's own logic regardless. The raw `git`
// helpers below (initGitRepo, gitHeadSubject, gitRevCount, plus the assertion
// `git status` calls) keep spawning git directly: they exercise real git state,
// not the akm CLI. Env mutation goes through the allowlisted withEnv wrapper;
// temp dirs are created via makeTempDir (kept local) and tracked for cleanup.

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

describe("akm save", () => {
  test("returns skipped when stash is not a git repo", async () => {
    const stashDir = makeTempDir("akm-save-nongit-");
    const result = await runCli(["save"], stashDir);
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

    const result = await runCli(["save"], stashDir);
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

    const result = await runCli(["save", "-m", "test commit"], stashDir);
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

    const result = await runCli(["save"], stashDir);
    expect(result.code).toBe(0);
    const json = parseSaveOutput(result.stdout);
    expect(json.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--oneline"], { encoding: "utf8" });
    expect(log.stdout).toContain("akm save");
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
      semanticSearchMode: "off",
      sources: [{ type: "git", name: "named-stash", url: namedRepoUrl }],
    });

    const result = await runCliWithEnv(["save", "named-stash", "-m", "named target commit"], primaryStashDir, {
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
      semanticSearchMode: "off",
      sources: [{ type: "git", name: namedRepoName, url: namedRepoUrl }],
    });

    const result = await withEnv(
      {
        AKM_STASH_DIR: primaryStashDir,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: makeTempDir("akm-save-data-"),
        XDG_STATE_HOME: makeTempDir("akm-save-state-"),
      },
      () => runCliCapture(["save", namedRepoName, "-m", "slash target commit"]),
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

    const result = await withEnv(
      {
        AKM_STASH_DIR: primaryStashDir,
        XDG_CONFIG_HOME: configRoot,
        XDG_CACHE_HOME: makeTempDir("akm-save-cache-installed-"),
        XDG_DATA_HOME: makeTempDir("akm-save-data-installed-"),
        XDG_STATE_HOME: makeTempDir("akm-save-state-installed-"),
      },
      () => runCliCapture(["save", "installed-stash"]),
    );

    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr.trim()) as { error?: string };
    expect(error.error).toContain('No git stash found with name "installed-stash"');
    expect(spawnSync("git", ["-C", installedStashDir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain(
      "installed.md",
    );
  });
});
