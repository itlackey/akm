// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../core/adapter/adapters/akm-adapter";
import { stashDirNames } from "../../core/asset/asset-placement";
import { resolveSecret, type SourceConfigEntry } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryIndexCacheDir } from "../../core/paths";
import { validateGitUrl } from "../../registry/resolve";
import { withFreshnessCache } from "../freshness";
import type { SyncOptions as ProviderSyncOptions, SourceProvider } from "../provider";
import { registerSourceProvider } from "../provider-factory";
import { assertNoIgnoredPathOverwrite, cloneRepo, inspectGitUpstream, runGit } from "./git-install";
import type { SourceLockData, SyncOptions } from "./install-types";
import { sanitizeString } from "./provider-utils";

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
 * cache directory. Implements the {@link SourceProvider} interface.
 *
 * Reading is the indexer's job — this class doesn't implement `search` or
 * `show`. Install refs are materialized by `syncFromRef`; this provider only
 * refreshes configured Git sources.
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
      this.#path = resolveGitContentDir(this.#config);
    }
    return this.#path;
  }

  async sync(options?: ProviderSyncOptions): Promise<void> {
    await syncMirroredRepo(this.#config, {
      force: options?.force,
      ...(this.#config.credential
        ? { credential: resolveSecret(this.#config.credential, options?.secrets?.resolveSecret) }
        : {}),
    });
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

export function getCachePaths(
  repoUrl: string,
  cacheRootOverride?: string,
): {
  rootDir: string;
  repoDir: string;
  indexPath: string;
} {
  const key = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  const cacheRoot = cacheRootOverride ?? getRegistryIndexCacheDir();
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
  options?: { requireRepoDir?: boolean; writable?: boolean; force?: boolean; credential?: string },
): Promise<void> {
  const requireRepoDir = options?.requireRepoDir === true;
  const writable = options?.writable === true;

  await withFreshnessCache({
    markerPath: cachePaths.indexPath,
    ttlMs: CACHE_TTL_MS,
    staleMs: CACHE_STALE_MS,
    force: options?.force === true,
    allowStaleOnRefreshFailure: !(options?.force === true && writable),
    isUsable: () => !requireRepoDir || hasExtractedRepo(cachePaths.repoDir),
    refresh: async () => {
      fs.mkdirSync(cachePaths.rootDir, { recursive: true });
      if (writable && fs.existsSync(path.join(cachePaths.repoDir, ".git"))) {
        // Writable repo already cloned — pull instead of re-clone to preserve local changes
        pullRepo(cachePaths.repoDir, options?.credential);
      } else {
        cloneRepo(repo.cloneUrl, repo.ref, cachePaths.repoDir, writable, options?.credential);
      }
      // Touch index file to track freshness
      fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });
    },
  });
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
  const cachePaths = getCachePaths(repo.canonicalUrl, options?.cacheRootDir);
  await ensureGitMirror(repo, cachePaths, {
    requireRepoDir: true,
    writable: options?.writable ?? config.writable === true,
    force: options?.force,
    credential: options?.credential,
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

function pullRepo(repoDir: string, credential?: string): void {
  const status = runGit(["-C", repoDir, "status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim()) {
    throw new UsageError(`Writable Git source at ${repoDir} has uncommitted changes; refusing to update it.`);
  }
  const relation = inspectGitUpstream(repoDir, credential);
  if (relation.behind > 0 && relation.upstream) {
    if (relation.ahead > 0) {
      throw new UsageError(`Writable Git source at ${repoDir} has unpushed commits; refusing to update it.`);
    }
    const statusBeforeMerge = runGit(["-C", repoDir, "status", "--porcelain"]);
    if (statusBeforeMerge.status !== 0 || statusBeforeMerge.stdout.trim()) {
      throw new UsageError(
        `Writable Git source at ${repoDir} changed while its update was prepared; refusing to merge.`,
      );
    }
    assertNoIgnoredPathOverwrite(repoDir, relation.upstream);
    const merge = runGit(["-C", repoDir, "merge", "--ff-only", "--no-overwrite-ignore", relation.upstream], {
      timeout: 120_000,
    });
    if (merge.status !== 0) {
      throw new Error(`Failed to fast-forward ${repoDir}: ${merge.stderr?.trim() || "unknown error"}`);
    }
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
    // WI-3.1: the "any type dir present" test is now sourced from the `akm`
    // adapter's directoryList() — behavior-identical to the placement
    // stash-subdir names, with `stashDirNames()` kept live as the fallback. The
    // content/ subdir check above is preserved verbatim.
    const ownedDirs =
      akmAdapter.directoryList?.({ id: "akm", adapter: "akm", root: repoDir, writable: false }) ?? stashDirNames();
    return ownedDirs.some((dirName) => fs.existsSync(path.join(repoDir, dirName)));
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
    const repo = sanitizeString(segments[1]!.replace(/\.git$/i, ""));

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
