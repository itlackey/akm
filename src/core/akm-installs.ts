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
 *
 * The running node is not the only one that can have installed an `akm`
 * global (upgrade-D3 r3-4): every distinct `node` executable found on `PATH`,
 * in an nvm `bin/` dir, or in `~/.bun/bin` gets its own npm global root
 * probed the same bounded, local way, and that root's `<root>/akm-cli/dist`
 * is scanned directly so a copy that was `npm install -g`'d there but never
 * linked onto PATH is still reported. `${BUN_INSTALL:-~/.bun}/lib/node_modules`
 * is scanned unconditionally too: that is where `npm install -g` puts a
 * package when it runs under bun's `node -> bun` shim, a layout distinct
 * from bun's own global install and easy to strand out of sight.
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
// The negative lookahead excludes `.bun/lib/node_modules/`: that is npm's
// own global-root layout (`<prefix>/lib/node_modules`), which a plain `npm
// install -g` produces when it runs under bun's `node -> bun` shim with
// `$HOME/.bun` (or `$BUN_INSTALL`) as its prefix. Bun's own global installs
// never use that literal subpath (`install/global/node_modules/` today, or
// a bare version directory in the older layout), so this stays a bun match
// while letting the npm-under-bun-shim case fall through to the generic
// `node_modules` → "npm" classification below (upgrade-D3 r3-4).
export const BUN_GLOBAL_INSTALL_PATTERN = /(^|\/)\.bun\/(?!lib\/node_modules\/)(?:[^/]+\/)+node_modules\//;

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
  /**
   * Directory of the first (pre-realpath) candidate that resolved to
   * `path` — e.g. `~/.nvm/versions/node/v24/bin` for an nvm shim whose
   * realpath lands under `lib/node_modules/akm-cli/dist`. Unlike
   * `path.dirname(path)`, this is where that install's own adjacent
   * package manager (`npm`/`pnpm`) actually lives, so upgrading through it
   * uses the right manager instead of falling back to the bare command on
   * the running process's PATH (upgrade-D D3).
   */
  binDir: string;
  manager: AkmInstallManager;
  /** `--version` output, trimmed, or `undefined` when the probe failed or timed out. */
  version: string | undefined;
  /** True when this install is the one executing right now. */
  isRunning: boolean;
  /**
   * False when the ONLY candidate that resolved to this install was the
   * direct `<npmGlobalRoot>/akm-cli/dist` scan in
   * {@link addNpmGlobalRootCandidates} — a copy `npm install -g` placed on
   * disk but never linked onto PATH, a prefix `bin/`, or an nvm `bin/`.
   * `akm upgrade` cannot manage an unlinked copy through any package manager
   * command, since there is no link for that manager to update. True for
   * every other candidate source (PATH, the known roots, a prefix's `bin/`,
   * an nvm `bin/`). On Windows npm links a global package with cmd-shim
   * FILES in its own prefix (`%APPDATA%\npm\akm.cmd`), never symlinks, so no
   * realpath can tie the shim to `akm-cli\dist`; there, a direct scan whose
   * prefix holds `akm.cmd` counts as linked.
   */
  linked: boolean;
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
  /**
   * Extra install roots scanned unconditionally, regardless of `PATH` or
   * `HOME`/`NVM_DIR` — `install.sh`'s default `INSTALL_DIR`. Defaults to
   * `["/usr/local/bin"]`. Tests supply `[]` so a real standalone install on
   * the host running the tests cannot leak into enumeration (upgrade-D r2-3).
   */
  fixedRoots?: readonly string[];
  /**
   * The platform whose npm layout and link rule apply; defaults to
   * `process.platform`. Tests exercise the win32 branch (prefix-is-bin-dir,
   * cmd-shim files) on a POSIX host through this seam.
   */
  platform?: NodeJS.Platform;
}

/**
 * Enumerate every `akm` found on `PATH` plus the known install roots,
 * deduped by realpath. Never throws — a root that does not exist, cannot be
 * read, or resolves to a broken symlink is simply skipped.
 */
