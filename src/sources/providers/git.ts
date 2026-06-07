// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import { resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { getSources, loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryCacheDir, getRegistryIndexCacheDir } from "../../core/paths";
import { sanitizeCommitMessage } from "../../core/write-source";
import { parseRegistryRef, resolveRegistryArtifact, validateGitRef, validateGitUrl } from "../../registry/resolve";
import type { ParsedGitRef } from "../../registry/types";
import type { ProviderContext, SourceProvider } from "../provider";
import { registerSourceProvider } from "../provider-factory";
import type { SourceLockData, SyncOptions } from "./install-types";
import {
  applyAkmIncludeConfig,
  buildInstallCacheDir,
  copyDirectoryContents,
  detectStashRoot,
  isDirectory,
  isExpired,
  sanitizeString,
} from "./provider-utils";

/** Cache TTL before refreshing the mirrored repo (12 hours). */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Maximum stale age allowed when refresh fails (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function runGit(
  args: string[],
  options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    encoding: "utf8",
    ...options,
    env: { ...process.env, ...options?.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

interface ParsedRepoUrl {
  cloneUrl: string;
  ref: string | null;
  canonicalUrl: string;
}

/**
 * Git source provider — clones (and re-pulls) a remote repo into a local
 * cache directory. Implements the v1 {@link SourceProvider} interface (spec
 * §2.1, §2.5): `{ name, kind, init, path, sync }`.
 *
 * Reading is the indexer's job — this class doesn't implement `search` or
 * `show`. The install-time helpers `syncRegistryGitRef` / `syncMirroredRepo`
 * live below as standalone functions used by `akm add` / `akm update`.
 */
class GitSourceProvider implements SourceProvider {
  readonly kind = "git" as const;
  readonly name: string;
  readonly #config: SourceConfigEntry;
  #path: string | null = null;

  constructor(config: SourceConfigEntry) {
    this.#config = config;
    this.name = config.name ?? "git";
  }

  async init(_ctx: ProviderContext): Promise<void> {
    // Resolve the on-disk content directory once. For configured git sources
    // this is the cached working tree; for one-shot install refs it's the
    // path the install pipeline materialised.
    this.#path = resolveGitContentDir(this.#config);
  }

  path(): string {
    if (this.#path == null) {
      // Lazy resolution: providers are sometimes constructed without an
      // explicit init() call (e.g. by legacy callers that just want the
      // path). Resolve on demand and cache.
      this.#path = resolveGitContentDir(this.#config);
    }
    return this.#path;
  }

  async sync(): Promise<void> {
    // Two execution modes:
    //   1. Long-lived configured source (config.url) — mirror into the
    //      registry-index cache and serve as a read-only working tree.
    //   2. One-shot install ref (options.ref like "git:..." / "github:...") —
    //      delegate to the install-time pipeline.
    if (typeof this.#config.options?.ref === "string" && this.#config.options.ref) {
      await syncRegistryGitRef(String(this.#config.options.ref));
      return;
    }
    await syncMirroredRepo(this.#config);
  }
}

/** Resolve the on-disk content directory for a configured git source. */
function resolveGitContentDir(config: SourceConfigEntry): string {
  if (config.path) return config.path;
  if (config.url) {
    const repo = parseGitRepoUrl(config.url);
    return getCachePaths(repo.canonicalUrl).repoDir;
  }
  throw new ConfigError("git source entry must have either `path` or `url`");
}

// ── Self-register ───────────────────────────────────────────────────────────

registerSourceProvider("git", (config) => new GitSourceProvider(config));

// ── Cache management ────────────────────────────────────────────────────────

function getCachePaths(repoUrl: string): {
  rootDir: string;
  repoDir: string;
  indexPath: string;
} {
  const key = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  const cacheRoot = getRegistryIndexCacheDir();
  const rootDir = path.join(cacheRoot, `git-${key}`);

  return {
    rootDir,
    repoDir: path.join(rootDir, "repo"),
    indexPath: path.join(rootDir, "index.json"),
  };
}

async function ensureGitMirror(
  repo: ParsedRepoUrl,
  cachePaths: ReturnType<typeof getCachePaths>,
  options?: { requireRepoDir?: boolean; writable?: boolean; force?: boolean },
): Promise<void> {
  const requireRepoDir = options?.requireRepoDir === true;
  const writable = options?.writable === true;
  const force = options?.force === true;

  // Check if cache is fresh
  let mtime = 0;
  try {
    mtime = fs.statSync(cachePaths.indexPath).mtimeMs;
  } catch {
    /* no cached index */
  }

  if (!force && mtime && !isExpired(mtime, CACHE_TTL_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
    return;
  }

  try {
    fs.mkdirSync(cachePaths.rootDir, { recursive: true });
    if (writable && fs.existsSync(path.join(cachePaths.repoDir, ".git"))) {
      // Writable repo already cloned — pull instead of re-clone to preserve local changes
      pullRepo(cachePaths.repoDir);
    } else {
      cloneRepo(repo.cloneUrl, repo.ref, cachePaths.repoDir, writable);
    }
    // Touch index file to track freshness
    fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (mtime && !isExpired(mtime, CACHE_STALE_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
      return;
    }
    throw err;
  }
}

/**
 * Sync mode for a long-lived configured git stash. Mirrors the repo into the
 * shared registry-index cache (12h TTL) and exposes the working tree as the
 * stash content directory.
 */
export async function syncMirroredRepo(config: SourceConfigEntry, options?: SyncOptions): Promise<SourceLockData> {
  if (!config.url) {
    throw new ConfigError("git stash entry requires a URL when no install ref is supplied");
  }
  const repo = parseGitRepoUrl(config.url);
  const cachePaths = getCachePaths(repo.canonicalUrl);
  await ensureGitMirror(repo, cachePaths, {
    requireRepoDir: true,
    writable: options?.writable ?? config.writable === true,
    force: options?.force,
  });

  const syncedAt = (options?.now ?? new Date()).toISOString();
  const contentDir = cachePaths.repoDir;
  return {
    id: repo.canonicalUrl,
    source: "git",
    ref: repo.canonicalUrl,
    artifactUrl: repo.canonicalUrl,
    contentDir,
    cacheDir: cachePaths.rootDir,
    extractedDir: contentDir,
    writable: options?.writable ?? config.writable === true,
    syncedAt,
  };
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

function pullRepo(repoDir: string): void {
  const result = runGit(["-C", repoDir, "pull", "--ff-only"], {
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.error?.message || "unknown error";
    throw new Error(`Failed to pull ${repoDir}: ${err}`);
  }
}

function hasExtractedRepo(repoDir: string): boolean {
  try {
    if (!fs.statSync(repoDir).isDirectory()) return false;
    if (fs.statSync(path.join(repoDir, "content")).isDirectory()) return true;
  } catch {
    /* fall through to root-layout detection */
  }

  try {
    if (!fs.statSync(repoDir).isDirectory()) return false;
    return Object.values(TYPE_DIRS).some((dirName) => fs.existsSync(path.join(repoDir, dirName)));
  } catch {
    return false;
  }
}

function parseGitRepoUrl(rawUrl: string): ParsedRepoUrl {
  if (!rawUrl) {
    throw new ConfigError("Git provider requires a repository URL");
  }

  // SSH shorthand: git@host:path — valid as-is, delegated to system git credentials
  if (/^git@[^:]+:.+$/.test(rawUrl)) {
    return { cloneUrl: rawUrl, ref: null, canonicalUrl: rawUrl };
  }

  // Validate URL scheme is safe before parsing
  try {
    validateGitUrl(rawUrl);
  } catch (err) {
    if (err instanceof UsageError) throw new ConfigError(err.message);
    throw err;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError(`Git provider URL is not valid: "${rawUrl}"`);
  }

  // GitHub web URLs: extract a clean clone URL and optional branch from /tree/<ref>
  if (parsed.hostname === "github.com" && parsed.protocol === "https:") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new ConfigError(`Git provider URL must point to a repository, got "${rawUrl}"`);
    }

    const owner = sanitizeString(segments[0]);
    const repo = sanitizeString(segments[1].replace(/\.git$/i, ""));

    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new ConfigError(`Unsupported repository URL: "${rawUrl}"`);
    }

    let ref: string | null = null;
    if (segments[2] === "tree" && segments.length >= 4) {
      const rawRef = sanitizeString(segments.slice(3).join("/"), 255);
      if (rawRef && !rawRef.includes("..") && /^[A-Za-z0-9._/-]+$/.test(rawRef)) {
        ref = rawRef;
      }
    }

    const cloneUrl = `https://github.com/${owner}/${repo}`;
    const canonicalUrl = ref ? `${cloneUrl}/tree/${ref}` : cloneUrl;
    return { cloneUrl, ref, canonicalUrl };
  }

  // Any other valid git URL: use as-is for cloning, but strip embedded credentials
  // from canonicalUrl so secrets don't leak into cache keys or warning messages.
  let canonicalUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    canonicalUrl = u.toString();
  } catch {
    // URL failed to parse — fall back to raw (validateGitUrl already accepted it)
  }
  return { cloneUrl: rawUrl, ref: null, canonicalUrl };
}

// ── Save support ─────────────────────────────────────────────────────────────

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
  options?: { push?: boolean; repoDir?: string },
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

  // Safety check (#476): when the stash dir is shared with a non-akm project
  // (stash root == project repo root), `git add -A` would stage every dirty
  // file in the user's working tree and push their unrelated WIP to the
  // stash's remote. Refuse if any dirty path is outside the known akm-
  // managed subtrees (TYPE_DIRS + `.akm/` state).
  const nonAkmDirty = collectNonAkmDirtyPaths(statusResult.stdout);
  if (nonAkmDirty.length > 0) {
    const sample = nonAkmDirty.slice(0, 10);
    const more = nonAkmDirty.length > sample.length ? `\n  ...and ${nonAkmDirty.length - sample.length} more` : "";
    throw new Error(
      `refusing to push: stash repo at ${repoDir} has uncommitted non-akm changes:\n` +
        sample.map((p) => `  ${p}`).join("\n") +
        more +
        `\nCommit or stash these manually before running an akm push. ` +
        `Akm-managed paths are: ${Object.values(TYPE_DIRS).join(", ")}, .akm/`,
    );
  }

  // Stage and commit — supply fallback identity so fresh environments without
  // user.name/user.email configured can always commit to the default stash.
  // `add -A` is safe here because nonAkmDirty was just verified empty.
  const addResult = runGit(["-C", repoDir, "add", "-A"]);
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr?.trim() || "unknown error"}`);
  }
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

// ── Stash-safety helpers (#476) ──────────────────────────────────────────────

/**
 * Inspect `git status --porcelain` output and return every dirty path that is
 * NOT inside an akm-managed subtree. Used by `runUpstreamPush` to refuse
 * pushing unrelated WIP when a writable stash shares its root with a project
 * repo.
 *
 * Porcelain v1 format: `XY <path>` or `XY <orig> -> <new>` for renames. We
 * key off the post-rename path (or the only path) — that is the working-tree
 * file at risk of being staged by `git add -A`.
 */
function collectNonAkmDirtyPaths(porcelainOutput: string): string[] {
  const akmDirs = new Set<string>(Object.values(TYPE_DIRS));
  const result: string[] = [];
  for (const rawLine of porcelainOutput.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    // Skip the 2-char status code + 1 space.
    let p = line.length > 3 ? line.slice(3) : "";
    // Renames / copies: `from -> to`. Stage decision applies to `to`.
    const arrow = p.lastIndexOf(" -> ");
    if (arrow !== -1) {
      p = p.slice(arrow + 4);
    }
    // Strip surrounding quotes for paths with special chars.
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      p = p.slice(1, -1);
    }
    if (!p) continue;
    const segments = p.split("/");
    const top = segments[0];
    if (top === ".akm" || akmDirs.has(top)) continue;
    result.push(p);
  }
  return result;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { collectNonAkmDirtyPaths, ensureGitMirror, GitSourceProvider, getCachePaths, parseGitRepoUrl };
// resolveWritableOverride is exported at its declaration above.
