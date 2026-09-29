// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Item 4 (alpha.9 plan §5.4/§8 step 8): the `memory-cleanup-archive` health
 * advisory reports a non-git bundle's archive size/count, since the purge
 * sweep never touches one. Round 3: a GIT-backed bundle is no longer silent
 * either — `.git` presence never proved a retirement was actually committed
 * (B1), so this now also reports how much of a git-backed archive the purge
 * sweep can never remove.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectArchiveUsageAdvisory } from "../../../src/commands/health/archive-usage";

function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-archive-usage-"));
}

function markGitBacked(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });
}

/** A REAL git repo — `collectArchiveUsageAdvisory` now runs real `git status`/`ls-files` for a git-backed bundle, not just a `.git`-presence check. */
function git(stashDir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", stashDir, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

function initGitRepo(stashDir: string): void {
  expect(spawnSync("git", ["init", "--initial-branch=main", stashDir], { encoding: "utf8" }).status).toBe(0);
  git(stashDir, "config", "user.email", "test@example.com");
  git(stashDir, "config", "user.name", "test");
}

function commitAll(stashDir: string, message: string): void {
  git(stashDir, "add", "-A");
  git(stashDir, "commit", "-m", message);
}

function seedArchiveFile(stashDir: string, relPath: string, contents: string): void {
  const filePath = path.join(stashDir, ".akm", "memory-cleanup", "archive", relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

describe("collectArchiveUsageAdvisory", () => {
  test("silent when the bundle is git-backed AND every archived byte is committed and clean (round 3)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "---\nkind: memory-cleanup-archive\n---\n");
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "old body");
    commitAll(stashDir, "archive, committed and clean");
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("warns with byte/file counts when a git-backed bundle's archive has uncommitted bytes (round 3)", () => {
    // The owner's own scenario (B1): a filesystem-kind bundle whose accepted
    // retirements are never committed, even though `.git` exists.
    const stashDir = sandbox();
    initGitRepo(stashDir);
    // Committed FIRST, and only THIS one path — `commitAll`'s `add -A`
    // would stage everything, including the retirement seeded afterward.
    seedArchiveFile(stashDir, "2026-02-01-memories-other/cleanup.md", "123"); // 3 bytes, committed
    git(stashDir, "add", ".akm/memory-cleanup/archive/2026-02-01-memories-other/cleanup.md");
    git(stashDir, "commit", "-m", "commit only the second retirement's tombstone");
    // This retirement (15 bytes across 2 files) is seeded AFTER that commit
    // and never added at all — genuinely untracked.
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "1234567890"); // 10 bytes, never committed
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "12345"); // 5 bytes, never committed

    const advisory = collectArchiveUsageAdvisory(stashDir);

    expect(advisory?.name).toBe("memory-cleanup-archive");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.evidence).toEqual({
      files: 3,
      bytes: 18,
      truncated: false,
      unpurgeableFiles: 2,
      unpurgeableBytes: 15,
      gitStateKnown: true,
    });
    expect(advisory?.message).toContain("3 archived file(s), 18 byte(s)");
    expect(advisory?.message).toContain("2 file(s), 15 byte(s) of that cannot be purged");
  });

  test("an unusable .git (present but not a real repo) counts the WHOLE archive as unpurgeable, not silently nothing (round 3)", () => {
    const stashDir = sandbox();
    markGitBacked(stashDir); // a bare, non-functional .git directory
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "1234567890"); // 10 bytes
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "12345"); // 5 bytes

    const advisory = collectArchiveUsageAdvisory(stashDir);

    expect(advisory?.status).toBe("warn");
    expect(advisory?.evidence).toMatchObject({
      files: 2,
      bytes: 15,
      unpurgeableFiles: 2,
      unpurgeableBytes: 15,
      gitStateKnown: false,
    });
  });

  test("silent when there is no archive directory at all", () => {
    const stashDir = sandbox();
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("silent when the archive directory exists but is empty", () => {
    const stashDir = sandbox();
    fs.mkdirSync(path.join(stashDir, ".akm", "memory-cleanup", "archive"), { recursive: true });
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("reports size and file count for a non-git bundle with a non-empty archive", () => {
    const stashDir = sandbox();
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "1234567890"); // 10 bytes
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "12345"); // 5 bytes
    seedArchiveFile(stashDir, "2026-02-01-memories-other/cleanup.md", "123"); // 3 bytes

    const advisory = collectArchiveUsageAdvisory(stashDir);

    expect(advisory?.name).toBe("memory-cleanup-archive");
    expect(advisory?.status).toBe("pass");
    expect(advisory?.evidence).toEqual({ files: 3, bytes: 18, truncated: false });
    expect(advisory?.message).toContain("3 archived file(s)");
  });
});
