/**
 * Tests for src/core/write-source.ts — the single dispatch point for writes.
 *
 * Covers the locked v1 contract from spec §2.6 / §2.7 / §5.4 / §10 step 5:
 *
 *   - writable refusal (default-resolution + explicit `writable: false`)
 *   - plain filesystem write
 *   - git write/delete leaves the file on disk with NO per-write commit (0.9.0)
 *   - the single batch-at-boundary commit (issue #507) produces exactly one
 *     complete commit + clean tree, pushes per the writable+remote+push gate,
 *     and is a no-op for filesystem targets
 *   - deprecated `pushOnCommit` maps onto the batch push gate
 *   - rejection of `writable: true` on website / npm at config load
 *   - rejection of unsupported `kind` reaching the helper
 *   - resolveWriteTarget precedence (explicit → defaultWriteTarget → stashDir)
 *   - commit-message sanitization (issue #270) via the boundary commit
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SourceConfigEntry } from "../../src/core/config/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import {
  assertWritableAllowedForKind,
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  formatRefForMessage,
  type ResolvedWriteTarget,
  resolveWritable,
  resolveWriteTarget,
  sanitizeCommitMessage,
  type WriteTargetSource,
  writeAssetToSource,
} from "../../src/core/write-source";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";

// ── Fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initBareGitRepo(): { remoteDir: string; workDir: string } {
  const remoteDir = makeTempDir("akm-write-remote-");
  const workDir = makeTempDir("akm-write-work-");
  // Bare remote so `git push` has somewhere to send commits.
  let r = spawnSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init --bare failed: ${r.stderr}`);
  r = spawnSync("git", ["init", "--initial-branch=main", workDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  // Identity for the working tree — write-source supplies its own at commit
  // time, but a remote add + initial push needs *some* config.
  spawnSync("git", ["-C", workDir, "config", "user.email", "test@akm.local"], { encoding: "utf8" });
  spawnSync("git", ["-C", workDir, "config", "user.name", "akm test"], { encoding: "utf8" });
  spawnSync("git", ["-C", workDir, "remote", "add", "origin", remoteDir], { encoding: "utf8" });
  // Seed an initial commit so `git push` can fast-forward.
  fs.writeFileSync(path.join(workDir, "README.md"), "seed\n");
  spawnSync("git", ["-C", workDir, "add", "README.md"], { encoding: "utf8" });
  spawnSync("git", ["-C", workDir, "commit", "-m", "seed"], { encoding: "utf8" });
  spawnSync("git", ["-C", workDir, "push", "-u", "origin", "main"], { encoding: "utf8" });
  return { remoteDir, workDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveWritable ─────────────────────────────────────────────────────────

describe("resolveWritable", () => {
  test("defaults to true for filesystem", () => {
    expect(resolveWritable({ type: "filesystem" })).toBe(true);
  });

  test("defaults to false for git", () => {
    expect(resolveWritable({ type: "git" })).toBe(false);
  });

  test("defaults to false for website / npm", () => {
    expect(resolveWritable({ type: "website" })).toBe(false);
    expect(resolveWritable({ type: "npm" })).toBe(false);
  });

  test("explicit value wins for filesystem", () => {
    expect(resolveWritable({ type: "filesystem", writable: false })).toBe(false);
  });

  test("explicit value wins for git", () => {
    expect(resolveWritable({ type: "git", writable: true })).toBe(true);
  });
});

// ── assertWritableAllowedForKind ────────────────────────────────────────────

describe("assertWritableAllowedForKind", () => {
  test("rejects writable: true on website", () => {
    expect(() => assertWritableAllowedForKind({ type: "website", writable: true, name: "docs" })).toThrow(ConfigError);
  });

  test("rejects writable: true on npm", () => {
    expect(() => assertWritableAllowedForKind({ type: "npm", writable: true, name: "pkg" })).toThrow(ConfigError);
  });

  test("allows writable: true on git", () => {
    expect(() => assertWritableAllowedForKind({ type: "git", writable: true })).not.toThrow();
  });

  test("allows writable: true on filesystem", () => {
    expect(() => assertWritableAllowedForKind({ type: "filesystem", writable: true })).not.toThrow();
  });

  test("ignores absent / false writable on website + npm (no-op)", () => {
    expect(() => assertWritableAllowedForKind({ type: "website" })).not.toThrow();
    expect(() => assertWritableAllowedForKind({ type: "npm", writable: false })).not.toThrow();
  });
});

// ── writeAssetToSource — filesystem ─────────────────────────────────────────

describe("writeAssetToSource — filesystem", () => {
  test("writes the asset to the expected on-disk location", async () => {
    const dir = makeTempDir("akm-write-fs-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", path: dir, name: "mine", writable: true };

    const result = await writeAssetToSource(source, config, { type: "memory", name: "alpha" }, "hello world");

    expect(result.path).toBe(path.join(dir, "memories", "alpha.md"));
    expect(result.ref).toBe("memory:alpha");
    expect(fs.readFileSync(result.path, "utf8")).toBe("hello world\n");
  });

  test("creates intermediate directories", async () => {
    const dir = makeTempDir("akm-write-fs-nested-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", path: dir, writable: true };

    const result = await writeAssetToSource(source, config, { type: "knowledge", name: "topic/sub" }, "body");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path.endsWith(path.join("knowledge", "topic", "sub.md"))).toBe(true);
  });

  test("appends a trailing newline when missing", async () => {
    const dir = makeTempDir("akm-write-fs-nl-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    const result = await writeAssetToSource(source, config, { type: "memory", name: "a" }, "no-newline");
    expect(fs.readFileSync(result.path, "utf8")).toBe("no-newline\n");
  });

  test("preserves an existing trailing newline (no double newline)", async () => {
    const dir = makeTempDir("akm-write-fs-nl2-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    const result = await writeAssetToSource(source, config, { type: "memory", name: "a" }, "with-newline\n");
    expect(fs.readFileSync(result.path, "utf8")).toBe("with-newline\n");
  });

  test("refuses to write when source is not writable", async () => {
    const dir = makeTempDir("akm-write-readonly-");
    const source: WriteTargetSource = { kind: "filesystem", name: "ro", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: false };

    await expect(writeAssetToSource(source, config, { type: "memory", name: "a" }, "body")).rejects.toThrow(UsageError);
  });

  test("refuses to write when default-writable would be false (e.g. git default)", async () => {
    const dir = makeTempDir("akm-write-default-ro-");
    const source: WriteTargetSource = { kind: "git", name: "upstream", path: dir };
    const config: SourceConfigEntry = { type: "git", url: "https://example.test/x" };

    await expect(writeAssetToSource(source, config, { type: "memory", name: "a" }, "body")).rejects.toThrow(UsageError);
  });

  test("rejects unknown asset types", async () => {
    const dir = makeTempDir("akm-write-unknown-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    // Cast to bypass compile-time type guard — we're testing runtime rejection.
    await expect(
      writeAssetToSource(source, config, { type: "totally-not-a-type" as never, name: "a" }, "body"),
    ).rejects.toThrow(UsageError);
  });

  test("rejects path traversal in asset name", async () => {
    const dir = makeTempDir("akm-write-traversal-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    await expect(
      writeAssetToSource(source, config, { type: "memory", name: "../../escape" }, "body"),
    ).rejects.toThrow();
  });
});

// ── writeAssetToSource — git (0.9.0 batch-at-boundary, issue #507) ───────────

function gitTarget(workDir: string, opts?: { writable?: boolean; pushOnCommit?: boolean }): ResolvedWriteTarget {
  const config: SourceConfigEntry = {
    type: "git",
    name: "team",
    writable: opts?.writable ?? true,
    ...(opts?.pushOnCommit !== undefined ? { options: { pushOnCommit: opts.pushOnCommit } } : {}),
  };
  return { source: { kind: "git", name: "team", path: workDir }, config };
}

describe("writeAssetToSource — git (no per-write commit)", () => {
  test("git write leaves the file on disk with NO per-write commit", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "alpha" }, "body");

    // The file is written...
    expect(fs.existsSync(path.join(workDir, "memories", "alpha.md"))).toBe(true);
    // ...but no commit ran: HEAD is still the seed, and the working tree is dirty.
    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("seed");
    const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout.trim()).not.toBe("");
  });

  test("the boundary commit produces exactly one complete commit and a clean tree", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "alpha" }, "body");
    commitWriteTargetBoundary(target, "Update memory:alpha");

    // Exactly one new commit on top of the seed.
    const count = spawnSync("git", ["-C", workDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
    expect(count.stdout.trim()).toBe("2");
    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Update memory:alpha");
    // No dirty residue: the boundary commit staged the asset (add -A).
    const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });

  test("multiple writes collapse into ONE boundary commit (batch-at-boundary)", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "one" }, "a");
    await writeAssetToSource(target.source, target.config, { type: "memory", name: "two" }, "b");
    await deleteAssetFromSource(target.source, target.config, { type: "memory", name: "one" });
    commitWriteTargetBoundary(target, "Batch update");

    // Only one commit was produced for the whole batch.
    const count = spawnSync("git", ["-C", workDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
    expect(count.stdout.trim()).toBe("2");
    // The surviving asset is tracked; the deleted one is gone; tree is clean.
    expect(fs.existsSync(path.join(workDir, "memories", "two.md"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "memories", "one.md"))).toBe(false);
    const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });

  test("boundary commit pushes when target is writable with a remote", async () => {
    const { remoteDir, workDir } = initBareGitRepo();
    const target = gitTarget(workDir, { writable: true });

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "pushed" }, "body");
    commitWriteTargetBoundary(target, "Update memory:pushed");

    const remoteLog = spawnSync("git", ["--git-dir", remoteDir, "log", "--format=%s", "-1", "main"], {
      encoding: "utf8",
    });
    expect(remoteLog.stdout.trim()).toBe("Update memory:pushed");
  });

  test("boundary commit does not push when push is disabled", async () => {
    const { remoteDir, workDir } = initBareGitRepo();
    const target = gitTarget(workDir, { writable: true });

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "local-only" }, "body");
    commitWriteTargetBoundary(target, "Update memory:local-only", { push: false });

    // Commit landed locally...
    const localLog = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(localLog.stdout.trim()).toBe("Update memory:local-only");
    // ...but the remote still only has the seed commit.
    const remoteLog = spawnSync("git", ["--git-dir", remoteDir, "log", "--format=%s", "-1", "main"], {
      encoding: "utf8",
    });
    expect(remoteLog.stdout.trim()).toBe("seed");
  });

  test("deprecated pushOnCommit maps onto the batch push gate (still pushes)", async () => {
    const { remoteDir, workDir } = initBareGitRepo();
    const target = gitTarget(workDir, { writable: true, pushOnCommit: true });

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "legacy" }, "body");
    commitWriteTargetBoundary(target, "Update memory:legacy");

    const remoteLog = spawnSync("git", ["--git-dir", remoteDir, "log", "--format=%s", "-1", "main"], {
      encoding: "utf8",
    });
    expect(remoteLog.stdout.trim()).toBe("Update memory:legacy");
  });

  test("commitWriteTargetBoundary is a no-op for filesystem targets", async () => {
    const { workDir } = initBareGitRepo();
    const fsTarget: ResolvedWriteTarget = {
      source: { kind: "filesystem", name: "fs", path: workDir },
      config: { type: "filesystem", name: "fs", writable: true },
    };

    await writeAssetToSource(fsTarget.source, fsTarget.config, { type: "memory", name: "x" }, "body");
    commitWriteTargetBoundary(fsTarget, "should be ignored");

    // No commit ran (HEAD still seed) even though workDir is a git repo —
    // filesystem targets never commit at this boundary.
    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("seed");
  });
});

// ── deleteAssetFromSource ───────────────────────────────────────────────────

describe("deleteAssetFromSource", () => {
  test("git delete removes the file with no per-write commit; boundary commits the removal", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    // Seed an asset and commit it as a boundary so we start from a clean tree.
    await writeAssetToSource(target.source, target.config, { type: "memory", name: "doomed" }, "body");
    commitWriteTargetBoundary(target, "Add memory:doomed");
    expect(fs.existsSync(path.join(workDir, "memories", "doomed.md"))).toBe(true);

    // Delete leaves the file gone but does NOT commit on its own.
    await deleteAssetFromSource(target.source, target.config, { type: "memory", name: "doomed" });
    expect(fs.existsSync(path.join(workDir, "memories", "doomed.md"))).toBe(false);
    let log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Add memory:doomed");

    // Boundary commits the removal as one commit; tree clean afterwards.
    commitWriteTargetBoundary(target, "Remove memory:doomed");
    log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Remove memory:doomed");
    const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });

  test("filesystem delete is a plain unlink (no commit)", async () => {
    const dir = makeTempDir("akm-delete-fs-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    await writeAssetToSource(source, config, { type: "memory", name: "ephem" }, "body");
    await deleteAssetFromSource(source, config, { type: "memory", name: "ephem" });
    expect(fs.existsSync(path.join(dir, "memories", "ephem.md"))).toBe(false);
  });

  test("throws when the asset does not exist", async () => {
    const dir = makeTempDir("akm-delete-missing-");
    const source: WriteTargetSource = { kind: "filesystem", name: "mine", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: true };

    await expect(deleteAssetFromSource(source, config, { type: "memory", name: "ghost" })).rejects.toThrow(UsageError);
  });

  test("refuses to delete from a non-writable source", async () => {
    const dir = makeTempDir("akm-delete-ro-");
    const source: WriteTargetSource = { kind: "filesystem", name: "ro", path: dir };
    const config: SourceConfigEntry = { type: "filesystem", writable: false };

    await expect(deleteAssetFromSource(source, config, { type: "memory", name: "x" })).rejects.toThrow(UsageError);
  });
});

// ── Unknown kind reaching the helper ────────────────────────────────────────

describe("writeAssetToSource — unsupported kinds", () => {
  test("rejects unknown source kinds with ConfigError", async () => {
    // The config loader would normally catch this, but the helper still
    // defends itself in case an external caller bypasses the loader.
    const dir = makeTempDir("akm-write-unsup-");
    const source: WriteTargetSource = { kind: "website", name: "docs", path: dir };
    const config: SourceConfigEntry = { type: "website", writable: true };

    await expect(writeAssetToSource(source, config, { type: "memory", name: "a" }, "body")).rejects.toThrow(
      ConfigError,
    );
  });
});

// ── resolveWriteTarget ──────────────────────────────────────────────────────

describe("resolveWriteTarget", () => {
  let savedEnv: string | undefined;
  let savedCfgEnv: string | undefined;
  let savedDataHome: string | undefined;
  let savedStateHome: string | undefined;
  const xdgTempDirs: string[] = [];

  beforeEach(() => {
    savedEnv = process.env.AKM_STASH_DIR;
    savedCfgEnv = process.env.AKM_CONFIG_DIR;
    savedDataHome = process.env.XDG_DATA_HOME;
    savedStateHome = process.env.XDG_STATE_HOME;
    // Pair AKM_STASH_DIR (set by individual tests below) with XDG_DATA_HOME /
    // XDG_STATE_HOME so the test-isolation guard in src/core/paths.ts stays inert.
    const dataTmp = makeTempDir("akm-write-source-data-");
    const stateTmp = makeTempDir("akm-write-source-state-");
    xdgTempDirs.push(dataTmp, stateTmp);
    process.env.XDG_DATA_HOME = dataTmp;
    process.env.XDG_STATE_HOME = stateTmp;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = savedEnv;
    if (savedCfgEnv === undefined) delete process.env.AKM_CONFIG_DIR;
    else process.env.AKM_CONFIG_DIR = savedCfgEnv;
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    xdgTempDirs.length = 0;
  });

  test("explicit --target wins", () => {
    const dir = makeTempDir("akm-target-explicit-");
    const result = resolveWriteTarget(
      {
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", path: dir, name: "explicit", writable: true }],
      },
      "explicit",
    );
    expect(result.source.name).toBe("explicit");
    expect(result.source.path).toBe(dir);
  });

  test("git target uses content root for assets and retains repository root for sync", async () => {
    const url = "https://example.invalid/acme/content-layout.git";
    const repoRoot = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const contentRoot = path.join(repoRoot, "content");
    fs.mkdirSync(contentRoot, { recursive: true });

    const result = resolveWriteTarget(
      {
        semanticSearchMode: "off",
        sources: [{ type: "git", url, name: "team", writable: true }],
      },
      "team",
    );

    expect(result.source.path).toBe(contentRoot);
    expect(result.source.repoPath).toBe(repoRoot);
    const written = await writeAssetToSource(
      result.source,
      result.config,
      { type: "knowledge", name: "layout" },
      "Body",
    );
    expect(written.path).toBe(path.join(contentRoot, "knowledge", "layout.md"));
    fs.rmSync(getCachePaths(parseGitRepoUrl(url).canonicalUrl).rootDir, { recursive: true, force: true });
  });

  test("git target falls back to repository root when content layout is absent", async () => {
    const url = "https://example.invalid/acme/root-layout.git";
    const paths = getCachePaths(parseGitRepoUrl(url).canonicalUrl);
    fs.mkdirSync(paths.repoDir, { recursive: true });

    const result = resolveWriteTarget(
      {
        semanticSearchMode: "off",
        sources: [{ type: "git", url, name: "team", writable: true }],
      },
      "team",
    );

    expect(result.source.path).toBe(paths.repoDir);
    expect(result.source.repoPath).toBe(paths.repoDir);
    const written = await writeAssetToSource(
      result.source,
      result.config,
      { type: "knowledge", name: "layout" },
      "Body",
    );
    expect(written.path).toBe(path.join(paths.repoDir, "knowledge", "layout.md"));
    fs.rmSync(paths.rootDir, { recursive: true, force: true });
  });

  test("falls back to defaultWriteTarget", () => {
    const dir = makeTempDir("akm-target-default-");
    const result = resolveWriteTarget({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: dir, name: "default-one", writable: true }],
      defaultWriteTarget: "default-one",
    });
    expect(result.source.name).toBe("default-one");
  });

  test("falls back to working stashDir when no explicit target / defaultWriteTarget", () => {
    const stashDir = makeTempDir("akm-target-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    const result = resolveWriteTarget({ semanticSearchMode: "off" });
    expect(result.source.kind).toBe("filesystem");
    expect(result.source.path).toBe(stashDir);
  });

  test("throws ConfigError when defaultWriteTarget points at a missing source", () => {
    expect(() =>
      resolveWriteTarget({
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", path: "/tmp/akm-missing", name: "exists", writable: true }],
        defaultWriteTarget: "ghost",
      }),
    ).toThrow(ConfigError);
  });

  test("throws UsageError when --target names a missing source", () => {
    expect(() =>
      resolveWriteTarget(
        {
          semanticSearchMode: "off",
          sources: [{ type: "filesystem", path: "/tmp/akm-other", name: "other", writable: true }],
        },
        "nope",
      ),
    ).toThrow(UsageError);
  });
});

// ── sanitizeCommitMessage (issue #270) ──────────────────────────────────────

describe("sanitizeCommitMessage", () => {
  test("strips newline injection attempts and collapses to a single line", () => {
    // Classic newline-injection payload: forge a Co-Authored-By trailer.
    const payload = "Update skill:foo\n\nCo-Authored-By: attacker <evil@example>";
    const out = sanitizeCommitMessage(payload);
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
    // Content survives, just on one line with whitespace runs collapsed.
    expect(out).toBe("Update skill:foo Co-Authored-By: attacker <evil@example>");
  });

  test("strips carriage returns", () => {
    expect(sanitizeCommitMessage("a\rb\r\nc")).toBe("a b c");
  });

  test("strips NUL bytes", () => {
    const out = sanitizeCommitMessage("subject\x00hidden");
    expect(out.includes("\x00")).toBe(false);
    expect(out).toBe("subjecthidden");
  });

  test("strips other C0 control characters", () => {
    // 0x07 BEL, 0x1B ESC, 0x7F DEL — all become spaces (then collapsed).
    expect(sanitizeCommitMessage("a\x07b\x1Bc\x7Fd")).toBe("a b c d");
  });

  test("clamps to 4096 characters", () => {
    const long = "x".repeat(5000);
    const out = sanitizeCommitMessage(long);
    expect(out.length).toBe(4096);
  });

  test("returns empty string for empty/whitespace-only input", () => {
    expect(sanitizeCommitMessage("")).toBe("");
    expect(sanitizeCommitMessage("   \n\r\t  ")).toBe("");
  });

  test("returns empty string for non-string input", () => {
    expect(sanitizeCommitMessage(undefined as unknown as string)).toBe("");
    expect(sanitizeCommitMessage(null as unknown as string)).toBe("");
  });
});

// ── git commit message sanitization end-to-end (issue #270) ─────────────────

describe("commit message sanitization (issue #270, via boundary commit)", () => {
  test("ref.origin with embedded newline does not produce multi-line commit", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    // Newline-laden origin: an attacker who controls a config entry could
    // otherwise smuggle trailers into the commit subject.
    const malignOrigin = "team\n\nCo-Authored-By: attacker <evil@example>";
    const ref = { type: "memory" as const, name: "alpha", origin: malignOrigin };
    await writeAssetToSource(target.source, target.config, ref, "body");
    commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);

    const fullLog = spawnSync("git", ["-C", workDir, "log", "--format=%B%x00", "-1"], { encoding: "utf8" });
    // Trim the NUL terminator we used as a record separator. The remaining
    // body must contain no embedded newlines (other than the trailing one git
    // always appends to the message).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the explicit record separator.
    const messageBody = fullLog.stdout.replace(/\x00\s*$/, "").replace(/\n$/, "");
    expect(messageBody.includes("\n")).toBe(false);
    expect(messageBody.includes("Co-Authored-By: attacker")).toBe(true);
    // The injected trailer is part of the *subject*, not a real trailer.
    expect(messageBody.startsWith("Update team")).toBe(true);
  });

  test("ref.origin with NUL byte is sanitized (commit succeeds)", async () => {
    const { workDir } = initBareGitRepo();
    const target = gitTarget(workDir);

    // A NUL byte in argv would make git reject the commit outright. We strip
    // it so the commit succeeds with the rest of the origin intact.
    const malignOrigin = "team\x00hidden";
    const ref = { type: "memory" as const, name: "beta", origin: malignOrigin };
    await writeAssetToSource(target.source, target.config, ref, "body");
    commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);

    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.includes("\x00")).toBe(false);
    expect(log.stdout.trim()).toBe("Update teamhidden//memory:beta");
  });
});
