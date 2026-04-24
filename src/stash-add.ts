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
import { warn } from "./warn";
import { ensureWikiNameAvailable, validateWikiName } from "./wiki";

const VALID_OVERRIDE_TYPES = new Set(["wiki"]);

export async function akmAdd(input: {
  ref: string;
  name?: string;
  overrideType?: string;
  options?: Record<string, unknown>;
  trustThisInstall?: boolean;
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
    return addWebsiteStashSource(ref, stashDir, input.name ?? wikiName, input.options, wikiName);
  }

  // Detect local directory refs and route them to stashes[] instead of installed[]
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      if (input.trustThisInstall) {
        warn("--trust has no effect on local directory sources; the install audit is not run for local paths.");
      }
      return addLocalStashSource(ref, parsed.sourcePath, stashDir, wikiName);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryStash(ref, stashDir, input.trustThisInstall, input.writable, wikiName);
}

export async function registerWikiSource(input: {
  ref: string;
  name?: string;
  options?: Record<string, unknown>;
  trustThisInstall?: boolean;
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
    trustThisInstall: input.trustThisInstall,
    writable: input.writable,
  });
}

/**
 * Add a local directory as a filesystem stash source.
 * Creates a stashes[] entry instead of an installed[] entry.
 */
async function addLocalStashSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  wikiName?: string,
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  const config = loadUserConfig();

  // Check for duplicates in stashes[]
  const stashes = [...(config.stashes ?? [])];
  const existing = stashes.find((s) => s.type === "filesystem" && s.path && path.resolve(s.path) === resolvedPath);
  let persistedEntry: StashConfigEntry;
  if (!existing) {
    persistedEntry = {
      type: "filesystem",
      path: resolvedPath,
      name: wikiName ?? toReadableId(resolvedPath),
      ...(wikiName ? { wikiName } : {}),
    };
    stashes.push(persistedEntry);
    saveConfig({ ...config, stashes });
  } else {
    if (wikiName && existing.wikiName !== wikiName) {
      existing.wikiName = wikiName;
      saveConfig({ ...config, stashes });
    }
    persistedEntry = existing;
  }

  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref: wikiName ?? ref,
    stashSource: {
      type: "filesystem",
      path: resolvedPath,
      name: persistedEntry.name ?? toReadableId(resolvedPath),
      stashRoot: resolvedPath,
      ...(persistedEntry.wikiName ? { wiki: persistedEntry.wikiName } : {}),
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
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

async function addWebsiteStashSource(
  ref: string,
  stashDir: string,
  name?: string,
  options?: Record<string, unknown>,
  wikiName?: string,
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
      ...(wikiName ? { wikiName } : {}),
    };
    stashes.push(entry);
    saveConfig({ ...config, stashes });
  } else {
    let changed = false;
    if (options && Object.keys(options).length > 0) {
      entry.options = { ...entry.options, ...options };
      changed = true;
    }
    if (wikiName && entry.wikiName !== wikiName) {
      entry.wikiName = wikiName;
      changed = true;
    }
    if (changed) saveConfig({ ...config, stashes });
  }

  const cachePaths = await ensureWebsiteMirror(entry, { requireStashDir: true });
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    ref: wikiName ?? ref,
    stashSource: {
      type: "website",
      url: normalizedUrl,
      name: entry.name,
      stashRoot: cachePaths.stashDir,
      ...(entry.wikiName ? { wiki: entry.wikiName } : {}),
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
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

/**
 * Install a stash from a registry (npm, github, git).
 */
async function addRegistryStash(
  ref: string,
  stashDir: string,
  trustThisInstall?: boolean,
  writable?: boolean,
  wikiName?: string,
): Promise<AddResponse> {
  const installed = await installRegistryRef(ref, { trustThisInstall, writable });
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
    writable: installed.writable,
    ...(wikiName ? { wikiName } : {}),
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
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
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
