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
import type { InstalledStashEntry } from "../../registry/types";
import { detectStashRoot } from "../../sources/providers/provider-utils";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import type { AddResponse } from "../../sources/types";
import {
  ensureWebsiteMirror,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteInputUrl,
} from "../../sources/website-ingest";
import { ensureWikiNameAvailable, validateWikiName } from "../../wiki/wiki";

const VALID_OVERRIDE_TYPES = new Set(["wiki"]);

export async function akmAdd(input: {
  ref: string;
  name?: string;
  overrideType?: string;
  options?: Record<string, unknown>;
  writable?: boolean;
}): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref)
    throw new UsageError(
      "Install ref or local directory is required. " +
        "Examples: `akm add @scope/stash`, `akm add github:owner/repo`, `akm add ./local/path`",
    );

  // Validate and resolve wiki name when --type wiki is used
  let wikiName: string | undefined;
  if (input.overrideType) {
    if (!VALID_OVERRIDE_TYPES.has(input.overrideType)) {
      throw new UsageError(
        `Invalid --type value: "${input.overrideType}". Supported types: ${[...VALID_OVERRIDE_TYPES].join(", ")}`,
      );
    }
    if (input.overrideType === "wiki") {
      const derived = input.name ?? deriveWikiNameFromRef(ref);
      validateWikiName(derived);
      wikiName = derived;
    }
  }

  const stashDir = resolveStashDir();

  if (shouldAddAsWebsiteUrl(ref)) {
    return addWebsiteSource(ref, stashDir, input.name ?? wikiName, input.options, wikiName);
  }

  // Detect local directory refs and route them to stashes[] instead of installed[]
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      return addLocalSource(ref, parsed.sourcePath, stashDir, wikiName, input.name);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryStash(ref, stashDir, input.writable, wikiName);
}

export async function registerWikiSource(input: {
  ref: string;
  name?: string;
  options?: Record<string, unknown>;
  writable?: boolean;
}): Promise<AddResponse> {
  const stashDir = resolveStashDir();
  const name = input.name ?? deriveWikiNameFromRef(input.ref);
  validateWikiName(name);
  ensureWikiNameAvailable(stashDir, name);
  return akmAdd({
    ref: input.ref,
    name,
    overrideType: "wiki",
    options: input.options,
    writable: input.writable,
  });
}

/**
 * Add a local directory as a filesystem stash source.
 * Creates a stashes[] entry instead of an installed[] entry.
 */
async function addLocalSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  wikiName?: string,
  explicitName?: string,
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  // Derive the canonical name: explicit --name wins, then wiki name, then readable path.
  const derivedName = explicitName ?? wikiName ?? toReadableId(resolvedPath);
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
        ...(wikiName ? { wikiName } : {}),
      };
      sources.push(persistedEntry);
      return { ...config, sources };
    }
    const existing = { ...sources[index] };
    if (explicitName) existing.name = explicitName;
    if (wikiName) existing.wikiName = wikiName;
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
    ref: wikiName ?? ref,
    sourceAdded: {
      type: "filesystem",
      path: resolvedPath,
      name: persistedEntry?.name ?? toReadableId(resolvedPath),
      stashRoot: resolvedPath,
      ...(persistedEntry?.wikiName ? { wiki: persistedEntry.wikiName } : {}),
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
  wikiName?: string,
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
        ...(wikiName ? { wikiName } : {}),
      };
      sources.push(entry);
      return { ...config, sources };
    }
    const existing = { ...sources[index] };
    if (options && Object.keys(options).length > 0) existing.options = { ...existing.options, ...options };
    if (wikiName) existing.wikiName = wikiName;
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
    ref: wikiName ?? ref,
    sourceAdded: {
      type: "website",
      url: normalizedUrl,
      name: entry?.name,
      stashRoot: cachePaths.stashDir,
      ...(entry?.wikiName ? { wiki: entry.wikiName } : {}),
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
async function addRegistryStash(
  ref: string,
  stashDir: string,
  writable?: boolean,
  wikiName?: string,
): Promise<AddResponse> {
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
    ...(wikiName ? { wikiName } : {}),
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
export function upsertInstalledRegistryEntry(entry: InstalledStashEntry) {
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

function normalizeInstalledEntry(entry: InstalledStashEntry): InstalledStashEntry {
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

/**
 * Derive a wiki name from a ref string when --name is not provided.
 * Lowercases and slugifies the most meaningful identifier segment.
 */
export function deriveWikiNameFromRef(ref: string): string {
  let candidate = ref;

  // github:owner/repo or github:owner/repo@ref
  if (/^github:/i.test(ref)) {
    const repoPath = ref.replace(/^github:/i, "").split("@")[0];
    candidate = repoPath.split("/").pop() ?? repoPath;
  }
  // npm:pkg or @scope/pkg
  else if (/^npm:/i.test(ref) || ref.startsWith("@")) {
    candidate = ref
      .replace(/^npm:/i, "")
      .replace(/^@[^/]+\//, "")
      .split("@")[0];
  }
  // git URLs or HTTPS git URLs
  else if (/^(git:|https?:\/\/)/.test(ref)) {
    try {
      candidate = new URL(ref).pathname.split("/").pop() ?? candidate;
    } catch {
      candidate = ref.split("/").pop() ?? ref;
    }
    candidate = candidate.replace(/\.git$/, "");
  }
  // Local paths
  else {
    candidate = path.basename(ref.replace(/\/+$/, ""));
  }

  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Re-export SourceSpec (the discriminated union from #123) so existing
// importers of `upsertInstalledRegistryEntry` (formerly from registry-install)
// resolve the same nominal type.
export type { SourceSpec };
