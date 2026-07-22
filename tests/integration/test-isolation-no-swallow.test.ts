/**
 * Test-isolation guard — no-swallow contract.
 *
 * The write-guard added in src/core/paths.ts (commit ac8ca22) throws
 * `ConfigError("TEST_ISOLATION_MISSING")` under `bun test` when `AKM_STASH_DIR`
 * is set but `XDG_DATA_HOME` / `AKM_DATA_DIR` (or `XDG_STATE_HOME` /
 * `AKM_STATE_DIR`) is not paired alongside it.
 *
 * Several production call sites used to wrap DB/data-dir operations in
 * `try { ... } catch { best-effort-comment }` blocks, silently downgrading
 * the loud guard violation into a "no result" outcome. This test file fixes
 * those sites in place and asserts the loud-fail behaviour from every
 * patched surface.
 *
 * Each test follows the same shape:
 *   1. Set `AKM_STASH_DIR` to a tmp dir.
 *   2. DELIBERATELY leave `XDG_DATA_HOME` and `XDG_STATE_HOME` unset (we
 *      remember and restore them in the cleanup hooks).
 *   3. Confirm that calling the patched code throws `TEST_ISOLATION_MISSING`
 *      rather than returning null / [] / a benign fallback value.
 *
 * If a future patch reverts a swallow, the corresponding test fails loudly
 * at the call site instead of producing wrong-result data.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigError, isTestIsolationError, rethrowIfTestIsolationError } from "../../src/core/errors";

// ── Env capture ──────────────────────────────────────────────────────────────

const originalStashDir = process.env.AKM_STASH_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalStateHome = process.env.XDG_STATE_HOME;
const originalAkmDataDir = process.env.AKM_DATA_DIR;
const originalAkmStateDir = process.env.AKM_STATE_DIR;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBunTest = process.env.BUN_TEST;
const originalNodeEnv = process.env.NODE_ENV;

// Ensure the guard is active. paths.isUnderBunTest accepts BUN_TEST=1 OR
// NODE_ENV=test. Some Bun versions don't auto-set BUN_TEST on the worker
// (the value can be empty when launched via `bun test`), so set it
// explicitly at module load.
process.env.BUN_TEST = "1";

const createdTmpDirs: string[] = [];

function makeTmp(prefix = "akm-no-swallow-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function leakyEnv(): void {
  // Setup a tmp stash dir but DELIBERATELY do not pair it with data-dir /
  // state-dir overrides — this is the leak the guard protects against.
  const stash = makeTmp("akm-leak-stash-");
  process.env.AKM_STASH_DIR = stash;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.AKM_DATA_DIR;
  delete process.env.AKM_STATE_DIR;
  // Also point XDG_CONFIG_HOME at a tmp dir so loadConfig() doesn't read
  // the dev's real ~/.config/akm/config.json — config is not what the guard
  // protects, but tests below load it indirectly.
  process.env.XDG_CONFIG_HOME = makeTmp("akm-leak-config-");
}

function restoreEnv(orig: string | undefined, key: string): void {
  if (orig === undefined) delete process.env[key];
  else process.env[key] = orig;
}

beforeAll(() => {
  expect(process.env.BUN_TEST).toBe("1");
});

beforeEach(() => {
  leakyEnv();
});

afterEach(() => {
  restoreEnv(originalStashDir, "AKM_STASH_DIR");
  restoreEnv(originalDataHome, "XDG_DATA_HOME");
  restoreEnv(originalStateHome, "XDG_STATE_HOME");
  restoreEnv(originalAkmDataDir, "AKM_DATA_DIR");
  restoreEnv(originalAkmStateDir, "AKM_STATE_DIR");
  restoreEnv(originalConfigHome, "XDG_CONFIG_HOME");
});

afterAll(() => {
  restoreEnv(originalBunTest, "BUN_TEST");
  restoreEnv(originalNodeEnv, "NODE_ENV");
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
});

// ── Helper-level coverage ────────────────────────────────────────────────────

describe("rethrowIfTestIsolationError", () => {
  test("re-throws TEST_ISOLATION_MISSING errors", () => {
    const err = new ConfigError("guard", "TEST_ISOLATION_MISSING");
    expect(() => rethrowIfTestIsolationError(err)).toThrow(/guard/);
  });

  test("passes through unrelated ConfigError codes", () => {
    const err = new ConfigError("not the guard", "INVALID_CONFIG_FILE");
    expect(() => rethrowIfTestIsolationError(err)).not.toThrow();
  });

  test("passes through arbitrary non-Error values", () => {
    expect(() => rethrowIfTestIsolationError("oops")).not.toThrow();
    expect(() => rethrowIfTestIsolationError(undefined)).not.toThrow();
    expect(() => rethrowIfTestIsolationError(new Error("plain"))).not.toThrow();
  });

  test("isTestIsolationError matches the expected code", () => {
    expect(isTestIsolationError(new ConfigError("g", "TEST_ISOLATION_MISSING"))).toBe(true);
    expect(isTestIsolationError(new ConfigError("g", "INVALID_CONFIG_FILE"))).toBe(false);
    expect(isTestIsolationError(new Error("plain"))).toBe(false);
  });
});

// ── Each patched call site ──────────────────────────────────────────────────

describe("paths.ts guard surfaces TEST_ISOLATION_MISSING", () => {
  test("getDataDir throws under the leaky env", async () => {
    const { getDataDir } = await import("../../src/core/paths");
    let caught: unknown;
    try {
      getDataDir();
    } catch (err) {
      caught = err;
    }
    expect(isTestIsolationError(caught)).toBe(true);
  });
});

describe("registry/skills-sh — fetchSkills surfaces guard violations", () => {
  test("a leaky env causes search() to surface the data-dir guard via warnings", async () => {
    // skills-sh's `search()` wraps the entire fetch path in a catch that
    // turns errors into a warning. Confirm the guard's distinctive
    // "Refusing to resolve data directory under bun test" prose survives
    // the wrapping (proving the inner openDatabase catch did NOT swallow).
    const { resolveProviderFactory } = await import("../../src/registry/factory");
    await import("../../src/registry/providers/skills-sh");
    const factory = resolveProviderFactory("skills-sh");
    if (!factory) throw new Error("skills-sh factory not registered");
    const provider = factory({ url: "http://127.0.0.1:1/skills-sh-unreachable", name: "skills.sh" });
    const result = await provider.search({ query: "test", limit: 1 });
    const warnings = result.warnings ?? [];
    const combined = warnings.join("\n");
    expect(combined).toContain("Refusing to resolve data directory under bun test");
  });
});

describe("registry/static-index — loadIndex surfaces guard violations", () => {
  test("a leaky env causes loadAllKits to surface the data-dir guard via warnings", async () => {
    const { resolveProviderFactory } = await import("../../src/registry/factory");
    await import("../../src/registry/providers/static-index");
    const factory = resolveProviderFactory("static-index");
    if (!factory) throw new Error("static-index factory not registered");
    const provider = factory({ url: "http://127.0.0.1:1/static-index-unreachable", name: "test-reg" });
    const result = await provider.search({ query: "anything", limit: 1 });
    const warnings = result.warnings ?? [];
    const combined = warnings.join("\n");
    expect(combined).toContain("Refusing to resolve data directory under bun test");
  });
});

describe("indexer/graph-db — loadStoredGraph* surface guard violations", () => {
  test("loadStoredGraphMeta re-throws TEST_ISOLATION_MISSING instead of returning null", async () => {
    const { loadStoredGraphMeta } = await import("../../src/indexer/db/graph-db");
    let caught: unknown;
    try {
      loadStoredGraphMeta("/no/such/stash");
    } catch (err) {
      caught = err;
    }
    expect(isTestIsolationError(caught)).toBe(true);
  });

  test("loadStoredGraphSnapshot re-throws TEST_ISOLATION_MISSING instead of returning null", async () => {
    const { loadStoredGraphSnapshot } = await import("../../src/indexer/db/graph-db");
    let caught: unknown;
    try {
      loadStoredGraphSnapshot("/no/such/stash");
    } catch (err) {
      caught = err;
    }
    expect(isTestIsolationError(caught)).toBe(true);
  });

  test("loadGraphFilesOnly re-throws TEST_ISOLATION_MISSING instead of returning []", async () => {
    const { loadGraphFilesOnly } = await import("../../src/indexer/db/graph-db");
    let caught: unknown;
    try {
      loadGraphFilesOnly("/no/such/stash");
    } catch (err) {
      caught = err;
    }
    expect(isTestIsolationError(caught)).toBe(true);
  });
});

describe("integrations/lockfile — readLockfile surfaces guard violations", () => {
  test("readLockfile re-throws TEST_ISOLATION_MISSING via getDataDir", async () => {
    const { readLockfile } = await import("../../src/integrations/lockfile");
    let caught: unknown;
    try {
      readLockfile();
    } catch (err) {
      caught = err;
    }
    // getLockfilePath() calls getDataDir() which throws. The path is built
    // BEFORE the catch block (line 113), so the throw propagates from the
    // path resolver — our helper is defense-in-depth for future refactors.
    expect(isTestIsolationError(caught)).toBe(true);
  });
});
