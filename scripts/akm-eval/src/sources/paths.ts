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

export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.AKM_DATA_DIR) return env.AKM_DATA_DIR;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, "akm");
  return path.join(os.homedir(), ".local", "share", "akm");
}

export function resolveStashDir(
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (override) return path.resolve(override);
  if (env.AKM_STASH_DIR) return path.resolve(env.AKM_STASH_DIR);
  return path.resolve(path.join(os.homedir(), "akm"));
}

export function resolveStateDbPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(resolveDataDir(env), "state.db");
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
