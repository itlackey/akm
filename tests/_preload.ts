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
 * The tripwire throws on any detected leak. If a future investigation needs
 * to inventory leaks without failing the build, temporarily replace `throw`
 * with `console.warn` in the `afterEach` handler below
 * (see knowledge/projects/akm/test-harness-redesign for context).
 *
 * Tests that legitimately need to mutate cwd or fetch within a test should
 * use `tests/_helpers/sandbox.ts` (`withMockedFetch`, etc.) — the helpers
 * mutate inside the per-test window and restore before the tripwire fires.
 */

import { afterEach, beforeEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../src/core/config/config";
import { clearLogFile, resetVerbose, setQuiet } from "../src/core/warn";
import { resetGraphBoostCache } from "../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { resetAllSeams } from "./_helpers/seams";

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
  // The AKM_*_DIR overrides take precedence over XDG in src/core/paths.ts.
  // If a developer's shell exports any of them, they would defeat the XDG
  // sandbox above and leak production paths into the suite. Delete them at
  // startup so the XDG sandbox always wins; tests that need a specific
  // AKM_*_DIR set it explicitly (and the afterEach tripwire restores it).
  delete process.env.AKM_CONFIG_DIR;
  delete process.env.AKM_DATA_DIR;
  delete process.env.AKM_CACHE_DIR;
  delete process.env.AKM_STATE_DIR;
  // Diagnostic / secret env vars must start unset so production code paths
  // see a clean default. Tests that need them set should do so explicitly.
  delete process.env.AKM_VERBOSE;
  delete process.env.AKM_LLM_API_KEY;
  delete process.env.AKM_EMBED_API_KEY;
  // Teardown must fire on signal-kills too, not just clean exit. A worker that
  // is SIGTERM/SIGINT/SIGHUP'd (e.g. an orphaned/hung `bun test` worker being
  // reaped) otherwise leaks its entire `akm-test-suite-*` root under /tmp — the
  // accumulation that filled tmpfs with tens of thousands of husks. SIGKILL is
  // uncatchable, so the stale-husk sweep in scripts/sweep-test-tmp.ts is the
  // backstop for that case.
  const removeSuiteRoot = (): void => {
    if (!suiteSandboxRoot) return;
    try {
      fs.rmSync(suiteSandboxRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  };
  process.on("exit", removeSuiteRoot);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      removeSuiteRoot();
      // Re-raise default behaviour with the conventional 128+signo code.
      process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
    });
  }
}

installSuiteWideSandbox();

/**
 * Baseline env keys captured immediately after the suite-wide sandbox is
 * installed. The tripwire only flags keys that appear or disappear *during*
 * a test, ignoring pre-existing session-scoped XDG vars (XDG_SESSION_TYPE,
 * XDG_RUNTIME_DIR, …) that the suite never touches.
 */
const baselineEnvKeys: Set<string> = new Set(Object.keys(process.env));

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem safety + cross-file leak self-heal
//
// Two failure modes the per-test snapshot/restore CANNOT catch, because they
// cross file boundaries (a `beforeAll` sets state; the file's `afterAll` tears
// down the *directory* but leaks the *env var* or leaves *config-file* content
// in the shared sandbox; the next file inherits it):
//
//   1. Env leak  — e.g. AKM_STASH_DIR left pointing at a now-deleted /tmp dir.
//   2. FS leak   — e.g. a config.json with a stale stashDir written into the
//                  shared suite-sandbox XDG_CONFIG_HOME.
//
// The fix self-heals at the top of every `beforeEach`, ALWAYS toward the
// sandbox (under os.tmpdir()) and NEVER toward the developer's real $HOME.
//
// SAFETY MODEL (decoupled from heal correctness): every destructive fs op in
// this harness goes through `assertUnderTmp`, which throws rather than ever
// touch a path outside the OS temp root. Plus a hard HOME-escape backstop.
// So even a BUG in the heal logic can only ever cause a test failure — it can
// never reach ~/.config, ~/.local/share, ~/.cache, or the real ~/akm stash.
// ─────────────────────────────────────────────────────────────────────────────

/** Realpath of the OS temp root, resolved once — the safety boundary. */
const TMP_REAL: string = fs.realpathSync(os.tmpdir());

/** The sandbox baseline values for HOME + the four XDG dirs (under TMP_REAL). */
const SANDBOX_ENV: Record<string, string> = {
  HOME: path.join(suiteSandboxRoot ?? "", "home"),
  XDG_CONFIG_HOME: path.join(suiteSandboxRoot ?? "", "xdg-config"),
  XDG_CACHE_HOME: path.join(suiteSandboxRoot ?? "", "xdg-cache"),
  XDG_DATA_HOME: path.join(suiteSandboxRoot ?? "", "xdg-data"),
  XDG_STATE_HOME: path.join(suiteSandboxRoot ?? "", "xdg-state"),
};

const AKM_DIR_OVERRIDES: readonly string[] = [
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_CACHE_DIR",
  "AKM_DATA_DIR",
  "AKM_STATE_DIR",
];

/** True iff `dir` is the temp root or strictly within it. */
function isUnderTmp(dir: string): boolean {
  try {
    const real = fs.realpathSync(dir);
    return real === TMP_REAL || real.startsWith(TMP_REAL + path.sep);
  } catch {
    return false;
  }
}

