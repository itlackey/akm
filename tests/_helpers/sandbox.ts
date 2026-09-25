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
 *     cleanup = sandboxStashDir();           // sets process.env.AKM_BUNDLE_DIR
 *     sandboxXdgConfigHome(cleanup);         // sets process.env.XDG_CONFIG_HOME
 *   });
 *   afterEach(() => cleanup());
 *
 * Each function returns a `cleanup` callback that removes the temp dir and
 * restores the original env var value.  If you pass an existing `cleanup`
 * callback as the first argument the new cleanup is chained onto it so a
 * single call to the returned callback undoes all sandboxed env vars.
 */

import { spyOn } from "bun:test";
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
 * that need a per-call env override (e.g. a populated `AKM_BUNDLE_DIR`).
 *
 * `timeoutMs` is an optional safety net for callers whose `fn()` can hang —
 * e.g. it shells out to a subprocess or makes a network call with no bound
 * of its own. JS has no true promise cancellation: if `fn()` never settles,
 * the `finally` above never runs either, so the override stays applied to
 * `process.env` indefinitely — including past the point where the *caller's*
 * own test-runner timeout gives up on the test and moves on. That silently
 * corrupts every later test's sandbox (see tests/_preload.ts's leak
 * tripwire, and the CI incident this parameter was added for: a single hung
 * `history` call in tests/integration/node-compat.test.ts left
 * `AKM_FORCE_INIT_TMP_STASH`/`AKM_OUTPUT` applied to `process.env` for the
 * rest of the run, cascading into 19 unrelated failures). When `timeoutMs`
 * is set, `fn()` races against it; losing the race still restores env on
 * schedule while `fn()` keeps running harmlessly in the background (its
 * eventual settlement is swallowed so it can't surface as an unhandled
 * rejection later). Omit it to keep the exact prior (unbounded) behavior.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
  timeoutMs?: number,
): Promise<T> {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  for (const key of keys) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  if (timeoutMs === undefined) {
    try {
      return await fn();
    } finally {
      restore();
    }
  }

  const fnPromise = (async () => fn())();
  fnPromise.catch(() => {
    // A late settlement after the timeout below already won the race —
    // swallow it so it can't surface as an unhandled rejection.
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `withEnv: fn() did not settle within ${timeoutMs}ms — env restored anyway; the underlying call may still be running in the background.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([fnPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    restore();
  }
}

/**
 * Change one environment entry inside an active {@link withEnv} scope.
 *
 * Race-boundary tests use this from injected callbacks to prove production
 * code does not re-read credentials after preflight. The owning `withEnv`
 * scope remains responsible for restoration.
 */
export function mutateScopedEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Synchronous counterpart for production helpers that must run before fixture writes. */
export function withEnvSync<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  try {
    for (const key of keys) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
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
 * NOT wired into `process.env` — callers pass it to `withEnv({ AKM_BUNDLE_DIR })`
 * or to a subprocess env. Registering cleanup here keeps `fs.mkdtempSync` out of
 * test files (which the isolation lint flags).
 */
/**
 * Run `fn` with `process.stdin.isTTY` forced to `isTTY`, restoring it after.
 *
 * `isTTY` is process-global, so a hand-rolled save/override/restore that gets
 * its restore wrong leaks into unrelated tests — and `tests/_preload.ts`'s leak
 * tripwire guards env vars and tmpdirs, not stream descriptors, so nothing
 * would catch it. This existed as four separate inline copies before it lived
 * here; prefer this over writing a fifth.
 *
 * Restores by re-defining the property, which is also how the value was set —
 * a getter on the original descriptor is not preserved, but no caller has ever
 * needed one.
 */
export async function withTTY<T>(isTTY: boolean, fn: () => T | Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
  }
}

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
 * Sandbox `AKM_BUNDLE_DIR`.  Returns `{ dir, cleanup }` where `dir` is the new
 * stash root.  The standard stash subdirs (skills, commands, agents, knowledge,
 * scripts, memories, lessons) are created automatically.
 */
export function sandboxStashDir(chain?: Cleanup): { dir: string; cleanup: Cleanup } {
  const result = sandboxEnvDir("akm-sb-stash-", "AKM_BUNDLE_DIR", chain);
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
 * Mock `os.homedir()` to return an isolated, freshly created temp directory.
 *
 * Unlike `sandboxHome()` (which sets `process.env.HOME`), this covers code
 * paths where `os.homedir()` must actually change value: Bun's native
 * `os.homedir()` is resolved once at process start and does NOT track later
 * writes to `process.env.HOME`, so overriding the env var alone is a no-op
 * against it. `spyOn(os, "homedir")` intercepts the call directly, which
 * works for every importer of `node:os` since they all share the same
 * module-level function reference.
 *
 * Returns `{ dir, cleanup }` where `dir` is the realpath-resolved fake home
 * directory (so callers comparing against `os.homedir()`'s return value don't
 * hit a symlink mismatch, e.g. `/tmp` -> `/private/tmp` on macOS). `cleanup`
 * restores the spy and removes the temp directory — this is the file that
 * owns the `node:fs` removal call paired with a real `os.homedir()` read, so
 * call sites of this helper don't have to (see
 * `scripts/lint-tests-isolation.ts`'s `real-home-delete` rule, which flags a
 * test file that combines the two directly).
 */
export function mockHomedir(): { dir: string; cleanup: Cleanup } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akm-mock-home-")));
  const spy = spyOn(os, "homedir").mockReturnValue(dir);
  return {
    dir,
    cleanup: () => {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
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
  /** Isolated stash root (`AKM_BUNDLE_DIR`), scaffolded with the standard subdirs. */
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
  /** Isolated Claude plugins root (`AKM_CLAUDE_PLUGINS_DIR`), empty by default. */
  readonly claudePluginsDir: string;
  /** Isolated OpenCode cache root (`AKM_OPENCODE_CACHE_DIR`), empty by default. */
  readonly opencodeCacheDir: string;
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
 *   - points `AKM_BUNDLE_DIR`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
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

  const claudePluginsDir = path.join(root, "claude-plugins");
  fs.mkdirSync(claudePluginsDir, { recursive: true });

  const opencodeCacheDir = path.join(root, "opencode-cache");
  fs.mkdirSync(opencodeCacheDir, { recursive: true });

  const env: Record<string, string> = {
    AKM_BUNDLE_DIR: stashDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    // Redirect the Claude session-log scan at an empty fixture dir so the
    // synchronous `akm health` session-log scan stays hermetic and fast
    // instead of walking the host's real (and potentially huge) history.
    AKM_CLAUDE_PROJECTS_DIR: sessionLogsDir,
    // Same reasoning for the `plugin-version` advisory (itlackey/akm#832): an
    // empty fixture dir means "no plugin installed" instead of scanning the
    // host's real `~/.claude/plugins` cache.
    AKM_CLAUDE_PLUGINS_DIR: claudePluginsDir,
    // Same reasoning for the `opencode-plugin-version` advisory: an empty
    // fixture dir means "no OpenCode plugin installed" instead of reading
    // the host's real `~/.cache/opencode` package cache.
    AKM_OPENCODE_CACHE_DIR: opencodeCacheDir,
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

  return {
    stashDir,
    dataDir,
    cacheDir,
    configDir,
    stateDir,
    sessionLogsDir,
    claudePluginsDir,
    opencodeCacheDir,
    root,
    cleanup,
  };
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

/** Install deterministic named engines for tests that freeze workflow plans. */
export function writeWorkflowTestConfig(): void {
  writeSandboxConfig({
    engines: {
      "test-agent": { kind: "agent", platform: "opencode-sdk" },
      "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" },
    },
    defaults: { engine: "test-agent", llmEngine: "test-llm" },
    workflow: { judgeEngine: "test-llm" },
  });
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
export async function withMockedFetch<T>(
  run: () => Promise<T>,
  // `init` is forwarded so a test can assert on request headers (e.g. that an
  // Authorization header carries the expected bearer token). Existing callers
  // take only `url` and are unaffected. Returning a promise is also allowed so
  // mocks can be written as `async` functions.
  mock: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return await mock(url, init);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
