import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { StashConfigEntry } from "../config";
import { ConfigError } from "../errors";
import { getRegistryIndexCacheDir } from "../paths";
import { extractTarGzSecure } from "../registry-install";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse } from "../stash-types";
import { isExpired, sanitizeString } from "./provider-utils";

/** Cache TTL before refreshing the mirrored repo (12 hours). */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Maximum stale age allowed when refresh fails (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface ParsedRepoUrl {
  owner: string;
  repo: string;
  ref: string;
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
  archivePath: string;
  repoDir: string;
  indexPath: string;
} {
  const key = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `context-hub-${key}`);
  return {
    rootDir,
    archivePath: path.join(rootDir, "repo.tar.gz"),
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
    await downloadArchive(buildTarballUrl(repo), cachePaths.archivePath);
    extractTarGzSecure(cachePaths.archivePath, cachePaths.repoDir);
    // Touch index file to track freshness
    fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (mtime && !isExpired(mtime, CACHE_STALE_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
      return;
    }
    throw err;
  }
}

function hasExtractedRepo(repoDir: string): boolean {
  try {
    return fs.statSync(repoDir).isDirectory() && fs.statSync(path.join(repoDir, "content")).isDirectory();
  } catch {
    return false;
  }
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, { timeout: 120_000, retries: 1 });
  if (!response.ok) {
    throw new Error(`Failed to download archive (${response.status}) from ${url}`);
  }

  const BunRuntime = (globalThis as Record<string, unknown>).Bun as {
    write?: (path: string, body: Response) => Promise<number>;
  };
  if (BunRuntime?.write) {
    await BunRuntime.write(destination, response);
    return;
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destination, Buffer.from(arrayBuffer));
}

function buildTarballUrl(repo: ParsedRepoUrl): string {
  return `https://github.com/${repo.owner}/${repo.repo}/archive/refs/heads/${repo.ref}.tar.gz`;
}

function parseGitRepoUrl(rawUrl: string): ParsedRepoUrl {
  if (!rawUrl) {
    throw new ConfigError("Git provider requires a GitHub repository URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError(`Git provider URL is not valid: "${rawUrl}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new ConfigError(`Git provider URL must use https://, got "${parsed.protocol}"`);
  }
  if (parsed.hostname !== "github.com") {
    throw new ConfigError(`Git provider only supports github.com URLs, got "${parsed.hostname}"`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new ConfigError(`Git provider URL must point to a GitHub repository, got "${rawUrl}"`);
  }

  const owner = sanitizeString(segments[0]);
  const repo = sanitizeString(segments[1].replace(/\.git$/i, ""));
  let ref = "main";
  if (segments[2] === "tree" && segments.length >= 4) {
    ref = sanitizeString(segments.slice(3).join("/"), 255) || "main";
  }

  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ConfigError(`Unsupported repository URL: "${rawUrl}"`);
  }
  if (!ref || ref.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new ConfigError(`Unsupported branch/ref in URL: "${rawUrl}"`);
  }

  return {
    owner,
    repo,
    ref,
    canonicalUrl: `https://github.com/${owner}/${repo}/tree/${ref}`,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { GitStashProvider, ensureGitMirror, getCachePaths, parseGitRepoUrl };
