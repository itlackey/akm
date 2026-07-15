/**
 * Regression test for #339: `akmImprove` must run `ensureIndex` BEFORE
 * `collectEligibleRefs`, otherwise an empty/stale `entries` table (e.g. right
 * after a full reindex clears the table before repopulating) makes the improve
 * loop silently no-op with `plannedRefs = []`.
 *
 * Before this fix: ensureIndex ran AFTER collectEligibleRefs, so the very
 * first run after a DB rebuild saw an empty entries table, captured
 * `plannedRefs = []`, and the rebuild only helped the NEXT run.
 *
 * Real runs use this ordering. Dry-runs intentionally consume the existing
 * index without invoking an index writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { closeDatabase, getEntryCount, openExistingDatabase } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLesson } from "../../_helpers/assets";
import { withTestImproveLlm } from "../../_helpers/improve-config";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-ensure-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-ensure-config-");
  // index.db lives under AKM_DATA_DIR; isolate so we never touch the user's
  // real ~/.local/share/akm/index.db.
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-ensure-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-ensure-state-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.AKM_STATE_DIR === undefined) delete process.env.AKM_STATE_DIR;
  else process.env.AKM_STATE_DIR = savedEnv.AKM_STATE_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akmImprove ordering: ensureIndex must run before collectEligibleRefs (#339)", () => {
  test("empty entries table on entry still produces non-empty plannedRefs after the call", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));

    // Seed two lessons on disk.
    writeLesson(stashDir, "prefer-ripgrep", "Prefer ripgrep over grep", "Searching large repos");
    writeLesson(stashDir, "lock-files", "Always commit lock files", "Adding deps");

    // Build the index so entries are populated, then wipe the entries table
    // to simulate a freshly-cleared `entries` table (e.g. mid-rebuild, before
    // re-insertion).
    await akmIndex({ stashDir, full: true });
    const dbPathBefore = getDbPath();
    expect(fs.existsSync(dbPathBefore)).toBe(true);

    {
      const db = openExistingDatabase();
      try {
        db.exec("DELETE FROM entries");
        // Force ensureIndex's staleness check to fire by also clearing builtAt
        // (so hasNewerIndexableFiles returns true unconditionally).
        db.prepare("DELETE FROM index_meta WHERE key = 'builtAt'").run();
        expect(getEntryCount(db)).toBe(0);
      } finally {
        closeDatabase(db);
      }
    }

    let entryCountAtCollect = 0;
    const result = await akmImprove({
      stashDir,
      strategy: "index-order",
      repairValidationFailures: false,
      config: {
        configVersion: "0.9.0",
        stashDir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
        improve: {
          strategies: {
            "index-order": {
              processes: {
                reflect: { enabled: false },
                distill: { enabled: false },
                consolidate: { enabled: false },
                memoryInference: { enabled: false },
                graphExtraction: { enabled: false },
                extract: { enabled: false },
                validation: { enabled: false },
                triage: { enabled: false },
                proactiveMaintenance: { enabled: false },
                recombine: { enabled: false },
                procedural: { enabled: false },
              },
            },
          },
        },
      },
      collectEligibleRefsFn: (async () => {
        const db = openExistingDatabase();
        try {
          entryCountAtCollect = getEntryCount(db);
        } finally {
          closeDatabase(db);
        }
        return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, strategyFilteredRefs: [] };
      }) as never,
    });

    expect(result.ok).toBe(true);
    expect(entryCountAtCollect).toBe(2);
  });

  test("dry-run never invokes ensureIndex and uses only the existing index", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-dryrun-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));

    writeLesson(stashDir, "single-lesson", "Single lesson", "Trigger");

    // Drive a no-DB starting state. Dry-run must not create one merely to make
    // planning more complete.
    let ensureCalls = 0;
    let ensureMode: string | undefined;
    const result = await akmImprove({
      dryRun: true,
      stashDir,
      ensureIndexFn: async (dir: string, options) => {
        ensureCalls += 1;
        ensureMode = options?.mode;
        const { ensureIndex } = await import("../../../src/indexer/ensure-index");
        return ensureIndex(dir, options);
      },
    });

    expect(ensureCalls).toBe(0);
    expect(ensureMode).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.plannedRefs).toEqual([]);
  });
});
