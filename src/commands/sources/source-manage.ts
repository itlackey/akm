// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { isRemoteUrl } from "../../core/common";
import type { BundleConfigEntry, SourceConfigEntry } from "../../core/config/config";
import {
  bundleEntryToSourceEntry,
  bundlesToSourceEntries,
  getSources,
  loadConfig,
  mutateConfig,
} from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { bundleKeyForPath, bundleKeyForUrl, nextBundleKey } from "./bundle-config-ops";

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
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    let key: string;
    if (isRemoteUrl(target)) {
      if (bundleKeyForUrl(config, target)) {
        result = { sources: getSources(config), added: false, message: "Source URL already configured" };
        return config;
      }
      key = nextBundleKey(bundles, name, target);
      bundles[key] = urlBundleDescriptor(providerType as string, target, providerOptions, writable === true);
    } else {
      const resolvedPath = path.resolve(target);
      if (bundleKeyForPath(config, resolvedPath)) {
        result = { sources: getSources(config), added: false, message: "Source path already configured" };
        return config;
      }
      key = nextBundleKey(bundles, name, resolvedPath);
      bundles[key] = { path: resolvedPath, ...(writable === true ? { writable: true } : {}) };
    }
    const next = { ...config, bundles };
    const entry = bundleEntryToSourceEntry(key, bundles[key]) as SourceConfigEntry;
    result = { sources: bundlesToSourceEntries(next) ?? [], added: true, entry };
    return next;
  });
  return result as SourceAddResult;
}

/** Build the 0.9.0 bundle descriptor for a URL source (spec §10.1). */
function urlBundleDescriptor(
  providerType: string,
  url: string,
  options: Record<string, unknown> | undefined,
  writable: boolean,
): BundleConfigEntry {
  if (providerType === "website") {
    // Website provider options ride on the (passthrough) website descriptor and
    // round-trip back to `entry.options` via bundleEntryToSourceEntry.
    return { website: { url, ...(options ?? {}) } };
  }
  if (providerType === "npm") return { npm: url };
  if (providerType === "git") return { git: url, ...(writable ? { writable: true } : {}) };
  throw new ConfigError(
    `unsupported source type "${providerType}"; expected filesystem, git, website, or npm`,
    "INVALID_CONFIG_FILE",
  );
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
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    // Match priority: URL > path > bundle key (name).
    let key = isUrlTarget ? bundleKeyForUrl(config, target) : undefined;
    if (!key && resolvedPath) key = bundleKeyForPath(config, resolvedPath);
    if (!key && target in bundles) key = target;
    if (!key) {
      result = { sources: getSources(config), removed: false, message: "No matching source found" };
      return config;
    }
    const removed = bundleEntryToSourceEntry(key, bundles[key]) as SourceConfigEntry;
    delete bundles[key];
    const next = { ...config, bundles: Object.keys(bundles).length > 0 ? bundles : undefined };
    result = { sources: bundlesToSourceEntries(next) ?? [], removed: true, entry: removed };
    return next;
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
