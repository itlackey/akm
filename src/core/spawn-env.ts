// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE allowlist-based child-environment primitive.
 *
 * Three akm code paths spawn a child from an explicit list of environment
 * variable NAMES — the agent-CLI spawn wrapper
 * (`integrations/agent/spawn.ts`, `profile.envPassthrough`), the workflow
 * `exec` unit runner (`workflows/exec/exec-unit.ts`), and the opencode-sdk
 * server spawn (`integrations/harnesses/opencode-sdk/sdk-runner.ts`) — and
 * all build their allowlist from {@link COMMON_SPAWN_ENV_PASSTHROUGH} /
 * {@link spawnEnvNamesFor}. Keeping that in one leaf module is what makes
 * "allowlist" a single reviewable mechanism instead of independent
 * implementations that drift apart.
 *
 * A LEAF: node built-ins only, so both the integrations layer and the workflow
 * engine can import it without opening a cycle.
 *
 * @module core/spawn-env
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The baseline env names every allowlisted akm child receives regardless of
 * what it runs: process identity (`HOME`, `USER`), tool resolution (`PATH`),
 * locale (`LANG`, `LC_ALL`), terminal (`TERM`), scratch space (`TMPDIR`), and
 * akm's own event provenance (`AKM_EVENT_SOURCE` — machine traffic, never a
 * secret). BOTH allowlists extend it — the agent-CLI profiles'
 * `COMMON_PASSTHROUGH` (`integrations/agent/profiles.ts`) and the workflow
 * exec unit's `EXEC_DEFAULT_ENV_PASSTHROUGH` (`workflows/exec/exec-unit.ts`)
 * — so a baseline name cannot drift into one child-spawn path but not the
 * other. NOTE: profile `envPassthrough` is frozen into workflow engine
 * snapshots, so growing this list changes frozen-plan content — extend
 * deliberately.
 */
export const COMMON_SPAWN_ENV_PASSTHROUGH = [
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "AKM_EVENT_SOURCE",
] as const;

/**
 * The names Windows itself requires of ANY child, whatever the caller's
 * allowlist says. Applied at build time rather than added to
 * {@link COMMON_SPAWN_ENV_PASSTHROUGH} because profile `envPassthrough` is
 * frozen into workflow engine snapshots: growing the shared list would change
 * the bytes — and so the hashes — of every plan already on disk, to express
 * something that is not a policy choice at all.
 *
 * `SystemRoot`, `SystemDrive` and `WINDIR` are what PROCESS CREATION reads;
 * without them the loader cannot find system DLLs and the spawn fails before
 * the command runs. Without `PATHEXT` Windows never tries `bun.exe`/`bun.cmd`,
 * so a `bin: "bun"` profile is unresolvable, and `COMSPEC` is how `.bat`/`.cmd`
 * targets resolve at all. The rest are the win32 analogues of baseline names
 * the POSIX side already grants — `HOME` (`USERPROFILE`, `HOMEDRIVE`,
 * `HOMEPATH`) and `TMPDIR` (`TEMP`, `TMP`). None is a secret.
 *
 * Config and install roots (`APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, …) are
 * deliberately NOT here: a child can be created and can resolve its command
 * without them, so which allowlist wants them stays a per-caller decision.
 *
 * THE definition of the floor. The workflow exec allowlist
 * (`EXEC_DEFAULT_ENV_PASSTHROUGH`) spreads this constant rather than
 * re-spelling it, because that list is also consumed on POSIX — where
 * {@link spawnEnvNamesFor} appends nothing — and the names still have to be
 * requestable there for a win32 run of the same workflow.
 */
export const WIN32_SPAWN_ENV_FLOOR = [
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
] as const;

/**
 * The effective allowlist for `platform`: the caller's names, plus any floor
 * the operating system requires of every child regardless of allowlist.
 * Exported for tests, which must be able to ask for a platform they are not
 * running on.
 */
export function spawnEnvNamesFor(names: Iterable<string>, platform: string = process.platform): string[] {
  const effective = [...names];
  if (platform !== "win32") return effective;
  // Deduped by EXACT spelling, never case-folded: {@link collectAllowlistedEnv}
  // looks each surviving name up with exactly this case, and a `source` that is
  // a plain object — the agent spawn's `envSource` seam — does not case-fold.
  // Suppressing `SystemRoot` because the caller happened to write `SYSTEMROOT`
  // would therefore drop the loader-critical variable the floor exists to
  // guarantee. Keeping both spellings is harmless: the win32 environment is
  // itself case-insensitive, so they resolve to the same value.
  const present = new Set(effective);
  for (const name of WIN32_SPAWN_ENV_FLOOR) {
    if (!present.has(name)) effective.push(name);
  }
  return effective;
}

