import fs from "node:fs";
import path from "node:path";
import { isHttpUrl, resolveStashDir } from "./common";
import type { StashConfigEntry } from "./config";
import { loadConfig, loadUserConfig, saveConfig } from "./config";
import { UsageError } from "./errors";
import { akmIndex } from "./indexer";
import { upsertLockEntry } from "./lockfile";
import { detectStashRoot, installRegistryRef, upsertInstalledRegistryEntry } from "./registry-install";
import { parseRegistryRef } from "./registry-resolve";
import { ensureWebsiteMirror, validateWebsiteInputUrl } from "./stash-providers/website";
import type { AddResponse } from "./stash-types";

export async function akmAdd(input: {
  ref: string;
  name?: string;
  options?: Record<string, unknown>;
}): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref)
    throw new UsageError(
      "Install ref or local directory is required. " +
        "Examples: `akm add @scope/kit`, `akm add github:owner/repo`, `akm add ./local/path`",
    );

  const stashDir = resolveStashDir();

  if (shouldAddAsWebsiteUrl(ref)) {
    return addWebsiteStashSource(ref, stashDir, input.name, input.options);
  }

  // Detect local directory refs and route them to stashes[] instead of installed[]
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      return addLocalStashSource(ref, parsed.sourcePath, stashDir);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryKit(ref, stashDir);
}

/**
 * Add a local directory as a filesystem stash source.
 * Creates a stashes[] entry instead of an installed[] entry.
 */
async function addLocalStashSource(ref: string, sourcePath: string, stashDir: string): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  const config = loadUserConfig();

  // Check for duplicates in stashes[]
  const stashes = [...(config.stashes ?? [])];
  const existing = stashes.find((s) => s.type === "filesystem" && s.path && path.resolve(s.path) === resolvedPath);
  if (!existing) {
    const entry: StashConfigEntry = {
      type: "filesystem",
      path: resolvedPath,
      name: toReadableId(resolvedPath),
    };
    stashes.push(entry);
    saveConfig({ ...config, stashes });
  }

  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref,
    stashSource: {
      type: "filesystem",
      path: resolvedPath,
      name: toReadableId(resolvedPath),
      stashRoot: resolvedPath,
    },
    config: {
      stashCount: updatedConfig.stashes?.length ?? 0,
      installedKitCount: updatedConfig.installed?.length ?? 0,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

async function addWebsiteStashSource(
  ref: string,
  stashDir: string,
  name?: string,
  options?: Record<string, unknown>,
): Promise<AddResponse> {
  const normalizedUrl = validateWebsiteInputUrl(ref);
  const config = loadUserConfig();
  const stashes = [...(config.stashes ?? [])];
  let entry = stashes.find(
    (stash): stash is StashConfigEntry => stash.type === "website" && stash.url === normalizedUrl,
  );

  if (!entry) {
    entry = {
      type: "website",
      url: normalizedUrl,
      name: name ?? toWebsiteName(normalizedUrl),
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    };
    stashes.push(entry);
    saveConfig({ ...config, stashes });
  } else if (options && Object.keys(options).length > 0) {
    entry.options = { ...entry.options, ...options };
    saveConfig({ ...config, stashes });
  }

  const cachePaths = await ensureWebsiteMirror(entry, { requireStashDir: true });
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref,
    stashSource: {
      type: "website",
      url: normalizedUrl,
      name: entry.name,
      stashRoot: cachePaths.stashDir,
    },
    config: {
      stashCount: updatedConfig.stashes?.length ?? 0,
      installedKitCount: updatedConfig.installed?.length ?? 0,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

/**
 * Install a kit from a registry (npm, github, git).
 */
async function addRegistryKit(ref: string, stashDir: string): Promise<AddResponse> {
  const installed = await installRegistryRef(ref);
  const replaced = (loadConfig().installed ?? []).find((entry) => entry.id === installed.id);
  const config = upsertInstalledRegistryEntry({
    id: installed.id,
    source: installed.source,
    ref: installed.ref,
    artifactUrl: installed.artifactUrl,
    resolvedVersion: installed.resolvedVersion,
    resolvedRevision: installed.resolvedRevision,
    stashRoot: installed.stashRoot,
    cacheDir: installed.cacheDir,
    installedAt: installed.installedAt,
  });

  await upsertLockEntry({
    id: installed.id,
    source: installed.source,
    ref: installed.ref,
    resolvedVersion: installed.resolvedVersion,
    resolvedRevision: installed.resolvedRevision,
    integrity: installed.integrity,
  });

  // Clean up old cache directory on re-install
  if (replaced && replaced.cacheDir !== installed.cacheDir) {
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
      id: installed.id,
      source: installed.source,
      ref: installed.ref,
      artifactUrl: installed.artifactUrl,
      resolvedVersion: installed.resolvedVersion,
      resolvedRevision: installed.resolvedRevision,
      stashRoot: installed.stashRoot,
      cacheDir: installed.cacheDir,
      extractedDir: installed.extractedDir,
      installedAt: installed.installedAt,
      audit: installed.audit,
    },
    config: {
      stashCount: config.stashes?.length ?? 0,
      installedKitCount: config.installed?.length ?? 0,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
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
