// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only git queries for `akm ui`: a bundle's branch, ahead/behind and last
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

const GIT_TIMEOUT_MS = 10_000;
/** `git log` output for a large accept can be big; cap what we buffer. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Paths listed per commit; `pathCount` still counts them all. */
const PATHS_PER_COMMIT = 50;

function git(repoDir: string, args: string[]): Promise<string | null> {
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
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
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
  branch: string | null;
  upstream: string | null;
  /** Commits not on the upstream; `null` without an upstream. */
  ahead: number | null;
  /** Commits only on the upstream (as of the last fetch); `null` without an upstream. */
  behind: number | null;
  /** Paths with uncommitted changes. */
  dirtyPaths: number;
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
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream?.trim()) {
    const counts = (await git(repoDir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]))?.trim().split(/\s+/);
    if (counts?.length === 2) {
      ahead = Number(counts[0]);
      behind = Number(counts[1]);
    }
  }
  const [sha, time, subject] = (last ?? "").trim().split("\x1f");
  return {
    branch: branch?.trim() || null,
    upstream: upstream?.trim() || null,
    ahead,
    behind,
    dirtyPaths: status ? status.split("\n").filter((line) => line.trim() !== "").length : 0,
    lastCommit: sha && time ? { sha, time, subject: subject ?? "" } : null,
  };
}

/** What made a commit, judged from its subject: the subjects akm itself writes, else `other`. */
export type ChangeOrigin = "improve-sync" | "accept" | "remember" | "sync" | "other";

export function classifyCommitOrigin(subject: string): ChangeOrigin {
  if (/^akm improve\b/i.test(subject)) return "improve-sync";
  if (/^akm (accept|proposal)\b/i.test(subject)) return "accept";
  if (/\bremember\b/i.test(subject)) return "remember";
  if (/^akm (save|sync)\b/i.test(subject)) return "sync";
  return "other";
}

export interface StashCommit extends GitCommitSummary {
  shortSha: string;
  author: string;
  origin: ChangeOrigin;
  paths: string[];
  pathCount: number;
}

/** The `limit` most recent commits of the repository at `repoDir`, newest first; `null` when it is not a git root. */
export async function readRecentCommits(repoDir: string, limit: number, file?: string): Promise<StashCommit[] | null> {
  if (!isGitRoot(repoDir)) return null;
  const out = await git(repoDir, [
    "log",
    "-n",
    String(limit),
    "--name-only",
    "--format=%x1e%H%x1f%cI%x1f%an%x1f%s",
    ...(file ? ["--", file] : []),
  ]);
  if (out === null) return [];
  const commits: StashCommit[] = [];
  for (const record of out.split("\x1e")) {
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
      origin: classifyCommitOrigin(subject),
      paths: paths.slice(0, PATHS_PER_COMMIT),
      pathCount: paths.length,
    });
  }
  return commits;
}

/** Caller supplies an indexed asset path inside this bundle and a commit ID it took from {@link readRecentCommits}. */
export async function readFileRevision(repoDir: string, file: string, sha: string) {
  const after = await git(repoDir, ["show", `${sha}:${file}`]);
  if (after === null) return null;
  const before = await git(repoDir, ["show", `${sha}^:${file}`]);
  const unified = await git(repoDir, ["show", "--no-ext-diff", "--no-textconv", "--format=", sha, "--", file]);
  return { before, after, unified: unified ?? "" };
}
