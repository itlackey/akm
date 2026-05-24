/**
 * Sandbox helpers for tests.
 *
 * The preload (`tests/_preload.ts`) creates a fresh sandbox directory for
 * every test and points HOME, every `XDG_*`, and every AKM_*_DIR env var
 * at subdirectories of it. These helpers expose ergonomic accessors for
 * that sandbox state so test bodies don't have to read env vars by hand.
 *
 * The contract:
 *
 *   - The sandbox directories all live under `process.env.AKM_*_DIR` /
 *     `process.env.XDG_*_HOME` / `process.env.HOME`. The preload owns
 *     creation and teardown.
 *   - These helpers are pure accessors plus a couple of file-writing
 *     conveniences. They do NOT mutate the harnessed env vars themselves —
 *     that is the preload's job — and they do not need to be paired with
 *     restore logic.
 *   - `withMockedFetch` swaps `globalThis.fetch` for the duration of a
 *     callback and restores it before returning, so the tripwire's
 *     fetch-leak detector never fires.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path to a per-test stash directory under the sandbox HOME.
 *
 * The preload doesn't set `AKM_STASH_DIR` directly (see the comment in
 * `tests/_preload.ts`), but it does isolate `HOME`. Tests that want a
 * sandbox-local stash can call this and pass it as `AKM_STASH_DIR` to
 * spawned CLI processes — or use it as the `dir` argument to `loadConfig`
 * / `saveConfig` etc.
 */
export function sandboxStashDir(): string {
  const home = sandboxHome();
  const dir = path.join(home, "stash");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the sandbox HOME for the current test. */
export function sandboxHome(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("sandboxHome(): HOME is not set — is the preload loaded?");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** Absolute path to the sandbox XDG_CONFIG_HOME for the current test. */
export function sandboxXdgConfigHome(): string {
  const dir = process.env.XDG_CONFIG_HOME;
  if (!dir) throw new Error("sandboxXdgConfigHome(): XDG_CONFIG_HOME is not set — is the preload loaded?");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the sandbox XDG_DATA_HOME for the current test. */
export function sandboxXdgDataHome(): string {
  const dir = process.env.XDG_DATA_HOME;
  if (!dir) throw new Error("sandboxXdgDataHome(): XDG_DATA_HOME is not set — is the preload loaded?");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the sandbox root (parent of all of the above). */
export function sandboxRoot(): string {
  const stash = process.env.AKM_STASH_DIR;
  if (!stash) throw new Error("sandboxRoot(): AKM_STASH_DIR is not set — is the preload loaded?");
  // The preload colocates every sandbox dir under one mkdtemp root.
  // AKM_STASH_DIR = <root>/stash, so the parent is the root.
  return path.dirname(stash);
}

/**
 * Write a JSON `config.json` to the sandbox `$XDG_CONFIG_HOME/akm/`
 * directory (where `loadUserConfig()` reads from) and return the path.
 *
 * Useful for tests that want to exercise `loadConfig()` with a specific
 * config shape without setting up directories by hand.
 */
export function writeSandboxConfig(partial: Record<string, unknown>): string {
  const configRoot = sandboxXdgConfigHome();
  const akmDir = path.join(configRoot, "akm");
  fs.mkdirSync(akmDir, { recursive: true });
  const configPath = path.join(akmDir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(partial, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * Run `fn` with `globalThis.fetch` replaced by `mockFetch`. The original
 * fetch is restored before this returns (including on thrown errors), so
 * the harness tripwire never fires.
 *
 * Usage:
 *
 *   await withMockedFetch(async () => {
 *     await someCodeThatFetches();
 *   }, async (url) => new Response("ok"));
 */
export async function withMockedFetch<T>(fn: () => Promise<T> | T, mockFetch: typeof globalThis.fetch): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