/**
 * The single chokepoint for every destructive filesystem op in this harness.
 * Throws — failing the suite loudly — rather than ever operating on a path
 * outside the OS temp root, so a harness bug can NEVER reach real user data.
 * Resolves the nearest existing ancestor via realpath to defeat symlink
 * escapes (symlinked temp dir, or a planted symlink inside the sandbox).
 */
function assertUnderTmp(target: string): string {
  const resolved = path.resolve(target);
  let probe = resolved;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const real = fs.realpathSync(probe);
  if (!isUnderTmp(real)) {
    throw new Error(
      `[harness-safety] refusing filesystem op outside OS temp root: ${target} ` +
        `(resolved to ${real}; temp root is ${TMP_REAL}). This guard exists so the ` +
        `test harness can never touch the developer's real data.`,
    );
  }
  return resolved;
}

function safeRm(target: string): void {
  fs.rmSync(assertUnderTmp(target), { recursive: true, force: true });
}

function safeMkdir(target: string): void {
  fs.mkdirSync(assertUnderTmp(target), { recursive: true });
}

/** Set, under the temp root, and an existing directory. */
function isLiveTmpDir(dir: string | undefined): boolean {
  if (!dir || !isUnderTmp(dir)) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repair cross-file state leaks. Run at the TOP of `beforeEach`, before the
 * snapshot is taken, so the snapshot captures healed (sandbox) values and the
 * `afterEach` restore never re-introduces a leak.
 *
 * Heal only fires on the leak signature (a path var pointing at a missing or
 * out-of-tmp dir). A test's OWN overrides — always set in its `beforeEach` or
 * body, which run AFTER this — are never affected; and files that set valid
 * /tmp dirs in `beforeAll` (which exist at this point) are left alone.
 */
function healSandboxEnv(): void {
  // Repair 1: HOME + XDG dirs → reset any leaked/missing one to the sandbox.
  for (const [key, fallback] of Object.entries(SANDBOX_ENV)) {
    if (!isLiveTmpDir(process.env[key])) {
      safeMkdir(fallback);
      process.env[key] = fallback;
    }
  }

  // Repair 2: AKM_*_DIR overrides have NO sandbox baseline (unset at preload).
  // Drop any that leaked to a missing or out-of-tmp dir; production then falls
  // back to the sandbox HOME/XDG. Valid live /tmp overrides are preserved.
  for (const key of AKM_DIR_OVERRIDES) {
    const current = process.env[key];
    if (current !== undefined && !isLiveTmpDir(current)) {
      delete process.env[key];
    }
  }

  // Repair 3: when using the shared sandbox config (test didn't override
  // XDG_CONFIG_HOME), drop a leftover config.json so a prior file's config
  // can't bleed in. (Verified: no test persists shared-sandbox config across
  // tests.) Guarded by safeRm/safeMkdir → can only touch the /tmp sandbox.
  if (process.env.XDG_CONFIG_HOME === SANDBOX_ENV.XDG_CONFIG_HOME) {
    const akmDir = path.join(SANDBOX_ENV.XDG_CONFIG_HOME, "akm");
    const cfg = path.join(akmDir, "config.json");
    if (fs.existsSync(cfg)) safeRm(cfg);
    safeMkdir(akmDir);
  }

  // Backstop ("at all costs"): HOME MUST be inside the temp root. If anything
  // ever leaves it pointing at the real home, fail HARD before a test can run.
  if (!isUnderTmp(process.env.HOME ?? "")) {
    throw new Error(
      `[harness-safety] HOME escaped the sandbox: ${process.env.HOME}. Refusing to run to protect real user data.`,
    );
  }
}

/** Reset every known module-level singleton in production code. */
function resetSingletons(): void {
  resetAllSeams();
  resetConfigCache();
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
  // Enable quiet mode by default in tests so production [improve]/warn/info
  // lines do not flood stderr and bury bun's "(fail) <test name>" output.
  // Individual tests that need to assert on log output can call setQuiet(false)
  // and restore it; the harness will reset to true before the next test.
  setQuiet(true);
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
  // Repair cross-file leaks BEFORE snapshotting, so the snapshot (and the
  // afterEach restore) carry healed sandbox values rather than leaked ones.
  healSandboxEnv();
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

  // Tripwire 2: cwd changes. Always restore so the next test starts from
  // the expected directory, regardless of whether the tripwire throws.
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

  // Restore bun:test function mocks (mock()/spyOn) unconditionally. NOTE:
  // this does NOT undo mock.module() registrations — a two-file probe proved
  // module mocks leak across test files in the same process regardless of
  // mock.restore(). That is why mock.module is banned at ZERO in this tree
  // (use a src `_set…ForTests` seam via tests/_helpers/seams.ts instead).
  mock.restore();

  // Restore every src-module seam a test installed via overrideSeam/withSeam
  // (tests/_helpers/seams.ts), so a fake never survives past its test.
  resetAllSeams();

  snapshot = undefined;

  if (leakReasons.length > 0) {
    throw new Error(`[sandbox tripwire] ${leakReasons.join("; ")}`);
  }
});
