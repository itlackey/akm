// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { isRemoteUrl } from "../../core/common";
import type { BundleConfigEntry, SourceConfigEntry } from "../../core/config/config";
import { bundleEntryToSourceEntry, bundlesToSourceEntries, getSources, mutateConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import {
  type BundleInsertPosition,
  bundleKeyForPath,
  bundleKeyForUrl,
  nextBundleKey,
  placeBundle,
} from "./bundle-config-ops";

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

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Add a stash source (filesystem path or remote provider URL) to config.
 *
 * Filesystem paths are auto-detected when `target` does not start with
 * `http://` or `https://`. URL sources require a `providerType` option
 * (e.g. "website", "git").
 */
export function addStash(
  opts: {
    target: string;
    name?: string;
    providerType?: string;
    options?: Record<string, unknown>;
    writable?: boolean;
    credential?: string;
  } & BundleInsertPosition,
): SourceAddResult {
  const { target, name, providerType, options: providerOptions, writable, credential, before, after } = opts;
  if (providerType === "openviking") {
    throw new ConfigError("openviking is not supported in akm v1.", "INVALID_CONFIG_FILE");
  }
  if (writable === true && providerType && providerType !== "filesystem" && providerType !== "git") {
    throw new ConfigError("writable: true is only supported on filesystem and git sources", "INVALID_CONFIG_FILE");
  }
  if (credential && providerType !== "git") {
    throw new ConfigError("credential is only supported on git sources", "INVALID_CONFIG_FILE");
  }
  let result: SourceAddResult | undefined;

  const targetIsUrl = isRemoteUrl(target);
  if (targetIsUrl && !providerType) {
    throw new UsageError("--provider is required for URL sources (e.g. --provider git --provider website)");
  }
  // R-013: `--provider npm` names an npm package SPEC (e.g. "lodash",
  // "@scope/pkg@^2"), never a URL — a tarball URL is not installable as a
  // package spec and would only fail much later, at first sync, with a
  // confusing "Invalid npm package name" error. Reject it loudly here instead.
  if (providerType === "npm" && targetIsUrl) {
    throw new UsageError(
      `--provider npm expects a package spec (e.g. "lodash" or "@scope/pkg@^2"), not a URL: "${target}". ` +
        "Drop --provider npm and re-run `akm bundle add <package>` to add an npm source.",
    );
  }
  // A bare (non-URL) target with --provider npm is a declarative npm source
  // add — the same "locator, not a URL" descriptor path used for git/website
  // URL sources below. Without this, a non-URL target fell through to the
  // filesystem branch below and `--provider npm` was silently ignored,
  // creating a bogus filesystem bundle for the current working directory
  // (R-013).
  const useDescriptorPath = targetIsUrl || providerType === "npm";
  mutateConfig((config) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    let key: string;
    if (useDescriptorPath) {
      if (bundleKeyForUrl(config, target)) {
        const already = targetIsUrl ? "Source URL already configured" : "Source already configured";
        result = { sources: getSources(config), added: false, message: already };
        return config;
      }
      key = nextBundleKey(bundles, name, target);
      const entry = urlBundleDescriptor(providerType as string, target, providerOptions, writable === true, credential);
      const nextBundles = placeBundle(bundles, key, entry, { before, after });
      const next = { ...config, bundles: nextBundles };
      result = {
        sources: bundlesToSourceEntries(next) ?? [],
        added: true,
        entry: bundleEntryToSourceEntry(key, entry) as SourceConfigEntry,
      };
      return next;
    } else {
      const resolvedPath = path.resolve(target);
      if (bundleKeyForPath(config, resolvedPath)) {
        result = { sources: getSources(config), added: false, message: "Source path already configured" };
        return config;
      }
      key = nextBundleKey(bundles, name, resolvedPath);
      const entry: BundleConfigEntry = {
        path: resolvedPath,
        ...(writable === true ? { writable: true } : {}),
        components: {
          main: { root: ".", adapter: detectAdapterId(resolvedPath), writable: writable ?? true },
        },
      };
      const nextBundles = placeBundle(bundles, key, entry, { before, after });
      const next = { ...config, bundles: nextBundles };
      result = {
        sources: bundlesToSourceEntries(next) ?? [],
        added: true,
        entry: bundleEntryToSourceEntry(key, entry) as SourceConfigEntry,
      };
      return next;
    }
  });
  return result as SourceAddResult;
}

/**
 * Build the 0.9.0 bundle descriptor for a declarative (non-filesystem) source
 * (spec §10.1). `locator` is a URL for git/website; for npm it is a bare
 * package spec (e.g. "lodash", "@scope/pkg@^2") — never a URL (R-013,
 * rejected earlier in {@link addStash}).
 */
function urlBundleDescriptor(
  providerType: string,
  locator: string,
  options: Record<string, unknown> | undefined,
  writable: boolean,
  credential?: string,
): BundleConfigEntry {
  if (providerType === "website") {
    // Website provider options ride on the (passthrough) website descriptor and
    // round-trip back to `entry.options` via bundleEntryToSourceEntry.
    return {
      website: { url: locator, ...(options ?? {}) },
      components: { main: { root: ".", adapter: "website-snapshot", writable: false } },
    };
  }
  if (providerType === "npm") return { npm: locator };
  if (providerType === "git") {
    return { git: locator, ...(writable ? { writable: true } : {}), ...(credential ? { credential } : {}) };
  }
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
    const removed = bundleEntryToSourceEntry(key, bundles[key]!) as SourceConfigEntry;
    delete bundles[key];
    const next = { ...config, bundles: Object.keys(bundles).length > 0 ? bundles : undefined };
    result = { sources: bundlesToSourceEntries(next) ?? [], removed: true, entry: removed };
    return next;
  });
  return result as SourceRemoveResult;
}
