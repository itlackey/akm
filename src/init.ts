/**
 * Agentikit initialization logic.
 *
 * Creates the stash directory structure, sets the AGENTIKIT_STASH_DIR
 * environment variable, and ensures ripgrep is available.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS, TYPE_DIRS } from "./common"
import { ensureRg } from "./ripgrep"

export interface InitResponse {
  stashDir: string
  created: boolean
  envSet: boolean
  profileUpdated?: string
  ripgrep?: {
    rgPath: string
    installed: boolean
    version: string
  }
}

export function agentikitInit(): InitResponse {
  let stashDir: string
  const home = process.env.HOME || ""
  if (IS_WINDOWS) {
    const docs = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Documents")
      : ""
    if (!docs) {
      throw new Error("Unable to determine Documents folder. Ensure USERPROFILE is set.")
    }
    stashDir = path.join(docs, "agentikit")
  } else {
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
    const result = spawnSync("setx", ["AGENTIKIT_STASH_DIR", stashDir], {
      encoding: "utf8",
      timeout: 10_000,
    })
    envSet = result.status === 0
  } else {
    const shell = process.env.SHELL || ""
    let profile: string
    if (shell.endsWith("/zsh")) {
      profile = path.join(home, ".zshrc")
    } else if (shell.endsWith("/bash")) {
      profile = path.join(home, ".bashrc")
    } else {
      profile = path.join(home, ".profile")
    }

    const exportLine = `export AGENTIKIT_STASH_DIR="${stashDir}"`
    const existing = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : ""
    if (!existing.includes("AGENTIKIT_STASH_DIR")) {
      fs.appendFileSync(profile, `\n# Agentikit stash directory\n${exportLine}\n`)
      envSet = true
      profileUpdated = profile
    }
  }

  process.env.AGENTIKIT_STASH_DIR = stashDir

  // Ensure ripgrep is available (install to stash/bin if needed)
  let ripgrep: InitResponse["ripgrep"]
  try {
    const rgResult = ensureRg(stashDir)
    ripgrep = rgResult
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  return { stashDir, created, envSet, profileUpdated, ripgrep }
}
