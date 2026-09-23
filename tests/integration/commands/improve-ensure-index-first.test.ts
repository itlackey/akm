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
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getEntryCount } from "../../../src/storage/repositories/index-entries-repository";
import { writeLesson } from "../../_helpers/assets";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  mutateScopedEnv,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

const dirCleanups: (() => void)[] = [];

function makeTempDir(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  dirCleanups.push(cleanup);
  return dir;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  // index.db lives under AKM_DATA_DIR; isolate so we never touch the user's
  // real ~/.local/share/akm/index.db.
  const akmDataDir = makeSandboxDir("akm-improve-ensure-data-");
  const akmStateDir = makeSandboxDir("akm-improve-ensure-state-");
  dirCleanups.push(akmDataDir.cleanup, akmStateDir.cleanup);
  storage = withIsolatedAkmStorage({ AKM_DATA_DIR: akmDataDir.dir, AKM_STATE_DIR: akmStateDir.dir });
});

afterEach(() => {
  storage.cleanup();
  for (const cleanup of dirCleanups.splice(0)) cleanup();
});

describe("akmImprove ordering: ensureIndex must run before collectEligibleRefs (#339)", () => {
  test("empty entries table on entry still produces non-empty plannedRefs after the call", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-stash-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
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
        semanticSearchMode: "off",
        bundles: { stash: { path: stashDir, writable: true } },
        defaultBundle: "stash",
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

  test("R6: ensureIndexDurationMs is surfaced on the result only when an implicit reindex actually ran", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-duration-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));

    writeLesson(stashDir, "prefer-ripgrep", "Prefer ripgrep over grep", "Searching large repos");
    await akmIndex({ stashDir, full: true });

    // Same staleness-forcing setup as the ordering test above: wipe entries
    // and builtAt so the run's ensureIndex call must rebuild inline.
    {
      const db = openExistingDatabase();
      try {
        db.exec("DELETE FROM entries");
        db.prepare("DELETE FROM index_meta WHERE key = 'builtAt'").run();
      } finally {
        closeDatabase(db);
      }
    }

    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      improve: {
        strategies: {
          "duration-order": {
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
    };
    const collectEligibleRefsFn = (async () => ({
      plannedRefs: [],
      memorySummary: { eligible: 0, derived: 0 },
      strategyFilteredRefs: [],
    })) as never;

    const rebuiltResult = await akmImprove({
      stashDir,
      strategy: "duration-order",
      repairValidationFailures: false,
      config,
      collectEligibleRefsFn,
    });
    expect(rebuiltResult.ok).toBe(true);
    expect(rebuiltResult.ensureIndexDurationMs).toBeGreaterThanOrEqual(0);

    // Second run: the index left behind by the first run is already fresh, so
    // ensureIndex is a no-op and the field must be OMITTED, not reported as 0.
    const freshResult = await akmImprove({
      stashDir,
      strategy: "duration-order",
      repairValidationFailures: false,
      config,
      collectEligibleRefsFn,
    });
    expect(freshResult.ok).toBe(true);
    expect(freshResult.ensureIndexDurationMs).toBeUndefined();
  });

  test("dry-run never invokes ensureIndex and uses only the existing index", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-dryrun-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
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
