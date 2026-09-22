// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../../core/common";
import { UsageError } from "../../core/errors";
import { getRegistryCacheDir } from "../../core/paths";
import {
  gitCredentialEnvironment,
  parseRegistryRef,
  resolveRegistryArtifact,
  validateGitRef,
  validateGitUrl,
} from "../../registry/resolve";
import type { ParsedGitRef } from "../../registry/types";
import type { SourceLockData, SyncOptions } from "./install-types";
import { applyAkmIncludeConfig, buildInstallCacheDir, detectStashRoot, isDirectory } from "./provider-utils";

/**
 * Shared subprocess wrapper for `git` invocations. Disables git's interactive
 * terminal prompt so a missing credential never hangs the process.
 */
export function runGit(
  args: string[],
  options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    encoding: "utf8",
    ...options,
    env: { ...process.env, ...options?.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export interface GitUpstreamState {
  hasRemote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Fetch and classify the current branch against its upstream without changing the worktree. */
export function inspectGitUpstream(repoDir: string, credential?: string): GitUpstreamState {
  const remotes = runGit(["-C", repoDir, "remote"]);
  if (remotes.status !== 0) throw new UsageError(`Cannot inspect Git remotes at ${repoDir}: ${remotes.stderr.trim()}`);
  if (!remotes.stdout.trim()) return { hasRemote: false, ahead: 0, behind: 0 };

  const fetch = runGit(["-C", repoDir, "fetch", "--prune"], {
    timeout: 120_000,
    env: gitCredentialEnvironment(credential),
  });
  if (fetch.status !== 0) throw new UsageError(`Cannot refresh Git target at ${repoDir}: ${fetch.stderr.trim()}`);
  const upstream = runGit(["-C", repoDir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    throw new UsageError(`Git target at ${repoDir} has a remote but no upstream branch; configure one before writing.`);
  }
  const relation = gitRelation(repoDir, upstream.stdout.trim());
  return { hasRemote: true, upstream: upstream.stdout.trim(), ...relation };
}

/**
 * Verify the actually-cloned HEAD matches the revision resolved before the
 * clone ran (R-011). This is a presence/identity check only — full
 * content-digest verification across install/update is separate, larger
 * scope work. `expectedRevision` may be an annotated tag's OBJECT id (which
 * `git ls-remote` reports, distinct from the commit it points to), so the
 * comparison peels it (`^{commit}`) before comparing against HEAD; a plain
 * commit SHA peels to itself.
 */
export function verifyClonedRevision(cloneDir: string, url: string, expectedRevision: string | undefined): void {
  if (!expectedRevision) {
    // `resolveGitArtifact` (registry/resolve.ts) throws when it cannot resolve
    // a revision via `git ls-remote`, so a plain git install never reaches
    // this call with `undefined` — treat it as a bug, not a silently-skipped
    // check that would defeat the R-011 post-clone integrity verification.
    throw new UsageError(`No revision was resolved from ${url}; refusing to install without a verifiable checkout.`);
  }
  const head = runGit(["-C", cloneDir, "rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    throw new UsageError(`Failed to read cloned HEAD at ${cloneDir}: ${head.stderr.trim() || "rev-parse failed"}`);
  }
  const actual = head.stdout.trim();
  const peeled = runGit(["-C", cloneDir, "rev-parse", `${expectedRevision}^{commit}`]);
  const expectedCommit = peeled.status === 0 ? peeled.stdout.trim() : expectedRevision;
  if (actual !== expectedCommit) {
    throw new UsageError(
      `Cloned HEAD ${actual} at ${cloneDir} does not match the revision resolved from ${url} (${expectedRevision}); refusing to install a mismatched checkout.`,
    );
  }
}

function gitRelation(repoDir: string, target: string): { ahead: number; behind: number } {
  const result = runGit(["-C", repoDir, "rev-list", "--left-right", "--count", `HEAD...${target}`]);
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (result.status !== 0 || !match) {
    throw new UsageError(`Cannot compare Git history at ${repoDir}: ${result.stderr.trim() || "unknown relation"}`);
  }
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

/** Reject a fast-forward that would replace an ignored, untracked local path. */
export function assertNoIgnoredPathOverwrite(repoDir: string, targetRevision: string): void {
  const ignored = runGit(["-C", repoDir, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  if (ignored.status !== 0) {
    throw new UsageError(`Cannot inspect ignored files at ${repoDir}: ${ignored.stderr.trim()}`);
  }
  const ignoredPaths = ignored.stdout.split("\0").filter(Boolean);
  if (ignoredPaths.length === 0) return;
  const changed = runGit(["-C", repoDir, "diff", "--name-only", "--no-renames", "-z", "HEAD", targetRevision]);
  if (changed.status !== 0) {
    throw new UsageError(`Cannot inspect incoming Git paths at ${repoDir}: ${changed.stderr.trim()}`);
  }
  const changedPaths = changed.stdout.split("\0").filter(Boolean);
  const conflict = ignoredPaths.find((ignoredPath) =>
    changedPaths.some(
      (changedPath) =>
        changedPath === ignoredPath ||
        changedPath.startsWith(`${ignoredPath}/`) ||
        ignoredPath.startsWith(`${changedPath}/`),
    ),
  );
  if (conflict) {
    throw new UsageError(
      `Git update would overwrite ignored local path ${path.join(repoDir, conflict)}; move or remove it before update.`,
    );
  }
}

/**
 * Whether a requested ref is a full commit hash rather than a branch or tag.
 *
 * Only the unambiguous 40-hex (SHA-1) and 64-hex (SHA-256) forms count. An
 * abbreviated hash is indistinguishable from a legal branch name, so it stays
 * on the `--branch` path where git itself reports the mismatch.
 */
function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^[0-9a-f]{64}$/i.test(ref);
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function replaceDirectory(stagedDir: string, destination: string): void {
  const backup = `${destination}.backup-${randomBytes(4).toString("hex")}`;
  const hadDestination = fs.existsSync(destination);
  if (hadDestination) fs.renameSync(destination, backup);
  try {
    fs.renameSync(stagedDir, destination);
  } catch (error) {
    if (hadDestination && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
  if (hadDestination) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      // The new destination is live; a stale backup is safer than reporting a
      // failed replacement after the swap already succeeded.
    }
  }
}

/**
 * Materialize a Git install ref (`akm bundle add github:owner/repo` or
 * `akm bundle add git:url`) through the clone, strip, and include-filter pipeline.
 */
export async function syncGitRef(ref: string, options?: SyncOptions): Promise<SourceLockData> {
  const parsed = parseRegistryRef(ref);
  if (parsed.source === "github") {
    const githubRef: ParsedGitRef = {
      source: "git",
      ref: parsed.ref,
      id: parsed.id,
      url: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
      requestedRef: parsed.requestedRef,
    };
    const result = await doSyncGit(githubRef, options);
    return { ...result, source: "github" };
  }
  if (parsed.source !== "git") {
    throw new UsageError(`syncGitRef requires a git: or github: ref, got "${ref}"`);
  }
  return doSyncGit(parsed, options);
}

async function doSyncGit(parsed: ParsedGitRef, options?: SyncOptions): Promise<SourceLockData> {
  validateGitUrl(parsed.url);
  if (parsed.requestedRef) validateGitRef(parsed.requestedRef);
  const resolved = await resolveRegistryArtifact(parsed, { gitCredential: options?.credential });
  const syncedAt = (options?.now ?? new Date()).toISOString();
  if (options?.writable && options.writableRoot) {
    return syncExistingWritableCheckout(
      parsed,
      resolved,
      options.writableRoot,
      syncedAt,
      options.writableRequiredRoots,
      options.credential,
    );
  }
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheDir();
  const cacheDir = buildInstallCacheDir(
    cacheRootDir,
    parsed.source,
    parsed.id,
    options?.writable ? "writable" : resolved.resolvedRevision,
  );
  const cloneDir = path.join(cacheDir, "clone");
  const extractedDir = path.join(cacheDir, "extracted");

  // Cache hit. Writable installs must remain real checkouts so every mutation
  // can be committed; an older extracted snapshot is not eligible.
  if (isDirectory(extractedDir) && (!options?.writable || isDirectory(path.join(extractedDir, ".git")))) {
    if (options?.writable) {
      const provisionalBundleRoot = detectStashRoot(extractedDir);
      const installRoot = applyAkmIncludeConfig(provisionalBundleRoot, cacheDir, extractedDir) ?? provisionalBundleRoot;
      if (installRoot !== provisionalBundleRoot) {
        throw new UsageError("Writable Git installs do not support akm.include (package.json) filtered snapshots.");
      }
      return syncExistingWritableCheckout(
        parsed,
        resolved,
        detectStashRoot(installRoot),
        syncedAt,
        options.writableRequiredRoots,
        options.credential,
      );
    }
    try {
      if (options?.force) {
        throw new Error("refresh read-only snapshot");
      }
      const provisionalBundleRoot = detectStashRoot(extractedDir);
      const installRoot = applyAkmIncludeConfig(provisionalBundleRoot, cacheDir, extractedDir) ?? provisionalBundleRoot;
      const stashRoot = detectStashRoot(installRoot);
      if (stashRoot) {
        return {
          id: resolved.id,
          source: resolved.source,
          ref: resolved.ref,
          artifactUrl: resolved.artifactUrl,
          resolvedVersion: resolved.resolvedVersion,
          resolvedRevision: resolved.resolvedRevision,
          contentDir: stashRoot,
          cacheDir,
          extractedDir,
          writable: options?.writable,
          syncedAt,
        };
      }
    } catch {
      // Cache invalid, re-clone
    }
  }

  const cacheExisted = fs.existsSync(cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.rmSync(cloneDir, { recursive: true, force: true });

  let provisionalBundleRoot: string;
  let installRoot: string;
  let stashRoot: string;
  try {
    // `git clone --branch` accepts only a branch or tag name, never a raw commit
    // hash — so pinning an install to a commit (`#<40-hex-sha>`, which
    // parseGithubShorthand/parseGitUrl accept and validateGitRef allows) made the
    // clone fail outright. A commit pin needs a full clone followed by a
    // checkout of that revision; `--depth 1` cannot fetch an arbitrary commit
    // either, so the read-only shallow optimization is skipped in that case.
    const pinnedCommit = parsed.requestedRef !== undefined && isCommitSha(parsed.requestedRef);
    const cloneArgs = ["clone"];
    if (!options?.writable && !pinnedCommit) cloneArgs.push("--depth", "1");
    if (parsed.requestedRef && !pinnedCommit) {
      cloneArgs.push("--branch", parsed.requestedRef);
    }
    cloneArgs.push(parsed.url, cloneDir);

    const cloneResult = runGit(cloneArgs, {
      timeout: 120_000,
      env: gitCredentialEnvironment(options?.credential),
    });
    if (cloneResult.status !== 0) {
      throw new Error(classifyCloneFailure(parsed.url, cloneResult.stderr, cloneResult.error));
    }

    if (pinnedCommit) {
      const checkout = runGit(["-C", cloneDir, "checkout", "--detach", parsed.requestedRef!], { timeout: 120_000 });
      if (checkout.status !== 0) {
        throw new Error(
          `Could not check out commit ${parsed.requestedRef} from ${parsed.url}: ${checkout.stderr.trim() || "unknown git error"}`,
        );
      }
    }

    // R-011: `resolved.resolvedRevision` was resolved via a SEPARATE
    // `git ls-remote` round-trip before this clone ran (resolveGitArtifact /
    // resolveGithubArtifact in registry/resolve.ts) and was never checked
    // against what actually got cloned. Verify it now, while `.git` still
    // exists (the read-only branch below strips it).
    verifyClonedRevision(cloneDir, parsed.url, resolved.resolvedRevision);

    if (options?.writable) {
      const branch = runGit(["-C", cloneDir, "branch", "--show-current"]);
      if (branch.status !== 0 || !branch.stdout.trim()) {
        throw new UsageError("Writable Git installs require a branch ref; tags and detached revisions are read-only.");
      }
      const stagedRoot = detectStashRoot(cloneDir);
      if (applyAkmIncludeConfig(stagedRoot, cacheDir, cloneDir)) {
        throw new UsageError("Writable Git installs do not support akm.include (package.json) filtered snapshots.");
      }
      replaceDirectory(cloneDir, extractedDir);
    } else {
      // Read-only installs are immutable snapshots and do not retain Git metadata.
      fs.rmSync(path.join(cloneDir, ".git"), { recursive: true, force: true });
      replaceDirectory(cloneDir, extractedDir);
    }

    provisionalBundleRoot = detectStashRoot(extractedDir);
    installRoot = applyAkmIncludeConfig(provisionalBundleRoot, cacheDir, extractedDir) ?? provisionalBundleRoot;
    if (options?.writable && installRoot !== provisionalBundleRoot) {
      throw new UsageError("Writable Git installs do not support akm.include (package.json) filtered snapshots.");
    }
    stashRoot = detectStashRoot(installRoot);
  } catch (err) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    try {
      if (!cacheExisted) fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: resolved.resolvedRevision,
    contentDir: stashRoot,
    cacheDir,
    extractedDir,
    writable: options?.writable,
    syncedAt,
  };
}

export function syncExistingWritableCheckout(
  parsed: ParsedGitRef,
  resolved: Awaited<ReturnType<typeof resolveRegistryArtifact>>,
  contentRoot: string,
  syncedAt: string,
  requiredRoots: readonly string[] = [],
  credential?: string,
): SourceLockData {
  const root = path.resolve(contentRoot);
  const repoResult = runGit(["-C", root, "rev-parse", "--show-toplevel"]);
  if (repoResult.status !== 0 || !repoResult.stdout.trim()) {
    throw new UsageError(
      `Writable Git install at ${root} is not a checkout; refusing to replace it because it may contain local work.`,
    );
  }
  const repoDir = path.resolve(repoResult.stdout.trim());
  if (!isWithin(root, repoDir)) {
    throw new UsageError(`Writable Git content root ${root} resolves outside its checkout at ${repoDir}.`);
  }

  const remote = runGit(["-C", repoDir, "remote", "get-url", "origin"]);
  if (remote.status !== 0 || normalizeRemoteUrl(remote.stdout) !== normalizeRemoteUrl(parsed.url)) {
    throw new UsageError(
      `Writable Git install at ${root} points at a different origin; refusing to update or replace the checkout.`,
    );
  }

  const status = runGit(["-C", repoDir, "status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim()) {
    throw new UsageError(
      `Writable Git install at ${root} has uncommitted changes; commit or discard them before update.`,
    );
  }

  if (parsed.requestedRef) {
    const branch = runGit(["-C", repoDir, "branch", "--show-current"]);
    const expectedBranch = parsed.requestedRef.replace(/^refs\/heads\//, "");
    if (branch.status !== 0 || !branch.stdout.trim() || branch.stdout.trim() !== expectedBranch) {
      throw new UsageError(
        `Writable Git install at ${root} is checked out on a different branch than requested ref "${parsed.requestedRef}".`,
      );
    }
  }

  const shallow = runGit(["-C", repoDir, "rev-parse", "--is-shallow-repository"]);
  const fetchArgs = ["-C", repoDir, "fetch", "--prune", "--tags"];
  if (shallow.status === 0 && shallow.stdout.trim() === "true") fetchArgs.push("--unshallow");
  fetchArgs.push("origin");
  if (parsed.requestedRef) fetchArgs.push(parsed.requestedRef);
  const fetch = runGit(fetchArgs, { timeout: 120_000, env: gitCredentialEnvironment(credential) });
  if (fetch.status !== 0) {
    throw new UsageError(
      `Writable Git install at ${root} could not fetch its expected origin; local work was preserved. ${fetch.stderr.trim()}`,
    );
  }

  let targetRevision = resolved.resolvedRevision;
  if (targetRevision) {
    const resolvedTarget = runGit(["-C", repoDir, "rev-parse", "--verify", `${targetRevision}^{commit}`]);
    if (resolvedTarget.status === 0) targetRevision = resolvedTarget.stdout.trim();
    else targetRevision = undefined;
  }
  if (!targetRevision) {
    const fallbackTarget = runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      parsed.requestedRef ? "FETCH_HEAD" : "@{u}",
    ]);
    if (fallbackTarget.status !== 0 || !fallbackTarget.stdout.trim()) {
      throw new UsageError(`Writable Git install at ${root} has no verifiable upstream revision.`);
    }
    targetRevision = fallbackTarget.stdout.trim();
  }

  const relation = gitRelation(repoDir, targetRevision);
  const rootsToPreserve = [...new Set([root, ...requiredRoots.map((candidate) => path.resolve(candidate))])];
  for (const requiredRoot of rootsToPreserve) {
    if (!isWithin(requiredRoot, repoDir)) {
      throw new UsageError(`Configured Git component root ${requiredRoot} resolves outside ${repoDir}.`);
    }
  }

  if (relation.behind > 0) {
    if (relation.ahead > 0) {
      throw new UsageError(
        `Writable Git install at ${root} has local commits that are not in the requested upstream revision; push or reconcile them before update.`,
      );
    }

    assertNoIgnoredPathOverwrite(repoDir, targetRevision);

    for (const requiredRoot of rootsToPreserve) {
      const relative = path.relative(repoDir, requiredRoot).replaceAll(path.sep, "/");
      if (!relative) continue;
      const tree = runGit(["-C", repoDir, "ls-tree", "-d", "-z", "--name-only", targetRevision, "--", relative]);
      const names = tree.stdout.split("\0").filter(Boolean);
      if (tree.status !== 0 || !names.includes(relative)) {
        throw new UsageError(
          `Writable Git update would remove configured content root ${requiredRoot}; the existing checkout was left unchanged.`,
        );
      }
    }

    const statusBeforeMerge = runGit(["-C", repoDir, "status", "--porcelain"]);
    if (statusBeforeMerge.status !== 0 || statusBeforeMerge.stdout.trim()) {
      throw new UsageError(
        `Writable Git install at ${root} changed while its update was prepared; local work was preserved.`,
      );
    }
    assertNoIgnoredPathOverwrite(repoDir, targetRevision);
    const merge = runGit(["-C", repoDir, "merge", "--ff-only", "--no-overwrite-ignore", targetRevision], {
      timeout: 120_000,
    });
    if (merge.status !== 0) {
      throw new UsageError(
        `Writable Git install at ${root} cannot fast-forward; local commits were preserved. ${merge.stderr.trim()}`,
      );
    }
  }
  for (const requiredRoot of rootsToPreserve) {
    if (!isDirectory(requiredRoot)) {
      throw new UsageError(`Writable Git update did not preserve configured content root ${requiredRoot}.`);
    }
  }
  const head = runGit(["-C", repoDir, "rev-parse", "HEAD"]);
  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: head.status === 0 ? head.stdout.trim() : targetRevision,
    contentDir: root,
    cacheDir: repoDir,
    extractedDir: repoDir,
    writable: true,
    syncedAt,
  };
}

export function cloneRepo(
  cloneUrl: string,
  ref: string | null,
  destDir: string,
  writable = false,
  credential?: string,
): void {
  // Stage the clone into a sibling temp dir so that a failed clone never
  // destroys a previously-valid destDir (e.g. when the remote is temporarily
  // unreachable and we have a valid cached copy).
  const tmpDir = `${destDir}.tmp-${randomBytes(4).toString("hex")}`;

  const args = ["clone"];
  if (!writable) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, tmpDir);

  const result = runGit(args, { timeout: 120_000, env: gitCredentialEnvironment(credential) });
  if (result.status !== 0) {
    // Clean up the (possibly partial) temp dir but leave destDir untouched.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(classifyCloneFailure(cloneUrl, result.stderr, result.error));
  }

  try {
    if (!writable) {
      // Remove .git directory — we only need the working tree for read-only stashes
      const gitDir = path.join(tmpDir, ".git");
      if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
    }

    replaceDirectory(tmpDir, destDir);
  } catch (err) {
    // Post-clone steps failed — clean up the temp dir to avoid orphaned dirs.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ── Clone-failure classification (#487) ─────────────────────────────────────

/**
 * Translate git's stderr into an actionable message. Without this, a user
 * who passes a nonexistent or private repo to `akm bundle add` sees:
 *
 *   "could not read Username for 'https://github.com': No such device or
 *    address"
 *
 * That is git falling through to its auth-prompt path — the actual cause
 * is "repo doesn't exist (or is private)". We classify the common patterns
 * and emit a message that names the cause and the fix.
 */
export function classifyCloneFailure(
  url: string,
  stderr: string | undefined | null,
  spawnError: NodeJS.ErrnoException | Error | undefined,
): string {
  const safeUrl = redactUrlUserinfo(url);
  const raw = (stderr ?? "").trim();
  const spawnMsg = spawnError?.message ?? "";

  // `git` binary not on PATH.
  if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return `Failed to clone ${safeUrl}: 'git' is not installed or not on PATH. Install git, then re-run.`;
  }

  // Auth-prompt fall-through (the headline #487 case).
  if (/could not read Username|terminal prompts disabled|Authentication failed|fatal: Authentication/i.test(raw)) {
    return (
      `Failed to clone ${safeUrl}: repository not found or private. ` +
      `If the repository is public, double-check the URL and try again. ` +
      `If it is private, set GH_TOKEN (or configure a git credential helper) before re-running.`
    );
  }

  // 404-style messages from git http.
  if (/repository '.*' not found|HTTP 404|fatal: remote error|not found:|Not Found/i.test(raw)) {
    return (
      `Failed to clone ${safeUrl}: repository not found. ` +
      `Check the URL — for GitHub, the form is 'owner/repo' or 'github:owner/repo'.`
    );
  }

  // SSH connection issues.
  if (
    /Permission denied \(publickey\)|kex_exchange_identification|Connection refused|Connection timed out/i.test(raw)
  ) {
    return (
      `Failed to clone ${safeUrl}: network or SSH failure. ` +
      `Check connectivity, your SSH agent, and the remote host's availability.`
    );
  }

  // Branch / ref-specific failures.
  if (/Remote branch .* not found in upstream origin|couldn't find remote ref/i.test(raw)) {
    return (
      `Failed to clone ${safeUrl}: the requested branch/tag does not exist on the remote. ` +
      `Verify the ref name and re-run.`
    );
  }

  const detail = raw || spawnMsg || "unknown error";
  return `Failed to clone ${safeUrl}: ${redactUrlUserinfo(detail)}`;
}

function redactUrlUserinfo(text: string): string {
  return text.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]+)@/g, "$1[REDACTED]@");
}
