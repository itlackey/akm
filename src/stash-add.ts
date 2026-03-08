import { agentikitIndex } from "./indexer"
import fs from "node:fs"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"
import { upsertInstalledRegistryEntry, installRegistryRef } from "./registry-install"
import type { AddResponse } from "./stash-types"

export async function agentikitAdd(input: { ref: string }): Promise<AddResponse> {
  const ref = input.ref.trim()
  if (!ref) throw new Error("Install ref or local git directory is required.")

  const stashDir = resolveStashDir()
  const installed = await installRegistryRef(ref)
  const replaced = loadConfig(stashDir).registry?.installed.find((entry) => entry.id === installed.id)
  const config = upsertInstalledRegistryEntry(
    {
      id: installed.id,
      source: installed.source,
      ref: installed.ref,
      artifactUrl: installed.artifactUrl,
      resolvedVersion: installed.resolvedVersion,
      resolvedRevision: installed.resolvedRevision,
      stashRoot: installed.stashRoot,
      cacheDir: installed.cacheDir,
      installedAt: installed.installedAt,
    },
    stashDir,
  )

  if (replaced && replaced.cacheDir !== installed.cacheDir) {
    try {
      fs.rmSync(replaced.cacheDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup only.
    }
  }

  const index = await agentikitIndex({ stashDir })

  return {
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
      additionalStashDirs: config.additionalStashDirs,
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
