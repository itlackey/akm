// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Worktree concurrency + lifecycle GC (bugs 6 and 8):
 *
 *   - N units minting worktrees of the SAME base repo at once (a `map` step
 *     with concurrency > 1) all succeed and leave the repo's administrative
 *     state consistent — the repo-mutating git calls serialize per repository
 *     instead of racing `prune` against another unit's in-flight `add`;
 *   - those git calls are async, so a create/cleanup never wedges the event
 *     loop (asserted by keeping a timer ticking across a batch of them);
 *   - a run's worktree root is removed once its last unit worktree is gone,
 *     but survives while a dirty worktree is retained;
 *   - the age-based sweep removes stale retained/orphaned entries and leaves
 *     fresh ones alone;
 *   - the sweep never escapes the `akm-worktrees` root (refuses a foreign
 *     root, never follows a symlink out).
 *
 * Uses temp git repo fixtures; the git-dependent suites skip gracefully when
 * git is unavailable. The sweep suite operates on a private
 * `<tmp>/…/akm-worktrees` root, never the shared real one.
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
  STALE_WORKTREE_MAX_AGE_MS,
  sweepStaleWorktrees,
  WORKTREES_DIR_NAME,
  worktreesRoot,
} from "../../../src/workflows/exec/worktree";

const GIT = isGitAvailable();

const RUN_ID = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
const RUN_ID_B = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";

let scratch: string[] = [];

