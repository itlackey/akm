/**
 * Test-isolation sandbox helpers.
 *
 * These helpers create isolated temporary directories for AKM-specific paths
 * (stash, HOME, XDG config/data) and set the corresponding env vars so tests
 * never touch real user data.
 *
 * Usage pattern:
 *
 *   import { sandboxStashDir, sandboxXdgConfigHome } from "./_helpers/sandbox";
 *
 *   let cleanup: () => void;
 *   beforeEach(() => {
 *     cleanup = sandboxStashDir();           // sets process.env.AKM_STASH_DIR
 *     sandboxXdgConfigHome(cleanup);         // sets process.env.XDG_CONFIG_HOME
 *   });
 *   afterEach(() => cleanup());
 *
 * Each function returns a `cleanup` callback that removes the temp dir and
 * restores the original env var value.  If you pass an existing `cleanup`
 * callback as the first argument the new cleanup is chained onto it so a
 * single call to the returned callback undoes all sandboxed env vars.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Cleanup = () => void;

/** A disposable sandbox directory: its path plus a cleanup function. */
export interface SandboxedDir {
  dir: string;
  cleanup: Cleanup;
}

/**
 * The standard subdirectories an initialized AKM stash has.
 *
 * Single source of truth for the "freshly initialized stash" layout used by
 * the test sandbox. Mirrors the `stashDir` values of the default asset specs
 * that `akm init` scaffolds (src/core/asset/asset-spec.ts → src/commands/init.ts).
 * Kept as a literal here (rather than importing TYPE_DIRS) so the helper has
 * no production-module dependency and so the set is stable regardless of any
 * runtime asset-type (de)registration a test performs.
 *
 * Previously two divergent lists existed in this file: `makeStashDir` created
 * 5 dirs (scripts, skills, commands, agents, knowledge) and `sandboxStashDir`
 * created 7 (… + memories, lessons). Both now derive from this one constant.
 */
export const STASH_SKELETON_SUBDIRS: readonly string[] = [
  "skills",
  "commands",
  "agents",
  "knowledge",
  "scripts",
  "memories",
  "lessons",
];

let sandboxCounter = 0;

/**
 * Run `fn` with `process.env` keys temporarily set to the given values,
 * restoring each prior value (or deleting the key) in a `finally` — even if
 * `fn` throws.
 *
 * Lives here (in the allowlisted sandbox helper) rather than inline in test
 * files so the test-isolation lint stays satisfied: tests mutate env only
 * through this restoring wrapper. Used by the in-process CLI harness call sites
 * that need a per-call env override (e.g. a populated `AKM_STASH_DIR`).
 */
export async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  try {
    for (const key of keys) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

/**
 * Create an isolated, asset-typed stash directory (with the standard subdirs an
 * initialized stash has) and return its path plus a disposer. The directory is
 * NOT wired into `process.env` — callers pass it to `withEnv({ AKM_STASH_DIR })`
 * or to a subprocess env. Registering cleanup here keeps `fs.mkdtempSync` out of
 * test files (which the isolation lint flags).
 */
export function makeStashDir(): SandboxedDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-sb-stash2-${sandboxCounter++}-`));
  for (const sub of STASH_SKELETON_SUBDIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Create an isolated empty temp directory and return its path plus a disposer.
 * Like {@link makeStashDir} but without the stash subdir scaffold — for project
 * dirs, config dirs, etc. Keeps `fs.mkdtempSync` out of test files.
 */
export function makeSandboxDir(prefix = "akm-sb-dir"): SandboxedDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${sandboxCounter++}-`));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ── Core primitive ───────────────────────────────────────────────────────────

/**
 * Create a temp dir, set `envVar` to it, and return a cleanup callback that
 * restores the original value and (optionally) deletes the temp dir.
 *
 * @param prefix   Prefix passed to `mkdtempSync`.
 * @param envVar   The process.env key to override.
 * @param chain    An optional existing cleanup callback to chain onto.
 */
