/**
 * Agentikit initialization logic.
 *
 * Creates the working stash directory structure, sets the AKM_STASH_DIR
 * environment variable, and ensures ripgrep is available.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS, TYPE_DIRS } from "./common"
import { ensureRg } from "./ripgrep-install"
import { getConfigPath, saveConfig, DEFAULT_CONFIG } from "./config"

export interface InitResponse {
  stashDir: string
  created: boolean
  envSet: boolean
  profileUpdated?: string
  configPath: string
  envHint?: string
  ripgrep?: {
    rgPath: string
    installed: boolean
    version: string
  }
}

export async function agentikitInit(): Promise<InitResponse> {
  let stashDir: string
  if (IS_WINDOWS) {
    const userProfile = process.env.USERPROFILE?.trim()
    if (!userProfile) {
      throw new Error("Unable to determine Documents folder. Ensure USERPROFILE is set.")
    }
    const docs = path.join(userProfile, "Documents")
    stashDir = path.join(docs, "agentikit")
  } else {
    const home = process.env.HOME?.trim()
    if (!home) {
      throw new Error("Unable to determine home directory. Set HOME.")
    }
    stashDir = path.join(home, "agentikit")
  }

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

  let envSet = false
  let profileUpdated: string | undefined

  if (IS_WINDOWS) {
    const result = spawnSync("setx", ["AKM_STASH_DIR", stashDir], {
      encoding: "utf8",
      timeout: 10_000,
    })
    envSet = result.status === 0
  } else {
    const shell = process.env.SHELL || ""
    const homeDir = process.env.HOME! // already validated non-empty above
    let profile: string
    if (shell.endsWith("/zsh")) {
      profile = path.join(homeDir, ".zshrc")
    } else if (shell.endsWith("/bash")) {
      profile = path.join(homeDir, ".bashrc")
    } else {
      profile = path.join(homeDir, ".profile")
    }

    const exportLine = `export AKM_STASH_DIR="${stashDir}"`
    const existing = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : ""
    if (!existing.includes("AKM_STASH_DIR")) {
      const updated = existing + `\n# Agentikit working stash directory\n${exportLine}\n`
      const tmpPath = profile + `.tmp.${process.pid}`
      try {
        fs.writeFileSync(tmpPath, updated, "utf8")
        fs.renameSync(tmpPath, profile)
      } catch (err) {
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        throw err
      }
      envSet = true
      profileUpdated = profile
    }
  }

  // Create default config.json if it doesn't exist
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG)
  }

  process.env.AKM_STASH_DIR = stashDir

  // Ensure ripgrep is available (install to stash/bin if needed)
  let ripgrep: InitResponse["ripgrep"]
  try {
    const rgResult = ensureRg(stashDir)
    ripgrep = rgResult
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  // Build a hint so callers can set the env var in the current shell
  let envHint: string | undefined
  if (profileUpdated) {
    if (IS_WINDOWS) {
      envHint = `set AKM_STASH_DIR=${stashDir}`
    } else {
      envHint = `export AKM_STASH_DIR="${stashDir}"`
    }
  }

  return { stashDir, created, envSet, profileUpdated, envHint, configPath, ripgrep }
}
