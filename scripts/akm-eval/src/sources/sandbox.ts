/**
 * Reusable sandbox helper.
 *
 * Builds tmpdir-scoped storage roots and returns the env carve-outs that
 * isolate `akm` invocations from every user storage directory.
 * Used by:
 *   - paired mode in `src/run.ts` (copies the live stash for re-eval),
 *   - the memory-safety runner (mandatory isolation; mutates the stash),
 *   - Phase 5's graph A/B harness (will reuse this verbatim).
 *
 * Isolation contract (updated for PR #449 / 2026-05-23 incident):
 *   - HOME and all XDG homes point under $root.
 *   - Every AKM storage override points under $root, so hostile parent
 *     overrides cannot take precedence over the XDG carve-outs.
 * No akm code path can escape into the real user directories.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Sandbox {
  /** Absolute path to the sandboxed stash dir. */
  stashDir: string;
  /** Absolute path to the sandbox data dir (state.db, etc.). */
  dataDir: string;
  /** Complete storage-isolation env to pass to subprocess invocations. */
  env: Record<string, string>;
  /** Absolute path to the sandbox root (parent of stashDir + dataDir). */
  root: string;
  /** Remove the sandbox. Idempotent; safe to call from a finally block. */
  cleanup(): void;
}

export interface CreateSandboxOptions {
  /** Either a directory to copy in as the initial stash, or empty to start fresh. */
  fixture?: string;
  /** Inherit parent env vars (filtered to safe ones) on top of the carve-out. */
  inheritEnv?: boolean;
  /** Prefix for the tmpdir name. */
  prefix?: string;
}

/** Storage variables that must be selected explicitly for every eval child. */
export const EVAL_STORAGE_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;

/** Host session identity/path overrides that must not bleed into an eval child. */
const EVAL_SESSION_ENV_KEYS = [
  "XDG_RUNTIME_DIR",
  "AKM_CLAUDE_PROJECTS_DIR",
  "CLAUDE_PROJECT_DIR",
] as const;

const SESSION_ID_ENV_KEY = /(?:^|_)SESSION_ID$/;

/** Inherit trusted-runtime configuration and credentials, but never host storage/session state. */
export function buildEvalChildEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const excluded = new Set<string>([...EVAL_STORAGE_ENV_KEYS, ...EVAL_SESSION_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !excluded.has(key) && !SESSION_ID_ENV_KEY.test(key)) env[key] = value;
  }
  return env;
}

export function createSandbox(opts: CreateSandboxOptions = {}): Sandbox {
  const prefix = opts.prefix ?? "akm-eval-sandbox-";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stashDir = path.join(root, "stash");
  const dataDir = path.join(root, "data");
  const homeDir = path.join(root, "home");
  const configDir = path.join(stashDir, ".akm");
  const cacheDir = path.join(root, "cache");
  const stateDir = path.join(root, "state");
  const xdgConfigHome = path.join(root, "xdg", "config");
  const xdgDataHome = path.join(root, "xdg", "data");
  const xdgCacheHome = path.join(root, "xdg", "cache");
  const xdgStateHome = path.join(root, "xdg", "state");

  if (opts.fixture) {
    if (!fs.existsSync(opts.fixture)) {
      throw new Error(`sandbox fixture not found: ${opts.fixture}`);
    }
    fs.cpSync(opts.fixture, stashDir, { recursive: true });
  } else {
    fs.mkdirSync(stashDir, { recursive: true });
  }
  for (const dir of [
    dataDir,
    homeDir,
    configDir,
    cacheDir,
    stateDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const env = opts.inheritEnv ? buildEvalChildEnv() : {};
  env.AKM_STASH_DIR = stashDir;
  env.AKM_CONFIG_DIR = configDir;
  env.AKM_DATA_DIR = dataDir;
  env.AKM_CACHE_DIR = cacheDir;
  env.AKM_STATE_DIR = stateDir;
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = xdgConfigHome;
  env.XDG_DATA_HOME = xdgDataHome;
  env.XDG_CACHE_HOME = xdgCacheHome;
  env.XDG_STATE_HOME = xdgStateHome;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { root, stashDir, dataDir, env, cleanup };
}
