/**
 * Source operations: list, remove, update.
 *
 * Provides unified operations across all source kinds (local, managed, remote).
 * The CLI's `akm list`, `akm remove`, and `akm update` commands are wired here.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "./common";
import { loadConfig } from "./config";
import { NotFoundError, UsageError } from "./errors";
import { akmIndex } from "./indexer";
import { removeLockEntry, upsertLockEntry } from "./lockfile";
import { installRegistryRef, removeInstalledRegistryEntry, upsertInstalledRegistryEntry } from "./registry-install";
import { parseRegistryRef } from "./registry-resolve";
import type { InstalledKitEntry } from "./registry-types";
import { removeStash } from "./stash-source-manage";
import type {
  KitInstallStatus,
  RemoveResponse,
  SourceEntry,
  SourceKind,
  SourceListResponse,
  UpdateResponse,
} from "./stash-types";

export async function akmListSources(input?: { stashDir?: string; kind?: SourceKind[] }): Promise<SourceListResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const config = loadConfig();
  const kindFilter = input?.kind;

  const sources: SourceEntry[] = [];

  // Stash entries → local or remote sources
  for (const stash of config.stashes ?? []) {
    const isRemote = stash.url != null;
    const kind: SourceKind = isRemote ? "remote" : "local";
    if (kindFilter && !kindFilter.includes(kind)) continue;

    const name = stash.name ?? stash.path ?? stash.url ?? "unknown";
    sources.push({
      name,
      kind,
      path: stash.path,
      provider: isRemote ? stash.type : undefined,
      updatable: false,
      writable: stash.writable === true,
      status: { exists: stash.path ? directoryExists(stash.path) : true },
    });
  }

  // Installed entries → managed sources
  for (const entry of config.installed ?? []) {
    const kind: SourceKind = "managed";
    if (kindFilter && !kindFilter.includes(kind)) continue;

    sources.push({
      name: entry.id,
      kind,
      path: entry.stashRoot,
      ref: entry.ref,
      version: entry.resolvedVersion,
      updatable: true,
      writable: entry.writable === true,
      status: { exists: directoryExists(entry.stashRoot) },
    });
  }

  return {
    schemaVersion: 1,
    stashDir,
    sources,
    totalSources: sources.length,
  };
}

export async function akmRemove(input: { target: string; stashDir?: string }): Promise<RemoveResponse> {
  const target = input.target.trim();
  if (!target)
    throw new UsageError(
      "Target is required. Provide the source id, ref, path, URL, or name (e.g. `akm remove npm:@scope/kit` or `akm remove ~/my-stash`).",
    );

  const stashDir = input.stashDir ?? resolveStashDir();
  const config = loadConfig();
  const installed = config.installed ?? [];

  // Try installed[] first (managed sources)
  const entry = tryResolveInstalledTarget(installed, target);

  if (entry) {
    const updatedConfig = removeInstalledRegistryEntry(entry.id);
    await removeLockEntry(entry.id);
    if (entry.source !== "local") {
      cleanupDirectoryBestEffort(entry.cacheDir);
    }
    const index = await akmIndex({ stashDir });

    return {
      schemaVersion: 1,
      stashDir,
      target,
      removed: {
        id: entry.id,
        source: entry.source,
        ref: entry.ref,
        cacheDir: entry.cacheDir,
        stashRoot: entry.stashRoot,
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

  // Fall through to stashes[] (local/remote sources)
  const stashResult = removeStash(target);
  if (!stashResult.removed || !stashResult.entry) {
    throw new NotFoundError(`No matching source for target: ${target}`);
  }

  const removedEntry = stashResult.entry;
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    target,
    removed: {
      id: removedEntry.name ?? removedEntry.path ?? removedEntry.url ?? target,
      source: removedEntry.type,
      ref: removedEntry.path ?? removedEntry.url ?? target,
      cacheDir: "",
      stashRoot: removedEntry.path ?? "",
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

export async function akmUpdate(input?: {
  target?: string;
  all?: boolean;
  force?: boolean;
  stashDir?: string;
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const target = input?.target?.trim();
  const all = input?.all === true;
  const force = input?.force === true;
  const installedEntries = loadConfig().installed ?? [];
  const selectedEntries = selectTargets(installedEntries, target, all);

  const processed: UpdateResponse["processed"] = [];
  for (const entry of selectedEntries) {
    if (force && shouldCleanupCache(entry)) {
      cleanupDirectoryBestEffort(entry.cacheDir);
    }
    const installed = await installRegistryRef(entry.ref);
    upsertInstalledRegistryEntry(toInstalledEntry(installed));
    await upsertLockEntry({
      id: installed.id,
      source: installed.source,
      ref: installed.ref,
      resolvedVersion: installed.resolvedVersion,
      resolvedRevision: installed.resolvedRevision,
      integrity: installed.integrity ?? (installed.source === "local" ? "local" : undefined),
    });
    if (entry.cacheDir !== installed.cacheDir && shouldCleanupCache(entry)) {
      cleanupDirectoryBestEffort(entry.cacheDir);
    }

    const versionChanged = (entry.resolvedVersion ?? "") !== (installed.resolvedVersion ?? "");
    const revisionChanged = (entry.resolvedRevision ?? "") !== (installed.resolvedRevision ?? "");

    processed.push({
      id: entry.id,
      source: entry.source,
      ref: entry.ref,
      previous: {
        resolvedVersion: entry.resolvedVersion,
        resolvedRevision: entry.resolvedRevision,
        cacheDir: entry.cacheDir,
      },
      installed: toInstallStatus(installed),
      changed: {
        version: versionChanged,
        revision: revisionChanged,
        any: versionChanged || revisionChanged,
      },
    });
  }

  const index = await akmIndex({ stashDir });
  const config = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    target,
    all,
    processed,
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

function selectTargets(installed: InstalledKitEntry[], target: string | undefined, all: boolean): InstalledKitEntry[] {
  if (all && target) {
    throw new UsageError("Specify either <target> or --all, not both.");
  }
  if (all) return installed;
  if (!target) {
    throw new UsageError("Either <target> or --all is required.");
  }

  const found = tryResolveInstalledTarget(installed, target);
  if (found) return [found];

  // Check if target matches a stash source and give a helpful message
  const config = loadConfig();
  const stashes = config.stashes ?? [];
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  const resolvedPath = !isUrl ? path.resolve(target) : undefined;
  const stashMatch = stashes.find((s) => {
    if (isUrl && s.url === target) return true;
    if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
    if (s.name === target) return true;
    return false;
  });

  if (stashMatch) {
    if (stashMatch.url) {
      throw new UsageError(`"${target}" is a remote provider — it queries live data and has nothing to update.`);
    }
    throw new UsageError(
      `"${target}" is a local directory — it reflects your files in place. To refresh the search index, run: akm index`,
    );
  }

  throw new NotFoundError(`No matching source for target: ${target}`);
}

function tryResolveInstalledTarget(installed: InstalledKitEntry[], target: string): InstalledKitEntry | undefined {
  const byId = installed.find((entry) => entry.id === target);
  if (byId) return byId;

  const byRef = installed.find((entry) => entry.ref === target);
  if (byRef) return byRef;

  let parsedId: string | undefined;
  try {
    parsedId = parseRegistryRef(target).id;
  } catch {
    parsedId = undefined;
  }
  if (parsedId) {
    const byParsedId = installed.find((entry) => entry.id === parsedId);
    if (byParsedId) return byParsedId;
  }

  return undefined;
}

function toInstalledEntry(status: KitInstallStatus): InstalledKitEntry {
  // KitInstallStatus extends InstalledKitEntry; omit transient install-only fields.
  const { extractedDir: _extractedDir, audit: _audit, ...base } = status;
  return base;
}

function toInstallStatus(status: KitInstallStatus): KitInstallStatus {
  return { ...status };
}

function cleanupDirectoryBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function shouldCleanupCache(entry: InstalledKitEntry): boolean {
  return entry.source !== "local";
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
