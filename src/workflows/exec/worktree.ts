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
 *   4. {@link sweepStaleWorktrees} — opportunistic, at most once per process:
 *      an age-based GC of run roots and retained trees that outlived their run.
 *
 * What "uncollected work" means (the honest contract): the clean probe is
 * `git status --porcelain` WITHOUT `--ignored`, so it counts tracked-file
 * modifications and untracked *unignored* files, but NOT files the base repo's
 * own `.gitignore` matches (build outputs, caches, logs, dependency dirs such
 * as `node_modules`/`dist`). Those ignored files are DISPOSABLE BY DEFINITION
 * — the repository already declares them regenerable — so a worktree whose only
 * residue is ignored files probes clean and IS removed. This is deliberate:
 * adding `--ignored` would retain a worktree after essentially every unit that
 * ran a package install or a build (the ignored `node_modules`/`dist` tree),
 * blowing up disk under the run-scoped tmp root. Work a unit needs preserved
 * must therefore be tracked or untracked-unignored; anything the workflow
 * repo has chosen to `.gitignore` is treated as throwaway.
 *
 * Concurrency (bug 6). `git worktree add|prune|remove` mutate the base repo's
 * administrative state (`.git/worktrees/*`) under repo-level locks, so a map
 * step running N isolated units at once used to have N of them racing on the
 * same repository. Two invariants close that:
 *
 *   • every repo-mutating operation runs inside {@link withRepoWorktreeLock},
 *     a promise chain keyed by the resolved base repo path (the
 *     `unit-writer.ts` idiom — Bun is single-threaded, so an in-process chain
 *     is sufficient), so at most one add/prune/remove per repository is ever
 *     in flight;
 *   • those git calls are ASYNC ({@link runManagedSubprocess}) rather than
 *     `spawnSync`, so a unit waiting on a git lock parks a promise instead of
 *     wedging the whole event loop (and with it every other in-flight unit,
 *     the lease heartbeat, and abort handling).
 *
 * The two sync git shell-outs that remain — {@link isGitAvailable} and
 * {@link assertGitWorkTree} — are read-only, take no repo lock, and run
 * BEFORE any unit dispatches (preflight / test gate), so they can never block
 * work that is already in flight.
 *
 * This module never throws — every operation returns a result object so the
 * executor maps failures onto its own step/unit failure vocabulary. The GC
 * sweep is the sole exception to "no logging here": it is fire-and-forget and
 * has no caller to report to, so it reports through `warn`.
 */

import { spawnSync } from "node:child_process";
import fs, { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWithin, safeRealpath } from "../../core/common";
import { runManagedSubprocess } from "../../core/subprocess";
import { warn } from "../../core/warn";

const GIT_TIMEOUT_MS = 30_000;

/** Directory under `os.tmpdir()` that owns every run's worktree roots. */
export const WORKTREES_DIR_NAME = "akm-worktrees";

/**
 * Age after which an orphaned entry under the worktrees root is swept.
 *
 * Retained dirty worktrees are forensic state — deleting them is only
 * acceptable once they are far past any plausible investigation window. Seven
 * days is one full on-call rotation: long enough that a retained tree from a
 * failed run has been triaged (or abandoned), short enough that a tmpdir does
 * not accumulate whole repository checkouts indefinitely.
 */
export const STALE_WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

function gitExitError(args: string[], code: number | null, stderr: string, stdout: string): string {
  const detail = (stderr || stdout || "").trim();
  return `git ${args.join(" ")} exited ${code}${detail ? `: ${detail}` : ""}`;
}