/**
 * Build a child environment from an allowlist: start EMPTY and copy through
 * exactly the named variables that exist in `source`. Names absent from the
 * source are simply absent from the child (never an empty string, which many
 * tools treat as "set but blank").
 *
 * `PATH`, when it comes through, is supplemented for scheduler contexts — see
 * {@link supplementPathForSchedulerContext}. That happens here rather than in
 * each caller so a child spawned from cron/launchd/Task Scheduler can find the
 * user's toolchain no matter which spawn path reached it. On win32 the names
 * in {@link WIN32_SPAWN_ENV_FLOOR} come through too, for the same reason: the
 * spawn cannot succeed without them, whichever caller built the list.
 */
export function collectAllowlistedEnv(
  names: Iterable<string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of spawnEnvNamesFor(names)) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (env.PATH !== undefined) {
    env.PATH = supplementPathForSchedulerContext(env.PATH);
  }
  return env;
}

/**
 * Answers already computed by {@link supplementPathForSchedulerContext}, keyed
 * by the input PATH and the home directory it was computed against.
 *
 * Correctness envelope: the answer is a pure function of those two, the
 * platform, and which candidate directories exist on disk. The platform cannot
 * change under a running process, and the other two are in the key — so the one
 * thing the memo assumes is that a candidate directory does not APPEAR while
 * akm runs. Answering the rest of a run the way its start was answered is what
 * a shell's own command-path caching already does, and the cost of not
 * memoizing is paid on every child-env build: two PATH splits and up to seven
 * SYNCHRONOUS `existsSync` probes, on the event loop a 10 000-unit fan-out
 * shares with every other in-flight unit.
 *
 * Bounded so a caller that somehow varies its PATH cannot grow it without
 * limit; a spawn path only ever sees a handful of distinct PATH strings, so
 * the reset is effectively unreachable in practice.
 */
const supplementedPaths = new Map<string, string>();
const SUPPLEMENTED_PATH_MEMO_MAX = 64;

/**
 * Supplement `existingPath` with well-known user binary directories when
 * running in a scheduler context (cron/launchd) where PATH is stripped.
 *
 * Detection heuristic: if the current PATH does not contain the user's home
 * directory, we are likely in a stripped scheduler env. In an interactive
 * shell the user's home almost always appears (e.g. ~/.bun/bin, ~/.cargo/bin).
 *
 * Only directories that actually exist on disk are prepended, and only if
 * they are not already present, so interactive-shell PATH ordering is never
 * disturbed.
 *
 * Memoized per input PATH — see {@link supplementedPaths} for what that
 * assumes.
 */
export function supplementPathForSchedulerContext(existingPath: string): string {
  const home = os.homedir();
  // NUL-joined so no pair of (home, PATH) can collide onto one key: no path
  // component can contain a NUL.
  const key = `${home}\u0000${existingPath}`;
  const memoized = supplementedPaths.get(key);
  if (memoized !== undefined) return memoized;
  const supplemented = computeSupplementedPath(existingPath, home);
  if (supplementedPaths.size >= SUPPLEMENTED_PATH_MEMO_MAX) supplementedPaths.clear();
  supplementedPaths.set(key, supplemented);
  return supplemented;
}

function computeSupplementedPath(existingPath: string, home: string): string {
  // A home of `/` (system crontab, launchd, service accounts) or of `""`
  // prefixes EVERY entry, so a prefix test would read the most stripped
  // environments there are as interactive and skip the repair they exist for.
  const comparableHome = home === "" || home === path.sep ? undefined : home;
  // If PATH already contains the home directory, we are in an interactive
  // shell — skip supplementation entirely. Compared on a path boundary: a
  // sibling home (`/home/alice` next to `/home/al`) is not this user's.
  const isUnderHome = (dir: string): boolean =>
    comparableHome !== undefined && (dir === comparableHome || dir.startsWith(comparableHome + path.sep));
  if (existingPath.split(path.delimiter).some(isUnderHome)) {
    return existingPath;
  }
  const candidates = pathCandidatesForCurrentPlatform(home);
  const existing = new Set(existingPath.split(path.delimiter).filter(Boolean));
  const toAdd = candidates.filter((d) => !existing.has(d) && fs.existsSync(d));
  if (toAdd.length === 0) return existingPath;
  return [...toAdd, existingPath].filter(Boolean).join(path.delimiter);
}

function pathCandidatesForCurrentPlatform(home: string): string[] {
  if (process.platform === "win32") {
    // Windows: Bun + Cargo + Scoop + Chocolatey + system tools. Order favors
    // user-local installs over machine-global so the user's chosen toolchain
    // wins. These paths are commonly stripped from Task Scheduler / service
    // environments, mirroring the cron/launchd problem on POSIX.
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const userProfile = process.env.USERPROFILE ?? home;
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(userProfile, ".bun", "bin"),
      path.join(localAppData, "Programs", "bun"),
      path.join(userProfile, ".cargo", "bin"),
      path.join(localAppData, "Programs", "Git", "cmd"),
      path.join(userProfile, "scoop", "shims"),
      path.join(programFiles, "Git", "cmd"),
      "C:\\ProgramData\\chocolatey\\bin",
    ];
  }
  return [
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
}
