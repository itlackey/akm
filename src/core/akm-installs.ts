// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Enumerate every `akm` executable installed on the host (upgrade-D D3).
 *
 * Splinter runs three copies at once: the bun-global `akm` the shell and the
 * Claude plugin invoke, the nvm-node `akm` cron and the user's task files
 * point at, and the OpenCode plugin's own bundled `akm-cli` sharing the same
 * databases in-process. `akm upgrade` only ever knows about — and moves —
 * whichever one is currently running (`detectInstallMethod`,
 * `../commands/sources/self-update.ts`); nothing on the host enumerates the
 * others. The July 2026 outage was a bun reinstall moving the binary out
 * from under cron with nothing to report it.
 *
 * This is pure, local enumeration: every directory on `PATH`, plus a fixed
 * set of known install roots (bun global, the npm global root for the
 * running node, pnpm global, `~/.local/bin`, `/usr/local/bin`, every nvm
 * node version's `bin/`), deduped by realpath, each classified by the same
 * node_modules-layout signals `detectInstallMethod` uses, and probed with a
 * bounded `--version` — the same timeout pattern
 * `src/commands/health/scheduler-binary.ts` uses for its own recorded-binary
 * probe. No network call is made anywhere in this module.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveNpmGlobalRoot } from "../tasks/resolve-akm-bin";

/**
 * Resolved (symlink-free) path signature of a bun-global install:
 * `~/.bun/install/global/node_modules/akm-cli/...` (or the `~/.bun/<ver>/`
 * layout older bun releases used). Moved here from
 * `src/commands/sources/self-update.ts` (which now imports it) so both the
 * single-process classifier and this multi-install enumerator share one
 * pattern instead of drifting apart.
 */
export const BUN_GLOBAL_INSTALL_PATTERN = /(^|\/)\.bun\/(?:[^/]+\/)+node_modules\//;

/** Same relocation as {@link BUN_GLOBAL_INSTALL_PATTERN}, for pnpm's global store layout. */
export const PNPM_GLOBAL_INSTALL_PATTERN = /(^|\/)(?:pnpm\/global|\.pnpm-global)(?:\/\d+)?\/node_modules\//;

const NODE_MODULES_SEGMENT = "/node_modules/";

/**
 * Walks up from `filePath`'s resolved directory looking for a `.git` entry.
 * Moved here from `src/commands/tasks/tasks.ts` (which now imports it), same
 * relocation as {@link BUN_GLOBAL_INSTALL_PATTERN}, so the scheduler-binding
 * "checkout" check and this module's own install classifier share one
 * algorithm instead of drifting apart.
 */
export function hasGitAncestor(filePath: string): boolean {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(filePath));
  } catch {
    return false;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Bound on each discovered install's `--version` probe. Mirrors scheduler-binary.ts's probe timeout. */
const AKM_INSTALL_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** How a discovered install was placed on the host. */
export type AkmInstallManager = "npm" | "bun" | "pnpm" | "standalone" | "checkout" | "unknown";

/** One `akm` executable found on the host. */
export interface AkmInstall {
  /** Resolved (symlink-free) absolute path — the dedup key. */
  path: string;
  manager: AkmInstallManager;
  /** `--version` output, trimmed, or `undefined` when the probe failed or timed out. */
  version: string | undefined;
  /** True when this install is the one executing right now. */
  isRunning: boolean;
  /**
   * Directory this install was discovered in (e.g. the nvm `bin/` a symlink
   * lives in), for looking up its own adjacent package manager. `undefined`
   * when enumeration has not populated it.
   */
  binDir?: string;
}

export interface EnumerateAkmInstallsOptions {
  /** Injectable process runner for the `--version` probe; defaults to the real one. Tests supply a fake. */
  spawnSync?: typeof spawnSync;
  /**
   * Realpaths considered "the running install"; defaults to the live
   * process's own resolved `execPath`/`argv[1]`. Tests supply an explicit
   * set instead of depending on how the test runner itself was launched.
   */
  runningRealpaths?: readonly string[];
}

/**
 * Enumerate every `akm` found on `PATH` plus the known install roots,
 * deduped by realpath. Never throws — a root that does not exist, cannot be
 * read, or resolves to a broken symlink is simply skipped.
 */
export function enumerateAkmInstalls(env: NodeJS.ProcessEnv, options: EnumerateAkmInstallsOptions = {}): AkmInstall[] {
  const run = options.spawnSync ?? spawnSync;
  const runningRealpaths = new Set(options.runningRealpaths ?? defaultRunningRealpaths());
  const npmGlobalRoot = resolveNpmGlobalRootSafely(env);

  const candidates = new Set<string>();
  for (const dir of pathDirectories(env)) addCandidate(candidates, dir);
  for (const dir of knownRootDirectories(env, npmGlobalRoot)) addCandidate(candidates, dir);

  const byRealpath = new Map<string, AkmInstall>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // broken symlink, or it vanished between listing and stat
    }
    if (byRealpath.has(real)) continue;
    byRealpath.set(real, {
      path: real,
      manager: classifyInstall(real),
      version: probeVersion(run, real),
      isRunning: runningRealpaths.has(real),
    });
  }
  return [...byRealpath.values()];
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