/**
 * Run one git command asynchronously; `ok` = exit 0. Never throws (spawn
 * errors and the 30 s timeout → ok: false). Async so a git lock wait parks a
 * promise instead of blocking the event loop; repo-mutating callers must hold
 * {@link withRepoWorktreeLock}.
 */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  const result = await runManagedSubprocess(["git", "-C", cwd, ...args], {
    capture: true,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.spawnError) {
    return { ok: false, stdout: "", error: `git ${args[0]} failed to spawn: ${result.spawnError.message}` };
  }
  if (result.timedOut) {
    return { ok: false, stdout: result.stdout, error: `git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      stdout: result.stdout,
      error: gitExitError(args, result.exitCode, result.stderr, result.stdout),
    };
  }
  return { ok: true, stdout: result.stdout };
}

/**
 * Synchronous git for the two read-only probes that run before any unit is in
 * flight ({@link isGitAvailable}, {@link assertGitWorkTree}). They take no
 * repository lock, so blocking here cannot stall another unit's git call.
 */
function gitSync(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.error) {
    return { ok: false, stdout: "", error: `git ${args[0]} failed to spawn: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      error: gitExitError(args, result.status, result.stderr ?? "", result.stdout ?? ""),
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
  const result = gitSync(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!result.ok) {
    return `"${dir}" is not a git repository (isolation: worktree requires one): ${result.error}`;
  }
  if (result.stdout.trim() !== "true") {
    return `"${dir}" is not inside a git work tree (isolation: worktree requires one).`;
  }
  return undefined;
}

// ── Per-repository serialization ────────────────────────────────────────────

/** In-flight tail of each base repository's serialized git-worktree chain. */
const repoOperationTails = new Map<string, Promise<unknown>>();

/** Base repos already pruned in this process, keyed `<repo>\0<runId>`. */
const prunedRuns = new Set<string>();

/**
 * Serialize `fn` against every other repo-mutating worktree operation on the
 * same base repository. Keyed by the RESOLVED repo path so two spellings of
 * one repo (symlinked tmpdir, relative cwd) share a chain. A failure rejects
 * its own caller but never wedges the chain (`unit-writer.ts` idiom).
 */
function withRepoWorktreeLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoOperationTails.get(repoKey) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  repoOperationTails.set(repoKey, tail);
  // Drop drained keys so a long-lived process does not retain one promise per
  // repository it ever touched.
  void tail.then(() => {
    if (repoOperationTails.get(repoKey) === tail) repoOperationTails.delete(repoKey);
  });
  return run;
}

export type WorktreeCreateResult =
  | {
      ok: true;
      path: string;
      /**
       * Set when a leftover directory at the attempt path was DIRTY (or its
       * state could not be verified) and was moved aside instead of deleted —
       * the caller logs where the previous attempt's work was preserved.
       */
      preservedLeftover?: string;
    }
  | { ok: false; error: string };

/** Journal-safe directory name for a unit attempt id (ids carry `:` / `~`). */
function sanitizeAttemptId(attemptId: string): string {
  return attemptId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Parent directory of every run's worktree root (`<tmp>/akm-worktrees`). */
export function worktreesRoot(): string {
  return path.join(os.tmpdir(), WORKTREES_DIR_NAME);
}

/** Run-scoped parent directory for all of one run's unit worktrees. */
export function runWorktreeRoot(runId: string): string {
  return path.join(worktreesRoot(), runId);
}

/**
 * Move a leftover attempt directory aside to `<dest>.retained-<ts>[-n]`
 * (never overwriting an earlier retained copy). Throws on fs errors — the
 * caller maps them onto its result object.
 */
function moveLeftoverAside(dest: string): string {
  const base = `${dest}.retained-${Date.now()}`;
  let aside = base;
  for (let n = 1; fs.existsSync(aside); n++) aside = `${base}-${n}`;
  fs.renameSync(dest, aside);
  return aside;
}

/**
 * Create a fresh DETACHED worktree of `baseDir`'s repository at
 * `<tmp>/akm-worktrees/<runId>/<attemptId>` (detached HEAD — no branch is
 * minted, so parallel units cannot collide on branch names).
 *
 * A leftover directory at the attempt path (a RETAINED dirty worktree from a
 * prior invocation, or a crashed attempt's partial state) is handled with the
 * same never-destroy-unverified-work rule as {@link cleanupUnitWorktree}:
 * `git status --porcelain` CLEAN → removed; DIRTY or unverifiable (the probe
 * fails — e.g. a half-created directory that is no longer a valid worktree)
 * → moved aside to `<dest>.retained-<ts>` and reported via
 * `preservedLeftover` so the caller can log where the work went. Either way
 * `git worktree prune` clears the stale registration before re-creating.
 *
 * The whole body runs under {@link withRepoWorktreeLock}: the leftover probe,
 * the prune and the add form ONE critical section against the base repo's
 * administrative state, so a concurrent unit's prune can never land between
 * another unit's prune and its add.
 */
export function createUnitWorktree(baseDir: string, runId: string, attemptId: string): Promise<WorktreeCreateResult> {
  // Opportunistic, at most once per process, never awaited — GC must never sit
  // on the dispatch path.
  sweepStaleWorktreesOnce();
  const repoKey = safeRealpath(baseDir);
  const dest = path.join(runWorktreeRoot(runId), sanitizeAttemptId(attemptId));
  return withRepoWorktreeLock(repoKey, async () => {
    let preservedLeftover: string | undefined;
    let leftoverHandled = false;
    try {
      if (fs.existsSync(dest)) {
        const status = await git(dest, ["status", "--porcelain"]);
        if (status.ok && status.stdout.trim() === "") {
          fs.rmSync(dest, { recursive: true, force: true });
        } else {
          preservedLeftover = moveLeftoverAside(dest);
        }
        leftoverHandled = true;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch (err) {
      return { ok: false, error: `could not prepare worktree directory ${dest}: ${message(err)}` };
    }
    // Prune only drops administrative entries whose worktree directory is
    // already gone; it never touches a live worktree. Two triggers, both
    // necessary, and never per-unit-attempt (which multiplied lock contention
    // without buying safety):
    //   • a leftover was just removed/moved — its stale registration MUST go
    //     before re-adding at the same path;
    //   • first worktree of this (repo, run) — reaps registrations orphaned by
    //     earlier runs whose roots were GC'd or deleted out from under git.
    const pruneKey = `${repoKey}\u0000${runId}`;
    if (leftoverHandled || !prunedRuns.has(pruneKey)) {
      prunedRuns.add(pruneKey);
      await git(baseDir, ["worktree", "prune"]);
    }
    const added = await git(baseDir, ["worktree", "add", "--detach", dest]);
    if (!added.ok) {
      return { ok: false, error: `could not create isolation worktree at ${dest}: ${added.error}` };
    }
    return { ok: true, path: dest, ...(preservedLeftover !== undefined ? { preservedLeftover } : {}) };
  });
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
 *
 * The probe deliberately omits `--ignored`: a worktree whose only residue is
 * files matched by the base repo's `.gitignore` (build artifacts, caches,
 * logs, `node_modules`) probes clean and IS removed. Those files are disposable
 * by the repo's own declaration; retaining a worktree per build/install would
 * blow up disk. "Uncollected work" the caller preserves is therefore
 * tracked-or-untracked-unignored changes only (module doc).
 *
 * Only `git worktree remove` takes the base repo's lock, so the status probe
 * stays OFF {@link withRepoWorktreeLock} — parallel units probe concurrently
 * and serialize only on the mutation.
 */
export async function cleanupUnitWorktree(baseDir: string, worktreePath: string): Promise<WorktreeCleanupResult> {
  const status = await git(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return { removed: false, dirty: false, error: status.error };
  }
  if (status.stdout.trim() !== "") {
    return { removed: false, dirty: true };
  }
  const removed = await withRepoWorktreeLock(safeRealpath(baseDir), () =>
    git(baseDir, ["worktree", "remove", worktreePath]),
  );
  if (!removed.ok) {
    return { removed: false, dirty: false, error: removed.error };
  }
  removeRunRootIfEmpty(worktreePath);
  return { removed: true, dirty: false };
}

// ── Garbage collection ──────────────────────────────────────────────────────

/**
 * Drop the run-scoped root once its last unit worktree is gone. `rmdir`
 * refuses a non-empty directory, so a run that retained a dirty worktree (or
 * a `.retained-<ts>` copy) keeps its root and its forensic contents; only a
 * fully drained root disappears. Never touches anything that is not a DIRECT
 * child of the worktrees root.
 */
function removeRunRootIfEmpty(worktreePath: string): void {
  const root = worktreesRoot();
  const runRoot = path.dirname(path.resolve(worktreePath));
  if (!isWithin(runRoot, root) || safeRealpath(path.dirname(runRoot)) !== safeRealpath(root)) return;
  try {
    fs.rmdirSync(runRoot);
  } catch {
    // ENOTEMPTY (retained work) / ENOENT (already gone) — both fine.
  }
}

/** Options for {@link sweepStaleWorktrees}. `root`/`now` are test seams. */
export interface SweepStaleWorktreesOptions {
  /**
   * Sweep root. Defaults to {@link worktreesRoot}. A root whose basename is
   * not `akm-worktrees` is REFUSED outright — recursive deletion is confined
   * to a directory this module owns, whatever the caller passes.
   */
  root?: string;
  /** Age threshold. Defaults to {@link STALE_WORKTREE_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** "Now" in epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Age-based GC of the worktrees root. Removes `<root>/<runId>/<entry>`
 * directories whose last activity is older than `maxAgeMs` — orphaned
 * worktrees from crashed runs AND deliberately retained dirty trees, because
 * the age threshold is exactly what makes discarding forensic state
 * acceptable. A run root is dropped once it is empty and itself stale (or
 * this sweep just emptied it), so a live run whose first worktree is mid-`add`
 * is never pulled out from under git.
 *
 * Safety invariants: it only ever descends two levels from `root`; entries
 * that are not real directories (symlinks included — `Dirent.isDirectory()`
 * reflects `lstat`) are skipped, never followed; and every candidate is
 * re-verified with {@link isWithin} against the resolved root before removal.
 * Deleting a directory leaves its registration in whatever base repo minted
 * it; the next run's `git worktree prune` on that repo reaps it.
 *
 * Returns the paths removed. Never throws.
 */
export async function sweepStaleWorktrees(opts: SweepStaleWorktreesOptions = {}): Promise<string[]> {
  const root = path.resolve(opts.root ?? worktreesRoot());
  const removed: string[] = [];
  if (path.basename(root) !== WORKTREES_DIR_NAME) return removed;
  const maxAgeMs = opts.maxAgeMs ?? STALE_WORKTREE_MAX_AGE_MS;
  const now = opts.now ?? Date.now();

  let runRoots: Dirent[];
  try {
    runRoots = await fsp.readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return removed; // No root yet (or unreadable) — nothing to sweep.
  }
  for (const runRootEntry of runRoots) {
    if (!runRootEntry.isDirectory()) continue;
    const runRoot = path.join(root, runRootEntry.name);
    if (!isWithin(runRoot, root)) continue;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(runRoot, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    let emptiedHere = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(runRoot, entry.name);
      if (!isWithin(candidate, root)) continue;
      if (now - (await lastActivityMs(candidate, entry.name)) < maxAgeMs) continue;
      try {
        await fsp.rm(candidate, { recursive: true, force: true });
        removed.push(candidate);
        emptiedHere = true;
      } catch {
        /* leave it for the next sweep */
      }
    }
    try {
      if ((await fsp.readdir(runRoot)).length > 0) continue;
      if (!emptiedHere && now - (await lastActivityMs(runRoot, runRootEntry.name)) < maxAgeMs) continue;
      await fsp.rmdir(runRoot);
      removed.push(runRoot);
    } catch {
      /* leave it for the next sweep */
    }
  }
  return removed;
}

/**
 * Newest evidence of activity for `p`: its mtime, or the timestamp embedded in
 * a `.retained-<ts>[-n]` name when that is newer. Taking the max is the
 * conservative direction — a sweep never deletes something that looks recent
 * by either measure. An unstattable entry reports as "now" so it survives.
 */
async function lastActivityMs(p: string, name: string): Promise<number> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fsp.stat(p)).mtimeMs;
  } catch {
    return Date.now();
  }
  const stamped = /\.retained-(\d{10,})(?:-\d+)?$/.exec(name);
  return stamped ? Math.max(mtimeMs, Number(stamped[1])) : mtimeMs;
}

let sweepStarted = false;

/**
 * Kick off the GC sweep at most once per process, fire-and-forget. Called from
 * {@link createUnitWorktree} so the cost is paid by a run that is already
 * doing worktree work, and never awaited so dispatch does not wait on it.
 */
function sweepStaleWorktreesOnce(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  void sweepStaleWorktrees()
    .then((removed) => {
      if (removed.length === 0) return;
      const shown = removed.slice(0, 10).join(", ");
      const rest = removed.length > 10 ? ` (+${removed.length - 10} more)` : "";
      warn(
        `Workflow worktree GC: removed ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"} ` +
          `older than ${STALE_WORKTREE_MAX_AGE_MS / (24 * 60 * 60 * 1000)}d under ${worktreesRoot()}: ${shown}${rest}`,
      );
    })
    .catch(() => {
      // GC is best-effort observability; a failed sweep never affects a run.
    });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
