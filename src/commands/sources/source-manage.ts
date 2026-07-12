// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { isRemoteUrl } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { getSources, loadConfig, mutateConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { resolveSourceEntries } from "../../indexer/search/search-source";

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
  let result: SourceAddResult | undefined;

  if (isRemoteUrl(target)) {
    if (!providerType) {
      throw new UsageError("--provider is required for URL sources (e.g. --provider git --provider website)");
    }
  }
  mutateConfig((config) => {
    const sources = [...getSources(config)];
    let entry: SourceConfigEntry;
    if (isRemoteUrl(target)) {
      if (sources.some((source) => source.url === target)) {
        result = { sources, added: false, message: "Source URL already configured" };
        return config;
      }
      entry = { type: providerType as string, url: target };
      if (name) entry.name = name;
      if (writable) entry.writable = true;
      if (providerOptions) entry.options = providerOptions;
    } else {
      const resolvedPath = path.resolve(target);
      if (sources.some((source) => source.path && path.resolve(source.path) === resolvedPath)) {
        result = { sources, added: false, message: "Source path already configured" };
        return config;
      }
      entry = { type: "filesystem", path: resolvedPath };
      if (name) entry.name = name;
    }
    sources.push(entry);
    result = { sources, added: true, entry };
    return { ...config, sources };
  });
  return result as SourceAddResult;
}

/**
 * Remove a stash source by URL, path, or name.
 * Match priority: URL > path > name (most specific first).
 */
export function removeStash(target: string): SourceRemoveResult {
  const isUrlTarget = isRemoteUrl(target);
  const resolvedPath = !isUrlTarget ? path.resolve(target) : undefined;
  let result: SourceRemoveResult | undefined;
  mutateConfig((config) => {
    const sources = [...getSources(config)];
    let idx = isUrlTarget ? sources.findIndex((source) => source.url === target) : -1;
    if (idx === -1 && resolvedPath) {
      idx = sources.findIndex((source) => source.path && path.resolve(source.path) === resolvedPath);
    }
    if (idx === -1) idx = sources.findIndex((source) => source.name === target);
    if (idx === -1) {
      result = { sources, removed: false, message: "No matching source found" };
      return config;
    }
    const removed = sources.splice(idx, 1)[0];
    result = { sources, removed: true, entry: removed };
    return { ...config, sources };
  });
  return result as SourceRemoveResult;
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
