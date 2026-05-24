/**
 * Global test isolation harness.
 *
 * Loaded by `bunfig.toml` `[test] preload`, so every test file in the suite
 * runs inside a process-wide sandbox. The harness owns three classes of
 * state:
 *
 *   1. Environment variables in {@link HARNESSED}. The preload-time
 *      bottom layer (`installSuiteWideSandbox`) repoints `HOME`, all four
 *      `XDG_*`, and the `AKM_*_DIR` overrides to a per-process sandbox
 *      directory under `os.tmpdir()`. Test files that set their own values
 *      via `beforeAll` / `beforeEach` still take precedence — but if a
 *      test forgets, the process-wide defaults keep production code's
 *      filesystem reads off the developer's real `~/.config`, `~/.cache`,
 *      `~/.local/share`, etc.
 *   2. `process.cwd()` and `globalThis.fetch` — snapshotted per-test and
 *      restored in `afterEach`.
 *   3. Module-level singletons in production code — `cachedConfig`,
 *      `embedCache`, `localEmbedder`, `cachedParsedGraph`, the warn-module
 *      log file path, and quiet/verbose flags. Each has an exported reset
 *      hook that the harness calls in `beforeEach`.
 *
 * In addition to providing isolation, the `afterEach` runs a tripwire that
 * detects:
 *
 *   - Any `AKM_*` / `XDG_*` / `HOME` env var that the test introduced
 *     (didn't exist at preload time) and didn't restore. Pre-existing
 *     baseline keys like the user's `XDG_SESSION_TYPE` / `XDG_RUNTIME_DIR`
 *     are ignored.
 *   - cwd changes that escaped the test boundary.
 *   - `globalThis.fetch` swaps that were not restored.
 *
 * The tripwire is in **warn-only mode** in Phase 1 of the rollout
 * (see knowledge:projects/akm/test-harness-redesign). It calls
 * `console.warn` so we can inventory leaks across the suite without
 * breaking the build. Phase 2 flips this to `throw` once known offenders
 * are cleaned up.
 *
 * Tests that legitimately need to mutate cwd or fetch within a test should
 * use `tests/_helpers/sandbox.ts` (`withMockedFetch`, etc.) — the helpers
 * mutate inside the per-test window and restore before the tripwire fires.
 */

