/**
 * Smoke tests for the shared fixture-stash loader.
 *
 * Validates that loadFixtureStash, fixtureContentHash, and listFixtures
 * behave as advertised in docs/technical/benchmark.md §5.5.
 *
 * ISOLATION-06 / RUNTIME-04: `loadFixtureStash`'s DEFAULT behaviour (no
 * `{ skipIndex: true }`) shells out to a real `akm index` CLI subprocess
 * (load.ts:135-148, `Bun.spawnSync`). That is exactly the "genuinely needs a
 * real subprocess" case Rule 5's own docstring says belongs in
 * tests/integration/, not here — this file's unit-scope shard must never
 * spawn. The one test that exercised that default path has moved to
 * tests/integration/fixture-stash-loader-spawn.test.ts; every test remaining
 * here calls `loadFixtureStash(…, { skipIndex: true })` (no spawn) or touches
 * neither the CLI nor process.env at all.
 *
 * #786 ORG-04: relocated out of tests/fixtures/stashes/ — no .test.ts belongs
 * under a fixtures/_fixtures path.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { computeFixtureContentHash, fixtureContentHash, listFixtures, loadFixtureStash } from "./fixtures/stashes/load";

describe("loadFixtureStash", () => {
  test("with { skipIndex: true } does not invoke akm index", () => {
    const priorAkmStashDir = process.env.AKM_BUNDLE_DIR;

    const { stashDir, cleanup } = loadFixtureStash("minimal", { skipIndex: true });

    try {
      // The fixture is still materialised and AKM_BUNDLE_DIR is still set.
      expect(fs.existsSync(stashDir)).toBe(true);
      expect(process.env.AKM_BUNDLE_DIR).toBe(stashDir);

      // But the index DB the helper would otherwise have created in the
      // isolated XDG_CACHE_HOME is absent — proving no `akm index` ran.
      const tmpRoot = path.dirname(stashDir);
      const dbPath = path.join(tmpRoot, "cache", "akm", "index.db");
      expect(fs.existsSync(dbPath)).toBe(false);

      // cleanup() (exercised below) is solely responsible for restoring
      // AKM_BUNDLE_DIR — asserted here rather than via a second manual
      // restore in this test body, which would re-trip the isolation lint's
      // unguarded-env rule for no behavioural benefit.
    } finally {
      cleanup();
    }

    expect(process.env.AKM_BUNDLE_DIR).toBe(priorAkmStashDir);
  });
});

describe("fixtureContentHash", () => {
  test("is deterministic for the same fixture", () => {
    const a = fixtureContentHash("minimal");
    const b = fixtureContentHash("minimal");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeFixtureContentHash is the same implementation (#250)", () => {
    // Critical addendum: there must be exactly one fixture-content hash
    // function. Two diverging hash implementations for the same content
    // would be a bug.
    expect(computeFixtureContentHash).toBe(fixtureContentHash);
    expect(computeFixtureContentHash("minimal")).toBe(fixtureContentHash("minimal"));
  });
});

describe("listFixtures", () => {
  test("returns all shipped fixtures, sorted", () => {
    const names = listFixtures();
    expect(names).toEqual(["all-types", "minimal", "ranking-baseline", "search-filter"]);
  });
});
