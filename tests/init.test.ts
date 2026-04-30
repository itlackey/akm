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
  HOME: process.env.HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-init-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-init-config-");
  process.env.HOME = makeTempDir("akm-init-home-");
});

afterEach(() => {
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
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
});
