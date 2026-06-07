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

import { akmInit } from "../src/commands/sources/init";
import { type Cleanup, sandboxHome, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let cleanup: Cleanup = () => {};

beforeEach(() => {
  process.env.AKM_FORCE_INIT_TMP_STASH = "1";
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const homeResult = sandboxHome(cfgResult.cleanup);
  cleanup = homeResult.cleanup;
});

afterEach(() => {
  delete process.env.AKM_FORCE_INIT_TMP_STASH;
  cleanup();
  cleanup = () => {};
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

  test("copies stash skeleton files to a newly created stash", async () => {
    const stashDir = makeTempDir("akm-init-skeleton-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    const result = await akmInit({ dir: stashDir });
    expect(result.created).toBe(true);
    const readmePath = path.join(stashDir, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, "utf8");
    expect(content).toContain("AKM Stash");
    expect(content).toContain("akm curate");
    expect(content).toContain("akm search");
  });

  test("does not overwrite skeleton files that already exist", async () => {
    const stashDir = makeTempDir("akm-init-skeleton-existing-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });
    const readmePath = path.join(stashDir, "README.md");
    fs.writeFileSync(readmePath, "custom content", "utf8");
    await akmInit({ dir: stashDir });
    expect(fs.readFileSync(readmePath, "utf8")).toBe("custom content");
  });
});
