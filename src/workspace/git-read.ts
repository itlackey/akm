// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only git queries for the workspace: a bundle's branch, ahead/behind and last
 * commit, and the write-target stash's recent commits.
 *
 * Nothing here fetches, and nothing takes a lock: `GIT_OPTIONAL_LOCKS=0` keeps
 * `git status` from refreshing the index, and ahead/behind is measured against
 * the remote-tracking branch as the last `akm sync` left it. Calls are async so
 * a slow repository stalls only its own request, not the server.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathsSyncWouldCommit } from "../sources/providers/git-stash";

const GIT_TIMEOUT_MS = 10_000;
/** `git log` output for a large accept can be big; cap what we buffer. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Paths listed per commit; `pathCount` still counts them all. */
const PATHS_PER_COMMIT = 50;

/**
 * A failed command keeps why: the first line of git's message, "timed out" or "git not found". `quiet` is a failure
 * git gave no message for, which is how it answers a question with "no" (`symbolic-ref -q` on a detached HEAD).
 */
type GitResult = { ok: true; out: string } | { ok: false; error: string; quiet: boolean };

function git(repoDir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoDir, "-c", "core.quotepath=false", ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, out: stdout });
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return resolve({ ok: false, error: "git not found", quiet: false });
        if (error.killed) return resolve({ ok: false, error: "timed out", quiet: false });
        const line = stderr
          .split("\n")
          .find((text) => text.trim() !== "")
          ?.trim();
        resolve({ ok: false, error: line ?? `git exited with ${error.code}`, quiet: !line });
      },
    );
  });
}

/** Why a failed `git log` is not just an empty history: it is when HEAD resolves, or git cannot even say. */
async function logFailure(repoDir: string, failed: { error: string }): Promise<string | null> {
  const head = await git(repoDir, ["rev-parse", "--verify", "-q", "HEAD"]);
  return head.ok ? failed.error : head.quiet ? null : head.error;
}

/** Whether `dir` is the root of its own git repository (a bundle inside a larger repo is not reported as git-backed). */
export function isGitRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

export interface GitCommitSummary {
  sha: string;
  time: string;
  subject: string;
}

export interface BundleGitStatus {
  /** Why git could not be read (its message, "timed out" or "git not found"); the other fields are then not to be trusted. */
  error: string | null;
  branch: string | null;
  upstream: string | null;
  /** Commits not on the upstream; `null` without an upstream. */
  ahead: number | null;
  /** Commits only on the upstream (as of the last fetch); `null` without an upstream. */
  behind: number | null;
  /** Paths with uncommitted changes, as `git status` lists them (an untracked folder is one). */
  dirtyPaths: number;
  /** The files `akm sync` would commit now, from the function that selects them; `null` when git could not list the changes. */
  uncommitted: number | null;
  lastCommit: GitCommitSummary | null;
}

export async function readBundleGitStatus(repoDir: string): Promise<BundleGitStatus | null> {
  if (!isGitRoot(repoDir)) return null;
  const [branch, upstream, status, last] = await Promise.all([
    // symbolic-ref also names the branch of a repository with no commits yet; a detached HEAD has none.
    git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(repoDir, ["status", "--porcelain"]),
    git(repoDir, ["log", "-1", "--format=%H%x1f%cI%x1f%s"]),
  ]);
  let error: string | null = !status.ok ? status.error : !branch.ok && !branch.quiet ? branch.error : null;
  if (!last.ok) error ??= await logFailure(repoDir, last);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream.ok && upstream.out.trim()) {
    const counted = await git(repoDir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const counts = counted.ok ? counted.out.trim().split(/\s+/) : [];
    if (counts.length === 2) {
      ahead = Number(counts[0]);
      behind = Number(counts[1]);
    }
  }
  const [sha, time, subject] = (last.ok ? last.out : "").trim().split("\x1f");
  const syncing = pathsSyncWouldCommit(repoDir);
  return {
    error,
    branch: (branch.ok && branch.out.trim()) || null,
    upstream: (upstream.ok && upstream.out.trim()) || null,
    ahead,
    behind,
    dirtyPaths: status.ok ? status.out.split("\n").filter((line) => line.trim() !== "").length : 0,
    uncommitted: syncing.ok ? syncing.paths.length : null,
    lastCommit: sha && time ? { sha, time, subject: subject ?? "" } : null,
  };
}

export interface StashCommit extends GitCommitSummary {
  shortSha: string;
  author: string;
  paths: string[];
  pathCount: number;
}

/**
 * The `limit` most recent commits of the repository at `repoDir`, newest first; `null` when it is not a git root.
 * `error` says why git could not be read, and then `commits` is empty because nothing was read.
 */
export async function readRecentCommits(
  repoDir: string,
  limit: number,
  file?: string,
): Promise<{ commits: StashCommit[]; error: string | null } | null> {
  if (!isGitRoot(repoDir)) return null;
  const out = await git(repoDir, [
    "log",
    "-n",
    String(limit),
    "--name-only",
    "--format=%x1e%H%x1f%cI%x1f%an%x1f%s",
    ...(file ? ["--", file] : []),
  ]);
  if (!out.ok) return { commits: [], error: await logFailure(repoDir, out) };
  const commits: StashCommit[] = [];
  for (const record of out.out.split("\x1e")) {
    if (!record.trim()) continue;
    const [header = "", ...pathLines] = record.split("\n");
    const [sha = "", time = "", author = "", subject = ""] = header.split("\x1f");
    const paths = pathLines.map((line) => line.trim()).filter(Boolean);
    commits.push({
      sha,
      shortSha: sha.slice(0, 8),
      time,
      author,
      subject,
      paths: paths.slice(0, PATHS_PER_COMMIT),
      pathCount: paths.length,
    });
  }
  return { commits, error: null };
}

/** Caller supplies an indexed asset path inside this bundle and a commit ID it took from {@link readRecentCommits}. */
export async function readFileRevision(repoDir: string, file: string, sha: string) {
  const after = await git(repoDir, ["show", `${sha}:${file}`]);
  if (!after.ok) return null;
  const before = await git(repoDir, ["show", `${sha}^:${file}`]);
  const unified = await git(repoDir, ["show", "--no-ext-diff", "--no-textconv", "--format=", sha, "--", file]);
  return { before: before.ok ? before.out : null, after: after.out, unified: unified.ok ? unified.out : "" };
}
