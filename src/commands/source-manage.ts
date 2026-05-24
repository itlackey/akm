// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { isRemoteUrl } from "../core/common";
import type { SourceConfigEntry } from "../core/config";
import { getSources, loadConfig, loadUserConfig, saveConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { resolveSourceEntries } from "../indexer/search-source";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourceAddResult {
  sources: SourceConfigEntry[];
  added: boolean;
  entry?: SourceConfigEntry;
  message?: string;
}

export interface SourceRemoveResult {
  sources: SourceConfigEntry[];
  removed: boolean;
  entry?: SourceConfigEntry;
  message?: string;
}

export interface SourceListResult {
  localSources: Array<{ path: string; registryId?: string }>;
  sources: SourceConfigEntry[];
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
  if (providerType === "openviking") {
    throw new ConfigError("openviking is not supported in akm v1.", "INVALID_CONFIG_FILE");
  }
  if (writable === true && providerType && providerType !== "filesystem" && providerType !== "git") {
    throw new ConfigError("writable: true is only supported on filesystem and git sources", "INVALID_CONFIG_FILE");
  }
  const config = loadUserConfig();
  const sources = [...getSources(config)];
  let entry: SourceConfigEntry;

  if (isRemoteUrl(target)) {
    if (!providerType) {
      throw new UsageError("--provider is required for URL sources (e.g. --provider git --provider website)");
    }
    // Deduplicate by URL
    if (sources.some((s) => s.url === target)) {
      return { sources, added: false, message: "Source URL already configured" };
    }
    entry = { type: providerType, url: target };
    if (name) entry.name = name;
    if (writable) entry.writable = true;
    if (providerOptions) entry.options = providerOptions;
  } else {
    // Filesystem path
    const resolvedPath = path.resolve(target);
    if (sources.some((s) => s.path && path.resolve(s.path) === resolvedPath)) {
      return { sources, added: false, message: "Source path already configured" };
    }
    entry = { type: "filesystem", path: resolvedPath };
    if (name) entry.name = name;
  }

  sources.push(entry);
  saveConfig({ ...config, sources });

  return { sources, added: true, entry };
}

/**
 * Remove a stash source by URL, path, or name.
 * Match priority: URL > path > name (most specific first).
 */
export function removeStash(target: string): SourceRemoveResult {
  const config = loadUserConfig();
  const sources = [...getSources(config)];
  const isUrlTarget = isRemoteUrl(target);
  const resolvedPath = !isUrlTarget ? path.resolve(target) : undefined;

  // Try URL match first, then path, then name (most specific → least specific)
  let idx = -1;
  if (isUrlTarget) {
    idx = sources.findIndex((s) => s.url === target);
  }
  if (idx === -1 && resolvedPath) {
    idx = sources.findIndex((s) => s.path && path.resolve(s.path) === resolvedPath);
  }
  if (idx === -1) {
    idx = sources.findIndex((s) => s.name === target);
  }

  if (idx === -1) {
    return { sources, removed: false, message: "No matching source found" };
  }

  const removed = sources.splice(idx, 1)[0];
  saveConfig({ ...config, sources });

  return { sources, removed: true, entry: removed };
}

/**
 * List all stash sources (local filesystem + configured stashes).
 */
export function listStashes(): SourceListResult {
  const config = loadConfig();
  const localSources = resolveSourceEntries();
  const sources = getSources(config);

  return { localSources, sources };
}
