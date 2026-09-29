// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Git worktree lifecycle for `isolation: worktree` units: each attempt of a
 * file-mutating agent/sdk unit gets a fresh detached worktree of the run's base
 * repository under `<tmp>/akm-worktrees/<runId>/<attemptId>`.
 *
 *   1. {@link assertGitWorkTree} — once per step, before dispatch.
 *   2. {@link createUnitWorktree} — `git worktree add --detach`; the path is
 *      journaled on the unit row and becomes the unit's cwd.
 *   3. {@link cleanupUnitWorktree} — a clean tree is removed, a dirty one kept.
 *      "Clean" ignores `.gitignore`d files (build outputs, `node_modules`),
 *      which the repo already declares disposable.
 *   4. {@link sweepStaleWorktrees} — at most once per process, removes trees
 *      and run roots older than a week.
 *
 * Every repo-mutating git call is async and serialized per base repository
 * ({@link withRepoWorktreeLock}), so parallel units never race on
 * `.git/worktrees`. Nothing here throws: results are objects the executor maps
 * onto its failure vocabulary (the fire-and-forget GC sweep reports via `warn`).
 */

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWithinAsync, safeRealpathAsync } from "../../core/common";
import { serializeByKey } from "../../core/concurrent";
import { runManagedSubprocess } from "../../core/subprocess";
import { warn } from "../../core/warn";

/** Timeout for each worktree git call (#891: a busy machine can push a healthy one past 30s). */
const GIT_TIMEOUT_MS = 120_000;

/** Directory under `os.tmpdir()` that owns every run's worktree roots. */
export const WORKTREES_DIR_NAME = "akm-worktrees";

/** Age after which an orphaned or retained worktree is swept: long enough to triage a failed run. */
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

/** One async git call: `cwd`/`args` in, a {@link GitResult} out. Never throws. */
type GitExecutor = (cwd: string, args: string[]) => Promise<GitResult>;

/**
 * Run one git command asynchronously via the real `git` binary; `ok` = exit
 * 0. Never throws (spawn errors and the timeout → ok: false).
 */
