/**
 * akm initialization logic.
 *
 * Creates the working stash directory structure, persists the stashDir
 * in config.json, and ensures ripgrep is available.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "./asset-spec";
import { getConfigPath, loadUserConfig, saveConfig } from "./config";
import { getBinDir, getDefaultStashDir } from "./paths";
import { ensureRg } from "./ripgrep-install";

export interface InitResponse {
  stashDir: string;
  created: boolean;
  configPath: string;
  ripgrep?: {
    rgPath: string;
    installed: boolean;
    version: string;
  };
}

export async function akmInit(options?: { dir?: string }): Promise<InitResponse> {
  const stashDir = options?.dir ? path.resolve(options.dir) : getDefaultStashDir();

  let created = false;
  if (!fs.existsSync(stashDir)) {
    fs.mkdirSync(stashDir, { recursive: true });
    created = true;
  }

  for (const sub of Object.values(TYPE_DIRS)) {
    const subDir = path.join(stashDir, sub);
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }
  }

  // Ensure the default stash is a local git repo (no remote required)
  ensureGitRepo(stashDir);

  // Persist stashDir in config.json
  const configPath = getConfigPath();
  const existing = loadUserConfig();
  if (!existing.stashDir || existing.stashDir !== stashDir) {
    saveConfig({ ...existing, stashDir });
  }

  // Ensure ripgrep is available (install to cache/bin if needed)
  let ripgrep: InitResponse["ripgrep"];
  try {
    const binDir = getBinDir();
    const rgResult = ensureRg(binDir);
    ripgrep = rgResult;
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  return { stashDir, created, configPath, ripgrep };
}

/** Initialise `dir` as a git repository if it is not already one. */
function ensureGitRepo(dir: string): void {
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) return;
  // Non-fatal: git may not be available in all environments
  spawnSync("git", ["init", dir], { encoding: "utf8", timeout: 15_000 });
}
