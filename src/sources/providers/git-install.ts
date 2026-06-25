// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../core/errors";
import { getRegistryCacheDir } from "../../core/paths";
import { parseRegistryRef, resolveRegistryArtifact, validateGitRef, validateGitUrl } from "../../registry/resolve";
import type { ParsedGitRef } from "../../registry/types";
import type { SourceLockData, SyncOptions } from "./install-types";
import {
  applyAkmIncludeConfig,
  buildInstallCacheDir,
  copyDirectoryContents,
  detectStashRoot,
  isDirectory,
} from "./provider-utils";

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

/**
 * Sync mode for a one-shot install ref (`akm add github:owner/repo` or
 * `akm add git:url`). Runs the clone → strip → include-filter pipeline that
 * historically lived in `installRegistryRef()`.
 */
export async function syncRegistryGitRef(ref: string, options?: SyncOptions): Promise<SourceLockData> {
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
    throw new UsageError(`syncRegistryGitRef requires a git: or github: ref, got "${ref}"`);
  }
  return doSyncGit(parsed, options);
}

async function doSyncGit(parsed: ParsedGitRef, options?: SyncOptions): Promise<SourceLockData> {
  const resolved = await resolveRegistryArtifact(parsed);
  const syncedAt = (options?.now ?? new Date()).toISOString();
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheDir();
  const cacheDir = buildInstallCacheDir(cacheRootDir, parsed.source, parsed.id, resolved.resolvedRevision);
  const cloneDir = path.join(cacheDir, "clone");
  const extractedDir = path.join(cacheDir, "extracted");

  // Cache hit
  if (!options?.force && isDirectory(extractedDir)) {
    try {
      const provisionalKitRoot = detectStashRoot(extractedDir);
      const installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
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

  fs.mkdirSync(cacheDir, { recursive: true });

  // Validate URL and ref before passing to git to prevent command injection
  validateGitUrl(parsed.url);
  if (parsed.requestedRef) validateGitRef(parsed.requestedRef);

  let provisionalKitRoot: string;
  let installRoot: string;
  let stashRoot: string;
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (parsed.requestedRef) {
      cloneArgs.push("--branch", parsed.requestedRef);
    }
    cloneArgs.push(parsed.url, cloneDir);

    const cloneResult = runGit(cloneArgs, { timeout: 120_000 });
    if (cloneResult.status !== 0) {
      throw new Error(classifyCloneFailure(parsed.url, cloneResult.stderr, cloneResult.error));
    }

    // Copy contents to extracted dir without .git
    fs.mkdirSync(extractedDir, { recursive: true });
    copyDirectoryContents(cloneDir, extractedDir);

    // Clean up the clone dir
    fs.rmSync(cloneDir, { recursive: true, force: true });

    provisionalKitRoot = detectStashRoot(extractedDir);
    installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
    stashRoot = detectStashRoot(installRoot);
  } catch (err) {
    // Clean up the cache directory so stale or partially-cloned artifacts
    // don't cause false cache hits on the next install attempt.
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
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

export function cloneRepo(cloneUrl: string, ref: string | null, destDir: string, writable = false): void {
  // Stage the clone into a sibling temp dir so that a failed clone never
  // destroys a previously-valid destDir (e.g. when the remote is temporarily
  // unreachable and we have a valid cached copy).
  const tmpDir = `${destDir}.tmp-${randomBytes(4).toString("hex")}`;

  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, tmpDir);

  const result = runGit(args, { timeout: 120_000 });
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

    // Swap: remove the old destDir (if any) then atomically rename tmpDir into place.
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, destDir);
  } catch (err) {
    // Post-clone steps failed — clean up the temp dir to avoid orphaned dirs.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ── Clone-failure classification (#487) ─────────────────────────────────────

/**
 * Translate git's stderr into an actionable message. Without this, a user
 * who passes a nonexistent or private repo to `akm add` sees:
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
  const raw = (stderr ?? "").trim();
  const spawnMsg = spawnError?.message ?? "";

  // `git` binary not on PATH.
  if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return `Failed to clone ${url}: 'git' is not installed or not on PATH. Install git, then re-run.`;
  }

  // Auth-prompt fall-through (the headline #487 case).
  if (/could not read Username|terminal prompts disabled|Authentication failed|fatal: Authentication/i.test(raw)) {
    return (
      `Failed to clone ${url}: repository not found or private. ` +
      `If the repository is public, double-check the URL and try again. ` +
      `If it is private, set GH_TOKEN (or configure a git credential helper) before re-running.`
    );
  }

  // 404-style messages from git http.
  if (/repository '.*' not found|HTTP 404|fatal: remote error|not found:|Not Found/i.test(raw)) {
    return (
      `Failed to clone ${url}: repository not found. ` +
      `Check the URL — for GitHub, the form is 'owner/repo' or 'github:owner/repo'.`
    );
  }

  // SSH connection issues.
  if (
    /Permission denied \(publickey\)|kex_exchange_identification|Connection refused|Connection timed out/i.test(raw)
  ) {
    return (
      `Failed to clone ${url}: network or SSH failure. ` +
      `Check connectivity, your SSH agent, and the remote host's availability.`
    );
  }

  // Branch / ref-specific failures.
  if (/Remote branch .* not found in upstream origin|couldn't find remote ref/i.test(raw)) {
    return (
      `Failed to clone ${url}: the requested branch/tag does not exist on the remote. ` +
      `Verify the ref name and re-run.`
    );
  }

  const detail = raw || spawnMsg || "unknown error";
  return `Failed to clone ${url}: ${detail}`;
}
