/**
 * Real-subprocess coverage for the shared fixture-stash loader's DEFAULT
 * (non-`skipIndex`) behaviour.
 *
 * ISOLATION-06 / RUNTIME-04: `loadFixtureStash(name)` without
 * `{ skipIndex: true }` runs a real `akm index` CLI subprocess
 * (tests/fixtures/stashes/load.ts:135-148, `Bun.spawnSync`). A stalled
 * synchronous spawn blocks the whole JS runtime past every JS-level test
 * timeout, so this test —
 * the ONLY call site anywhere in the repo that exercises the default,
 * spawning path — lives in tests/integration/ rather than alongside its
 * sibling smoke tests in tests/fixture-stash-loader.test.ts (unit scope).
 * Moved here (behaviour unchanged) so the unit target never spawns.
 *
 * #786 ORG-04: relocated out of tests/integration/fixtures/stashes/ — no
 * .test.ts belongs under a fixtures/_fixtures path.
 *
 * The sentinel working bundle this test needs (to prove `loadFixtureStash`'s
 * cleanup restores the config to whatever it was before the call, not some
 * hardcoded default) is routed through `withBundle`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../../src/core/common";
import { makeStashDir, withBundle } from "../_helpers/sandbox";
import { loadFixtureStash } from "../fixtures/stashes/load";

describe("loadFixtureStash", () => {
  test("materialises the minimal fixture, runs a real akm index, and cleanup removes it", async () => {
    const sentinel = makeStashDir();

    await withBundle(sentinel.dir, () => {
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

        // The helper made the materialised path the working bundle.
        expect(resolveStashDir()).toBe(stashDir);

        // Default behaviour runs `akm index`, which writes the SQLite DB
        // into the helper's isolated XDG_DATA_HOME (sibling of stashDir).
        const tmpRoot = path.dirname(stashDir);
        const dbPath = path.join(tmpRoot, "data", "akm", "index.db");
        expect(fs.existsSync(dbPath)).toBe(true);
      } finally {
        cleanup();
      }

      // After loadFixtureStash's own cleanup, the tmp tree is gone and the working
      // bundle is the sentinel again (the one current when loadFixtureStash was called).
      expect(fs.existsSync(stashDir)).toBe(false);
      expect(resolveStashDir()).toBe(sentinel.dir);
    });

    // withBundle's own restore brings the config back to what it was before this test ran.
    expect(() => resolveStashDir()).toThrow();
    sentinel.cleanup();
  });
});
