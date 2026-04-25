import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config";
import { loadConfig } from "../../core/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryCacheDir, getRegistryIndexCacheDir } from "../../core/paths";
import {
  parseRegistryRef,
  resolveRegistryArtifact,
  validateGitRef,
  validateGitUrl,
} from "../../registry/registry-resolve";
import type { ParsedGitRef } from "../../registry/registry-types";
import type { ProviderContext, SourceProvider } from "../source-provider";
import { registerSourceProvider } from "../source-provider-factory";
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

const GIT_STASH_TYPES = new Set(["git"]);

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

  // One-time silent migration: legacy `context-hub-${key}` directories were
  // created for ALL git stashes (not just the andrewyng/context-hub repo). If
  // the new path doesn't yet exist but the legacy one does, rename it in place
  // so existing clones aren't silently invalidated. Failures are non-fatal —
  // worst case the repo is re-cloned on the next refresh.
  try {
    const legacyRootDir = path.join(cacheRoot, `context-hub-${key}`);
    if (!fs.existsSync(rootDir) && fs.existsSync(legacyRootDir)) {
      fs.renameSync(legacyRootDir, rootDir);
    }
  } catch {
    /* migration is best-effort */
  }

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
async function syncMirroredRepo(config: SourceConfigEntry, options?: SyncOptions): Promise<SourceLockData> {
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

    const cloneResult = spawnSync("git", cloneArgs, { encoding: "utf8", timeout: 120_000 });
    if (cloneResult.status !== 0) {
      const err = cloneResult.stderr?.trim() || cloneResult.error?.message || "unknown error";
      throw new Error(`Failed to clone ${parsed.url}: ${err}`);
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

  const result = spawnSync("git", args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    // Clean up the (possibly partial) temp dir but leave destDir untouched.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const err = result.stderr?.trim() || result.error?.message || "unknown error";
    throw new Error(`Failed to clone ${cloneUrl}: ${err}`);
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
  const result = spawnSync("git", ["-C", repoDir, "pull", "--ff-only"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.error?.message || "unknown error";
    throw new Error(`Failed to pull ${repoDir}: ${err}`);
  }
}

function hasExtractedRepo(repoDir: string): boolean {
  try {
    return fs.statSync(repoDir).isDirectory() && fs.statSync(path.join(repoDir, "content")).isDirectory();
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

export interface SaveGitStashResult {
  committed: boolean;
  pushed: boolean;
  skipped: boolean;
  reason?: string;
  output: string;
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
 */
export function saveGitStash(name?: string, message?: string, writableOverride?: boolean): SaveGitStashResult {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const commitMessage = message?.trim() || `akm save ${timestamp}`;

  let repoDir: string;
  let writable = false;

  if (name) {
    const config = loadConfig();
    const stash = (config.sources ?? config.stashes ?? []).find((s) => s.name === name || s.url === name);
    if (!stash) throw new UsageError(`No git stash found with name "${name}"`);
    if (!GIT_STASH_TYPES.has(stash.type)) {
      throw new UsageError(`Stash "${name}" is not a git stash (type: ${stash.type})`);
    }
    if (!stash.url) throw new UsageError(`Stash "${name}" has no URL configured`);
    const repo = parseGitRepoUrl(stash.url);
    repoDir = getCachePaths(repo.canonicalUrl).repoDir;
    writable = stash.writable === true;
  } else {
    repoDir = resolveStashDir({ readOnly: true });
    // Allow caller to override writable for the primary stash (e.g. from root config.writable)
    if (writableOverride !== undefined) {
      writable = writableOverride;
    }
  }

  // No-op: not a git repo
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { committed: false, pushed: false, skipped: true, reason: "not a git repository", output: "" };
  }

  // Nothing to commit?
  const statusResult = spawnSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" });
  if (statusResult.error || statusResult.status !== 0) {
    throw new Error(
      `git status failed: ${statusResult.error?.message || statusResult.stderr?.trim() || "unknown error"}`,
    );
  }
  if (!statusResult.stdout.trim()) {
    return { committed: false, pushed: false, skipped: false, output: "nothing to commit, working tree clean" };
  }

  // Stage and commit — supply fallback identity so fresh environments without
  // user.name/user.email configured can always commit to the default stash.
  const addResult = spawnSync("git", ["-C", repoDir, "add", "-A"], { encoding: "utf8" });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr?.trim() || "unknown error"}`);
  }
  const commitResult = spawnSync(
    "git",
    ["-C", repoDir, "-c", "user.name=akm", "-c", "user.email=akm@local", "commit", "-m", commitMessage],
    { encoding: "utf8" },
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr?.trim() || "unknown error"}`);
  }

  // Push only when there is a remote AND the stash is marked writable
  const remoteResult = spawnSync("git", ["-C", repoDir, "remote"], { encoding: "utf8" });
  if (remoteResult.status !== 0) {
    throw new Error(`git remote failed: ${remoteResult.stderr?.trim() || "unknown error"}`);
  }
  const hasRemote = remoteResult.stdout.trim().length > 0;

  if (!hasRemote || !writable) {
    return { committed: true, pushed: false, skipped: false, output: commitResult.stdout.trim() };
  }

  const pushResult = spawnSync("git", ["-C", repoDir, "push"], { encoding: "utf8", timeout: 120_000 });
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

// ── Exports ─────────────────────────────────────────────────────────────────

export { ensureGitMirror, GitSourceProvider, getCachePaths, parseGitRepoUrl };