async function realGitExecutor(cwd: string, args: string[]): Promise<GitResult> {
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

let gitExecutor: GitExecutor = realGitExecutor;

/** Test seam: swap the git executor for repo-mutating calls (`undefined` restores the real one). */
export function setGitExecutorForTesting(executor: GitExecutor | undefined): void {
  gitExecutor = executor ?? realGitExecutor;
}

/**
 * Run one git command asynchronously; `ok` = exit 0. Never throws. Async so a
 * git lock wait parks a promise instead of blocking the event loop;
 * repo-mutating callers must hold {@link withRepoWorktreeLock}.
 */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  return gitExecutor(cwd, args);
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

/** Base repos already pruned in this process, per run id (dropped with the run's drained root). */
const prunedRuns = new Map<string, Set<string>>();

/**
 * Serialize `fn` against every other repo-mutating worktree operation on the
 * same base repository ({@link serializeByKey}). Keyed by the RESOLVED repo
 * path so two spellings of one repo (symlinked tmpdir, relative cwd) share a
 * chain. A failure rejects its own caller but never wedges the chain.
 */
function withRepoWorktreeLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  return serializeByKey(repoOperationTails, repoKey, fn);
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
  | {
      ok: false;
      error: string;
      /**
       * Same field on the failure path: when the leftover was moved aside and
       * the re-creation then failed, that copy is the ONLY one left of the
       * previous attempt's work, so the caller must still be told where it is.
       */
      preservedLeftover?: string;
    };

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
async function moveLeftoverAside(dest: string): Promise<string> {
  const base = `${dest}.retained-${Date.now()}`;
  let aside = base;
  for (let n = 1; await pathExists(aside); n++) aside = `${base}-${n}`;
  await fsp.rename(dest, aside);
  return aside;
}

async function pathExists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Create a fresh detached worktree at `<tmp>/akm-worktrees/<runId>/<attemptId>`.
 * A leftover at that path is removed when clean, otherwise moved aside to
 * `<dest>.retained-<ts>` (`preservedLeftover`). Probe, prune, and add form one
 * critical section under {@link withRepoWorktreeLock}.
 */
export async function createUnitWorktree(
  baseDir: string,
  runId: string,
  attemptId: string,
  commitOid?: string,
): Promise<WorktreeCreateResult> {
  // Opportunistic, at most once per process, never awaited — GC must never sit
  // on the dispatch path.
  sweepStaleWorktreesOnce();
  const repoKey = await safeRealpathAsync(baseDir);
  const dest = path.join(runWorktreeRoot(runId), sanitizeAttemptId(attemptId));
  return withRepoWorktreeLock(repoKey, async () => {
    let preservedLeftover: string | undefined;
    let leftoverHandled = false;
    try {
      if (await pathExists(dest)) {
        const status = await git(dest, ["status", "--porcelain"]);
        if (status.ok && status.stdout.trim() === "") {
          // Async on purpose: a recursive delete of a whole leftover checkout
          // inside this critical section would otherwise block the event loop
          // (every other in-flight unit, abort handling).
          await fsp.rm(dest, { recursive: true, force: true });
        } else {
          preservedLeftover = await moveLeftoverAside(dest);
        }
        leftoverHandled = true;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `could not prepare worktree directory ${dest}: ${message(err)}`,
        ...(preservedLeftover !== undefined ? { preservedLeftover } : {}),
      };
    }
    // Prune (never touches a live worktree) after a leftover was removed, and
    // on the first worktree of this (repo, run) to reap orphaned registrations.
    const prunedRepos = prunedRuns.get(runId);
    if (leftoverHandled || !prunedRepos?.has(repoKey)) {
      if (prunedRepos) prunedRepos.add(repoKey);
      else prunedRuns.set(runId, new Set([repoKey]));
      await git(baseDir, ["worktree", "prune"]);
    }
    const added = await git(baseDir, ["worktree", "add", "--detach", dest, ...(commitOid ? [commitOid] : [])]);
    if (!added.ok) {
      return {
        ok: false,
        error: `could not create isolation worktree at ${dest}: ${added.error}`,
        ...(preservedLeftover !== undefined ? { preservedLeftover } : {}),
      };
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
 * Post-unit cleanup: remove a clean worktree; retain (dirty: true) one with
 * uncommitted work or whose state could not be verified. `.gitignore`d files do
 * not count as work.
 */
export async function cleanupUnitWorktree(baseDir: string, worktreePath: string): Promise<WorktreeCleanupResult> {
  // The removal (without --force) is itself the cleanliness check: one git process per clean unit.
  const removed = await withRepoWorktreeLock(await safeRealpathAsync(baseDir), () =>
    git(baseDir, ["worktree", "remove", worktreePath]),
  );
  if (removed.ok) {
    await removeRunRootIfEmpty(worktreePath);
    return { removed: true, dirty: false };
  }
  // It refused, so the tree stays on disk. Ask the probe WHY it refused rather
  // than parsing git's message, whose wording varies with version and locale —
  // and which the caller's warn text has never been written against.
  const status = await git(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return { removed: false, dirty: false, error: status.error };
  }
  if (status.stdout.trim() !== "") {
    return { removed: false, dirty: true };
  }
  return { removed: false, dirty: false, error: removed.error };
}

// ── Garbage collection ──────────────────────────────────────────────────────

/** Drop the run-scoped root once empty (`rmdir` keeps any retained tree). */
async function removeRunRootIfEmpty(worktreePath: string): Promise<void> {
  const root = worktreesRoot();
  const runRoot = path.dirname(path.resolve(worktreePath));
  if (!(await isWithinAsync(runRoot, root))) return;
  if ((await safeRealpathAsync(path.dirname(runRoot))) !== (await safeRealpathAsync(root))) return;
  try {
    await fsp.rmdir(runRoot);
  } catch {
    // ENOTEMPTY (retained work) / ENOENT (already gone) — both fine.
    return;
  }
  // The run's worktrees are fully drained — drop its prune bookkeeping so
  // `prunedRuns` never outgrows the live runs. (A later worktree of the same
  // run simply prunes once more; the guard is an optimization, not a
  // correctness gate.)
  prunedRuns.delete(path.basename(runRoot));
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
 * Age-based GC of the worktrees root: removes `<root>/<runId>/<entry>`
 * directories older than `maxAgeMs`, and empty stale run roots. Descends two
 * levels only, never follows a symlink, and re-checks containment before each
 * removal. Returns the paths removed; never throws.
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
    if (!(await isWithinAsync(runRoot, root))) continue;
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
      if (!(await isWithinAsync(candidate, root))) continue;
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
