/**
 * Reusable sandbox helper.
 *
 * Builds a tmpdir-scoped stash + data dir pair and returns the env carve-outs
 * that isolate `akm` invocations from the user's real stash and `~/.local`.
 * Used by:
 *   - paired mode in `src/run.ts` (copies the live stash for re-eval),
 *   - the memory-safety runner (mandatory isolation; mutates the stash),
 *   - Phase 5's graph A/B harness (will reuse this verbatim).
 *
 * Isolation contract (updated for PR #449 / 2026-05-23 incident):
 *   - AKM_STASH_DIR   → $root/stash  (transient path, triggers paths.ts
 *                        transient-isolation rule → config writes go to
 *                        $STASH/.akm instead of $HOME/.config/akm)
 *   - AKM_DATA_DIR    → $root/data   (index.db, workflow.db, akm.lock)
 *   - HOME            → $root        (state dir falls to $HOME/.local/state/akm;
 *                        cache dir falls to $HOME/.cache/akm — both isolated)
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
  /** Env vars to pass to subprocess invocations (AKM_STASH_DIR, AKM_DATA_DIR, HOME). */
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

/** Env vars carried over from the parent when `inheritEnv` is set. */
const SAFE_PARENT_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export function createSandbox(opts: CreateSandboxOptions = {}): Sandbox {
  const prefix = opts.prefix ?? "akm-eval-sandbox-";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stashDir = path.join(root, "stash");
  const dataDir = path.join(root, "data");

  if (opts.fixture) {
    if (!fs.existsSync(opts.fixture)) {
      throw new Error(`sandbox fixture not found: ${opts.fixture}`);
    }
    fs.cpSync(opts.fixture, stashDir, { recursive: true });
  } else {
    fs.mkdirSync(stashDir, { recursive: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });

  const env: Record<string, string> = {};
  if (opts.inheritEnv) {
    for (const key of SAFE_PARENT_ENV) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
  }
  env.AKM_STASH_DIR = stashDir;
  env.AKM_DATA_DIR = dataDir;
  env.HOME = root;

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
