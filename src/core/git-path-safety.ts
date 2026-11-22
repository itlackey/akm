// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only questions about a directory's git state: is it git-backed, and
 * which of its paths are tracked, clean and verifiable. A leaf module (it
 * imports no provider), so the adapter layer can use it.
 */

import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git-run";

/**
 * Recognize a stash directory as git-backed by the presence of a `.git` entry.
 *
 * Recognition is deliberately by `.git` presence — NOT by a configured remote.
 * `akm init` git-inits the primary stash (see init.ts `ensureGitRepo`), so a
 * freshly-initialized local stash with no remote is still git-backed. This is
 * the single source of truth used both by `saveGitStash` (below) and by the
 * end-of-run improve auto-sync gate.
 */
export function isGitBackedStash(stashDir: string): boolean {
  return fs.existsSync(path.join(stashDir, ".git"));
}

/** {@link listGitChangedPaths}/{@link tryListGitTrackedPaths}'s result: the paths, and whether the underlying git call itself succeeded. */
export interface GitPathQueryResult {
  paths: string[];
  /** `false` means `paths` is `[]` because the git call errored or exited nonzero — NOT because nothing matched. A caller that treats an empty result as "safe" (nothing dirty, nothing tracked) must check this first. */
  ok: boolean;
}

/**
 * Return repo-relative dirty/staged paths without changing the index, and
 * whether `git status` itself succeeded. A broken submodule, a detached
 * `GIT_DIR`, or git simply not being on `PATH` all exit nonzero here — a
 * caller that would otherwise read the empty `paths` as "nothing is dirty"
 * must check `ok` first (see {@link listGitChangedPaths}'s callers that
 * cannot, and the archive purge sweep, which can and does).
 */
export function tryListGitChangedPaths(repoDir: string): GitPathQueryResult {
  const result = runGit(["-C", repoDir, "status", "--porcelain", "-z", "--untracked-files=all"]);
  if (result.status !== 0) return { paths: [], ok: false };
  const records = result.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const previousPath = records[++i];
      if (previousPath) paths.push(previousPath);
    }
  }
  return { paths, ok: true };
}

/** Return repo-relative dirty/staged paths without changing the index. `[]` on any git failure — see {@link tryListGitChangedPaths} for a caller that must tell that apart from "nothing is dirty". */
export function listGitChangedPaths(repoDir: string): string[] {
  return tryListGitChangedPaths(repoDir).paths;
}

/**
 * Return repo-relative paths git tracks at HEAD/index under `pathspec` (or
 * the whole repo when omitted), and whether `git ls-files` itself
 * succeeded — see {@link tryListGitChangedPaths}, the same contract.
 */
export function tryListGitTrackedPaths(repoDir: string, pathspec?: string): GitPathQueryResult {
  const args = ["-C", repoDir, "ls-files", "-z"];
  if (pathspec) args.push("--", pathspec);
  const result = runGit(args);
  if (result.status !== 0) return { paths: [], ok: false };
  return { paths: result.stdout.split("\0").filter((record) => record.length > 0), ok: true };
}

/**
 * Return repo-relative paths under `pathspec` that `git ls-files -v` tags as
 * NOT verifiable against the worktree: `assume-unchanged` (a lowercase tag —
 * `ls-files -v` lowercases a file's normal tag letter when that bit is set)
 * or `skip-worktree` (the literal `S`). `git status` silently omits an edit
 * to either kind of file — the index is telling git not to compare it — so a
 * caller that trusts {@link tryListGitChangedPaths} alone would read a
 * genuinely modified file as clean.
 */
export function tryListGitUnverifiablePaths(repoDir: string, pathspec?: string): GitPathQueryResult {
  const args = ["-C", repoDir, "ls-files", "-v", "-z"];
  if (pathspec) args.push("--", pathspec);
  const result = runGit(args);
  if (result.status !== 0) return { paths: [], ok: false };
  const paths: string[] = [];
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const tag = record.slice(0, 1);
    if (tag === "S" || (tag >= "a" && tag <= "z")) paths.push(record.slice(2));
  }
  return { paths, ok: true };
}

/** {@link checkGitPathSafety}'s result. */
export interface GitPathSafetyResult {
  /** `false` when any of the three underlying git queries failed — a caller must treat this as "nothing is provably safe", never as an empty-but-trustworthy result. */
  ok: boolean;
  /** `repoRelativePath` is tracked at HEAD/index, not dirty/staged/untracked, and not assume-unchanged/skip-worktree. Always `false` when `ok` is `false`. */
  isSafe(repoRelativePath: string): boolean;
}

/**
 * The three-part git cleanliness check shared by the archive purge sweep
 * (`purgeGracedArchive` in `commands/improve/memory/memory-improve.ts`) and
 * the `memory-cleanup-archive` health advisory (`collectArchiveUsageAdvisory`
 * in `commands/health/archive-usage.ts`): a path is safe to treat as
 * committed only if it is tracked ({@link tryListGitTrackedPaths}), not dirty
 * ({@link tryListGitChangedPaths}), and not assume-unchanged/skip-worktree
 * ({@link tryListGitUnverifiablePaths} — those hide their own edits from
 * `git status`, so an unverifiable file is never trusted as clean either).
 *
 * Each of the three git calls can fail independently (a broken submodule, or
 * git missing from `PATH`); `ok` is `false` if any one does, and `isSafe`
 * then returns `false` for every path rather than guessing — callers that
 * need to short-circuit before doing other work still check `ok` themselves.
 */
export function checkGitPathSafety(repoDir: string, pathspec?: string): GitPathSafetyResult {
  const dirtyQuery = tryListGitChangedPaths(repoDir);
  const trackedQuery = tryListGitTrackedPaths(repoDir, pathspec);
  const unverifiableQuery = tryListGitUnverifiablePaths(repoDir, pathspec);
  const ok = dirtyQuery.ok && trackedQuery.ok && unverifiableQuery.ok;
  const dirty = new Set(dirtyQuery.paths);
  const tracked = new Set(trackedQuery.paths);
  const unverifiable = new Set(unverifiableQuery.paths);
  return {
    ok,
    isSafe: (repoRelativePath) =>
      ok && tracked.has(repoRelativePath) && !dirty.has(repoRelativePath) && !unverifiable.has(repoRelativePath),
  };
}
