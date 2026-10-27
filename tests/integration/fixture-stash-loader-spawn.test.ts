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
 * The literal sentinel-value AKM_BUNDLE_DIR override this test needs (to
 * prove `loadFixtureStash`'s cleanup restores to whatever was set before the
 * call, not some hardcoded default) is routed through `withEnv` rather than
 * a raw `process.env.AKM_BUNDLE_DIR = …` assignment, so this file needs no
 * isolation-lint allowlist entry.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withEnv } from "../_helpers/sandbox";
import { loadFixtureStash } from "../fixtures/stashes/load";

describe("loadFixtureStash", () => {
  test("materialises the minimal fixture, runs a real akm index, and cleanup removes it", async () => {
    const priorAkmStashDir = process.env.AKM_BUNDLE_DIR;
    const sentinel = "/tmp/some-prior-value";

    await withEnv({ AKM_BUNDLE_DIR: sentinel }, () => {
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

        // The helper set AKM_BUNDLE_DIR to the materialised path.
        expect(process.env.AKM_BUNDLE_DIR).toBe(stashDir);

        // Default behaviour runs `akm index`, which writes the SQLite DB
        // into the helper's isolated XDG_DATA_HOME (sibling of stashDir).
        const tmpRoot = path.dirname(stashDir);
        const dbPath = path.join(tmpRoot, "data", "akm", "index.db");
        expect(fs.existsSync(dbPath)).toBe(true);
      } finally {
        cleanup();
      }

      // After loadFixtureStash's own cleanup, the tmp tree is gone and
      // AKM_BUNDLE_DIR is restored to the sentinel withEnv set (the value
      // that was current when loadFixtureStash was called).
      expect(fs.existsSync(stashDir)).toBe(false);
      expect(process.env.AKM_BUNDLE_DIR).toBe(sentinel);
    });

    // withEnv's own restore (its finally) brings AKM_BUNDLE_DIR back to
    // whatever it was before this test ran.
    expect(process.env.AKM_BUNDLE_DIR).toBe(priorAkmStashDir);
  });
});