export function enumerateAkmInstalls(env: NodeJS.ProcessEnv, options: EnumerateAkmInstallsOptions = {}): AkmInstall[] {
  const run = options.spawnSync ?? spawnSync;
  const runningRealpaths = new Set(options.runningRealpaths ?? defaultRunningRealpaths());
  const platform = options.platform ?? process.platform;
  const npmGlobalRoot = resolveNpmGlobalRootSafely(env);
  const home = env.HOME?.trim();

  const fixedRoots = options.fixedRoots ?? ["/usr/local/bin"];

  // candidate akm path -> the binDir it should be reported with, and
  // whether it was reached only through the direct `akm-cli/dist` scan.
  // `binDir` is normally just the directory the candidate was found in, but
  // a candidate added directly from an npm global root's `akm-cli/dist`
  // (below) is reported with that root's `bin/` instead — where its
  // adjacent npm actually lives, not the `dist/` directory it has no
  // package manager in.
  const candidates = new Map<string, { binDir: string; direct: boolean }>();
  for (const dir of pathDirectories(env)) addCandidate(candidates, dir);
  for (const dir of knownRootDirectories(env, npmGlobalRoot, fixedRoots, platform)) addCandidate(candidates, dir);
  for (const root of discoverAdjacentNpmGlobalRoots(env, home)) addNpmGlobalRootCandidates(candidates, root, platform);
  const bunPrefixRoot = bunPrefixLibNodeModules(env, home);
  if (bunPrefixRoot) addNpmGlobalRootCandidates(candidates, bunPrefixRoot, platform);

  const byRealpath = new Map<string, AkmInstall>();
  for (const [candidate, { binDir, direct }] of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // broken symlink, or it vanished between listing and stat
    }
    const existing = byRealpath.get(real);
    if (existing) {
      // A later, direct-only candidate never demotes an already-linked
      // install; a later linked candidate always promotes an install first
      // seen only through the direct scan (upgrade-D3 r2-1).
      if (!direct) existing.linked = true;
      continue;
    }
    byRealpath.set(real, {
      path: real,
      binDir,
      manager: classifyInstall(real),
      version: probeVersion(run, real),
      isRunning: runningRealpaths.has(real),
      linked: !direct,
    });
  }
  return [...byRealpath.values()];
}

/**
 * Every distinct `node` executable found on `PATH`, in an nvm `bin/` dir, or
 * in `~/.bun/bin`, resolved to its own npm global root the same bounded,
 * local way {@link resolveNpmGlobalRoot} resolves it for the running node.
 * Only the running node's root was ever probed before (upgrade-D3 r3-4), so
 * a package installed under any other node on the host — an nvm copy, or
 * the bun-shimmed `node` a stray `npm install -g` ran under — was invisible.
 */
function discoverAdjacentNpmGlobalRoots(env: NodeJS.ProcessEnv, home: string | undefined): Set<string> {
  const roots = new Set<string>();
  const probedNodes = new Set<string>();
  const dirs = [
    ...pathDirectories(env),
    ...nvmBinDirectories(env, home),
    ...(home ? [path.join(home, ".bun", "bin")] : []),
  ];
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      let real: string;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (probedNodes.has(real)) continue;
      probedNodes.add(real);
      try {
        const root = resolveNpmGlobalRoot(candidate, env);
        if (root) roots.add(root);
      } catch {
        // Not a usable node/npm pair on this host — skip it.
      }
    }
  }
  return roots;
}

/**
 * `${BUN_INSTALL:-~/.bun}/lib/node_modules` — npm's own global-root layout
 * under bun's prefix. Scanned unconditionally (not gated on finding a
 * working `node`/`npm` pair there) because it is exactly where `npm install
 * -g` lands when it runs under bun's `node -> bun` shim: that shim answers
 * `--version` like node but cannot run npm's script through
 * {@link resolveNpmGlobalRoot}'s probe (upgrade-D3 r3-4).
 */
