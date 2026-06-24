/**
 * Shared fixture-stash loader for tests/*.test.ts and bench tasks.
 *
 * Each fixture lives at `tests/fixtures/stashes/<name>/` with a `MANIFEST.json`
 * and the standard akm stash layout. `loadFixtureStash(name)` copies the
 * fixture into a fresh tmp dir, sets `AKM_STASH_DIR`, runs `akm index`, and
 * returns the materialised path plus a cleanup function.
 *
 * See docs/technical/benchmark.md §5.5 for the contract.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";

const FIXTURES_ROOT = __dirname;

export interface LoadedFixtureStash {
  /** Absolute path to the materialised stash directory. */
  stashDir: string;
  /** Restore the prior `AKM_STASH_DIR` env value and remove the tmp dir. */
  cleanup: () => void;
  /** Deterministic SHA-256 of the fixture's source content (not the tmp copy). */
  contentHash: string;
  /**
   * Absolute path to the XDG_CACHE_HOME directory that contains the pre-built
   * FTS5 index (`<cacheHome>/akm/index.db`). Undefined when `skipIndex: true`.
   * Callers can copy this into their own isolated cache dirs to avoid re-indexing.
   */
  indexCacheHome?: string;
}

/**
 * List the fixture names available under `tests/fixtures/stashes/`.
 *
 * A directory is considered a fixture iff it contains a `MANIFEST.json`.
 * Returned names are sorted alphabetically.
 */
export function listFixtures(): string[] {
  const entries = fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(FIXTURES_ROOT, entry.name, "MANIFEST.json");
    if (fs.existsSync(manifest)) names.push(entry.name);
  }
  names.sort();
  return names;
}

/**
 * Synchronous, deterministic SHA-256 hex of every file under the named
 * fixture. Hash input is `<relative-path>\0<file-bytes>\0` for each file in
 * sorted-relative-path order. Used by `bench compare` to refuse cross-fixture
 * diffs.
 *
 * Also exported as `computeFixtureContentHash` for callers that prefer the
 * `compute*` naming convention used by sibling helpers in `tests/bench/`
 * (see `computeTaskCorpusHash` in corpus.ts). The two names point at the
 * SAME implementation — there is exactly one fixture-content hash function
 * in this codebase, and `LoadedFixtureStash.contentHash` reuses it.
 */
export function fixtureContentHash(name: string): string {
  const root = fixtureSourceDir(name);
  const files = collectFilesSorted(root);
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Alias for `fixtureContentHash` matching the `compute*` naming used by
 * sibling helpers in `tests/bench/`. Reuses the SAME implementation —
 * defining a separate hash function for the same content would risk drift
 * between the report-stamping path and `LoadedFixtureStash.contentHash`.
 */
export const computeFixtureContentHash = fixtureContentHash;

/**
 * Options for `loadFixtureStash`.
 */
export interface LoadFixtureStashOptions {
  /**
   * If true, skip the `akm index` invocation. The fixture is still copied to
   * a tmp dir and `AKM_STASH_DIR` is still set, but no SQLite DB is created
   * in the isolated XDG cache. Useful for callers that build their own index
   * directly via the internal indexer DB API and would otherwise pay ~200-
   * 300ms for a wasted spawn. Defaults to false.
   */
  skipIndex?: boolean;
}

/**
 * Copy the named fixture into a fresh tmp dir, set `AKM_STASH_DIR`, and build
 * its FTS index **in-process** via the production {@link akmIndex} indexer.
 * Returns the tmp path plus a cleanup function that restores the prior env
 * value and recursively removes the tmp dir.
 *
 * In-process (not a `bun run … index` subprocess) is deliberate: the spawn was
 * pure fd churn — one of the `spawnSync`/`Bun.serve` lifecycles that drive both
 * the unit-suite runtime and the Bun `--isolate` epoll fd race (#664). Building
 * the index directly is faster (no Bun cold-start) and keeps no extra fds open.
 *
 * Pass `{ skipIndex: true }` if the caller will build its own index and the
 * helper's index build would be wasted work. Returns a Promise because the
 * indexer is async.
 */
export async function loadFixtureStash(
  name: string,
  options: LoadFixtureStashOptions = {},
): Promise<LoadedFixtureStash> {
  const sourceDir = fixtureSourceDir(name);
  const contentHash = fixtureContentHash(name);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `akm-fixture-${name}-`));
  const stashDir = path.join(tmpRoot, "stash");
  const cacheHome = path.join(tmpRoot, "cache");
  const configHome = path.join(tmpRoot, "config");
  copyDirRecursive(sourceDir, stashDir);
  fs.mkdirSync(cacheHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });

  const priorAkmStashDir = process.env.AKM_STASH_DIR;
  process.env.AKM_STASH_DIR = stashDir;

  if (!options.skipIndex) {
    // Isolate the XDG dirs for the in-process index so the helper never touches
    // the operator's real ~/.cache|~/.local/share/akm or pulls in their
    // configured registries / sources — the shipped fixture is the only thing
    // indexed. AKM_STASH_DIR must be paired with XDG_DATA_HOME + XDG_STATE_HOME
    // so the test-isolation guard in src/core/paths.ts stays inert. We snapshot
    // and restore these four vars around the build; AKM_STASH_DIR is left set
    // (cleanup() restores it) to preserve the helper's documented contract.
    const dataHome = path.join(tmpRoot, "data");
    const stateHome = path.join(tmpRoot, "state");
    const xdgSnapshot = {
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    const restoreXdg = (): void => {
      for (const [key, value] of Object.entries(xdgSnapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    process.env.XDG_CACHE_HOME = cacheHome;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_STATE_HOME = stateHome;

    try {
      // Pin semantic search off so the build is deterministic and never reaches
      // for a local embedder — the FTS index is all fixtures need.
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir, full: true });
    } catch (err) {
      // Restore env and clean up before rethrowing so the caller is not left
      // with a leaked tmp dir or mutated process state.
      restoreXdg();
      if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = priorAkmStashDir;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      throw new Error(`akm index failed for fixture "${name}": ${(err as Error).message}`);
    }
    restoreXdg();
  }

  const cleanup = (): void => {
    if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = priorAkmStashDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return { stashDir, cleanup, contentHash, ...(!options.skipIndex ? { indexCacheHome: cacheHome } : {}) };
}

// ── Internals ───────────────────────────────────────────────────────────────

function fixtureSourceDir(name: string): string {
  if (!isSafeName(name)) {
    throw new Error(`invalid fixture name: ${JSON.stringify(name)}`);
  }
  const dir = path.join(FIXTURES_ROOT, name);
  if (!fs.existsSync(path.join(dir, "MANIFEST.json"))) {
    throw new Error(`fixture not found: ${name} (expected ${dir}/MANIFEST.json)`);
  }
  return dir;
}

function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function collectFilesSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs));
    }
  };
  walk(root);
  out.sort();
  return out;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
