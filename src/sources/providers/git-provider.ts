// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryIndexCacheDir } from "../../core/paths";
import { validateGitUrl } from "../../registry/resolve";
import type { SourceProvider } from "../provider";
import { registerSourceProvider } from "../provider-factory";
import { cloneRepo, runGit, syncRegistryGitRef } from "./git-install";
import type { SourceLockData, SyncOptions } from "./install-types";
import { isExpired, sanitizeString } from "./provider-utils";

/** Cache TTL before refreshing the mirrored repo (12 hours). */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Maximum stale age allowed when refresh fails (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ParsedRepoUrl {
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
export class GitSourceProvider implements SourceProvider {
  readonly kind = "git" as const;
  readonly name: string;
  readonly #config: SourceConfigEntry;
  #path: string | null = null;

  constructor(config: SourceConfigEntry) {
    this.#config = config;
    this.name = config.name ?? "git";
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

export function getCachePaths(repoUrl: string): {
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

export async function ensureGitMirror(
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

export function parseGitRepoUrl(rawUrl: string): ParsedRepoUrl {
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