function bunPrefixLibNodeModules(env: NodeJS.ProcessEnv, home: string | undefined): string | undefined {
  const bunInstall = env.BUN_INSTALL?.trim() || (home ? path.join(home, ".bun") : undefined);
  return bunInstall ? path.join(bunInstall, "lib", "node_modules") : undefined;
}

/**
 * Adds `<root>/../bin` (that root's own bin dir) and `<root>/akm-cli/dist`
 * as candidates, both reported with that bin dir. The `akm-cli/dist` scan is
 * `direct: true` — it is the only way this function reports an install that
 * was never linked onto any bin dir, so it must never mark `linked: true` on
 * its own (see the `linked` field on {@link AkmInstall}).
 */
function addNpmGlobalRootCandidates(
  candidates: Map<string, { binDir: string; direct: boolean }>,
  npmGlobalRoot: string,
  platform: NodeJS.Platform,
): void {
  const binDir = npmGlobalBinDir(npmGlobalRoot, platform);
  addCandidate(candidates, binDir);
  // On Windows npm's link is a cmd-shim FILE in its own prefix, which no
  // realpath can tie back to `akm-cli\dist`; the shim in that prefix is that
  // prefix's link by construction, so the direct scan counts as linked when
  // it is present. POSIX keeps the realpath rule: only a real symlink links.
  const direct = platform === "win32" ? !fs.existsSync(path.join(binDir, "akm.cmd")) : true;
  addCandidate(candidates, path.join(npmGlobalRoot, "akm-cli", "dist"), binDir, direct);
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

function knownRootDirectories(
  env: NodeJS.ProcessEnv,
  npmGlobalRoot: string | undefined,
  fixedRoots: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const home = env.HOME?.trim();
  const dirs: string[] = [];
  if (home) dirs.push(path.join(home, ".bun", "bin"));
  if (npmGlobalRoot) dirs.push(npmGlobalBinDir(npmGlobalRoot, platform));
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) dirs.push(pnpmHome);
  if (home) dirs.push(path.join(home, ".local", "bin"));
  dirs.push(...fixedRoots);
  dirs.push(...nvmBinDirectories(env, home));
  return dirs;
}

/**
 * npm's global bin dir for a global root. POSIX: the prefix sibling of
 * `<prefix>/lib/node_modules`, i.e. `<prefix>/bin`. Windows: the root is
 * `<prefix>\node_modules` and the shims live in the prefix itself.
 */
function npmGlobalBinDir(npmGlobalRoot: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.dirname(npmGlobalRoot);
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

/**
 * `binDirOverride` reports the candidate under a different binDir than
 * `dir` — see the call site in `addNpmGlobalRootCandidates`. `direct` marks
 * a candidate reached only through the direct `akm-cli/dist` scan there;
 * every other call site leaves it `false` (a real bin-dir candidate).
 */
function addCandidate(
  paths: Map<string, { binDir: string; direct: boolean }>,
  dir: string | undefined,
  binDirOverride?: string,
  direct = false,
): void {
  if (!dir) return;
  for (const name of ["akm", "akm.exe", "akm.cmd"]) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) paths.set(candidate, { binDir: binDirOverride ?? dir, direct });
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

/**
 * True for an npm-managed install that `akm upgrade` can never move because
 * nothing links it onto any bin dir (upgrade-D3 r2-1). Shared by the
 * self-update "left untouched" status and the `akm-installs` health remedy
 * so the "is this install manageable" decision lives in one place.
 */
export function isUnlinkedNpmInstall(install: AkmInstall): boolean {
  return install.manager === "npm" && !install.linked;
}

/**
 * The npm package directory implied by the `<npmGlobalRoot>/akm-cli/dist/<binary>`
 * layout {@link addNpmGlobalRootCandidates}'s direct scan assumes — this
 * install's realpath, two directories up from the `akm` binary itself.
 */
export function unlinkedNpmPackageRoot(install: AkmInstall): string {
  return path.dirname(path.dirname(install.path));
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
