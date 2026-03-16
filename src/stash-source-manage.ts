import path from "node:path";
import type { StashConfigEntry } from "./config";
import { loadConfig, saveConfig } from "./config";
import { UsageError } from "./errors";
import { resolveStashSources } from "./stash-source";

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
  remoteSources?: StashConfigEntry[];
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Add a stash source (filesystem path or remote provider URL) to config.
 *
 * Filesystem paths are auto-detected when `target` does not start with
 * `http://` or `https://`. URL sources require a `providerType` option
 * (e.g. "openviking").
 */
export function addStashSource(opts: {
  target: string;
  name?: string;
  providerType?: string;
  options?: Record<string, unknown>;
}): SourceAddResult {
  const { target, name, providerType, options: providerOptions } = opts;
  const config = loadConfig();
  const stashes = [...(config.stashes ?? [])];
  const isUrl = target.startsWith("http://") || target.startsWith("https://");

  let entry: StashConfigEntry;

  if (isUrl) {
    if (!providerType) {
      throw new UsageError("--provider is required for URL sources (e.g. --provider openviking)");
    }
    // Deduplicate by URL
    if (stashes.some((s) => s.url === target)) {
      return { stashes, added: false, message: "Source URL already configured" };
    }
    entry = { type: providerType, url: target };
    if (name) entry.name = name;
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

  // Drop legacy remoteStashSources when writing stashes
  const { remoteStashSources, ...rest } = config;
  saveConfig({ ...rest, stashes });

  return { stashes, added: true, entry };
}

/**
 * Remove a stash source by URL, path, or name.
 * Match priority: URL > path > name (most specific first).
 */
export function removeStashSource(target: string): SourceRemoveResult {
  const config = loadConfig();
  const stashes = [...(config.stashes ?? [])];
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
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

  // Drop legacy remoteStashSources when writing stashes (same as addStashSource)
  const { remoteStashSources, ...rest } = config;
  saveConfig({ ...rest, stashes });

  return { stashes, removed: true, entry: removed };
}

/**
 * List all stash sources (local filesystem + configured stashes + legacy remote).
 */
export function listStashSources(): SourceListResult {
  const config = loadConfig();
  const localSources = resolveStashSources();
  const stashes = config.stashes ?? [];
  // Legacy fallback: show remoteStashSources if no stashes config
  const legacyRemote = !config.stashes ? (config.remoteStashSources ?? []) : [];

  return {
    localSources,
    stashes,
    ...(legacyRemote.length > 0 ? { remoteSources: legacyRemote } : {}),
  };
}
