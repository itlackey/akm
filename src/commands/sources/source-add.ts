// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { isBundleSlug } from "../../core/asset/asset-ref";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry, SourceConfigEntry } from "../../core/config/config";
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
import { storeSecretResolver } from "../../sources/snapshot-fetchers/secret-seam";
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
  /** Override the auto-detected component adapter (#909). Local (filesystem) adds only. */
  adapter?: string;
}): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref)
    throw new UsageError(
      "Install ref or local directory is required. " +
        "Examples: `akm bundle add @scope/stash`, `akm bundle add github:owner/repo`, `akm bundle add ./local/path`",
    );

  const stashDir = resolveStashDir();

  if (shouldAddAsWebsiteUrl(ref)) {
    return addWebsiteSource(ref, stashDir, input.name, input.options);
  }

  // Local directories become filesystem bundles; registry refs use the
  // registry-backed bundle installer below.
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      return addLocalSource(ref, parsed.sourcePath, stashDir, input.name, input.adapter);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryStash(ref, stashDir, input.writable);
}

/** Add a local directory as a filesystem bundle. */
async function addLocalSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  explicitName?: string,
  explicitAdapter?: string,
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  const adapter = explicitAdapter ?? detectAdapterId(resolvedPath);
  let bundleKey = explicitName ?? toReadableId(resolvedPath);
  mutateConfig((config) => {
    const existing = bundleKeyForPath(config, resolvedPath);
    if (existing) {
      bundleKey = existing;
      const current = config.bundles?.[existing];
      if (current?.components && explicitAdapter === undefined) return config;
      const bundles = { ...(config.bundles ?? {}) };
      bundles[existing] = {
        ...current,
        path: resolvedPath,
        components: { main: { root: ".", adapter } },
      };
      return { ...config, bundles };
    }
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    bundleKey = nextBundleKey(bundles, explicitName, resolvedPath);
    bundles[bundleKey] = {
      path: resolvedPath,
      components: { main: { root: ".", adapter } },
    };
    return { ...config, bundles };
  });

  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    ref,
    sourceAdded: {
      type: "filesystem",
      path: resolvedPath,
      name: bundleKey,
      stashRoot: resolvedPath,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      // `IndexResponse.directoriesScanned`/`directoriesSkipped` were renamed/
      // removed (#index-redesign W6: reconcile is a flat per-file stat walk,
      // never a directory walk) — this response's own `directoriesScanned`/
      // `directoriesSkipped` shape is unchanged, so bridge from the renamed
      // source field; `directoriesSkipped` was already always 0.
      directoriesScanned: index.sourcesScanned,
      directoriesSkipped: 0,
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
  const numberOption = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  const maxPages = numberOption(options?.maxPages);
  const maxDepth = numberOption(options?.maxDepth);
  let entry: SourceConfigEntry | undefined;
  mutateConfig((config) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    const existingKey = bundleKeyForUrl(config, normalizedUrl);
    const key = existingKey ?? nextBundleKey(bundles, name ?? toWebsiteName(normalizedUrl), normalizedUrl);
    // Merge onto the existing descriptor rather than replacing it: re-running
    // `bundle add` for a URL that already has a bundle would otherwise drop
    // respectRobots / refresh, silently restoring default robots enforcement
    // and changing what the next update fetches. Explicitly-passed maxPages /
    // maxDepth still win over the stored values.
    const existingWebsite = existingKey ? ((bundles[key]?.website ?? {}) as Record<string, unknown>) : {};
    const website = {
      ...existingWebsite,
      url: normalizedUrl,
      ...(maxPages !== undefined ? { maxPages } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    };
    const nextBundle: BundleConfigEntry = {
      ...(existingKey ? bundles[key] : {}),
      website,
      components: { main: { root: ".", adapter: "website-snapshot", writable: false } },
    };
    if (JSON.stringify(bundles[key]) === JSON.stringify(nextBundle)) {
      entry = bundleEntryToSourceEntry(key, bundles[key]!) as SourceConfigEntry;
      return config;
    }
    bundles[key] = nextBundle;
    entry = bundleEntryToSourceEntry(key, nextBundle) as SourceConfigEntry;
    return { ...config, bundles };
  });

  const cachePaths = await ensureWebsiteMirror(entry as SourceConfigEntry, {
    requireStashDir: true,
    resolveSecret: storeSecretResolver.resolveSecret,
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  });
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    ref,
    sourceAdded: {
      type: "website",
      url: normalizedUrl,
      name: entry?.name,
      stashRoot: cachePaths.stashDir,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      // `IndexResponse.directoriesScanned`/`directoriesSkipped` were renamed/
      // removed (#index-redesign W6: reconcile is a flat per-file stat walk,
      // never a directory walk) — this response's own `directoriesScanned`/
      // `directoriesSkipped` shape is unchanged, so bridge from the renamed
      // source field; `directoriesSkipped` was already always 0.
      directoriesScanned: index.sourcesScanned,
      directoriesSkipped: 0,
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
  if (writable === true && parsedRef.source !== "git" && parsedRef.source !== "github") {
    throw new ConfigError("writable: true is only supported on filesystem and git sources", "INVALID_CONFIG_FILE");
  }

  const currentConfig = loadConfig();
  const existingBundleKey = findInstalledBundleKey(currentConfig.bundles ?? {}, parsedRef.id);
  const existingBundle = existingBundleKey ? currentConfig.bundles?.[existingBundleKey] : undefined;
  const priorLock = existingBundleKey ? readLockfile().find((entry) => entry.id === existingBundleKey) : undefined;
  const existingWritable =
    Object.values(existingBundle?.components ?? {})[0]?.writable ?? existingBundle?.writable === true;
  const effectiveWritable = writable === true || existingWritable;
  const requiredRoots = priorLock?.localRoot
    ? Object.values(existingBundle?.components ?? {}).map((component) =>
        path.resolve(priorLock.localRoot as string, component.root ?? "."),
      )
    : [];
  const synced = await syncFromRef(ref, {
    writable: effectiveWritable,
    ...(effectiveWritable && priorLock?.localRoot ? { writableRoot: priorLock.localRoot } : {}),
    ...(requiredRoots.length > 0 ? { writableRequiredRoots: requiredRoots } : {}),
  });

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
  const priorLocalRoot = priorLock?.localRoot;

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
  if (!effectiveWritable && priorLocalRoot && path.resolve(priorLocalRoot) !== path.resolve(synced.contentDir)) {
    try {
      fs.rmSync(priorLocalRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  const index = await akmIndex({ stashDir });

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
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
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      // `IndexResponse.directoriesScanned`/`directoriesSkipped` were renamed/
      // removed (#index-redesign W6: reconcile is a flat per-file stat walk,
      // never a directory walk) — this response's own `directoriesScanned`/
      // `directoriesSkipped` shape is unchanged, so bridge from the renamed
      // source field; `directoriesSkipped` was already always 0.
      directoriesScanned: index.sourcesScanned,
      directoriesSkipped: 0,
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
    const existingComponents = bundles[bundleId]?.components;
    const components = existingComponents
      ? Object.fromEntries(
          Object.entries(existingComponents).map(([id, component]) => [
            id,
            { ...component, writable: entry.writable === true },
          ]),
        )
      : {
          main: {
            root: ".",
            adapter: detectAdapterId(path.resolve(entry.stashRoot)),
            writable: entry.writable === true,
          },
        };
    const descriptor = installedSourceDescriptor(entry.source, entry.ref, path.resolve(entry.stashRoot));
    bundles[bundleId] = {
      ...descriptor,
      ...(entry.writable === true ? { writable: true } : {}),
      ...(entry.id !== bundleId ? { registryId: entry.id } : {}),
      components: components satisfies NonNullable<BundleConfigEntry["components"]>,
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
