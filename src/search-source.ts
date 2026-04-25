import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "./common";
import type { AkmConfig, StashConfigEntry } from "./config";
import { loadConfig } from "./config";
import { ensureGitMirror, getCachePaths, parseGitRepoUrl } from "./stash-providers/git";
import { ensureWebsiteMirror, getCachePaths as getWebsiteCachePaths } from "./stash-providers/website";
import { warn } from "./warn";

// Legacy "context-hub" / "github" type aliases are normalized to "git" at
// config-load time (see src/config.ts), so this set only contains the canonical
// type.
const GIT_STASH_TYPES = new Set(["git"]);

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchSource {
  path: string;
  /** For installed sources, the installed stash id */
  registryId?: string;
  /** If set, all .md files in this source are indexed as wiki pages under this wiki name */
  wikiName?: string;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources, walking every configured stash
 * once. Iteration order:
 *
 *   1. The primary stash directory (the entry marked `primary: true`, or the
 *      legacy top-level `stashDir`). Always emitted, even when the directory
 *      does not yet exist on disk, so callers can use it as the clone target.
 *   2. Each entry in `config.stashes[]` (in declared order), excluding the
 *      one already emitted as the primary.
 *   3. Each entry in `config.installed[]` (registry-managed stashes).
 *
 * Replaces the previous four-pass loop that walked `stashes[]` separately
 * for each provider kind. Disabled entries (`enabled: false`) and entries
 * whose disk path doesn't exist are filtered after deduplication.
 */
export function resolveStashSources(overrideStashDir?: string, existingConfig?: AkmConfig): SearchSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir();
  const config = existingConfig ?? loadConfig();

  const sources: SearchSource[] = [{ path: stashDir }];
  const seen = new Set<string>([path.resolve(stashDir)]);

  const addSource = (dir: string, registryId?: string, wikiName?: string) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (isSuspiciousStashRoot(dir)) {
      warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`);
    }
    if (isValidDirectory(dir)) {
      sources.push({
        path: resolved,
        ...(registryId ? { registryId } : {}),
        ...(wikiName ? { wikiName } : {}),
      });
    }
  };

  // (1) + (2) Single pass over declared stashes — primary first if present,
  // then the rest in declared order. The primary's directory is already
  // injected as `sources[0]` above, so we only need to dedupe the source set.
  const stashes = config.stashes ?? [];
  const primaryIdx = stashes.findIndex((entry) => entry.primary === true);
  const ordered: StashConfigEntry[] = [];
  if (primaryIdx >= 0) {
    ordered.push(stashes[primaryIdx]);
    stashes.forEach((entry, i) => {
      if (i !== primaryIdx) ordered.push(entry);
    });
  } else {
    ordered.push(...stashes);
  }

  for (const entry of ordered) {
    if (entry.enabled === false) continue;
    const dir = resolveEntryContentDir(entry);
    if (dir == null) continue;
    addSource(dir, entry.name, entry.wikiName);
  }

  // (3) Installed stashes (registry-managed). Always last.
  for (const entry of config.installed ?? []) {
    addSource(entry.stashRoot, entry.id, entry.wikiName);
  }

  return sources;
}

/**
 * Resolve the content directory the indexer should walk for a given config
 * entry. Returns `undefined` if the entry has no walkable content
 * so the caller can skip it.
 */
function resolveEntryContentDir(entry: StashConfigEntry): string | undefined {
  if (entry.type === "filesystem" && entry.path) {
    return entry.path;
  }
  if (GIT_STASH_TYPES.has(entry.type) && entry.url) {
    try {
      const repo = parseGitRepoUrl(entry.url);
      const cachePaths = getCachePaths(repo.canonicalUrl);
      // The content/ subdirectory inside the extracted repo is the actual
      // stash root containing DOC.md / SKILL.md files that the walker indexes.
      return path.join(cachePaths.repoDir, "content");
    } catch (err) {
      warn(
        `Warning: failed to resolve git stash cache for "${entry.url}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
  if (entry.type === "website" && entry.url) {
    try {
      return getWebsiteCachePaths(entry.url).stashDir;
    } catch (err) {
      warn(
        `Warning: failed to resolve website stash cache for "${entry.url}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
  // Entries with no walkable directory (e.g. unsupported provider types).
  return undefined;
}

/**
 * Convenience: returns just the directory paths, preserving priority order.
 */
export function resolveAllStashDirs(overrideStashDir?: string): string[] {
  return resolveStashSources(overrideStashDir).map((s) => s.path);
}

/**
 * Find which source a file path belongs to.
 */
export function findSourceForPath(filePath: string, sources: SearchSource[]): SearchSource | undefined {
  const resolved = path.resolve(filePath);
  for (const source of sources) {
    if (resolved.startsWith(path.resolve(source.path) + path.sep)) return source;
  }
  return undefined;
}

/**
 * Return the primary stash source (first entry in the list).
 * This is the user's working stash and the default destination for clone.
 */
export function getPrimarySource(sources: SearchSource[]): SearchSource | undefined {
  return sources[0];
}

// ── Editability ─────────────────────────────────────────────────────────────

/**
 * Determine whether a file is safe to edit in place.
 *
 * The only files that are NOT editable are those inside a cache directory
 * managed by the package manager (`installed[].cacheDir`). These
 * will be overwritten by `akm update` without warning.
 *
 * Everything else — working stash, additional stashes, local project dirs — is
 * the user's domain to manage.
 */
export function isEditable(filePath: string, config?: AkmConfig): boolean {
  const cfg = config ?? loadConfig();
  const resolved = path.resolve(filePath);
  const cacheManaged = cfg.installed ?? [];
  const isWin = process.platform === "win32";

  for (const entry of cacheManaged) {
    // Local sources reference original paths — always editable
    if (entry.source === "local") continue;
    const cacheRoot = path.resolve(entry.cacheDir);
    if (isWin) {
      // Windows paths are case-insensitive — normalize both sides
      if (resolved.toLowerCase().startsWith(cacheRoot.toLowerCase() + path.sep)) return false;
    } else {
      if (resolved.startsWith(cacheRoot + path.sep)) return false;
    }
  }

  return true;
}

/**
 * Build an actionable hint for the agent when a file is not editable.
 * Callers must check `isEditable()` before calling — this function
 * unconditionally returns the hint string.
 */
export function buildEditHint(_filePath: string, assetType: string, assetName: string, origin?: string): string {
  const ref = origin ? `${origin}//${assetType}:${assetName}` : `${assetType}:${assetName}`;
  return `This asset is managed by akm and may be overwritten on update. To edit, run: akm clone ${ref}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

const SUSPICIOUS_ROOTS = new Set(["/", "/etc", "/bin", "/sbin", "/usr", "/var", "/tmp", "/dev", "/proc", "/sys"]);

function isSuspiciousStashRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (SUSPICIOUS_ROOTS.has(normalized)) return true;
  if (process.platform === "win32") {
    // Check for Windows system directories
    const winDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
    if (normalized === winDir || normalized.startsWith(winDir + path.sep)) return true;
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── Stash cache integration ─────────────────────────────────────────────────

/**
 * Ensure all cache-backed stash providers are refreshed so their cache
 * directories exist on disk. Must be called (async) before
 * `resolveStashSources()` so the content directories pass the
 * `isValidDirectory()` check.
 */
export async function ensureStashCaches(config?: AkmConfig): Promise<void> {
  const cfg = config ?? loadConfig();
  for (const entry of cfg.stashes ?? []) {
    if (!GIT_STASH_TYPES.has(entry.type) || !entry.url || entry.enabled === false) continue;
    try {
      const repo = parseGitRepoUrl(entry.url);
      const cachePaths = getCachePaths(repo.canonicalUrl);
      await ensureGitMirror(repo, cachePaths, { requireRepoDir: true, writable: entry.writable === true });
    } catch (err) {
      warn(
        `Warning: failed to refresh git mirror for "${entry.url}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const entry of cfg.stashes ?? []) {
    if (entry.type !== "website" || !entry.url || entry.enabled === false) continue;
    try {
      await ensureWebsiteMirror(entry, { requireStashDir: true });
    } catch (err) {
      warn(
        `Warning: failed to refresh website stash for "${entry.url}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** @deprecated Use ensureStashCaches instead. */
export const ensureGitCaches = ensureStashCaches;
/** @deprecated Use ensureStashCaches instead. */
export const ensureContextHubCaches = ensureStashCaches;
