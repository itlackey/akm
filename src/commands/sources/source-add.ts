// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isBundleSlug } from "../../core/asset/asset-ref";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry, SourceConfigEntry, SourceSpec } from "../../core/config/config";
import {
  bundleEntryToSourceEntry,
  getSources,
  installedSourceDescriptor,
  loadConfig,
  mutateConfig,
} from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { akmIndex } from "../../indexer/indexer";
import { deriveBundleId } from "../../indexer/installations";
import { readLockfile, removeLockEntry, upsertLockEntry } from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle } from "../../registry/types";
import { detectStashRoot } from "../../sources/providers/provider-utils";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import {
  ensureWebsiteMirror,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteInputUrl,
} from "../../sources/snapshot-fetchers/website-ingest";
import type { AddResponse } from "../../sources/types";
import { bundleKeyForPath, bundleKeyForUrl, nextBundleKey } from "./bundle-config-ops";

export async function akmAdd(input: {
  ref: string;
  name?: string;
  options?: Record<string, unknown>;
  writable?: boolean;
}): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref)
    throw new UsageError(
      "Install ref or local directory is required. " +
        "Examples: `akm add @scope/stash`, `akm add github:owner/repo`, `akm add ./local/path`",
    );

  const stashDir = resolveStashDir();

  if (shouldAddAsWebsiteUrl(ref)) {
    return addWebsiteSource(ref, stashDir, input.name, input.options);
  }

  // Detect local directory refs and route them to stashes[] instead of installed[]
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      return addLocalSource(ref, parsed.sourcePath, stashDir, input.name);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryStash(ref, stashDir, input.writable);
}

/**
 * Add a local directory as a filesystem bundle (spec §10.1) — replaces the
 * retired `sources[]` filesystem entry.
 */
