/**
 * Smoke tests for the shared fixture-stash loader.
 *
 * Validates that loadFixtureStash, fixtureContentHash, and listFixtures
 * behave as advertised in docs/technical/benchmark.md §5.5.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixtureContentHash, listFixtures, loadFixtureStash } from "./load";

describe("loadFixtureStash", () => {
  test("materialises the minimal fixture and cleanup removes it", () => {
    const priorAkmStashDir = process.env.AKM_STASH_DIR;
    const sentinel = "/tmp/some-prior-value";
    process.env.AKM_STASH_DIR = sentinel;

    const { stashDir, cleanup, contentHash } = loadFixtureStash("minimal");

    try {
      expect(fs.existsSync(stashDir)).toBe(true);
      expect(fs.statSync(stashDir).isDirectory()).toBe(true);

      // All five core asset directories from the minimal fixture.
      for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
        expect(fs.existsSync(path.join(stashDir, sub))).toBe(true);
      }

      // Content hash is non-empty hex.
      expect(contentHash).toMatch(/^[0-9a-f]{64}$/);

      // The helper set AKM_STASH_DIR to the materialised path.
      expect(process.env.AKM_STASH_DIR).toBe(stashDir);

      // Default behaviour runs `akm index`, which writes the SQLite DB into
      // the helper's isolated XDG_CACHE_HOME (sibling of stashDir).
      const tmpRoot = path.dirname(stashDir);
      const dbPath = path.join(tmpRoot, "cache", "akm", "index.db");
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      cleanup();
    }

    // After cleanup, the tmp tree is gone and AKM_STASH_DIR is restored.
    expect(fs.existsSync(stashDir)).toBe(false);
    expect(process.env.AKM_STASH_DIR).toBe(sentinel);

    // Restore the test's own prior value rather than the synthetic sentinel.
    if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = priorAkmStashDir;
  });

  test("with { skipIndex: true } does not invoke akm index", () => {
    const priorAkmStashDir = process.env.AKM_STASH_DIR;

    const { stashDir, cleanup } = loadFixtureStash("minimal", { skipIndex: true });

    try {
      // The fixture is still materialised and AKM_STASH_DIR is still set.
      expect(fs.existsSync(stashDir)).toBe(true);
      expect(process.env.AKM_STASH_DIR).toBe(stashDir);

      // But the index DB the helper would otherwise have created in the
      // isolated XDG_CACHE_HOME is absent — proving no `akm index` ran.
      const tmpRoot = path.dirname(stashDir);
      const dbPath = path.join(tmpRoot, "cache", "akm", "index.db");
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      cleanup();
    }

    if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = priorAkmStashDir;
  });
});

describe("fixtureContentHash", () => {
  test("is deterministic for the same fixture", () => {
    const a = fixtureContentHash("minimal");
    const b = fixtureContentHash("minimal");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("listFixtures", () => {
  test("returns all six shipped fixtures, sorted", () => {
    const names = listFixtures();
    expect(names).toEqual(["az-cli", "docker-homelab", "minimal", "multi-domain", "noisy", "ranking-baseline"]);
  });
});
