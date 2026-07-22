/**
 * Path resolution helpers that mirror akm's own path logic.
 *
 * Standalone so the toolkit never imports akm internals. Kept in lock-step
 * with `src/core/paths.ts` semantics: respects `AKM_DATA_DIR`,
 * `XDG_DATA_HOME`, and `AKM_STASH_DIR`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.AKM_DATA_DIR?.trim();
  if (override) return override;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.win32.join(localAppData, "akm", "data");
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.win32.join(userProfile, "AppData", "Local", "akm", "data");
    const appData = env.APPDATA?.trim();
    if (appData) return path.win32.normalize(path.win32.join(appData, "..", "Local", "akm", "data"));
    throw new Error("Unable to determine data directory. Set AKM_DATA_DIR, LOCALAPPDATA, USERPROFILE, or APPDATA.");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return path.join(xdgDataHome, "akm");
  const home = env.HOME?.trim();
  return home ? path.join(home, ".local", "share", "akm") : path.join("/tmp", "akm-data");
}

export function resolveStashDir(
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (override) return path.resolve(override);
  if (env.AKM_STASH_DIR) return path.resolve(env.AKM_STASH_DIR);
  return path.resolve(path.join(os.homedir(), "akm"));
}

export function resolveStateDbPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? path.win32.join(resolveDataDir(env, platform), "state.db")
    : path.join(resolveDataDir(env, platform), "state.db");
}

export function resolveIndexDbPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? path.win32.join(resolveDataDir(env, platform), "index.db")
    : path.join(resolveDataDir(env, platform), "index.db");
}

export function resolveEvalsRoot(stashRoot: string): string {
  return path.join(stashRoot, ".akm", "evals");
}

export function resolveProposalsRoot(stashRoot: string): string {
  return path.join(stashRoot, ".akm", "proposals");
}

export function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
