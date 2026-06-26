// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import { resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { getSources, loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { sanitizeCommitMessage } from "../../core/write-source";
import { runGit } from "./git-install";
import { getCachePaths, parseGitRepoUrl } from "./git-provider";

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

export interface SaveGitStashResult {
  committed: boolean;
  pushed: boolean;
  skipped: boolean;
  reason?: string;
  output: string;
}

/**
 * Resolve the writable-override flag for an end-of-run / `akm sync` commit on
 * the primary stash. Returns `true` when the root config explicitly marks the
 * primary stash writable, otherwise `undefined` (leave the per-stash default
 * untouched). Extracted so `akm sync`, `akm improve`'s end-of-run sync, and the
 * CLI body all derive this identically instead of re-copying the expression.
 */
export function resolveWritableOverride(config: { writable?: boolean }): true | undefined {
  return config.writable === true ? true : undefined;
}

/**
 * Commit (and optionally push) local changes in a git-backed stash.
 *
 * Behaviour:
 *   - Not a git repo → skipped (no-op)
 *   - Git repo, no remote → commit only
 *   - Git repo, has remote, but stash is not writable → commit only
 *   - Git repo, has remote, stash is writable → commit + push
 *
 * When `name` is omitted the primary stash directory is used.
 * When `message` is omitted a timestamp is used.
 *
 * `options.repoDir` overrides the primary-stash directory the commit targets
 * (only honoured when `name` is omitted). Callers that already resolved the
 * primary stash dir (e.g. `akm improve`'s end-of-run sync, whose pre-commit
 * gate validates that exact directory) pass it here so the gate and the commit
 * operate on the SAME directory instead of independently calling
 * `resolveStashDir({ readOnly: true })`. When absent, behaviour is unchanged.
 */
export function saveGitStash(
  name?: string,
  message?: string,
  writableOverride?: boolean,
  options?: { push?: boolean; repoDir?: string; paths?: string[] },
): SaveGitStashResult {
  // `push: false` (from `akm sync --no-push`) commits but never pushes, even
  // when the stash is writable with a remote configured.
  const allowPush = options?.push !== false;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  // Sanitize the user-supplied message: strip CR/LF/NUL, collapse whitespace,
  // clamp length. An attacker can otherwise pass `--message "subject\n\n\
  // Co-Authored-By: someone-else"` and forge trailers in the commit log.
  // Empty result falls back to the timestamped default.
  const sanitized = message ? sanitizeCommitMessage(message) : "";
  const commitMessage = sanitized || `akm save ${timestamp}`;

  let repoDir: string;
  let writable = false;

  if (name) {
    const config = loadConfig();
    const stash = findGitStashByTarget(getSources(config), name);
    if (!stash) throw new UsageError(`No git stash found with name "${name}"`);
    if (stash.type !== "git") {
      throw new UsageError(`Stash "${name}" is not a git stash (type: ${stash.type})`);
    }
    if (!stash.url) throw new UsageError(`Stash "${name}" has no URL configured`);
    const repo = parseGitRepoUrl(stash.url);
    repoDir = getCachePaths(repo.canonicalUrl).repoDir;
    writable = stash.writable === true;
  } else {
    // Honour an explicit primary-stash dir override (keeps the improve gate and
    // the commit on the same directory); otherwise resolve the default.
    repoDir = options?.repoDir ?? resolveStashDir({ readOnly: true });
    // Allow caller to override writable for the primary stash (e.g. from root config.writable)
    if (writableOverride !== undefined) {
      writable = writableOverride;
    }
  }

  // No-op: not a git repo
  if (!isGitBackedStash(repoDir)) {
    return { committed: false, pushed: false, skipped: true, reason: "not a git repository", output: "" };
  }

  // Nothing to commit?
  const statusResult = runGit(["-C", repoDir, "status", "--porcelain"]);
  if (statusResult.error || statusResult.status !== 0) {
    throw new Error(
      `git status failed: ${statusResult.error?.message || statusResult.stderr?.trim() || "unknown error"}`,
    );
  }
  if (!statusResult.stdout.trim()) {
    return { committed: false, pushed: false, skipped: false, output: "nothing to commit, working tree clean" };
  }

  // Scoped staging (#476 + the auto-sync incident): NEVER refuse akm's commit
  // because unrelated non-akm files exist in the working tree. When the stash
  // dir is shared with a non-akm project (stash root == project repo root), a
  // blunt `git add -A` would sweep the user's unrelated WIP into the stash's
  // remote. We avoid that by SCOPING what we stage, not by refusing the commit.
  //
  // Precedence:
  //   1. Explicit modified-file list (`options.paths`) — stage exactly those.
  //   2. Managed pathspecs (TYPE_DIRS values + `.akm`) that exist on disk —
  //      stages everything akm owns and, by construction, never stages non-akm
  //      WIP. This preserves the #476 protection WITHOUT refusing.
  //   3. Last-resort `git add -A` — ONLY when neither an explicit list nor any
  //      managed pathspec can be resolved. This is the maintainer-approved
  //      "or all files if we cannot determine the exact file list" fallback and
  //      is the one (rare) path that could include unrelated non-akm files.
  if (!stageScopedChanges(repoDir, options?.paths)) {
    throw new Error(`git add failed while staging akm changes in ${repoDir}`);
  }

  // Nothing actually staged → don't create an empty commit. This happens when
  // only non-akm files were dirty (precedence 2 staged nothing).
  const stagedResult = runGit(["-C", repoDir, "diff", "--cached", "--quiet"]);
  if (stagedResult.status === 0) {
    return { committed: false, pushed: false, skipped: false, output: "nothing to commit" };
  }

  // Commit — supply fallback identity so fresh environments without
  // user.name/user.email configured can always commit to the default stash.
  const commitResult = runGit([
    "-C",
    repoDir,
    "-c",
    "user.name=akm",
    "-c",
    "user.email=akm@local",
    "commit",
    "-m",
    commitMessage,
  ]);
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr?.trim() || "unknown error"}`);
  }

  // Push only when there is a remote AND the stash is marked writable
  const remoteResult = runGit(["-C", repoDir, "remote"]);
  if (remoteResult.status !== 0) {
    throw new Error(`git remote failed: ${remoteResult.stderr?.trim() || "unknown error"}`);
  }
  const hasRemote = remoteResult.stdout.trim().length > 0;

  if (!hasRemote || !writable || !allowPush) {
    return { committed: true, pushed: false, skipped: false, output: commitResult.stdout.trim() };
  }

  const pushResult = runGit(["-C", repoDir, "push"], { timeout: 120_000 });
  if (pushResult.status !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr?.trim() || "unknown error"}`);
  }

  return {
    committed: true,
    pushed: true,
    skipped: false,
    output: (commitResult.stdout + pushResult.stdout).trim() || "changes committed and pushed",
  };
}

