// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import type { SourceConfigEntry, SourceSpec } from "../../core/config/config";
import { getSources, loadConfig, mutateConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { akmIndex } from "../../indexer/indexer";
import { upsertLockEntry } from "../../integrations/lockfile";
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
 * Add a local directory as a filesystem stash source.
 * Creates a stashes[] entry instead of an installed[] entry.
 */
async function addLocalSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  explicitName?: string,
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  // Derive the canonical name: explicit --name wins, then readable path.
  const derivedName = explicitName ?? toReadableId(resolvedPath);
  let persistedEntry: SourceConfigEntry | undefined;
  mutateConfig((config) => {
    const sources = [...getSources(config)];
    const index = sources.findIndex(
      (source) => source.type === "filesystem" && source.path && path.resolve(source.path) === resolvedPath,
    );
    if (index < 0) {
      persistedEntry = {
        type: "filesystem",
        path: resolvedPath,
        name: derivedName,
      };
      sources.push(persistedEntry);
      return { ...config, sources };
    }
    const existing = { ...sources[index] };
    if (explicitName) existing.name = explicitName;
    persistedEntry = existing;
    if (JSON.stringify(existing) === JSON.stringify(sources[index])) return config;
    sources[index] = existing;
    return { ...config, sources };
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
      name: persistedEntry?.name ?? toReadableId(resolvedPath),
      stashRoot: resolvedPath,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
      installedKitCount: updatedConfig.installed?.length ?? 0,
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
  let entry: SourceConfigEntry | undefined;
  mutateConfig((config) => {
    const sources = [...getSources(config)];
    const index = sources.findIndex((source) => source.type === "website" && source.url === normalizedUrl);
    if (index < 0) {
      entry = {
        type: "website",
        url: normalizedUrl,
        name: name ?? toWebsiteName(normalizedUrl),
        ...(options && Object.keys(options).length > 0 ? { options } : {}),
      };
      sources.push(entry);
      return { ...config, sources };
    }
    const existing = { ...sources[index] };
    if (options && Object.keys(options).length > 0) existing.options = { ...existing.options, ...options };
    entry = existing;
    if (JSON.stringify(existing) === JSON.stringify(sources[index])) return config;
    sources[index] = existing;
    return { ...config, sources };
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
      installedKitCount: updatedConfig.installed?.length ?? 0,
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

  const replaced = (loadConfig().installed ?? []).find((entry) => entry.id === synced.id);
  const updatedConfig = upsertInstalledRegistryEntry({
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

  await upsertLockEntry({
    id: synced.id,
    source: synced.source,
    ref: synced.ref,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    integrity: synced.integrity,
  });

  // Clean up old cache directory on re-install
  if (replaced && replaced.cacheDir !== synced.cacheDir) {
    try {
      fs.rmSync(replaced.cacheDir, { recursive: true, force: true });
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
      installedKitCount: updatedConfig.installed?.length ?? 0,
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

/** Persist or replace an installed stash entry in the user config. */
export function upsertInstalledRegistryEntry(entry: InstalledBundle) {
  return mutateConfig((current) => {
    const withoutExisting = (current.installed ?? []).filter((item) => item.id !== entry.id);
    return { ...current, installed: [...withoutExisting, normalizeInstalledEntry(entry)] };
  }).config;
}

/** Remove an installed stash entry from the user config. */
export function removeInstalledRegistryEntry(id: string) {
  return mutateConfig((current) => {
    const currentInstalled = current.installed ?? [];
    const nextInstalled = currentInstalled.filter((item) => item.id !== id);
    if (nextInstalled.length === currentInstalled.length) return current;
    return { ...current, installed: nextInstalled.length > 0 ? nextInstalled : undefined };
  }).config;
}

function normalizeInstalledEntry(entry: InstalledBundle): InstalledBundle {
  return {
    ...entry,
    stashRoot: path.resolve(entry.stashRoot),
    cacheDir: path.resolve(entry.cacheDir),
  };
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