function knownRootDirectories(env: NodeJS.ProcessEnv, npmGlobalRoot: string | undefined): string[] {
  const home = env.HOME?.trim();
  const dirs: string[] = [];
  if (home) dirs.push(path.join(home, ".bun", "bin"));
  if (npmGlobalRoot) dirs.push(npmGlobalBinDir(npmGlobalRoot));
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) dirs.push(pnpmHome);
  if (home) dirs.push(path.join(home, ".local", "bin"));
  dirs.push("/usr/local/bin");
  dirs.push(...nvmBinDirectories(env, home));
  return dirs;
}

/** npm's global bin dir is the prefix sibling of `<prefix>/lib/node_modules`: `<prefix>/bin`. */
function npmGlobalBinDir(npmGlobalRoot: string): string {
  return path.join(path.dirname(path.dirname(npmGlobalRoot)), "bin");
}

function nvmBinDirectories(env: NodeJS.ProcessEnv, home: string | undefined): string[] {
  const nvmDir = env.NVM_DIR?.trim() || (home ? path.join(home, ".nvm") : undefined);
  if (!nvmDir) return [];
  const versionsRoot = path.join(nvmDir, "versions", "node");
  let versions: string[];
  try {
    versions = fs.readdirSync(versionsRoot);
  } catch {
    return [];
  }
  return versions.map((version) => path.join(versionsRoot, version, "bin"));
}

/** `nodePath` mirrors `resolveNpmGlobalRootForThisProcess` in self-update.ts: no provable node, no root. */
function resolveNpmGlobalRootSafely(env: NodeJS.ProcessEnv): string | undefined {
  const nodePath = env.AKM_LAUNCHER_NODE?.trim() || (process.versions.bun ? undefined : process.execPath);
  if (!nodePath) return undefined;
  try {
    return resolveNpmGlobalRoot(nodePath, env);
  } catch {
    return undefined;
  }
}

function addCandidate(paths: Set<string>, dir: string | undefined): void {
  if (!dir) return;
  for (const name of ["akm", "akm.exe", "akm.cmd"]) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) paths.add(candidate);
    } catch {
      // Not present at this root — normal; not every root exists on every host.
    }
  }
}

/**
 * Classify a resolved install path with the same node_modules-layout
 * signals `detectInstallMethod` (self-update.ts) uses for the running
 * process, generalized to an arbitrary discovered file:
 *   - under a bun/pnpm global store → "bun"/"pnpm"
 *   - otherwise inside any `node_modules/` → "npm" (matches
 *     `detectInstallMethod`'s own node_modules default)
 *   - otherwise inside a git checkout → "checkout"
 *   - otherwise → "standalone" (a compiled release binary)
 */
function classifyInstall(real: string): AkmInstallManager {
  const normalized = normalizePathSeparators(real);
  if (BUN_GLOBAL_INSTALL_PATTERN.test(normalized)) return "bun";
  if (PNPM_GLOBAL_INSTALL_PATTERN.test(normalized)) return "pnpm";
  if (normalized.includes(NODE_MODULES_SEGMENT)) return "npm";
  if (hasGitAncestor(real)) return "checkout";
  return "standalone";
}

function probeVersion(run: typeof spawnSync, real: string): string | undefined {
  let result: SpawnSyncReturns<string>;
  try {
    result = run(real, ["--version"], {
      encoding: "utf8",
      timeout: AKM_INSTALL_VERSION_PROBE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if ((result.status ?? 1) !== 0) return undefined;
  return result.stdout?.trim() || undefined;
}

function defaultRunningRealpaths(): string[] {
  const paths: string[] = [];
  for (const candidate of [process.execPath, process.argv[1]]) {
    if (!candidate) continue;
    try {
      paths.push(fs.realpathSync(candidate));
    } catch {
      // Not resolvable — not every launch has a real argv[1] (e.g. a REPL).
    }
  }
  return paths;
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}
