import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGitMirror, getCachePaths, type ParsedRepoUrl } from "../../../src/sources/providers/git";

const createdTmpDirs: string[] = [];

function makeTempDir(prefix = "akm-git-ahead-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("syncMirroredRepo: ahead with nothing to fast-forward is a no-op", () => {
  test("does not refuse, and keeps the local commit, when ahead > 0 and behind === 0", async () => {
    const root = makeTempDir();
    const remote = path.join(root, "remote.git");
    git(["init", "--bare", remote]);
    git(["init", "-b", "main", path.join(root, "seed")]);
    const seed = path.join(root, "seed");
    git(["config", "user.name", "AKM Test"], seed);
    git(["config", "user.email", "akm@example.test"], seed);
    fs.writeFileSync(path.join(seed, "seed.md"), "seed\n", "utf8");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["remote", "add", "origin", remote], seed);
    git(["push", "-u", "origin", "main"], seed);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

    const cacheRoot = makeTempDir("akm-git-ahead-cache-");
    const repo: ParsedRepoUrl = { cloneUrl: remote, ref: null, canonicalUrl: remote };
    const cachePaths = getCachePaths(repo.canonicalUrl, cacheRoot);

    await ensureGitMirror(repo, cachePaths, { writable: true, force: true });

    const { repoDir } = cachePaths;
    git(["config", "user.name", "AKM Test"], repoDir);
    git(["config", "user.email", "akm@example.test"], repoDir);

    fs.writeFileSync(path.join(repoDir, "local-only.md"), "local commit\n", "utf8");
    git(["add", "."], repoDir);
    git(["commit", "-m", "local only, never pushed"], repoDir);

    await expect(ensureGitMirror(repo, cachePaths, { writable: true, force: true })).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(repoDir, "local-only.md"))).toBe(true);
    expect(git(["log", "-1", "--format=%s"], repoDir)).toBe("local only, never pushed");
  });

  test("still refuses when ahead AND behind (a real merge is needed)", async () => {
    const root = makeTempDir();
    const remote = path.join(root, "remote.git");
    git(["init", "--bare", remote]);
    git(["init", "-b", "main", path.join(root, "seed")]);
    const seed = path.join(root, "seed");
    git(["config", "user.name", "AKM Test"], seed);
    git(["config", "user.email", "akm@example.test"], seed);
    fs.writeFileSync(path.join(seed, "seed.md"), "seed\n", "utf8");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["remote", "add", "origin", remote], seed);
    git(["push", "-u", "origin", "main"], seed);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

    const cacheRoot = makeTempDir("akm-git-ahead-behind-cache-");
    const repo: ParsedRepoUrl = { cloneUrl: remote, ref: null, canonicalUrl: remote };
    const cachePaths = getCachePaths(repo.canonicalUrl, cacheRoot);
    await ensureGitMirror(repo, cachePaths, { writable: true, force: true });

    const { repoDir } = cachePaths;
    git(["config", "user.name", "AKM Test"], repoDir);
    git(["config", "user.email", "akm@example.test"], repoDir);

    fs.writeFileSync(path.join(repoDir, "local-only.md"), "local commit\n", "utf8");
    git(["add", "."], repoDir);
    git(["commit", "-m", "local only"], repoDir);

    fs.writeFileSync(path.join(seed, "upstream-only.md"), "upstream\n", "utf8");
    git(["add", "."], seed);
    git(["commit", "-m", "upstream commit"], seed);
    git(["push", "origin", "main"], seed);

    await expect(ensureGitMirror(repo, cachePaths, { writable: true, force: true })).rejects.toThrow(/commits not on/);
  });

  test("a read-only refresh refuses to clone over a checkout holding a local commit, and keeps it", async () => {
    const root = makeTempDir();
    const remote = path.join(root, "remote.git");
    git(["init", "--bare", remote]);
    git(["init", "-b", "main", path.join(root, "seed")]);
    const seed = path.join(root, "seed");
    git(["config", "user.name", "AKM Test"], seed);
    git(["config", "user.email", "akm@example.test"], seed);
    fs.writeFileSync(path.join(seed, "seed.md"), "seed\n", "utf8");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["remote", "add", "origin", remote], seed);
    git(["push", "-u", "origin", "main"], seed);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

    const cacheRoot = makeTempDir("akm-git-readonly-cache-");
    const repo: ParsedRepoUrl = { cloneUrl: remote, ref: null, canonicalUrl: remote };
    const cachePaths = getCachePaths(repo.canonicalUrl, cacheRoot);
    await ensureGitMirror(repo, cachePaths, { writable: true, force: true });

    const { repoDir } = cachePaths;
    git(["config", "user.name", "AKM Test"], repoDir);
    git(["config", "user.email", "akm@example.test"], repoDir);
    fs.writeFileSync(path.join(repoDir, "local-only.md"), "local commit\n", "utf8");
    git(["add", "."], repoDir);
    git(["commit", "-m", "local only, never pushed"], repoDir);

    await expect(ensureGitMirror(repo, cachePaths, { writable: false, force: true })).rejects.toMatchObject({
      code: "SOURCE_HAS_LOCAL_WORK",
    });

    expect(fs.existsSync(path.join(repoDir, "local-only.md"))).toBe(true);
    expect(git(["log", "-1", "--format=%s"], repoDir)).toBe("local only, never pushed");
  });
});
