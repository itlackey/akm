// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../core/adapter/adapters/akm-adapter";
import { stashDirNames } from "../../core/asset/asset-placement";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig, SourceConfigEntry } from "../../core/config/config";
import { getSources, loadConfig, resolveConfiguredSources } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { sanitizeCommitMessage } from "../../core/git-message";
import { lockContentRootFor } from "../../integrations/lockfile";
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

/** Return repo-relative dirty/staged paths without changing the index. */
export function listGitChangedPaths(repoDir: string): string[] {
  const result = runGit(["-C", repoDir, "status", "--porcelain", "-z", "--untracked-files=all"]);
  if (result.status !== 0) return [];
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
  return paths;
}

export interface SaveGitStashResult {
  committed: boolean;
  pushed: boolean;
  skipped: boolean;
  reason?: string;
  output: string;
  /** Exact commit created by this invocation. */
  commit?: string;
}

export class GitStashPushError extends Error {
  readonly commit: string;

  constructor(message: string, commit: string) {
    super(message);
    this.name = "GitStashPushError";
    this.commit = commit;
  }
}

export interface GitExactPathState {
  oid: string;
  mode: "100644" | "100755" | "120000";
}

export type GitExactPathSnapshots = Record<string, GitExactPathState | null>;

export interface SaveGitStashOptions {
  push?: boolean;
  repoDir?: string;
  paths?: string[];
  transactionId?: string;
  /** Base commit the caller already bound its durable transaction to. */
  expectedBaseHead?: string | null;
  /** Exact post-mutation blobs the commit must contain. */
  expectedSnapshots?: GitExactPathSnapshots;
}

const GIT_PUSH_TIMEOUT_MS = 120_000;
const ZERO_OID = "0000000000000000000000000000000000000000";

// ── Test seam: exact-path commit race window ─────────────────────────────────

/**
 * Named points inside {@link createExactPathCommit}'s publication sequence.
 * TEST-ONLY.
 *
 *  - `before-update-ref` — the commit object exists, every pre-check has
 *    passed, and the branch ref is about to be compare-and-swapped from
 *    `baseHead` to it. A concurrent process that commits at exactly this
 *    instant is the race the `update-ref <ref> <new> <old>` CAS defends
 *    against, and it is the ONLY guard on the `akm sync` path (`akm sync`
 *    passes no `expectedBaseHead`, so the earlier preflight check is inert
 *    there).
 */
export type GitExactCommitPoint = "before-update-ref";

let exactCommitHookForTests: ((point: GitExactCommitPoint) => void) | undefined;

/**
 * TEST-ONLY. Interleave work into the exact-path commit sequence; `undefined`
 * restores. Exists because the CAS window is a few microseconds wide between
 * two synchronous `git` invocations — a wall-clock race would be
 * non-deterministic, and every earlier pre-check would swallow a commit that
 * landed before the window opened. Inert in production.
 */
export function _setGitExactCommitHookForTests(hook?: (point: GitExactCommitPoint) => void): void {
  exactCommitHookForTests = hook;
}

/** Fire a named exact-path-commit race point (no-op outside tests). */
function gitExactCommitHook(point: GitExactCommitPoint): void {
  exactCommitHookForTests?.(point);
}

/**
 * Resolve the writable flag for an end-of-run / `akm sync` commit from the
 * configured default bundle.
 */
