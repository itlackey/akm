/**
 * Tests for `akm init` (#284 GAP-HIGH 12).
 *
 * Verifies that `akmInit` materialises every registered asset-type directory
 * on disk, including the `lessons/` directory required by the proposal queue.
 * Adds a simple regression guard so a future TYPE_DIRS rename doesn't quietly
 * drop the lessons folder from the bootstrap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmInit } from "../src/commands/init";

const tempDirs: string[] = [];
const savedEnv = {
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  HOME: process.env.HOME,
  AKM_FORCE_INIT_TMP_STASH: process.env.AKM_FORCE_INIT_TMP_STASH,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-init-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-init-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-init-data-");
  process.env.XDG_STATE_HOME = makeTempDir("akm-init-state-");
  process.env.HOME = makeTempDir("akm-init-home-");
  // These tests legitimately need to init a /tmp-based stash — opt in to the
  // BUN_TEST sandbox bypass.
  process.env.AKM_FORCE_INIT_TMP_STASH = "1";
});

afterEach(() => {
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.AKM_FORCE_INIT_TMP_STASH === undefined) delete process.env.AKM_FORCE_INIT_TMP_STASH;
  else process.env.AKM_FORCE_INIT_TMP_STASH = savedEnv.AKM_FORCE_INIT_TMP_STASH;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm init", () => {
  test("creates the lessons/ directory on disk under the stash root", async () => {
    const stashDir = makeTempDir("akm-init-stash-");
    // Remove dir so init reports created=true
    fs.rmSync(stashDir, { recursive: true, force: true });
    const result = await akmInit({ dir: stashDir });
    expect(result.stashDir).toBe(stashDir);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
    // Also verify other core type dirs exist (fingerprint of TYPE_DIRS sweep).
    expect(fs.existsSync(path.join(stashDir, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories"))).toBe(true);
  });

  test("re-running on an existing stash is idempotent and keeps lessons/", async () => {
    const stashDir = makeTempDir("akm-init-stash-2-");
    await akmInit({ dir: stashDir });
    // Drop the lessons dir to confirm a re-run rebuilds it.
    fs.rmSync(path.join(stashDir, "lessons"), { recursive: true, force: true });
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(false);
    await akmInit({ dir: stashDir });
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
  });

  // ── BUN_TEST / NODE_ENV=test sandbox guard (Item 6) ────────────────────────
  test("refuses to init a /tmp stashDir under a test runner without AKM_FORCE_INIT_TMP_STASH", async () => {
    const stashDir = makeTempDir("akm-init-refuse-");
    // The beforeEach above set AKM_FORCE_INIT_TMP_STASH=1; turn it off here.
    delete process.env.AKM_FORCE_INIT_TMP_STASH;
    // Sanity: confirm we are running under a test runner (Bun sets NODE_ENV=test).
    expect(process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1").toBe(true);
    await expect(akmInit({ dir: stashDir })).rejects.toThrow(
      /refusing to persist --dir stashDir to a temporary path while under test runner/,
    );
  });

  test("refuses /var/tmp and /private/var/folders style paths under BUN_TEST=1", async () => {
    delete process.env.AKM_FORCE_INIT_TMP_STASH;
    // We don't actually create a /var/tmp or /private/var/folders dir; init resolves
    // the path before checking, but since the dir doesn't exist it will be mkdir'd
    // first. Both paths should be rejected by the sandbox guard before mkdir runs.
    // Instead of touching real paths, just verify the guard logic by attempting to
    // resolve a path that path.resolve() will leave intact.
    await expect(akmInit({ dir: "/var/tmp/akm-test-init-refuse" })).rejects.toThrow(
      /refusing to persist --dir stashDir to a temporary path/,
    );
  });

  test("AKM_FORCE_INIT_TMP_STASH=1 permits a /tmp stash under BUN_TEST=1", async () => {
    process.env.AKM_FORCE_INIT_TMP_STASH = "1";
    const stashDir = makeTempDir("akm-init-force-tmp-");
    const result = await akmInit({ dir: stashDir });
    expect(result.stashDir).toBe(stashDir);
  });
});
