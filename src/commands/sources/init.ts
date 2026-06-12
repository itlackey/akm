// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm initialization logic.
 *
 * Creates the working stash directory structure, persists the stashDir
 * in config.json, and ensures ripgrep is available.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import { loadUserConfig, saveConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { assertSafeStashDir, getBinDir, getConfigPath, getDefaultStashDir } from "../../core/paths";
import { ensureRg } from "../../core/ripgrep/install";
import { copyStashSkeleton, scaffoldStashMeta } from "./stash-skeleton";

/**
 * Refuse to persist a temporary-directory stashDir to the user's config when
 * running under a test runner AND `--dir <tempdir>` was passed explicitly.
 * This guard targets the exact agent-overreach pattern documented in
 * `memory:akm-init-persists-stashdir-warning`: an agent ran
 * `akm init --dir $(mktemp -d)` for an E2E test and silently rewrote the
 * developer's real config to point at a now-deleted temp dir.
 *
 * Tests that legitimately resolve a tempdir via HOME (default-path init) are
 * unaffected — those are normal `~/akm` resolutions and not the failure mode.
 *
 * Test sentinels (either suffices):
 *   - `BUN_TEST=1`     — explicit opt-in
 *   - `NODE_ENV=test`  — what `bun test` sets today
 *
 * Tests that genuinely need to exercise `akm init --dir /tmp/...` should set
 * `AKM_FORCE_INIT_TMP_STASH=1`.
 */
function assertInitSandbox(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return; // Only guard explicit --dir, not default HOME resolution.
  const isUnderTest = process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isUnderTest) return;
  if (process.env.AKM_FORCE_INIT_TMP_STASH === "1") return;
  const isTmp =
    stashDir.startsWith("/tmp/") ||
    stashDir === "/tmp" ||
    stashDir.startsWith("/var/tmp/") ||
    stashDir === "/var/tmp" ||
    stashDir.startsWith("/private/var/folders/") ||
    stashDir.startsWith("/private/tmp/");
  if (!isTmp) return;
  throw new ConfigError(
    `refusing to persist --dir stashDir to a temporary path while under test runner; set AKM_FORCE_INIT_TMP_STASH=1 if you really mean it (stashDir=${stashDir})`,
    "INIT_TMP_STASH_REFUSED",
  );
}

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

  // Safety check (#473): refuse stashDir at /, $HOME, /etc, ~/.config, etc.
  // Runs BEFORE any disk write — a fat-fingered `akm init --dir /` or
  // `akm init --dir ~` would otherwise mkdir + git-init the user's system
  // root or home directory. Catastrophic-on-misuse vs. trivial-to-recover-from.
  assertSafeStashDir(stashDir);

  // Defense-in-depth: refuse to persist an explicit --dir /tmp/... stashDir
  // to config under a test runner. Default HOME-resolved paths are exempt.
  assertInitSandbox(stashDir, options?.dir != null);

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

  if (created) {
    copyStashSkeleton(stashDir);
    scaffoldStashMeta(stashDir);
  }

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
