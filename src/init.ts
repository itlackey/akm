/**
 * Agentikit initialization logic.
 *
 * Creates the working stash directory structure, persists the stashDir
 * in config.json, and ensures ripgrep is available.
 */

import fs from "node:fs"
import path from "node:path"
import { TYPE_DIRS } from "./asset-spec"
import { ensureRg } from "./ripgrep-install"
import { loadConfig, saveConfig, getConfigPath } from "./config"
import { getDefaultStashDir, getBinDir } from "./paths"

export interface InitResponse {
  stashDir: string
  created: boolean
  configPath: string
  ripgrep?: {
    rgPath: string
    installed: boolean
    version: string
  }
}

export async function agentikitInit(options?: { dir?: string }): Promise<InitResponse> {
  const stashDir = options?.dir ? path.resolve(options.dir) : getDefaultStashDir()

  let created = false
  if (!fs.existsSync(stashDir)) {
    fs.mkdirSync(stashDir, { recursive: true })
    created = true
  }

  for (const sub of Object.values(TYPE_DIRS)) {
    const subDir = path.join(stashDir, sub)
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true })
    }
  }

  // Persist stashDir in config.json
  const configPath = getConfigPath()
  const existing = loadConfig()
  if (!existing.stashDir || existing.stashDir !== stashDir) {
    saveConfig({ ...existing, stashDir })
  }

  // Ensure ripgrep is available (install to cache/bin if needed)
  let ripgrep: InitResponse["ripgrep"]
  try {
    const binDir = getBinDir()
    const rgResult = ensureRg(binDir)
    ripgrep = rgResult
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  return { stashDir, created, configPath, ripgrep }
}