/**
 * Stage akm's changes in `repoDir` using the scoped-staging precedence
 * documented at the call site (#476). Returns `false` only when a `git add`
 * subprocess fails; returns `true` otherwise (including when nothing matched —
 * the caller then detects "nothing staged" via `git diff --cached --quiet`).
 *
 * @param paths Optional explicit repo-relative paths akm wrote this run. When
 *   provided and non-empty, exactly those are staged (chunked to stay under
 *   argv length limits). Otherwise we fall back to the managed pathspecs, and
 *   finally to `git add -A` only if no managed pathspec exists on disk.
 */
function stageScopedChanges(repoDir: string, paths?: string[]): boolean {
  // Precedence 1: explicit modified-file list.
  const explicit = (paths ?? []).filter((p) => typeof p === "string" && p.length > 0);
  if (explicit.length > 0) {
    return addPathspecsChunked(repoDir, explicit);
  }

  // Precedence 2: managed pathspecs that exist on disk (TYPE_DIRS + `.akm`).
  const managed = [...Object.values(TYPE_DIRS), ".akm"].filter((dir) => fs.existsSync(path.join(repoDir, dir)));
  if (managed.length > 0) {
    return addPathspecsChunked(repoDir, managed);
  }

  // Precedence 3 (last resort): nothing akm-managed resolved on disk. Stage
  // everything. This is the ONLY branch that can include unrelated non-akm
  // files — it is the explicit, maintainer-approved "or all files if we cannot
  // determine the exact file list" fallback and should be rare/never in
  // practice (a git-backed stash always has at least one managed subtree once
  // akm has written to it).
  const addAll = runGit(["-C", repoDir, "add", "-A"]);
  return addAll.status === 0;
}

/**
 * Run `git add -- <pathspec>...` in chunks so a very large path list never
 * exceeds the OS argv-length limit. Each chunk must succeed.
 */
function addPathspecsChunked(repoDir: string, pathspecs: string[]): boolean {
  const CHUNK = 500;
  for (let i = 0; i < pathspecs.length; i += CHUNK) {
    const chunk = pathspecs.slice(i, i + CHUNK);
    const result = runGit(["-C", repoDir, "add", "--", ...chunk]);
    if (result.status !== 0) return false;
  }
  return true;
}

function findGitStashByTarget(stashes: SourceConfigEntry[], target: string): SourceConfigEntry | undefined {
  return stashes.find((stash) => matchesGitStashTarget(stash, target));
}

function matchesGitStashTarget(stash: SourceConfigEntry, target: string): boolean {
  if (stash.type !== "git") return false;
  if (stash.name === target || stash.url === target) return true;
  if (!stash.url) return false;

  try {
    const repo = parseGitRepoUrl(stash.url);
    if (repo.canonicalUrl === target) return true;
    return buildGithubTargetAliases(repo.canonicalUrl).has(target);
  } catch {
    return false;
  }
}

function buildGithubTargetAliases(canonicalUrl: string): Set<string> {
  try {
    const parsed = new URL(canonicalUrl);
    if (parsed.hostname !== "github.com") return new Set();

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return new Set();

    const owner = segments[0];
    const repo = segments[1];
    const aliases = new Set<string>([`${owner}/${repo}`, `github:${owner}/${repo}`]);

    if (segments[2] === "tree" && segments.length >= 4) {
      const ref = segments.slice(3).join("/");
      aliases.add(`${owner}/${repo}#${ref}`);
      aliases.add(`github:${owner}/${repo}#${ref}`);
    }

    return aliases;
  } catch {
    return new Set();
  }
}