export function resolveWritableOverride(config: AkmConfig): true | undefined {
  const source = resolveConfiguredSources(config).find((entry) => entry.name === config.defaultBundle);
  if (!source) return undefined;
  return (source.writable ?? source.type === "filesystem") ? true : undefined;
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
 * `resolveStashDir()`. When absent, behaviour is unchanged.
 */
export function saveGitStash(
  name?: string,
  message?: string,
  writableOverride?: boolean,
  options?: SaveGitStashOptions,
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
  const transactionId = options?.transactionId;
  if (transactionId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(transactionId)) {
    throw new Error("Invalid Git transaction identifier.");
  }

  let repoDir: string;
  let writable = false;
  let managedContentRoot: string | undefined;

  if (name) {
    const config = loadConfig();
    const stash = findSyncStashByTarget(getSources(config), name);
    // NotFoundError (exit 1), not UsageError (exit 2): the argument is
    // well-formed, the bundle just isn't configured.
    if (!stash) throw new NotFoundError(`No git-backed bundle found with name "${name}"`, "SOURCE_NOT_FOUND");
    if (stash.enabled === false) {
      throw new UsageError(`Bundle "${name}" is disabled and cannot be synced.`, "INVALID_FLAG_VALUE");
    }
    if (stash.type === "filesystem") {
      if (!stash.path) throw new UsageError(`Filesystem bundle "${name}" has no path configured.`);
      const contentRoot = path.resolve(stash.path);
      const topLevel = runGit(["-C", contentRoot, "rev-parse", "--show-toplevel"]);
      if (topLevel.status !== 0 || !topLevel.stdout.trim()) {
        throw new UsageError(`Filesystem bundle "${name}" is not a Git working tree at ${contentRoot}.`);
      }
      repoDir = path.resolve(topLevel.stdout.trim());
      managedContentRoot = contentRoot;
      writable = stash.writable !== false;
    } else {
      const lockedRoot = lockContentRootFor(stash.name, stash.type);
      if (lockedRoot) {
        const topLevel = runGit(["-C", lockedRoot, "rev-parse", "--show-toplevel"]);
        if (topLevel.status !== 0 || !topLevel.stdout.trim()) {
          throw new UsageError(`Managed Git stash "${name}" is not a checkout at ${lockedRoot}`);
        }
        repoDir = path.resolve(topLevel.stdout.trim());
        managedContentRoot = path.resolve(lockedRoot);
      } else {
        if (!stash.url) throw new UsageError(`Stash "${name}" has no URL configured`);
        const repo = parseGitRepoUrl(stash.url);
        repoDir = getCachePaths(repo.canonicalUrl).repoDir;
      }
      writable = stash.writable === true;
    }
  } else {
    // Honour an explicit primary-stash dir override (keeps the improve gate and
    // the commit on the same directory); otherwise resolve the default.
    repoDir = options?.repoDir ?? resolveStashDir();
    // Allow the caller to pass the configured default bundle's writability.
    if (writableOverride !== undefined) {
      writable = writableOverride;
    }
  }

  // No-op: not a git repo
  if (!isGitBackedStash(repoDir)) {
    return { committed: false, pushed: false, skipped: true, reason: "not a git repository", output: "" };
  }

  const statusResult = runGit(["-C", repoDir, "status", "--porcelain"]);
  if (statusResult.error || statusResult.status !== 0) {
    throw new Error(
      `git status failed: ${statusResult.error?.message || statusResult.stderr?.trim() || "unknown error"}`,
    );
  }
  if (!statusResult.stdout.trim() && options?.paths === undefined) {
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
  //   2. A lock-backed content root, or managed adapter pathspecs for an
  //      ordinary stash. Both stay below AKM's resolved content boundary.
  //   3. No resolvable managed path — no commit. Broad staging is never safe
  //      because it can absorb unrelated work already present in the index.
  const managedRelativeRoot = managedContentRoot
    ? path.relative(repoDir, managedContentRoot).replaceAll(path.sep, "/")
    : "";
  const changedPaths = listGitChangedPaths(repoDir);
  const requestedPaths = normalizeExactPaths(
    repoDir,
    options?.paths ??
      (managedRelativeRoot && managedRelativeRoot !== ".." && !managedRelativeRoot.startsWith("../")
        ? changedPaths.filter(
            (changedPath) => changedPath === managedRelativeRoot || changedPath.startsWith(`${managedRelativeRoot}/`),
          )
        : managedFallbackPaths(repoDir, changedPaths)),
  );
  if (requestedPaths.length === 0) {
    return { committed: false, pushed: false, skipped: false, output: "nothing to commit" };
  }
  assertNoIgnoredExactPaths(repoDir, requestedPaths);

  const baseHead = readOptionalHead(repoDir);
  if (options?.expectedBaseHead !== undefined && (baseHead ?? null) !== options.expectedBaseHead) {
    throw new Error(`Git target advanced before its exact-path commit could be created.`);
  }

  const remoteResult = runGit(["-C", repoDir, "remote"]);
  if (remoteResult.status !== 0) {
    throw new Error(`git remote failed: ${remoteResult.stderr?.trim() || "unknown error"}`);
  }
  const hasRemote = remoteResult.stdout.trim().length > 0;
  const pushTarget = hasRemote && writable && allowPush ? readActualUpstream(repoDir, baseHead) : undefined;
  const exactCommit = createExactPathCommit(repoDir, {
    baseHead,
    commitMessage,
    paths: requestedPaths,
    transactionId,
    expectedSnapshots: options?.expectedSnapshots,
  });
  if (!exactCommit) {
    return { committed: false, pushed: false, skipped: false, output: "nothing to commit" };
  }

  if (!pushTarget) {
    return {
      committed: true,
      pushed: false,
      skipped: false,
      output: `commit ${exactCommit}`,
      commit: exactCommit,
    };
  }

  const pushResult = runGit(
    [
      "-C",
      repoDir,
      "push",
      `--force-with-lease=${pushTarget.mergeRef}:${pushTarget.upstreamHead}`,
      pushTarget.remote,
      `${exactCommit}:${pushTarget.mergeRef}`,
    ],
    { timeout: GIT_PUSH_TIMEOUT_MS },
  );
  if (pushResult.status !== 0) {
    throw new GitStashPushError(`git push failed: ${pushResult.stderr?.trim() || "unknown error"}`, exactCommit);
  }

  return {
    committed: true,
    pushed: true,
    skipped: false,
    output: pushResult.stdout.trim() || "changes committed and pushed",
    commit: exactCommit,
  };
}

function managedFallbackPaths(repoDir: string, changedPaths: string[]): string[] {
  const ownedDirs =
    akmAdapter.directoryList?.({ id: "akm", adapter: "akm", root: repoDir, writable: false }) ?? stashDirNames();
  const prefixes = [...ownedDirs, ".akm"];
  return changedPaths.filter((changedPath) =>
    prefixes.some((prefix) => changedPath === prefix || changedPath.startsWith(`${prefix}/`)),
  );
}

function normalizeExactPaths(repoDir: string, paths: string[]): string[] {
  const normalized = [...new Set(paths.map((value) => value.replaceAll(path.sep, "/")))];
  for (const filePath of normalized) {
    const absolute = path.resolve(repoDir, filePath);
    const relative = path.relative(repoDir, absolute).replaceAll(path.sep, "/");
    if (
      !filePath ||
      filePath.includes("\0") ||
      path.isAbsolute(filePath) ||
      relative !== filePath ||
      relative === ".." ||
      relative.startsWith("../")
    ) {
      throw new Error(`Unsafe exact Git path: ${filePath || "<empty>"}`);
    }
  }
  return normalized;
}

function runExactPathChunks(
  repoDir: string,
  command: string[],
  paths: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof runGit>[] {
  const CHUNK = 500;
  const results: ReturnType<typeof runGit>[] = [];
  for (let i = 0; i < paths.length; i += CHUNK) {
    results.push(
      runGit(["--literal-pathspecs", "-C", repoDir, ...command, "--", ...paths.slice(i, i + CHUNK)], {
        env: options.env,
      }),
    );
  }
  return results;
}

export function listIgnoredExactPaths(repoDir: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const input = `${paths.join("\0")}\0`;
  const result = runGit(["-C", repoDir, "check-ignore", "-z", "--stdin"], { input });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`git check-ignore failed: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function assertNoIgnoredExactPaths(repoDir: string, paths: string[]): void {
  const ignored = listIgnoredExactPaths(repoDir, normalizeExactPaths(repoDir, paths));
  if (ignored.length > 0) {
    throw new UsageError(
      `Exact Git publication path is ignored: ${ignored[0]}. Update .gitignore or choose a tracked destination before writing.`,
    );
  }
}

/** Reject exact staged/unstaged paths before an AKM filesystem mutation. */
export function assertGitExactPathsClean(repoDir: string, paths: string[]): void {
  const normalized = normalizeExactPaths(repoDir, paths);
  assertNoIgnoredExactPaths(repoDir, normalized);
  for (const result of runExactPathChunks(
    repoDir,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    normalized,
  )) {
    if (result.status !== 0) {
      throw new Error(`git status failed: ${result.stderr.trim() || "unknown error"}`);
    }
    if (result.stdout.length > 0) {
      const record = result.stdout.split("\0").find(Boolean) ?? "";
      throw new UsageError(
        `Exact Git operation path has staged or unstaged work: ${record.slice(3)}. Commit, stash, or discard that path before retrying.`,
      );
    }
  }
}

function readOptionalHead(repoDir: string): string | undefined {
  const result = runGit(["-C", repoDir, "rev-parse", "--verify", "HEAD"]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function readBranchRef(repoDir: string): string {
  const result = runGit(["-C", repoDir, "symbolic-ref", "--quiet", "HEAD"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new UsageError(`Writable Git target at ${repoDir} is detached from a branch.`);
  }
  return result.stdout.trim();
}

function readActualUpstream(
  repoDir: string,
  baseHead: string | undefined,
): { remote: string; mergeRef: string; upstreamHead: string } {
  if (!baseHead) throw new UsageError(`Writable Git target at ${repoDir} has no commit to publish.`);
  const branchRef = readBranchRef(repoDir);
  const branch = branchRef.replace(/^refs\/heads\//, "");
  const remote = runGit(["-C", repoDir, "config", "--get", `branch.${branch}.remote`]);
  const merge = runGit(["-C", repoDir, "config", "--get", `branch.${branch}.merge`]);
  const upstream = runGit(["-C", repoDir, "rev-parse", "--verify", "@{u}"]);
  if (remote.status !== 0 || merge.status !== 0 || upstream.status !== 0) {
    throw new UsageError(`Writable Git target at ${repoDir} has no configured upstream branch.`);
  }
  const upstreamHead = upstream.stdout.trim();
  if (!upstreamHead || upstreamHead !== baseHead) {
    throw new UsageError(`Writable Git target at ${repoDir} is not synchronized with its actual upstream.`);
  }
  return { remote: remote.stdout.trim(), mergeRef: merge.stdout.trim(), upstreamHead };
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
}

function readIndexEntries(repoDir: string, paths: string[]): Map<string, IndexEntry[]> {
  const entries = new Map(paths.map((filePath) => [filePath, [] as IndexEntry[]]));
  for (const result of runExactPathChunks(repoDir, ["ls-files", "--stage", "-z"], paths)) {
    if (result.status !== 0) throw new Error(`Cannot inspect Git index: ${result.stderr.trim() || "unknown error"}`);
    for (const record of result.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const match = record.slice(0, tab).match(/^(\d+) ([0-9a-f]+) (\d+)$/);
      if (tab < 0 || !match) throw new Error(`Cannot parse Git index entry.`);
      const filePath = record.slice(tab + 1);
      entries.get(filePath)?.push({ mode: match[1] as string, oid: match[2] as string, stage: Number(match[3]) });
    }
  }
  return entries;
}

function readTreeStates(
  repoDir: string,
  treeish: string | undefined,
  paths: string[],
): Map<string, GitExactPathState | null> {
  const states = new Map<string, GitExactPathState | null>(paths.map((filePath) => [filePath, null]));
  if (!treeish) return states;
  for (const result of runExactPathChunks(repoDir, ["ls-tree", "-z", treeish], paths)) {
    if (result.status !== 0) throw new Error(`Cannot inspect Git tree: ${result.stderr.trim() || "unknown error"}`);
    for (const record of result.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const match = record.slice(0, tab).match(/^(\d+) blob ([0-9a-f]+)$/);
      if (tab < 0 || !match) throw new Error(`Exact Git path is not a blob.`);
      const mode = match[1];
      if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
        throw new Error(`Unsupported Git mode ${mode}.`);
      }
      states.set(record.slice(tab + 1), { mode, oid: match[2] as string });
    }
  }
  return states;
}

function assertIndexMatchesBase(
  paths: string[],
  indexEntries: Map<string, IndexEntry[]>,
  baseStates: Map<string, GitExactPathState | null>,
): void {
  if (indexMatchesTree(paths, indexEntries, baseStates)) return;
  const dirtyPath = paths.find((filePath) => {
    const entries = indexEntries.get(filePath) ?? [];
    const base = baseStates.get(filePath) ?? null;
    return !(base === null
      ? entries.length === 0
      : entries.length === 1 &&
        entries[0]?.stage === 0 &&
        entries[0]?.mode === base.mode &&
        entries[0]?.oid === base.oid);
  });
  throw new UsageError(
    `Exact Git operation path has staged work: ${dirtyPath ?? paths[0]}. Commit, stash, or discard that path before retrying.`,
  );
}

function indexMatchesTree(
  paths: string[],
  indexEntries: Map<string, IndexEntry[]>,
  treeStates: Map<string, GitExactPathState | null>,
): boolean {
  for (const filePath of paths) {
    const entries = indexEntries.get(filePath) ?? [];
    const state = treeStates.get(filePath) ?? null;
    if (
      !(state === null
        ? entries.length === 0
        : entries.length === 1 &&
          entries[0]?.stage === 0 &&
          entries[0]?.mode === state.mode &&
          entries[0]?.oid === state.oid)
    ) {
      return false;
    }
  }
  return true;
}

/** Repair only the stale base index left by a crash after an exact commit CAS. */
export function reconcileGitExactPathIndex(repoDir: string, baseCommit: string, commit: string, paths: string[]): void {
  const normalized = normalizeExactPaths(repoDir, paths);
  const current = readIndexEntries(repoDir, normalized);
  const committedStates = readTreeStates(repoDir, commit, normalized);
  if (indexMatchesTree(normalized, current, committedStates)) return;
  const baseStates = readTreeStates(repoDir, baseCommit, normalized);
  if (!indexMatchesTree(normalized, current, baseStates)) {
    throw new UsageError(
      `Exact Git operation path has staged work after transaction recovery. Commit, stash, or discard it before retrying.`,
    );
  }
  for (const result of runExactPathChunks(repoDir, ["reset", "--quiet", commit], normalized)) {
    if (result.status !== 0) throw new Error(`git index cleanup failed during exact transaction recovery`);
  }
}

function captureWorktreeState(repoDir: string, filePath: string): GitExactPathState | null {
  const absolutePath = path.join(repoDir, filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let mode: GitExactPathState["mode"];
  let result: ReturnType<typeof runGit>;
  if (stat.isSymbolicLink()) {
    mode = "120000";
    result = runGit(["-C", repoDir, "hash-object", "--stdin"], { input: fs.readlinkSync(absolutePath) });
  } else if (stat.isFile()) {
    mode = stat.mode & 0o111 ? "100755" : "100644";
    result = runGit(["-C", repoDir, "hash-object", `--path=${filePath}`, "--", absolutePath]);
  } else {
    throw new Error(`Exact Git publication path is not a file: ${filePath}`);
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Cannot hash exact Git publication path: ${filePath}`);
  }
  return { oid: result.stdout.trim(), mode };
}

function samePathState(left: GitExactPathState | null, right: GitExactPathState | null): boolean {
  return left === null ? right === null : right !== null && left.oid === right.oid && left.mode === right.mode;
}

function assertWorktreeMatchesExpected(
  repoDir: string,
  paths: string[],
  expected: Map<string, GitExactPathState | null>,
): void {
  for (const filePath of paths) {
    if (!samePathState(captureWorktreeState(repoDir, filePath), expected.get(filePath) ?? null)) {
      throw new Error(`Exact Git publication path changed while committing: ${filePath}`);
    }
  }
}

function sameIndexEntries(left: Map<string, IndexEntry[]>, right: Map<string, IndexEntry[]>): boolean {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

function resetRealIndexPaths(
  repoDir: string,
  commit: string,
  paths: string[],
  initial: Map<string, IndexEntry[]>,
): void {
  const current = readIndexEntries(repoDir, paths);
  if (!sameIndexEntries(initial, current)) return;
  for (const result of runExactPathChunks(repoDir, ["reset", "--quiet", commit], paths)) {
    if (result.status !== 0) throw new Error(`git index cleanup failed after exact commit`);
  }
}

function createExactPathCommit(
  repoDir: string,
  options: {
    baseHead?: string;
    commitMessage: string;
    paths: string[];
    transactionId?: string;
    expectedSnapshots?: GitExactPathSnapshots;
  },
): string | null {
  const branchRef = readBranchRef(repoDir);
  const baseStates = readTreeStates(repoDir, options.baseHead, options.paths);
  const initialIndex = readIndexEntries(repoDir, options.paths);
  assertIndexMatchesBase(options.paths, initialIndex, baseStates);

  const expected = new Map<string, GitExactPathState | null>();
  for (const filePath of options.paths) {
    expected.set(
      filePath,
      options.expectedSnapshots && Object.hasOwn(options.expectedSnapshots, filePath)
        ? (options.expectedSnapshots[filePath] ?? null)
        : captureWorktreeState(repoDir, filePath),
    );
  }

  const gitIndex = runGit(["-C", repoDir, "rev-parse", "--git-path", "index"]);
  if (gitIndex.status !== 0 || !gitIndex.stdout.trim()) throw new Error(`Cannot resolve Git index path.`);
  const realIndexPath = path.resolve(repoDir, gitIndex.stdout.trim());
  const temporaryIndex = `${realIndexPath}.akm-${process.pid}-${randomBytes(6).toString("hex")}`;
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const seeded = options.baseHead
      ? runGit(["-C", repoDir, "read-tree", options.baseHead], { env })
      : runGit(["-C", repoDir, "read-tree", "--empty"], { env });
    if (seeded.status !== 0) throw new Error(`Cannot seed temporary Git index: ${seeded.stderr.trim()}`);
    const stagePaths = options.paths.filter(
      (filePath) => (expected.get(filePath) ?? null) !== null || (baseStates.get(filePath) ?? null) !== null,
    );
    for (const result of runExactPathChunks(repoDir, ["add", "-A"], stagePaths, { env })) {
      if (result.status !== 0) throw new Error(`Cannot stage exact Git paths: ${result.stderr.trim()}`);
    }
    const tree = runGit(["-C", repoDir, "write-tree"], { env });
    if (tree.status !== 0 || !tree.stdout.trim()) throw new Error(`Cannot write exact Git tree.`);
    const treeOid = tree.stdout.trim();
    const committedStates = readTreeStates(repoDir, treeOid, options.paths);
    for (const filePath of options.paths) {
      if (!samePathState(committedStates.get(filePath) ?? null, expected.get(filePath) ?? null)) {
        throw new Error(`Exact Git publication path changed while committing: ${filePath}`);
      }
    }
    assertWorktreeMatchesExpected(repoDir, options.paths, expected);
    const baseTreeResult = options.baseHead
      ? runGit(["-C", repoDir, "rev-parse", `${options.baseHead}^{tree}`])
      : undefined;
    if (baseTreeResult && (baseTreeResult.status !== 0 || !baseTreeResult.stdout.trim())) {
      throw new Error(`Cannot inspect base Git tree.`);
    }
    const baseTree = baseTreeResult?.stdout.trim() ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    if (treeOid === baseTree) return null;

    const body = options.transactionId
      ? `${options.commitMessage}\n\nAKM-Transaction: ${options.transactionId}\n`
      : `${options.commitMessage}\n`;
    const commit = runGit(
      [
        "-C",
        repoDir,
        "-c",
        "user.name=akm",
        "-c",
        "user.email=akm@local",
        "commit-tree",
        treeOid,
        ...(options.baseHead ? ["-p", options.baseHead] : []),
      ],
      { input: body },
    );
    if (commit.status !== 0 || !commit.stdout.trim()) {
      throw new Error(`git commit-tree failed: ${commit.stderr.trim() || "unknown error"}`);
    }
    const commitOid = commit.stdout.trim();
    const currentBranch = readBranchRef(repoDir);
    const currentHead = readOptionalHead(repoDir);
    if (currentBranch !== branchRef || currentHead !== options.baseHead) {
      throw new Error(`Git target changed before its exact commit could be attached.`);
    }
    assertWorktreeMatchesExpected(repoDir, options.paths, expected);
    // Race window: everything below this line is defended only by the
    // update-ref compare-and-swap. See
    // tests/integration/sync-exact-commit-cas.test.ts.
    gitExactCommitHook("before-update-ref");
    const update = runGit(["-C", repoDir, "update-ref", branchRef, commitOid, options.baseHead ?? ZERO_OID]);
    if (update.status !== 0) {
      throw new Error(`Git target advanced before its exact commit could be attached.`);
    }
    resetRealIndexPaths(repoDir, commitOid, options.paths, initialIndex);
    return commitOid;
  } finally {
    fs.rmSync(temporaryIndex, { force: true });
    fs.rmSync(`${temporaryIndex}.lock`, { force: true });
  }
}

function findSyncStashByTarget(stashes: SourceConfigEntry[], target: string): SourceConfigEntry | undefined {
  return stashes.find((stash) => {
    if (stash.type === "git") return matchesGitStashTarget(stash, target);
    if (stash.type !== "filesystem") return false;
    if (stash.name === target || stash.path === target) return true;
    return stash.path !== undefined && path.resolve(stash.path) === path.resolve(target);
  });
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
