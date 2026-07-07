// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Worktree lifecycle safety (peer-review regression, R2):
 * `createUnitWorktree` used to `rmSync` ANY leftover directory at the attempt
 * path — destroying a previously RETAINED dirty worktree (or a crashed
 * attempt's partial work) on resume, in violation of the pinned
 * "never delete a dirty tree" invariant. Now:
 *
 *   - a CLEAN leftover is removed and re-created (old behaviour);
 *   - a DIRTY leftover is moved aside to `<dest>.retained-<ts>` with its
 *     contents intact, and reported via `preservedLeftover`;
 *   - an UNVERIFIABLE leftover (the `git status` probe fails — e.g. a
 *     half-created directory that is not a valid worktree) is moved aside
 *     too, never deleted.
 *
 * Uses a temp git repo fixture; skips gracefully when git is unavailable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupUnitWorktree,
  createUnitWorktree,
  isGitAvailable,
  runWorktreeRoot,
} from "../../src/workflows/exec/worktree";

const GIT = isGitAvailable();

const RUN_ID = "88888888-8888-4888-8888-888888888888";

let scratch: string[] = [];

beforeEach(() => {
  scratch = [runWorktreeRoot(RUN_ID)];
});

afterEach(() => {
  for (const dir of scratch) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** Init a temp git repo with one committed file (`README.md`). */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-unit-repo-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@akm.invalid"]);
  git(dir, ["config", "user.name", "akm-test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

/** Init a temp git repo whose committed `.gitignore` ignores `build/` and `*.log`. */
function makeGitRepoWithGitignore(): string {
  const dir = makeGitRepo();
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n*.log\n");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-q", "-m", "gitignore"]);
  return dir;
}

function mustCreate(repo: string, attemptId: string): { path: string; preservedLeftover?: string } {
  const result = createUnitWorktree(repo, RUN_ID, attemptId);
  if (!result.ok) throw new Error(`createUnitWorktree failed: ${result.error}`);
  return result;
}

describe.skipIf(!GIT)("createUnitWorktree — leftover handling (never destroy dirty work)", () => {
  test("a DIRTY leftover at the attempt path is moved aside intact, not deleted", () => {
    const repo = makeGitRepo();

    // First invocation mints the worktree; the unit leaves uncollected work
    // and the tree is RETAINED (e.g. the engine crashed before the step
    // completed). Re-running the same content-derived attempt id must not
    // destroy it.
    const first = mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(first.path, "uncollected-work.txt"), "important\n");

    const second = mustCreate(repo, "work:solo");
    expect(second.path).toBe(first.path);
    // Fresh checkout — the dirty file is not in the new worktree…
    expect(fs.existsSync(path.join(second.path, "uncollected-work.txt"))).toBe(false);
    expect(fs.existsSync(path.join(second.path, "README.md"))).toBe(true);
    // …because the leftover was moved aside with its contents intact.
    expect(second.preservedLeftover).toBeDefined();
    const preserved = second.preservedLeftover as string;
    expect(preserved.startsWith(`${first.path}.retained-`)).toBe(true);
    expect(fs.readFileSync(path.join(preserved, "uncollected-work.txt"), "utf8")).toBe("important\n");
  });

  test("a CLEAN leftover is removed and re-created (no retained copies pile up)", () => {
    const repo = makeGitRepo();

    const first = mustCreate(repo, "work:solo");
    const second = mustCreate(repo, "work:solo");

    expect(second.path).toBe(first.path);
    expect(second.preservedLeftover).toBeUndefined();
    // Nothing was moved aside.
    const siblings = fs.readdirSync(path.dirname(second.path));
    expect(siblings.filter((name) => name.includes(".retained-"))).toEqual([]);
  });

  test("an UNVERIFIABLE leftover (status probe fails) is moved aside, never deleted", () => {
    const repo = makeGitRepo();

    // A half-created directory that is NOT a valid worktree — `git status`
    // fails in it, so its state cannot be verified.
    const dest = path.join(runWorktreeRoot(RUN_ID), "work2-solo");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "partial.txt"), "maybe important\n");

    const created = mustCreate(repo, "work2:solo");
    expect(created.path).toBe(dest);
    expect(created.preservedLeftover).toBeDefined();
    const preserved = created.preservedLeftover as string;
    expect(fs.readFileSync(path.join(preserved, "partial.txt"), "utf8")).toBe("maybe important\n");
    // The new worktree is a real checkout.
    expect(fs.existsSync(path.join(created.path, "README.md"))).toBe(true);
  });

  test("successive dirty leftovers get DISTINCT retained paths (no overwrite)", () => {
    const repo = makeGitRepo();

    const first = mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(first.path, "gen-1.txt"), "one\n");
    const second = mustCreate(repo, "work:solo");
    fs.writeFileSync(path.join(second.path, "gen-2.txt"), "two\n");
    const third = mustCreate(repo, "work:solo");

    const preservedFirst = second.preservedLeftover as string;
    const preservedSecond = third.preservedLeftover as string;
    expect(preservedFirst).toBeDefined();
    expect(preservedSecond).toBeDefined();
    expect(preservedSecond).not.toBe(preservedFirst);
    // Both generations of uncollected work survive.
    expect(fs.readFileSync(path.join(preservedFirst, "gen-1.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(preservedSecond, "gen-2.txt"), "utf8")).toBe("two\n");
  });
});

describe.skipIf(!GIT)(
  "cleanupUnitWorktree — the honest 'uncollected work' contract (ignored files are disposable)",
  () => {
    test("a worktree whose ONLY residue is .gitignore-matched files probes clean and IS removed", () => {
      const repo = makeGitRepoWithGitignore();
      const wt = mustCreate(repo, "build:solo").path;

      // The unit produced ONLY files the repo's own .gitignore declares
      // disposable (a build dir + a log). `git status --porcelain` (no
      // --ignored) reports these as clean, matching the documented contract:
      // ignored files are throwaway, so the worktree is removed, not retained.
      fs.mkdirSync(path.join(wt, "build"), { recursive: true });
      fs.writeFileSync(path.join(wt, "build", "out.o"), "artifact\n");
      fs.writeFileSync(path.join(wt, "debug.log"), "noise\n");

      const cleanup = cleanupUnitWorktree(repo, wt);
      expect(cleanup.removed).toBe(true);
      expect(cleanup.dirty).toBe(false);
      expect(cleanup.error).toBeUndefined();
      expect(fs.existsSync(wt)).toBe(false);
    });

    test("an untracked UNIGNORED file is real uncollected work → dirty, retained (the contract boundary)", () => {
      const repo = makeGitRepoWithGitignore();
      const wt = mustCreate(repo, "build:solo").path;

      // A file the .gitignore does NOT match is genuine uncollected work.
      fs.writeFileSync(path.join(wt, "result.txt"), "keep me\n");

      const cleanup = cleanupUnitWorktree(repo, wt);
      expect(cleanup.dirty).toBe(true);
      expect(cleanup.removed).toBe(false);
      // Retained intact — the caller logs the path.
      expect(fs.readFileSync(path.join(wt, "result.txt"), "utf8")).toBe("keep me\n");
    });
  },
);
