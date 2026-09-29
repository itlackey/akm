// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * alpha.9: `archiveCleanupCandidate` generalized to cover any memory,
 * knowledge or lesson file (not only `.derived` memories), for `akm proposal
 * accept` on a consolidate pair-pass `retire` proposal or an O1 promotion
 * retirement — plus `derivedTwinPath`, which locates the `.derived` twin
 * those callers take along. Memory cleanup's own family-prune usage must
 * stay byte-identical (its `previousBeliefState` inference, its tombstone
 * shape without the new fields).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveCleanupCandidate,
  derivedTwinPath,
  purgeGracedArchive,
  RETIRE_GRACE_DAYS,
} from "../../../src/commands/improve/memory/memory-improve";
import type { MemoryPruneCandidate } from "../../../src/core/improve-types";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { overrideSeam } from "../../_helpers/seams";

const MS_PER_DAY = 86_400_000;

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-archive-candidate-"));
  return dir;
}

/** `isGitBackedStash` is a plain `.git`-presence check — no real repo needed. */
function markGitBacked(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });
}

/** A REAL git repo (B1): the purge sweep now checks `git ls-files`/`git status` for real, so tests that expect a purge to actually happen need a real repo, not just a `.git` directory. */
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

function writeAsset(stashDir: string, relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

describe("archiveCleanupCandidate — generalized for retire proposals (alpha.9)", () => {
  test("a retire candidate (proposalId set) reads previousBeliefState from the file's ACTUAL frontmatter", () => {
    const stashDir = sandbox();
    const filePath = writeAsset(stashDir, "memories/old-note.md", "beliefState: superseded\ndescription: old");
    const candidate: MemoryPruneCandidate = {
      ref: "memories/old-note",
      reason: "duplicate",
      proposalId: "proposal-1",
      successorRefs: ["memories/new-note"],
    };
    const record = archiveCleanupCandidate(stashDir, candidate, filePath);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(record.reason).toBe("duplicate");
    expect(record.proposalId).toBe("proposal-1");
    expect(record.successorRefs).toEqual(["memories/new-note"]);
    expect(record.retiredAt).toBe(record.archivedAt);
    // Read from frontmatter, not inferred from `reason` (which under the OLD
    // inference would have produced "active" for anything but
    // "superseded-derived").
    expect(record.previousBeliefState).toBe("superseded");
    expect(record.parentRef).toBeUndefined();

    const tombstone = fs.readFileSync(path.join(stashDir, record.auditPath), "utf8");
    expect(tombstone).toContain("proposalId: proposal-1");
    expect(tombstone).toContain("successorRefs:");
    expect(tombstone).toContain("retiredAt:");
    expect(tombstone).toContain("previousBeliefState: superseded");
  });

  test("a retire candidate with no beliefState in frontmatter defaults to active, same as memory cleanup's resolver", () => {
    const stashDir = sandbox();
    const filePath = writeAsset(stashDir, "knowledge/dup.md", "description: a duplicate knowledge asset");
    const record = archiveCleanupCandidate(
      stashDir,
      { ref: "knowledge/dup", reason: "subsumed", proposalId: "p2", successorRefs: ["knowledge/keeper"] },
      filePath,
    );
    expect(record.previousBeliefState).toBe("active");
  });

  test("memory cleanup's own family-prune usage is unchanged: reason-based inference, no proposalId/successorRefs on the tombstone", () => {
    const stashDir = sandbox();
    // Actual frontmatter says "active", but the OLD inference for
    // superseded-derived must still win — proving this path was not
    // switched over to reading the real frontmatter value.
    const filePath = writeAsset(stashDir, "memories/child.derived.md", "beliefState: active");
    const candidate: MemoryPruneCandidate = {
      ref: "memory:child.derived",
      parentRef: "memories/child",
      reason: "superseded-derived",
      survivorRef: "memory:child.derived.v2",
    };
    const record = archiveCleanupCandidate(stashDir, candidate, filePath);
    expect(record.previousBeliefState).toBe("superseded");
    expect(record.parentRef).toBe("memories/child");
    expect(record.survivorRef).toBe("memory:child.derived.v2");
    expect(record.proposalId).toBeUndefined();
    expect(record.successorRefs).toBeUndefined();
    expect(record.retiredAt).toBeUndefined();

    const tombstone = fs.readFileSync(path.join(stashDir, record.auditPath), "utf8");
    expect(tombstone).not.toContain("proposalId:");
    expect(tombstone).not.toContain("successorRefs:");
    expect(tombstone).not.toContain("retiredAt:");
  });

  test("the tombstone is written before the file is moved — a failed move still leaves it behind (4c, third review round)", () => {
    const stashDir = sandbox();
    const filePath = writeAsset(stashDir, "memories/old-note.md", "description: an old note");
    const candidate: MemoryPruneCandidate = { ref: "memories/old-note", reason: "duplicate" };
    // Removed out from under it: the rename this call makes will fail
    // (ENOENT), simulating a crash right where the rename would happen.
    // Under the OLD ordering (move, then write the tombstone) this failure
    // would leave no trace at all. Under the fixed ordering, the tombstone
    // is already on disk by the time the rename is even attempted.
    fs.rmSync(filePath);
    expect(() => archiveCleanupCandidate(stashDir, candidate, filePath)).toThrow();

    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dirs = fs.readdirSync(archiveRoot);
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(path.join(archiveRoot, dirs[0]!, "cleanup.md"))).toBe(true);
  });
});

