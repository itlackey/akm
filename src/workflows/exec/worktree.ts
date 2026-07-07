// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Git worktree lifecycle for `isolation: worktree` units (redesign addendum,
 * R2). Parallel file-mutating units on the agent/sdk runners each get a
 * fresh DETACHED worktree of the run's base repository under a run-scoped
 * tmp directory, so concurrent units can never trample each other's working
 * tree. Lifecycle (driven by the native executor per journaled attempt):
 *
 *   1. {@link assertGitWorkTree} — preflight, once per step: a non-git base
 *      directory fails the step cleanly before anything dispatches.
 *   2. {@link createUnitWorktree} — `git worktree add --detach` into
 *      `<tmp>/akm-worktrees/<runId>/<attemptId>`; the path is journaled on
 *      the unit row (`workflow_run_units.worktree_path`, migration 004) and
 *      passed to dispatch as the unit's cwd.
 *   3. {@link cleanupUnitWorktree} — after the unit finishes:
 *      `git status --porcelain` CLEAN → the worktree is removed;
 *      DIRTY → it is RETAINED (the caller logs the path) so uncollected work
 *      is never destroyed.
 *
 * All git invocations are `spawnSync` (the repo-wide pattern for git
 * shell-outs) with explicit timeouts; this module never throws — every
 * operation returns a result object so the executor maps failures onto its
 * own step/unit failure vocabulary.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** Run one git command; `ok` = exit 0. Never throws (spawn errors → ok: false). */
function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.error) {
    return { ok: false, stdout: "", error: `git ${args[0]} failed to spawn: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      stdout: result.stdout ?? "",
      error: `git ${args.join(" ")} exited ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

/** True when a usable `git` binary is on PATH (tests skip gracefully without one). */
export function isGitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5_000 });
  return !result.error && result.status === 0;
}

/**
 * Preflight for worktree isolation: `dir` must be inside a git work tree.
 * Returns an error message (for a clean step failure) or undefined when ok.
 * A missing git binary reports as the same clean failure — a workflow that
 * declares isolation cannot run without git.
 */
export function assertGitWorkTree(dir: string): string | undefined {
  const result = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!result.ok) {
    return `"${dir}" is not a git repository (isolation: worktree requires one): ${result.error}`;
  }
  if (result.stdout.trim() !== "true") {
    return `"${dir}" is not inside a git work tree (isolation: worktree requires one).`;
  }
  return undefined;
}

export type WorktreeCreateResult = { ok: true; path: string } | { ok: false; error: string };

/** Journal-safe directory name for a unit attempt id (ids carry `:` / `~`). */
function sanitizeAttemptId(attemptId: string): string {
  return attemptId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Run-scoped parent directory for all of one run's unit worktrees. */
export function runWorktreeRoot(runId: string): string {
  return path.join(os.tmpdir(), "akm-worktrees", runId);
}

/**
 * Create a fresh DETACHED worktree of `baseDir`'s repository at
 * `<tmp>/akm-worktrees/<runId>/<attemptId>` (detached HEAD — no branch is
 * minted, so parallel units cannot collide on branch names). A leftover
 * directory from a crashed prior attempt at the same path is removed (and
 * `git worktree prune` clears its stale registration) before re-creating.
 */
export function createUnitWorktree(baseDir: string, runId: string, attemptId: string): WorktreeCreateResult {
  const dest = path.join(runWorktreeRoot(runId), sanitizeAttemptId(attemptId));
  try {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
      git(baseDir, ["worktree", "prune"]);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not prepare worktree directory ${dest}: ${message(err)}` };
  }
  const added = git(baseDir, ["worktree", "add", "--detach", dest]);
  if (!added.ok) {
    return { ok: false, error: `could not create isolation worktree at ${dest}: ${added.error}` };
  }
  return { ok: true, path: dest };
}

export interface WorktreeCleanupResult {
  /** The worktree was removed (it was clean). */
  removed: boolean;
  /** The worktree had uncommitted changes/untracked files and was RETAINED. */
  dirty: boolean;
  /** Set when the status probe or the removal itself failed (worktree retained). */
  error?: string;
}

/**
 * Post-unit cleanup: remove the worktree when `git status --porcelain` shows
 * it clean; retain it (dirty: true) when the unit left uncommitted work —
 * the caller logs the retained path. Any git failure retains the worktree
 * too (never destroy a tree whose state could not be verified).
 */
export function cleanupUnitWorktree(baseDir: string, worktreePath: string): WorktreeCleanupResult {
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return { removed: false, dirty: false, error: status.error };
  }
  if (status.stdout.trim() !== "") {
    return { removed: false, dirty: true };
  }
  const removed = git(baseDir, ["worktree", "remove", worktreePath]);
  if (!removed.ok) {
    return { removed: false, dirty: false, error: removed.error };
  }
  return { removed: true, dirty: false };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
