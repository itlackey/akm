import fs from "node:fs"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"
import { UsageError, NotFoundError } from "./errors"
import { agentikitIndex } from "./indexer"
import { removeLockEntry, upsertLockEntry } from "./lockfile"
import {
  installRegistryRef,
  removeInstalledRegistryEntry,
  upsertInstalledRegistryEntry,
} from "./registry-install"
import { parseRegistryRef } from "./registry-resolve"
import type { RegistryInstalledEntry } from "./registry-types"
import type {
  ListResponse,
  RegistryInstallStatus,
  RemoveResponse,
  UpdateResponse,
} from "./stash-types"

export async function agentikitList(input?: { stashDir?: string }): Promise<ListResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir()
  const config = loadConfig()
  const installed = config.registry?.installed ?? []

  return {
    stashDir,
    installed: installed.map((entry) => ({
      ...entry,
      status: {
        cacheDirExists: directoryExists(entry.cacheDir),
        stashRootExists: directoryExists(entry.stashRoot),
      },
    })),
    totalInstalled: installed.length,
  }
}

export async function agentikitRemove(input: { target: string; stashDir?: string }): Promise<RemoveResponse> {
  const target = input.target.trim()
  if (!target) throw new UsageError("Target is required.")

  const stashDir = input.stashDir ?? resolveStashDir()
  const config = loadConfig()
  const installed = config.registry?.installed ?? []
  const entry = resolveInstalledTarget(installed, target)

  const updatedConfig = removeInstalledRegistryEntry(entry.id)
  removeLockEntry(entry.id)
  cleanupDirectoryBestEffort(entry.cacheDir)
  const index = await agentikitIndex({ stashDir })

  return {
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
      searchPaths: updatedConfig.searchPaths,
      installedRegistryCount: updatedConfig.registry?.installed.length ?? 0,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  }
}

export async function agentikitUpdate(input?: {
  target?: string
  all?: boolean
  force?: boolean
  stashDir?: string
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir()
  const target = input?.target?.trim()
  const all = input?.all === true
  const force = input?.force === true
  const installedEntries = loadConfig().registry?.installed ?? []
  const selectedEntries = selectTargets(installedEntries, target, all)

  const processed: UpdateResponse["processed"] = []
  for (const entry of selectedEntries) {
    if (force) {
      cleanupDirectoryBestEffort(entry.cacheDir)
    }
    const installed = await installRegistryRef(entry.ref)
    upsertInstalledRegistryEntry(toInstalledEntry(installed))
    upsertLockEntry({
      id: installed.id,
      source: installed.source,
      ref: installed.ref,
      resolvedVersion: installed.resolvedVersion,
      resolvedRevision: installed.resolvedRevision,
      integrity: installed.integrity ?? (installed.source === "local" ? "local" : undefined),
    })
    if (entry.cacheDir !== installed.cacheDir) {
      cleanupDirectoryBestEffort(entry.cacheDir)
    }

    const versionChanged = (entry.resolvedVersion ?? "") !== (installed.resolvedVersion ?? "")
    const revisionChanged = (entry.resolvedRevision ?? "") !== (installed.resolvedRevision ?? "")

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
    })
  }

  const index = await agentikitIndex({ stashDir })
  const config = loadConfig()

  return {
    stashDir,
    target,
    all,
    processed,
    config: {
      searchPaths: config.searchPaths,
      installedRegistryCount: config.registry?.installed.length ?? 0,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  }
}

function selectTargets(installed: RegistryInstalledEntry[], target: string | undefined, all: boolean): RegistryInstalledEntry[] {
  if (all && target) {
    throw new UsageError("Specify either <target> or --all, not both.")
  }
  if (all) return installed
  if (!target) {
    throw new UsageError("Either <target> or --all is required.")
  }
  return [resolveInstalledTarget(installed, target)]
}

function resolveInstalledTarget(installed: RegistryInstalledEntry[], target: string): RegistryInstalledEntry {
  const byId = installed.find((entry) => entry.id === target)
  if (byId) return byId

  const byRef = installed.find((entry) => entry.ref === target)
  if (byRef) return byRef

  let parsedId: string | undefined
  try {
    parsedId = parseRegistryRef(target).id
  } catch {
    parsedId = undefined
  }
  if (parsedId) {
    const byParsedId = installed.find((entry) => entry.id === parsedId)
    if (byParsedId) return byParsedId
  }

  throw new NotFoundError(`No installed registry entry matched target: ${target}`)
}

function toInstalledEntry(status: RegistryInstallStatus): RegistryInstalledEntry {
  return {
    id: status.id,
    source: status.source,
    ref: status.ref,
    artifactUrl: status.artifactUrl,
    resolvedVersion: status.resolvedVersion,
    resolvedRevision: status.resolvedRevision,
    stashRoot: status.stashRoot,
    cacheDir: status.cacheDir,
    installedAt: status.installedAt,
  }
}

function toInstallStatus(status: RegistryInstallStatus): RegistryInstallStatus {
  return {
    id: status.id,
    source: status.source,
    ref: status.ref,
    artifactUrl: status.artifactUrl,
    resolvedVersion: status.resolvedVersion,
    resolvedRevision: status.resolvedRevision,
    stashRoot: status.stashRoot,
    cacheDir: status.cacheDir,
    extractedDir: status.extractedDir,
    installedAt: status.installedAt,
  }
}

function cleanupDirectoryBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}
