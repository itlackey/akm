/**
 * Tests for src/core/write-source.ts — the single dispatch point for writes.
 *
 * Covers the locked v1 contract from spec §2.6 / §2.7 / §5.4 / §10 step 5:
 *
 *   - writable refusal (default-resolution + explicit `writable: false`)
 *   - plain filesystem write
 *   - git commit on success
 *   - git commit + push when `pushOnCommit` is set
 *   - git delete (commits the deletion)
 *   - rejection of `writable: true` on website / npm at config load
 *   - rejection of unsupported `kind` reaching the helper
 *   - resolveWriteTarget precedence (explicit → defaultWriteTarget → stashDir)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SourceConfigEntry } from "../../src/core/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import {
  assertWritableAllowedForKind,
  deleteAssetFromSource,
  resolveWritable,
  resolveWriteTarget,
  sanitizeCommitMessage,
  type WriteTargetSource,
  writeAssetToSource,
} from "../../src/core/write-source";

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

    await expect(writeAssetToSource(source, config, { type: "totally-not-a-type", name: "a" }, "body")).rejects.toThrow(
      UsageError,
    );
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

// ── writeAssetToSource — git ────────────────────────────────────────────────

describe("writeAssetToSource — git", () => {
  test("performs a git commit after writing", async () => {
    const { workDir } = initBareGitRepo();
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = { type: "git", writable: true };

    await writeAssetToSource(source, config, { type: "memory", name: "alpha" }, "body");

    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Update memory:alpha");
    // Working tree should be clean post-commit.
    const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });

  test("pushes when pushOnCommit option is set", async () => {
    const { remoteDir, workDir } = initBareGitRepo();
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = {
      type: "git",
      writable: true,
      options: { pushOnCommit: true },
    };

    await writeAssetToSource(source, config, { type: "memory", name: "pushed" }, "body");

    // Confirm the commit landed on the bare remote.
    const remoteLog = spawnSync("git", ["--git-dir", remoteDir, "log", "--format=%s", "-1", "main"], {
      encoding: "utf8",
    });
    expect(remoteLog.stdout.trim()).toBe("Update memory:pushed");
  });

  test("does not push when pushOnCommit is absent", async () => {
    const { remoteDir, workDir } = initBareGitRepo();
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = { type: "git", writable: true };

    await writeAssetToSource(source, config, { type: "memory", name: "local-only" }, "body");

    const remoteLog = spawnSync("git", ["--git-dir", remoteDir, "log", "--format=%s", "-1", "main"], {
      encoding: "utf8",
    });
    // Remote still only has the seed commit.
    expect(remoteLog.stdout.trim()).toBe("seed");
  });
});

// ── deleteAssetFromSource ───────────────────────────────────────────────────

describe("deleteAssetFromSource", () => {
  test("removes the asset and commits the removal on git sources", async () => {
    const { workDir } = initBareGitRepo();
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = { type: "git", writable: true };

    await writeAssetToSource(source, config, { type: "memory", name: "doomed" }, "body");
    expect(fs.existsSync(path.join(workDir, "memories", "doomed.md"))).toBe(true);

    await deleteAssetFromSource(source, config, { type: "memory", name: "doomed" });
    expect(fs.existsSync(path.join(workDir, "memories", "doomed.md"))).toBe(false);

    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("Remove memory:doomed");
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

  beforeEach(() => {
    savedEnv = process.env.AKM_STASH_DIR;
    savedCfgEnv = process.env.AKM_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = savedEnv;
    if (savedCfgEnv === undefined) delete process.env.AKM_CONFIG_DIR;
    else process.env.AKM_CONFIG_DIR = savedCfgEnv;
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

describe("writeAssetToSource — commit message sanitization (issue #270)", () => {
  test("ref.origin with embedded newline does not produce multi-line commit", async () => {
    const { workDir } = initBareGitRepo();
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = { type: "git", writable: true };

    // Newline-laden origin: an attacker who controls a config entry could
    // otherwise smuggle trailers into the commit subject.
    const malignOrigin = "team\n\nCo-Authored-By: attacker <evil@example>";
    await writeAssetToSource(source, config, { type: "memory", name: "alpha", origin: malignOrigin }, "body");

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
    const source: WriteTargetSource = { kind: "git", name: "team", path: workDir };
    const config: SourceConfigEntry = { type: "git", writable: true };

    // A NUL byte in argv would make git reject the commit outright. We strip
    // it so the commit succeeds with the rest of the origin intact.
    const malignOrigin = "team\x00hidden";
    await writeAssetToSource(source, config, { type: "memory", name: "beta", origin: malignOrigin }, "body");

    const log = spawnSync("git", ["-C", workDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.includes("\x00")).toBe(false);
    expect(log.stdout.trim()).toBe("Update teamhidden//memory:beta");
  });
});