import { afterEach, beforeEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../src/core/config";
import { clearLogFile, resetQuiet, resetVerbose } from "../src/core/warn";
import { resetGraphBoostCache } from "../src/indexer/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";

/**
 * Env vars the harness owns. Anything in this list is restored from the
 * pre-test snapshot in `afterEach`. Any `AKM_*` / `XDG_*` / `HOME` env var
 * NOT in this list will trip the leak detector if it appears mid-test.
 *
 * Keep this list in sync with the design doc and with paths.ts + config.ts.
 */
const HARNESSED: readonly string[] = [
  // Storage layout overrides.
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_CACHE_DIR",
  "AKM_DATA_DIR",
  "AKM_STATE_DIR",
  // XDG base directories.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Home directory itself.
  "HOME",
  // Diagnostic / secret env vars production code reads.
  "AKM_VERBOSE",
  "AKM_LLM_API_KEY",
  "AKM_EMBED_API_KEY",
  // Registry overrides used by registry-providers tests.
  "AKM_REGISTRY_URL",
  "AKM_NPM_REGISTRY",
];

/**
 * Suite-wide sandbox root. Created once at preload time and torn down on
 * process exit. Any test that doesn't explicitly override `HOME` /
 * `XDG_*_HOME` will fall back to subdirectories of this root — keeping
 * production code's filesystem reads off the developer's real $HOME.
 */
let suiteSandboxRoot: string | undefined;

function installSuiteWideSandbox(): void {
  suiteSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-test-suite-"));
  const home = path.join(suiteSandboxRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  // Set the bottom layer ONLY. Test files that have their own `beforeAll`
  // / `beforeEach` that sets XDG vars to per-test directories still
  // override these — that's exactly what we want, since their teardown
  // also runs and restores their own snapshot of the prior value (which
  // is this sandbox path, not the developer's real $HOME).
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(suiteSandboxRoot, "xdg-config");
  process.env.XDG_CACHE_HOME = path.join(suiteSandboxRoot, "xdg-cache");
  process.env.XDG_DATA_HOME = path.join(suiteSandboxRoot, "xdg-data");
  process.env.XDG_STATE_HOME = path.join(suiteSandboxRoot, "xdg-state");
  // Diagnostic / secret env vars must start unset so production code paths
  // see a clean default. Tests that need them set should do so explicitly.
  delete process.env.AKM_VERBOSE;
  delete process.env.AKM_LLM_API_KEY;
  delete process.env.AKM_EMBED_API_KEY;
  process.on("exit", () => {
    if (suiteSandboxRoot) {
      try {
        fs.rmSync(suiteSandboxRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore.
      }
    }
  });
}

installSuiteWideSandbox();

/**
 * Baseline env keys captured immediately after the suite-wide sandbox is
 * installed. The tripwire only flags keys that appear or disappear *during*
 * a test, ignoring pre-existing session-scoped XDG vars (XDG_SESSION_TYPE,
 * XDG_RUNTIME_DIR, …) that the suite never touches.
 */
const baselineEnvKeys: Set<string> = new Set(Object.keys(process.env));

/** Reset every known module-level singleton in production code. */
function resetSingletons(): void {
  resetConfigCache();
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
  resetQuiet();
  resetVerbose();
  clearLogFile();
}

/** Snapshot of process state captured in `beforeEach`. */
interface Snapshot {
  env: Record<string, string | undefined>;
  cwd: string;
  fetch: typeof globalThis.fetch;
}

let snapshot: Snapshot | undefined;

beforeEach(() => {
  snapshot = {
    env: Object.fromEntries(HARNESSED.map((k) => [k, process.env[k]])),
    cwd: process.cwd(),
    fetch: globalThis.fetch,
  };
  resetSingletons();
});

afterEach(() => {
  const leakReasons: string[] = [];

  // Tripwire 1: any AKM_*/XDG_*/HOME var that didn't exist at preload time
  // and wasn't restored by the test. Excludes the user's session-scoped
  // XDG vars (XDG_SESSION_TYPE, XDG_RUNTIME_DIR, …) that exist at baseline.
  const leakedEnv = Object.keys(process.env)
    .filter((k) => k.startsWith("AKM_") || k.startsWith("XDG_") || k === "HOME")
    .filter((k) => !HARNESSED.includes(k))
    .filter((k) => !baselineEnvKeys.has(k));
  if (leakedEnv.length > 0) {
    leakReasons.push(`leaked env vars: ${leakedEnv.join(", ")}`);
  }

  // Tripwire 2: cwd changes. Restore even in warn-only mode so the next
  // test starts from the expected directory.
  if (snapshot && process.cwd() !== snapshot.cwd) {
    leakReasons.push(`cwd left at ${process.cwd()} (expected ${snapshot.cwd})`);
    try {
      process.chdir(snapshot.cwd);
    } catch {
      // The original cwd might be a sandbox that's already been removed.
      // Fall back to the repo root via __dirname-relative path.
      process.chdir(path.resolve(__dirname, ".."));
    }
  }

  // Tripwire 3: globalThis.fetch swaps that were not restored.
  if (snapshot && globalThis.fetch !== snapshot.fetch) {
    leakReasons.push("globalThis.fetch left replaced");
    globalThis.fetch = snapshot.fetch;
  }

  // Restore the harnessed env vars from the snapshot.
  if (snapshot) {
    for (const k of HARNESSED) {
      const orig = snapshot.env[k];
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
  }

  // mock.module is process-global in bun. Clear it unconditionally — files
  // that mock.module() but forget to mock.restore() were a major source of
  // cross-file pollution; this makes the cleanup mandatory.
  mock.restore();

  snapshot = undefined;

  if (leakReasons.length > 0) {
    // Phase 1: warn only. Phase 2 will switch this to `throw`.
    console.warn(`[sandbox tripwire] ${leakReasons.join("; ")}`);
  }
});
