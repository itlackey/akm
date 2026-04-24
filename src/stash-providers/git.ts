import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../common";
import type { StashConfigEntry } from "../config";
import { loadConfig } from "../config";
import { ConfigError, UsageError } from "../errors";
import { getRegistryIndexCacheDir } from "../paths";
import { validateGitUrl } from "../registry-resolve";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse } from "../stash-types";
import { isExpired, sanitizeString } from "./provider-utils";

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

class GitStashProvider implements StashProvider {
  readonly type = "git";
  readonly name: string;

  constructor(config: StashConfigEntry) {
    this.name = config.name ?? "git";
  }

  /** Content is indexed through the standard FTS5 pipeline. */
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };
  }

  /** Content is local files, shown via showLocal. */
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("Git provider content is shown via local index");
  }

  /** Content is local; no remote show needed. */
  canShow(_ref: string): boolean {
    return false;
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerStashProvider("git", (config) => new GitStashProvider(config));

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
  options?: { requireRepoDir?: boolean; writable?: boolean },
): Promise<void> {
  const requireRepoDir = options?.requireRepoDir === true;
  const writable = options?.writable === true;

  // Check if cache is fresh
  let mtime = 0;
  try {
    mtime = fs.statSync(cachePaths.indexPath).mtimeMs;
  } catch {
    /* no cached index */
  }

  if (mtime && !isExpired(mtime, CACHE_TTL_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
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
    const stash = config.stashes?.find((s) => s.name === name || s.url === name);
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

export { ensureGitMirror, GitStashProvider, getCachePaths, parseGitRepoUrl };