export function sandboxEnvDir(prefix: string, envVar: string, chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env[envVar];
  process.env[envVar] = dir;

  const cleanup: Cleanup = () => {
    // Restore env var
    if (previous === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = previous;
    }
    // Remove temp dir (best-effort)
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Run any previously chained cleanup
    if (chain) chain();
  };

  return { dir, cleanup };
}

// ── Named helpers ────────────────────────────────────────────────────────────

/**
 * Sandbox `AKM_STASH_DIR`.  Returns `{ dir, cleanup }` where `dir` is the new
 * stash root.  The standard stash subdirs (skills, commands, agents, knowledge,
 * scripts, memories, lessons) are created automatically.
 */
export function sandboxStashDir(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  const result = sandboxEnvDir("akm-sb-stash-", "AKM_STASH_DIR", chain);
  for (const sub of STASH_SKELETON_SUBDIRS) {
    fs.mkdirSync(path.join(result.dir, sub), { recursive: true });
  }
  return result;
}

/**
 * Sandbox `HOME`.  Returns `{ dir, cleanup }` where `dir` is the fake HOME.
 */
export function sandboxHome(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  return sandboxEnvDir("akm-sb-home-", "HOME", chain);
}

/**
 * Sandbox `XDG_CONFIG_HOME`.  Returns `{ dir, cleanup }`.
 * The `akm/` subdirectory is created automatically.
 */
export function sandboxXdgConfigHome(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  const result = sandboxEnvDir("akm-sb-cfg-", "XDG_CONFIG_HOME", chain);
  fs.mkdirSync(path.join(result.dir, "akm"), { recursive: true });
  return result;
}

/**
 * Sandbox `XDG_DATA_HOME`.  Returns `{ dir, cleanup }`.
 */
export function sandboxXdgDataHome(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  return sandboxEnvDir("akm-sb-data-", "XDG_DATA_HOME", chain);
}

/**
 * Sandbox `XDG_CACHE_HOME`.  Returns `{ dir, cleanup }`.
 */
export function sandboxXdgCacheHome(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  return sandboxEnvDir("akm-sb-cache-", "XDG_CACHE_HOME", chain);
}

/**
 * Sandbox `XDG_STATE_HOME`.  Returns `{ dir, cleanup }`.
 */
export function sandboxXdgStateHome(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  return sandboxEnvDir("akm-sb-state-", "XDG_STATE_HOME", chain);
}

// ── Composite isolation fixture ──────────────────────────────────────────────

/**
 * The resolved isolated-storage context returned by
 * {@link withIsolatedAkmStorage}. Every path is an absolute directory that
 * already exists on disk under a single per-call temp root.
 */
export interface IsolatedAkmStorage {
  /** Isolated stash root (`AKM_STASH_DIR`), scaffolded with the standard subdirs. */
  readonly stashDir: string;
  /** Isolated data dir (`XDG_DATA_HOME`). */
  readonly dataDir: string;
  /** Isolated cache dir (`XDG_CACHE_HOME`). */
  readonly cacheDir: string;
  /** Isolated config dir (`XDG_CONFIG_HOME`); its `akm/` subdir is created. */
  readonly configDir: string;
  /** Isolated state dir (`XDG_STATE_HOME`). */
  readonly stateDir: string;
  /** Isolated Claude session-log root (`AKM_CLAUDE_PROJECTS_DIR`), empty by default. */
  readonly sessionLogsDir: string;
  /** The single per-call temp root that contains every dir above. */
  readonly root: string;
  /** Restore every overridden env var and remove the temp root. Idempotent. */
  readonly cleanup: Cleanup;
}

