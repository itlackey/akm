// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE allowlist-based child-environment primitive.
 *
 * Every akm code path that spawns a child from an explicit list of environment
 * variable NAMES — the agent-CLI spawn wrapper
 * (`integrations/agent/spawn.ts`, `profile.envPassthrough`) and the workflow
 * `exec` unit runner (`workflows/exec/exec-unit.ts`) — starts from an EMPTY
 * environment and copies through named entries with {@link collectAllowlistedEnv}.
 * Keeping that in one leaf module is what makes "allowlist" a single reviewable
 * mechanism instead of two implementations that drift apart.
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
 * Build a child environment from an allowlist: start EMPTY and copy through
 * exactly the named variables that exist in `source`. Names absent from the
 * source are simply absent from the child (never an empty string, which many
 * tools treat as "set but blank").
 *
 * `PATH`, when it comes through, is supplemented for scheduler contexts — see
 * {@link supplementPathForSchedulerContext}. That happens here rather than in
 * each caller so a child spawned from cron/launchd/Task Scheduler can find the
 * user's toolchain no matter which spawn path reached it.
 */
export function collectAllowlistedEnv(
  names: Iterable<string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (env.PATH !== undefined) {
    env.PATH = supplementPathForSchedulerContext(env.PATH);
  }
  return env;
}

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
 */
export function supplementPathForSchedulerContext(existingPath: string): string {
  const home = os.homedir();
  // If PATH already contains the home directory, we are in an interactive
  // shell — skip supplementation entirely.
  if (existingPath.split(path.delimiter).some((d) => d.startsWith(home))) {
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
