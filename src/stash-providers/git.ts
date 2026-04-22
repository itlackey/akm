import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StashConfigEntry } from "../config";
import { ConfigError } from "../errors";
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
registerStashProvider("context-hub", (config) => new GitStashProvider(config));
registerStashProvider("github", (config) => new GitStashProvider(config));

// ── Cache management ────────────────────────────────────────────────────────

function getCachePaths(repoUrl: string): {
  rootDir: string;
  repoDir: string;
  indexPath: string;
} {
  const key = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `context-hub-${key}`);
  return {
    rootDir,
    repoDir: path.join(rootDir, "repo"),
    indexPath: path.join(rootDir, "index.json"),
  };
}

async function ensureGitMirror(
  repo: ParsedRepoUrl,
  cachePaths: ReturnType<typeof getCachePaths>,
  options?: { requireRepoDir?: boolean },
): Promise<void> {
  const requireRepoDir = options?.requireRepoDir === true;

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
    cloneRepo(repo.cloneUrl, repo.ref, cachePaths.repoDir);
    // Touch index file to track freshness
    fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (mtime && !isExpired(mtime, CACHE_STALE_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
      return;
    }
    throw err;
  }
}

function cloneRepo(cloneUrl: string, ref: string | null, destDir: string): void {
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });

  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, destDir);

  const result = spawnSync("git", args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.error?.message || "unknown error";
    throw new Error(`Failed to clone ${cloneUrl}: ${err}`);
  }

  // Remove .git directory — we only need the working tree
  const gitDir = path.join(destDir, ".git");
  if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
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
  validateGitUrl(rawUrl);

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

  // Any other valid git URL: use as-is, rely on system git credentials
  return { cloneUrl: rawUrl, ref: null, canonicalUrl: rawUrl };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { ensureGitMirror, GitStashProvider, getCachePaths, parseGitRepoUrl };
