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
import { copyStashSkeleton, ensureStashGitignore, scaffoldStashMeta } from "./stash-skeleton";

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
  const isUnderTest = isUnderTestRunner();
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

function isUnderTestRunner(): boolean {
  return process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
}

export interface InitResponse {
  stashDir: string;
  created: boolean;
  configPath: string;
  /**
   * Whether this init wrote `stashDir` to the user's config.json (i.e. changed
   * the default stash pointer). False when `--dir` targeted a secondary stash
   * and the existing default was deliberately left untouched.
   */
  defaultStashUpdated: boolean;
  /**
   * The `stashDir` that was configured BEFORE this init ran, when it differs
   * from the dir we scaffolded and was left in place. Only set when a `--dir`
   * was provided, an existing default already existed, and `--set-default` was
   * NOT passed — so the CLI can tell the user their default is unchanged.
   */
  previousStashDir?: string;
  ripgrep?: {
    rgPath: string;
    installed: boolean;
    version: string;
  };
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let akmInitOverride: typeof akmInitReal | undefined;

/** TEST-ONLY. Swap the implementation of `akmInit`; pass undefined to restore. */
export function _setAkmInitForTests(fake?: typeof akmInitReal): void {
  akmInitOverride = fake;
}

export async function akmInit(options?: { dir?: string; setDefault?: boolean }): Promise<InitResponse> {
  if (akmInitOverride) return akmInitOverride(options);
  return akmInitReal(options);
}

async function akmInitReal(options?: { dir?: string; setDefault?: boolean }): Promise<InitResponse> {
  const dirExplicitlyProvided = options?.dir != null;
  const setDefault = options?.setDefault === true;
  const stashDir = options?.dir ? path.resolve(options.dir) : getDefaultStashDir();

  // Safety check (#473): refuse stashDir at /, $HOME, /etc, ~/.config, etc.
  // Runs BEFORE any disk write — a fat-fingered `akm init --dir /` or
  // `akm init --dir ~` would otherwise mkdir + git-init the user's system
  // root or home directory. Catastrophic-on-misuse vs. trivial-to-recover-from.
  assertSafeStashDir(stashDir);

  // Defense-in-depth: refuse to persist an explicit --dir /tmp/... stashDir
  // to config under a test runner. Default HOME-resolved paths are exempt.
  assertInitSandbox(stashDir, dirExplicitlyProvided);

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

  // 08-F1: scaffold a default `.gitignore` that keeps env/ + secrets/ out of git
  // so a `git push` can never leak them. Idempotent + non-clobbering; the user
  // opts into versioning by un-ignoring a path.
  ensureStashGitignore(stashDir);

  // Run seeding UNCONDITIONALLY (not just when the stash was newly created) so
  // re-running `akm init` on an existing stash backfills any missing skeleton
  // files — the README, the per-type SOFT convention templates under
  // facts/conventions/assets/, and the `.meta/index.md` orientation doc. Both
  // helpers are absent-only: they never overwrite a file a user has edited.
  copyStashSkeleton(stashDir);
  scaffoldStashMeta(stashDir);

  // Persist stashDir in config.json — but ONLY when the user is actually
  // setting up / opting into a default. A bare `akm init --dir <secondary>`
  // must NOT silently repoint the user's real default stash (the footgun
  // documented in memory:akm-init-persists-stashdir-warning).
  //
  // Decision matrix — persist when ANY of:
  //   (a) no --dir provided           → default HOME-resolved setup flow
  //   (b) --dir AND no existing stashDir in config → first-time bootstrap
  //   (c) --dir AND --set-default      → explicit opt-in
  // Otherwise (--dir + existing default + no --set-default) leave the default
  // pointer alone; the target dir is still scaffolded above.
  const configPath = getConfigPath();
  const existing = loadUserConfig();
  const existingStashDir = existing.stashDir;
  const shouldPersist = !dirExplicitlyProvided || !existingStashDir || setDefault;

  let defaultStashUpdated = false;
  let previousStashDir: string | undefined;
  if (shouldPersist) {
    if (!existingStashDir || existingStashDir !== stashDir) {
      saveConfig({ ...existing, stashDir });
      defaultStashUpdated = true;
    }
    // else: already pointed here — no-op, no spurious rewrite.
  } else {
    // Default left untouched; surface it so the CLI can inform the user.
    previousStashDir = existingStashDir;
  }

  // Ensure ripgrep is available (install to cache/bin if needed)
  let ripgrep: InitResponse["ripgrep"];
  if (!isUnderTestRunner()) {
    try {
      const binDir = getBinDir();
      const rgResult = ensureRg(binDir);
      ripgrep = rgResult;
    } catch {
      // Non-fatal: ripgrep is optional, search works without it
    }
  }

  return { stashDir, created, configPath, defaultStashUpdated, previousStashDir, ripgrep };
}

/** Initialise `dir` as a git repository if it is not already one. */
function ensureGitRepo(dir: string): void {
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) return;
  // Non-fatal: git may not be available in all environments
  spawnSync("git", ["init", dir], { encoding: "utf8", timeout: 15_000 });
}