/**
 * Composite test-isolation fixture: collapse the 5-helper sandbox chain
 * (`sandboxStashDir` + `sandboxXdgConfigHome` + `sandboxXdgDataHome` +
 * `sandboxXdgCacheHome` + …) into ONE call that
 *
 *   - creates a single temp root under `os.tmpdir()`,
 *   - creates `stash/`, `data/`, `cache/`, `config/`, `state/` subdirs under it
 *     (the stash scaffolded with {@link STASH_SKELETON_SUBDIRS}, the config with
 *     an `akm/` subdir),
 *   - points `AKM_STASH_DIR`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
 *     `XDG_CONFIG_HOME`, `XDG_STATE_HOME` at them, snapshotting each prior value,
 *   - returns the resolved {@link IsolatedAkmStorage} context plus a single
 *     `cleanup()` that restores every env var and removes the temp root.
 *
 * Usage (the common beforeEach/afterEach shape):
 *
 *   let storage: IsolatedAkmStorage;
 *   beforeEach(() => { storage = withIsolatedAkmStorage(); });
 *   afterEach(() => storage.cleanup());
 *
 * `overrides` lets a test pin a specific env var to a literal value (or delete
 * it with `undefined`); those keys are still restored by `cleanup()`. Any
 * override of one of the four managed XDG/stash vars wins over the temp dir.
 *
 * The single `cleanup` restores env in the reverse order it was applied and is
 * safe to call more than once. The existing `tests/_preload.ts` afterEach
 * tripwire (which throws on any leaked `AKM_*`/`XDG_*`/`HOME` env var) is the
 * regression net that proves this helper restores everything it touched.
 */
export function withIsolatedAkmStorage(overrides?: Record<string, string | undefined>): IsolatedAkmStorage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `akm-iso-${sandboxCounter++}-`));

  const stashDir = path.join(root, "stash");
  const dataDir = path.join(root, "data");
  const cacheDir = path.join(root, "cache");
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");

  for (const sub of STASH_SKELETON_SUBDIRS) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "akm"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const sessionLogsDir = path.join(root, "claude-projects");
  fs.mkdirSync(sessionLogsDir, { recursive: true });

  const env: Record<string, string> = {
    AKM_STASH_DIR: stashDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    // Redirect the Claude session-log scan at an empty fixture dir so the
    // synchronous `akm health` session-log scan stays hermetic and fast
    // instead of walking the host's real (and potentially huge) history.
    AKM_CLAUDE_PROJECTS_DIR: sessionLogsDir,
  };

  // Snapshot + apply env (managed defaults first, then caller overrides so they
  // win). `cleanup` restores every snapshotted key, including override keys.
  const applied: Record<string, string | undefined> = { ...env, ...(overrides ?? {}) };
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(applied)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(applied)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let cleaned = false;
  const cleanup: Cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { stashDir, dataDir, cacheDir, configDir, stateDir, sessionLogsDir, root, cleanup };
}

// ── Config writer ────────────────────────────────────────────────────────────

/**
 * Write a (partial) AKM config JSON into the current `XDG_CONFIG_HOME/akm/`
 * directory.  Merges `partial` over any existing config on disk.
 *
 * Must be called after `sandboxXdgConfigHome()` has been invoked so that
 * `XDG_CONFIG_HOME` is set to an isolated temp dir.
 */
export function writeSandboxConfig(partial: Record<string, unknown>): void {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (!xdgConfigHome) {
    throw new Error("writeSandboxConfig: XDG_CONFIG_HOME is not set — call sandboxXdgConfigHome() first");
  }
  const configPath = path.join(xdgConfigHome, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      // start fresh if corrupt
    }
  }

  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ configVersion: "0.9.0", ...existing, ...partial }, null, 2)}\n`,
    "utf8",
  );
}

// ── Fetch mock ───────────────────────────────────────────────────────────────

/**
 * Temporarily replace `globalThis.fetch` with a mock handler while running
 * an async function.
 *
 * @param run    The async function to run with the mocked fetch.
 * @param mock   A function that receives the request URL string and returns a
 *               `Response` (or throws to simulate a network error).
 */
export async function withMockedFetch<T>(run: () => Promise<T>, mock: (url: string) => Response): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return mock(url);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