beforeEach(() => {
  scratch = [runWorktreeRoot(RUN_ID), runWorktreeRoot(RUN_ID_B)];
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

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout ?? "";
}

/** Init a temp git repo with one committed file (`README.md`). */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-conc-repo-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@akm.invalid"]);
  git(dir, ["config", "user.name", "akm-test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

/** Worktree paths git currently has REGISTERED for `repo` (excluding the repo itself). */
function registeredWorktrees(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((p) => p !== fs.realpathSync(repo));
}

// ── Bug 6: concurrent creation against one base repo ────────────────────────

describe.skipIf(!GIT)("createUnitWorktree — concurrent units on one base repo", () => {
  test("a fan-out of units minting worktrees at once all succeed with distinct, valid checkouts", async () => {
    const repo = makeGitRepo();
    const attempts = ["work:0", "work:1", "work:2", "work:3", "work:4", "work:5"];

    const results = await Promise.all(attempts.map((id) => createUnitWorktree(repo, RUN_ID, id)));

    for (const result of results) {
      expect(result.ok).toBe(true);
    }
    const paths = results.map((r) => (r.ok ? r.path : ""));
    expect(new Set(paths).size).toBe(attempts.length);
    for (const p of paths) {
      // A real detached checkout of the committed tree, under the run root.
      expect(p.startsWith(runWorktreeRoot(RUN_ID) + path.sep)).toBe(true);
      expect(fs.existsSync(path.join(p, "README.md"))).toBe(true);
    }
    // The base repo's administrative state agrees with the filesystem: exactly
    // one registration per worktree, none stale, none lost to a raced prune.
    const registered = registeredWorktrees(repo).map((p) => fs.realpathSync(p));
    expect(registered.sort()).toEqual(paths.map((p) => fs.realpathSync(p)).sort());
  });

  test("interleaved concurrent creates and cleanups leave no stale or missing registrations", async () => {
    const repo = makeGitRepo();
    const keep = ["keep:0", "keep:1"];
    const churn = ["churn:0", "churn:1", "churn:2", "churn:3"];

    const kept = await Promise.all(keep.map((id) => createUnitWorktree(repo, RUN_ID, id)));
    // Create and immediately tear down four more units while the kept ones
    // stay live — every one of these mutates the same repo's worktree metadata.
    await Promise.all(
      churn.map(async (id) => {
        const created = await createUnitWorktree(repo, RUN_ID, id);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const cleanup = await cleanupUnitWorktree(repo, created.path);
        expect(cleanup.removed).toBe(true);
        expect(cleanup.error).toBeUndefined();
      }),
    );

    const keptPaths = kept.map((r) => (r.ok ? fs.realpathSync(r.path) : ""));
    expect(
      registeredWorktrees(repo)
        .map((p) => fs.realpathSync(p))
        .sort(),
    ).toEqual(keptPaths.sort());
    for (const p of keptPaths) expect(fs.existsSync(path.join(p, "README.md"))).toBe(true);
  });

  test("worktree git calls do not block the event loop", async () => {
    const repo = makeGitRepo();
    // A 5 ms interval can only keep firing while the loop stays free; the old
    // spawnSync path froze it for the whole duration of every git call.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    try {
      const created = await Promise.all(
        ["loop:0", "loop:1", "loop:2"].map((id) => createUnitWorktree(repo, RUN_ID, id)),
      );
      for (const result of created) {
        expect(result.ok).toBe(true);
        if (result.ok) await cleanupUnitWorktree(repo, result.path);
      }
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

// ── Bug 8: run-root lifecycle ───────────────────────────────────────────────

describe.skipIf(!GIT)("cleanupUnitWorktree — run root lifecycle", () => {
  test("the run root is removed once its last unit worktree is cleaned up", async () => {
    const repo = makeGitRepo();
    const first = await createUnitWorktree(repo, RUN_ID, "work:0");
    const second = await createUnitWorktree(repo, RUN_ID, "work:1");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect((await cleanupUnitWorktree(repo, first.path)).removed).toBe(true);
    // One worktree still live → the run root stays.
    expect(fs.existsSync(runWorktreeRoot(RUN_ID))).toBe(true);

    expect((await cleanupUnitWorktree(repo, second.path)).removed).toBe(true);
    expect(fs.existsSync(runWorktreeRoot(RUN_ID))).toBe(false);
    // …and only this run's root — the shared worktrees root is untouched.
    expect(worktreesRoot()).toBe(path.dirname(runWorktreeRoot(RUN_ID)));
  });

  test("a retained dirty worktree keeps its run root alive", async () => {
    const repo = makeGitRepo();
    const dirty = await createUnitWorktree(repo, RUN_ID, "dirty:0");
    const clean = await createUnitWorktree(repo, RUN_ID, "clean:0");
    expect(dirty.ok && clean.ok).toBe(true);
    if (!dirty.ok || !clean.ok) return;
    fs.writeFileSync(path.join(dirty.path, "uncollected-work.txt"), "important\n");

    expect((await cleanupUnitWorktree(repo, clean.path)).removed).toBe(true);
    const retained = await cleanupUnitWorktree(repo, dirty.path);
    expect(retained.dirty).toBe(true);
    expect(retained.removed).toBe(false);

    // Forensic state survives, and so does the root that holds it.
    expect(fs.existsSync(runWorktreeRoot(RUN_ID))).toBe(true);
    expect(fs.readFileSync(path.join(dirty.path, "uncollected-work.txt"), "utf8")).toBe("important\n");
  });

  test("one run's cleanup never removes another run's root", async () => {
    const repo = makeGitRepo();
    const a = await createUnitWorktree(repo, RUN_ID, "work:0");
    const b = await createUnitWorktree(repo, RUN_ID_B, "work:0");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect((await cleanupUnitWorktree(repo, a.path)).removed).toBe(true);
    expect(fs.existsSync(runWorktreeRoot(RUN_ID))).toBe(false);
    expect(fs.existsSync(runWorktreeRoot(RUN_ID_B))).toBe(true);
  });
});

// ── Bug 8: age-based sweep (git-independent — operates on plain directories) ─

describe("sweepStaleWorktrees — age-based GC", () => {
  const roots: string[] = [];

  /** A private `<tmp>/…/akm-worktrees` root so the sweep never touches the real one. */
  function makeSweepRoot(): string {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-sweep-"));
    roots.push(parent);
    const root = path.join(parent, WORKTREES_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  function makeDir(...segments: string[]): string {
    const dir = path.join(...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function age(dir: string, ms: number): void {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(dir, when, when);
  }

  afterEach(() => {
    for (const dir of roots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("removes stale retained worktrees and leaves fresh ones", async () => {
    const root = makeSweepRoot();
    const runRoot = makeDir(root, "run-a");
    const staleTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stale = makeDir(runRoot, `work-0.retained-${staleTs}`);
    fs.writeFileSync(path.join(stale, "old-work.txt"), "ancient\n");
    const fresh = makeDir(runRoot, `work-1.retained-${Date.now()}`);
    fs.writeFileSync(path.join(fresh, "recent-work.txt"), "keep\n");
    const live = makeDir(runRoot, "work-2");
    age(stale, 30 * 24 * 60 * 60 * 1000);

    const removed = await sweepStaleWorktrees({ root });

    expect(removed).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.readFileSync(path.join(fresh, "recent-work.txt"), "utf8")).toBe("keep\n");
    expect(fs.existsSync(live)).toBe(true);
    // The run root still holds work → it survives.
    expect(fs.existsSync(runRoot)).toBe(true);
  });

  test("a retained directory whose NAME looks old but whose contents are fresh is kept", async () => {
    const root = makeSweepRoot();
    const runRoot = makeDir(root, "run-a");
    // Stale-looking name, but the directory was touched a moment ago: the
    // sweep takes the NEWEST evidence of activity, so this survives.
    const dir = makeDir(runRoot, `work-0.retained-${Date.now() - 30 * 24 * 60 * 60 * 1000}`);

    expect(await sweepStaleWorktrees({ root })).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("a run root emptied by the sweep is removed; a fresh empty root is kept", async () => {
    const root = makeSweepRoot();
    const staleRun = makeDir(root, "run-stale");
    const orphan = makeDir(staleRun, "work-0");
    age(orphan, STALE_WORKTREE_MAX_AGE_MS * 2);
    const freshEmpty = makeDir(root, "run-fresh");

    const removed = await sweepStaleWorktrees({ root });

    expect(removed).toEqual([orphan, staleRun]);
    expect(fs.existsSync(staleRun)).toBe(false);
    // A run that has just created its root (first worktree mid-`add`) is never
    // pulled out from under git.
    expect(fs.existsSync(freshEmpty)).toBe(true);
  });

  test("an already-empty STALE run root is removed", async () => {
    const root = makeSweepRoot();
    const staleEmpty = makeDir(root, "run-abandoned");
    age(staleEmpty, STALE_WORKTREE_MAX_AGE_MS * 2);

    expect(await sweepStaleWorktrees({ root })).toEqual([staleEmpty]);
    expect(fs.existsSync(staleEmpty)).toBe(false);
  });

  test("the threshold is configurable and defaults to 7 days", async () => {
    expect(STALE_WORKTREE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const root = makeSweepRoot();
    const runRoot = makeDir(root, "run-a");
    const dir = makeDir(runRoot, "work-0");
    age(dir, 60_000);

    expect(await sweepStaleWorktrees({ root, maxAgeMs: STALE_WORKTREE_MAX_AGE_MS })).toEqual([]);
    expect(await sweepStaleWorktrees({ root, maxAgeMs: 30_000 })).toEqual([dir, runRoot]);
  });

  test("a missing root is a no-op", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wt-sweep-none-"));
    roots.push(parent);
    expect(await sweepStaleWorktrees({ root: path.join(parent, WORKTREES_DIR_NAME) })).toEqual([]);
  });
});

// ── Path-escape safety for the recursive sweep ──────────────────────────────

describe("sweepStaleWorktrees — path-escape safety", () => {
  const dirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("refuses any root that is not an akm-worktrees directory", async () => {
    const parent = makeTempDir("akm-wt-escape-");
    const notOurs = path.join(parent, "important-data");
    fs.mkdirSync(notOurs, { recursive: true });
    const victim = path.join(notOurs, "run-a", "work-0");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "precious.txt"), "do not delete\n");
    const when = new Date(Date.now() - STALE_WORKTREE_MAX_AGE_MS * 2);
    fs.utimesSync(victim, when, when);

    // Ancient by every measure, but the root is not one this module owns.
    expect(await sweepStaleWorktrees({ root: notOurs })).toEqual([]);
    expect(await sweepStaleWorktrees({ root: parent })).toEqual([]);
    expect(fs.readFileSync(path.join(victim, "precious.txt"), "utf8")).toBe("do not delete\n");
  });

  test("never follows a symlink out of the root", async () => {
    const parent = makeTempDir("akm-wt-escape-link-");
    const root = path.join(parent, WORKTREES_DIR_NAME);
    const runRoot = path.join(root, "run-a");
    fs.mkdirSync(runRoot, { recursive: true });

    const outside = makeTempDir("akm-wt-escape-target-");
    fs.writeFileSync(path.join(outside, "precious.txt"), "do not delete\n");
    const link = path.join(runRoot, "work-0");
    fs.symlinkSync(outside, link);
    const when = new Date(Date.now() - STALE_WORKTREE_MAX_AGE_MS * 2);
    fs.lutimesSync(link, when, when);

    const removed = await sweepStaleWorktrees({ root });

    // The symlink is not a directory (lstat), so it is skipped outright and
    // its target is untouched.
    expect(removed).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("do not delete\n");
    expect(fs.existsSync(link)).toBe(true);
  });

  test("a run-root-level symlink is skipped too", async () => {
    const parent = makeTempDir("akm-wt-escape-link2-");
    const root = path.join(parent, WORKTREES_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });

    const outside = makeTempDir("akm-wt-escape-target2-");
    fs.mkdirSync(path.join(outside, "nested"), { recursive: true });
    fs.writeFileSync(path.join(outside, "nested", "precious.txt"), "do not delete\n");
    fs.symlinkSync(outside, path.join(root, "run-a"));

    expect(await sweepStaleWorktrees({ root })).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "nested", "precious.txt"), "utf8")).toBe("do not delete\n");
  });
});
