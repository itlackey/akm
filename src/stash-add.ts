import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "./common";
import type { StashConfigEntry } from "./config";
import { loadConfig, saveConfig } from "./config";
import { UsageError } from "./errors";
import { agentikitIndex } from "./indexer";
import { upsertLockEntry } from "./lockfile";
import { detectStashRoot, installRegistryRef, upsertInstalledRegistryEntry } from "./registry-install";
import { parseRegistryRef } from "./registry-resolve";
import type { AddResponse } from "./stash-types";

export async function agentikitAdd(input: { ref: string }): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref) throw new UsageError("Install ref or local directory is required.");

  const stashDir = resolveStashDir();

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
  const config = loadConfig();

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

  const index = await agentikitIndex({ stashDir });
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
      searchPaths: updatedConfig.searchPaths,
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

  const index = await agentikitIndex({ stashDir });

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
    },
    config: {
      searchPaths: config.searchPaths,
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
