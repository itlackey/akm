import path from "node:path";
import type { StashConfigEntry } from "./config";
import { loadConfig, loadUserConfig, saveConfig } from "./config";
import { UsageError } from "./errors";
import { resolveStashSources } from "./search-source";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourceAddResult {
  stashes: StashConfigEntry[];
  added: boolean;
  entry?: StashConfigEntry;
  message?: string;
}

export interface SourceRemoveResult {
  stashes: StashConfigEntry[];
  removed: boolean;
  entry?: StashConfigEntry;
  message?: string;
}

export interface SourceListResult {
  localSources: Array<{ path: string; registryId?: string }>;
  stashes: StashConfigEntry[];
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Add a stash source (filesystem path or remote provider URL) to config.
 *
 * Filesystem paths are auto-detected when `target` does not start with
 * `http://` or `https://`. URL sources require a `providerType` option
 * (e.g. "website", "git").
 */
export function addStash(opts: {
  target: string;
  name?: string;
  providerType?: string;
  options?: Record<string, unknown>;
  writable?: boolean;
}): SourceAddResult {
  const { target, name, providerType, options: providerOptions, writable } = opts;
  const config = loadUserConfig();
  const stashes = [...(config.stashes ?? [])];
  const isRemoteUrl =
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@") ||
    target.startsWith("ssh://") ||
    target.startsWith("git://");

  let entry: StashConfigEntry;

  if (isRemoteUrl) {
    if (!providerType) {
      throw new UsageError("--provider is required for URL sources (e.g. --provider git --provider website)");
    }
    // Deduplicate by URL
    if (stashes.some((s) => s.url === target)) {
      return { stashes, added: false, message: "Source URL already configured" };
    }
    entry = { type: providerType, url: target };
    if (name) entry.name = name;
    if (writable) entry.writable = true;
    if (providerOptions) entry.options = providerOptions;
  } else {
    // Filesystem path
    const resolvedPath = path.resolve(target);
    if (stashes.some((s) => s.path && path.resolve(s.path) === resolvedPath)) {
      return { stashes, added: false, message: "Source path already configured" };
    }
    entry = { type: "filesystem", path: resolvedPath };
    if (name) entry.name = name;
  }

  stashes.push(entry);
  saveConfig({ ...config, stashes });

  return { stashes, added: true, entry };
}

/**
 * Remove a stash source by URL, path, or name.
 * Match priority: URL > path > name (most specific first).
 */
export function removeStash(target: string): SourceRemoveResult {
  const config = loadUserConfig();
  const stashes = [...(config.stashes ?? [])];
  const isUrl =
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@") ||
    target.startsWith("ssh://") ||
    target.startsWith("git://");
  const resolvedPath = !isUrl ? path.resolve(target) : undefined;

  // Try URL match first, then path, then name (most specific → least specific)
  let idx = -1;
  if (isUrl) {
    idx = stashes.findIndex((s) => s.url === target);
  }
  if (idx === -1 && resolvedPath) {
    idx = stashes.findIndex((s) => s.path && path.resolve(s.path) === resolvedPath);
  }
  if (idx === -1) {
    idx = stashes.findIndex((s) => s.name === target);
  }

  if (idx === -1) {
    return { stashes, removed: false, message: "No matching source found" };
  }

  const removed = stashes.splice(idx, 1)[0];
  saveConfig({ ...config, stashes });

  return { stashes, removed: true, entry: removed };
}

/**
 * List all stash sources (local filesystem + configured stashes).
 */
export function listStashes(): SourceListResult {
  const config = loadConfig();
  const localSources = resolveStashSources();
  const stashes = config.stashes ?? [];

  return { localSources, stashes };
}
