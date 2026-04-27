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

const FIXTURES_ROOT = __dirname;
const REPO_ROOT = path.resolve(FIXTURES_ROOT, "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

export interface LoadedFixtureStash {
  /** Absolute path to the materialised stash directory. */
  stashDir: string;
  /** Restore the prior `AKM_STASH_DIR` env value and remove the tmp dir. */
  cleanup: () => void;
  /** Deterministic SHA-256 of the fixture's source content (not the tmp copy). */
  contentHash: string;
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
 * Copy the named fixture into a fresh tmp dir, set `AKM_STASH_DIR`, and run
 * `akm index` against it. Returns the tmp path plus a cleanup function that
 * restores the prior env value and recursively removes the tmp dir.
 *
 * Pass `{ skipIndex: true }` if the caller will build its own index and the
 * helper's `akm index` spawn would be wasted work.
 */
export function loadFixtureStash(name: string, options: LoadFixtureStashOptions = {}): LoadedFixtureStash {
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
    // Use isolated XDG dirs for the index invocation so the helper never
    // touches the operator's real ~/.cache/akm or pulls in their configured
    // registries / sources. The shipped fixture is the only thing indexed.
    const result = Bun.spawnSync({
      cmd: ["bun", "run", CLI_ENTRY, "index"],
      cwd: stashDir,
      env: {
        ...process.env,
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: configHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      // Restore env and clean up before throwing so the caller is not left
      // with a leaked tmp dir or mutated process state.
      if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = priorAkmStashDir;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
      throw new Error(`akm index failed for fixture "${name}" (exit ${result.exitCode}): ${stderr}`);
    }
  }

  const cleanup = (): void => {
    if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = priorAkmStashDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return { stashDir, cleanup, contentHash };
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