async function addLocalSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  explicitName?: string,
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  let bundleKey = explicitName ?? toReadableId(resolvedPath);
  mutateConfig((config) => {
    const existing = bundleKeyForPath(config, resolvedPath);
    if (existing) {
      // Already configured — the bundle key is the stable identity; leave it.
      bundleKey = existing;
      return config;
    }
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    bundleKey = nextBundleKey(bundles, explicitName, resolvedPath);
    bundles[bundleKey] = { path: resolvedPath };
    return { ...config, bundles };
  });

  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref,
    sourceAdded: {
      type: "filesystem",
      path: resolvedPath,
      name: bundleKey,
      stashRoot: resolvedPath,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
      installedKitCount: readLockfile().length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

async function addWebsiteSource(
  ref: string,
  stashDir: string,
  name?: string,
  options?: Record<string, unknown>,
): Promise<AddResponse> {
  const allowPrivateHosts = shouldAllowPrivateWebsiteUrlForTests(ref);
  const normalizedUrl = validateWebsiteInputUrl(ref, { allowPrivateHosts });
  const maxPages = typeof options?.maxPages === "number" ? (options.maxPages as number) : undefined;
  let entry: SourceConfigEntry | undefined;
  mutateConfig((config) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    const existingKey = bundleKeyForUrl(config, normalizedUrl);
    const key = existingKey ?? nextBundleKey(bundles, name ?? toWebsiteName(normalizedUrl), normalizedUrl);
    const website = { url: normalizedUrl, ...(maxPages !== undefined ? { maxPages } : {}) };
    const nextBundle: BundleConfigEntry = { ...(existingKey ? bundles[key] : {}), website };
    if (JSON.stringify(bundles[key]) === JSON.stringify(nextBundle)) {
      entry = bundleEntryToSourceEntry(key, bundles[key]) as SourceConfigEntry;
      return config;
    }
    bundles[key] = nextBundle;
    entry = bundleEntryToSourceEntry(key, nextBundle) as SourceConfigEntry;
    return { ...config, bundles };
  });

  const cachePaths = await ensureWebsiteMirror(entry as SourceConfigEntry, {
    requireStashDir: true,
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  });
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref,
    sourceAdded: {
      type: "website",
      url: normalizedUrl,
      name: entry?.name,
      stashRoot: cachePaths.stashDir,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
      installedKitCount: readLockfile().length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

/**
 * Install a stash from a registry (npm, github, git) by dispatching to the
 * matching syncable provider and persisting the lock entry.
 */
async function addRegistryStash(ref: string, stashDir: string, writable?: boolean): Promise<AddResponse> {
  const parsedRef = parseRegistryRef(ref);
  if (writable === true && parsedRef.source !== "git") {
    throw new ConfigError("writable: true is only supported on filesystem and git sources", "INVALID_CONFIG_FILE");
  }

  const synced = await syncFromRef(ref, { writable });

  const { config: updatedConfig, bundleId } = upsertInstalledRegistryEntry({
    id: synced.id,
    source: synced.source,
    ref: synced.ref,
    artifactUrl: synced.artifactUrl,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    stashRoot: synced.contentDir,
    cacheDir: synced.cacheDir,
    installedAt: synced.syncedAt,
    writable: synced.writable,
  });

  // The prior materialized root (if this is a re-install) — read BEFORE the lock
  // upsert overwrites it, so a moved cache root can be cleaned afterwards.
  const priorLocalRoot = readLockfile().find((e) => e.id === bundleId)?.localRoot;

  await upsertLockEntry({
    id: bundleId,
    source: synced.source,
    ref: synced.ref,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    integrity: synced.integrity,
    // §10.2 resolved lock state the install flow has on hand.
    localRoot: synced.contentDir,
    installedAt: synced.syncedAt,
  });

  // Clean up the old materialized root on re-install (moved cache).
  if (priorLocalRoot && path.resolve(priorLocalRoot) !== path.resolve(synced.contentDir)) {
    try {
      fs.rmSync(priorLocalRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  const index = await akmIndex({ stashDir });

  return {
    schemaVersion: 1,
    stashDir,
    ref,
    installed: {
      id: synced.id,
      source: synced.source,
      ref: synced.ref,
      artifactUrl: synced.artifactUrl,
      resolvedVersion: synced.resolvedVersion,
      resolvedRevision: synced.resolvedRevision,
      stashRoot: synced.contentDir,
      cacheDir: synced.cacheDir,
      extractedDir: synced.extractedDir,
      installedAt: synced.syncedAt,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
      installedKitCount: readLockfile().length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

/**
 * Persist or replace a registry-installed source as a 0.9.0 `bundles` entry
 * (spec §10.1 / §10.2 desired/resolved split). The bundle carries ONLY the
 * desired descriptor (git/npm locator + preserved `registryId` + `writable`);
 * the resolved cache root belongs exclusively in the lock (written by callers
 * via {@link upsertLockEntry} with the returned `bundleId`). Returns the config
 * plus the derived bundle id so the caller keys its lock entry identically.
 */
export function upsertInstalledRegistryEntry(entry: InstalledBundle): { config: AkmConfig; bundleId: string } {
  let bundleId = entry.id;
  const config = mutateConfig((current) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(current.bundles ?? {}) };
    bundleId = resolveInstalledBundleKey(bundles, entry.id, entry.stashRoot);
    const descriptor = installedSourceDescriptor(entry.source, entry.ref, path.resolve(entry.stashRoot));
    bundles[bundleId] = {
      ...descriptor,
      ...(entry.writable === true ? { writable: true } : {}),
      ...(entry.id !== bundleId ? { registryId: entry.id } : {}),
    };
    return { ...current, bundles };
  }).config;
  return { config, bundleId };
}

/**
 * Remove a registry-installed source: delete its `bundles` entry and its lock
 * entry (spec §10.2). Matches the bundle by preserved `registryId` or by a
 * slug-legal install id used verbatim as the key. Idempotent.
 */
export async function removeInstalledRegistryEntry(id: string): Promise<AkmConfig> {
  let removedKey: string | undefined;
  const config = mutateConfig((current) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(current.bundles ?? {}) };
    const key = findInstalledBundleKey(bundles, id);
    if (!key) return current;
    removedKey = key;
    delete bundles[key];
    return { ...current, bundles: Object.keys(bundles).length > 0 ? bundles : undefined };
  }).config;
  if (removedKey) await removeLockEntry(removedKey);
  return config;
}

/**
 * The bundle key that maps to a registry install id, or `undefined` when no
 * bundle currently represents it. A non-slug-legal install id (e.g.
 * `github:owner/repo`) is preserved verbatim on the bundle's `registryId`; a
 * slug-legal id is used directly as the key.
 */
function findInstalledBundleKey(bundles: Record<string, BundleConfigEntry>, installId: string): string | undefined {
  for (const [key, bundle] of Object.entries(bundles)) {
    if (bundle.registryId === installId) return key;
  }
  if (isBundleSlug(installId) && installId in bundles) return installId;
  return undefined;
}

/**
 * The stable bundle key for a registry install: reuse the existing bundle for
 * this install id (so re-installs keep the same key), otherwise derive a
 * batch-unique key via the shared {@link deriveBundleId} (D-R5), unique against
 * the currently-configured bundle keys.
 */
function resolveInstalledBundleKey(
  bundles: Record<string, BundleConfigEntry>,
  installId: string,
  stashRoot: string,
): string {
  const existing = findInstalledBundleKey(bundles, installId);
  if (existing) return existing;
  return deriveBundleId(installId, path.resolve(stashRoot), new Set(Object.keys(bundles)));
}

function toReadableId(resolvedPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && resolvedPath.startsWith(home + path.sep)) {
    return `~${resolvedPath.slice(home.length)}`;
  }
  return resolvedPath;
}

// Keep this list limited to widely-used git hosts for the non-breaking
// "repo-like URL" fast-path; everything else continues to default to website snapshots.
const KNOWN_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht"]);

export function shouldAddAsWebsiteUrl(ref: string): boolean {
  return isHttpUrl(ref) && !isLikelyGitRepositoryUrl(ref);
}

function isLikelyGitRepositoryUrl(ref: string): boolean {
  try {
    const parsed = new URL(ref);
    return KNOWN_GIT_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.pathname.endsWith(".git");
  } catch {
    return false;
  }
}

function toWebsiteName(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

// Re-export SourceSpec (the discriminated union from #123) so existing
// importers of `upsertInstalledRegistryEntry` (formerly from registry-install)
// resolve the same nominal type.
export type { SourceSpec };