describe("derivedTwinPath", () => {
  test("finds the <name>.derived.md sibling when it exists", () => {
    const stashDir = sandbox();
    const parentPath = writeAsset(stashDir, "memories/foo.md", "description: parent");
    const twinPath = writeAsset(stashDir, "memories/foo.derived.md", "description: derived child");
    expect(derivedTwinPath(parentPath, "memory")).toBe(twinPath);
  });

  test("returns undefined when no twin exists on disk", () => {
    const stashDir = sandbox();
    const parentPath = writeAsset(stashDir, "memories/lonely.md", "description: no child");
    expect(derivedTwinPath(parentPath, "memory")).toBeUndefined();
  });

  test("returns undefined for a non-memory type, and for an already-derived memory", () => {
    const stashDir = sandbox();
    const knowledgePath = writeAsset(stashDir, "knowledge/guide.md", "description: guide");
    expect(derivedTwinPath(knowledgePath, "knowledge")).toBeUndefined();

    const derivedPath = writeAsset(stashDir, "memories/bar.derived.md", "description: already derived");
    expect(derivedTwinPath(derivedPath, "memory")).toBeUndefined();
  });
});

describe("purgeGracedArchive — the purge sweep (item 4, plan §5.4/§8 step 8)", () => {
  /** A retire-shaped archive (proposalId set), via the real production path so `retiredAt` matches reality. Returns the tombstone's own `retiredAt`. */
  function archiveRetirement(stashDir: string, relPath: string, ref: string): string {
    const filePath = writeAsset(stashDir, relPath, "description: a retired asset");
    const candidate: MemoryPruneCandidate = {
      ref,
      reason: "duplicate",
      proposalId: `p-${ref}`,
      successorRefs: ["memories/keeper"],
    };
    const record = archiveCleanupCandidate(stashDir, candidate, filePath);
    if (!record.retiredAt) throw new Error("expected a retiredAt on a retire-shaped archive record");
    return record.retiredAt;
  }

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * MS_PER_DAY);
  }

  test("not git-backed: the archive is left untouched", () => {
    const stashDir = sandbox();
    archiveRetirement(stashDir, "memories/old.md", "memories/old");
    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));
    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "old.md"))).toBe(true);
  });

  test("no archive directory at all: a clean no-op", () => {
    const stashDir = sandbox();
    markGitBacked(stashDir);
    expect(purgeGracedArchive(stashDir)).toEqual({ purgedDirs: 0, purgedFiles: 0 });
  });

  test("within the grace period: nothing purged", () => {
    const stashDir = sandbox();
    markGitBacked(stashDir);
    archiveRetirement(stashDir, "memories/recent.md", "memories/recent");
    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS - 1));
    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "recent.md"))).toBe(true);
  });

  test("exactly at the grace boundary is not enough — only strictly more than RETIRE_GRACE_DAYS is purged", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    const retiredAt = archiveRetirement(stashDir, "memories/boundary.md", "memories/boundary");
    commitAll(stashDir, "archive retirement"); // committed and clean (B1) — grace-period date is the only remaining gate
    // now - retiredAt == exactly RETIRE_GRACE_DAYS (computed from the tombstone's
    // own timestamp, not two independent Date.now() calls, which would drift by
    // the test's own execution time and make this boundary check flaky).
    const exactlyAtBoundary = new Date(Date.parse(retiredAt) + RETIRE_GRACE_DAYS * MS_PER_DAY);
    expect(purgeGracedArchive(stashDir, exactlyAtBoundary)).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(purgeGracedArchive(stashDir, new Date(exactlyAtBoundary.getTime() + 1))).toEqual({
      purgedDirs: 1,
      purgedFiles: 1,
    });
  });

  test("past the grace period AND committed-clean in git: the archived file is deleted, cleanup.md is not (B1)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    commitAll(stashDir, "archive retirement");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 1, purgedFiles: 1 });
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "stale.md"))).toBe(false);
    expect(fs.existsSync(path.join(archiveRoot, dir, "cleanup.md"))).toBe(true);
    // The directory tree the file lived under is cleaned up too, not left empty.
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories"))).toBe(false);
  });

  test("a second, independently-timed retirement in the same archive is judged on its own retiredAt", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    archiveRetirement(stashDir, "memories/twin.derived.md", "memories/twin.derived");
    commitAll(stashDir, "archive both retirements");

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    // Both were archived "now" in this test, so both are past grace by the same future `now`.
    expect(result).toEqual({ purgedDirs: 2, purgedFiles: 2 });
  });

  test("a memory-cleanup family-prune archive (no retiredAt) is never touched, whatever its age", () => {
    const stashDir = sandbox();
    markGitBacked(stashDir);
    const filePath = writeAsset(stashDir, "memories/child.derived.md", "description: derived child");
    const candidate: MemoryPruneCandidate = {
      ref: "memory:child.derived",
      parentRef: "memories/child",
      reason: "superseded-derived",
      survivorRef: "memory:child.derived.v2",
    };
    archiveCleanupCandidate(stashDir, candidate, filePath);
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS * 10));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "child.derived.md"))).toBe(true);
  });

  test("an untracked archived file (never committed) is kept — git has no other copy of it (B1)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    // A `kind: "filesystem"` bundle's `proposal accept` never commits
    // (`commitWriteTargetBoundary` only fires for `kind: "git"`), so this
    // reproduces exactly that: the archive move happened on disk, but
    // nothing was ever `git add`ed, let alone committed.
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "stale.md"))).toBe(true);
    expect(fs.existsSync(path.join(archiveRoot, dir, "cleanup.md"))).toBe(true);
  });

  test("a modified archived file (committed, then edited on disk with no new commit) is kept (B1)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    commitAll(stashDir, "archive retirement");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    // Edited after the commit, without a follow-up commit — git sees this
    // file as dirty, so the committed copy no longer matches the worktree
    // copy purge would delete.
    fs.appendFileSync(path.join(archiveRoot, dir, "memories", "stale.md"), "Unsynced edit.\n");

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(path.join(archiveRoot, dir, "memories", "stale.md"))).toBe(true);
  });

  test("a symlinked archive/<dir> is never followed — nothing outside the archive is touched (N1)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });

    // A directory OUTSIDE the archive, shaped exactly like a purgeable
    // retirement (tombstone with a stale retiredAt, tracked and clean in
    // git) — if the symlink below were ever followed, this is what the old
    // code would delete.
    const victimDir = path.join(stashDir, "outside-the-archive");
    fs.mkdirSync(victimDir, { recursive: true });
    const retiredAt = new Date(Date.now() - (RETIRE_GRACE_DAYS + 1) * MS_PER_DAY).toISOString();
    fs.writeFileSync(
      path.join(victimDir, "cleanup.md"),
      `---\nkind: memory-cleanup-archive\nref: memories/victim\nretiredAt: "${retiredAt}"\noriginalPath: memories/victim.md\n---\n\nArchived.\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(victimDir, "victim.md"), "Should never be touched.\n", "utf8");
    commitAll(stashDir, "seed a victim directory outside the archive");

    // A symlink INSIDE the archive root pointing at the victim directory —
    // `entry.name` alone can't distinguish this from a real archive dir;
    // only `lstat`/`Dirent.isDirectory()` can.
    fs.symlinkSync(victimDir, path.join(archiveRoot, "2020-01-01-symlinked-elsewhere"));

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(path.join(victimDir, "victim.md"))).toBe(true);
    expect(fs.existsSync(path.join(victimDir, "cleanup.md"))).toBe(true);
  });

  test("a broken 'git status' (nonzero exit) purges NOTHING this sweep, even though 'git ls-files' still works, and warns once (G8, round-3 review)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    commitAll(stashDir, "archive retirement");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    const archivedFile = path.join(archiveRoot, dir, "memories", "stale.md");
    // Dirty — but `git status` itself is about to be broken, so the ONLY
    // safe outcome is "purge nothing", not "didn't see it, so it's clean".
    fs.appendFileSync(archivedFile, "uncommitted edit\n");

    // A fake `git` ahead of the real one on PATH that fails only `status`,
    // delegating every other subcommand (ls-files, ls-files -v, ...) to the
    // real binary — reproduces a broken submodule / detached worktree
    // without needing one.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fakegit-"));
    fs.writeFileSync(
      path.join(fakeBin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && { echo "fatal: simulated" >&2; exit 128; }; done\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    process.env.PATH = `${fakeBin}:${savedPath}`;
    let result: ReturnType<typeof purgeGracedArchive>;
    try {
      result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));
    } finally {
      process.env.PATH = savedPath;
    }

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(archivedFile)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("archive purge");
  });

  test("a broken submodule (gitlink) that fails 'git status' but not 'git ls-files' purges NOTHING (G9, round-3 review)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    commitAll(stashDir, "archive retirement");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    const archivedFile = path.join(archiveRoot, dir, "memories", "stale.md");

    // A gitlink entry (the shape a submodule leaves in the index) whose
    // target has no matching `.git/modules` entry — `git status` fails
    // trying to inspect it, `git ls-files` does not (it only reads the
    // index). Realistic, not synthetic: this is what a half-configured
    // submodule looks like.
    const sha = git(stashDir, "rev-parse", "HEAD").trim();
    // `--add --cacheinfo` stages the gitlink entry directly into the index —
    // a plain commit is enough; `git add -A` would also try (and fail) to
    // make sense of `vendor/` as a real submodule checkout on disk.
    git(stashDir, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor`);
    fs.mkdirSync(path.join(stashDir, "vendor"));
    fs.writeFileSync(path.join(stashDir, "vendor", ".git"), "gitdir: ../.git/modules/vendor\n");
    git(stashDir, "commit", "-m", "gitlink");
    fs.appendFileSync(archivedFile, "uncommitted edit\n");

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(archivedFile)).toBe(true);
  });

  test("an assume-unchanged tracked file hides its own edit from 'git status' — kept, not purged (G10, round-3 review)", () => {
    const stashDir = sandbox();
    initGitRepo(stashDir);
    archiveRetirement(stashDir, "memories/stale.md", "memories/stale");
    commitAll(stashDir, "archive retirement");
    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    const dir = fs.readdirSync(archiveRoot)[0]!;
    const archivedFile = path.join(archiveRoot, dir, "memories", "stale.md");
    fs.appendFileSync(archivedFile, "hidden edit\n");
    git(stashDir, "update-index", "--assume-unchanged", path.relative(stashDir, archivedFile));

    const result = purgeGracedArchive(stashDir, daysFromNow(RETIRE_GRACE_DAYS + 1));

    expect(result).toEqual({ purgedDirs: 0, purgedFiles: 0 });
    expect(fs.existsSync(archivedFile)).toBe(true);
  });
});
