/**
 * Improve's pre-run index (#339): `akmImprove` builds the index (incrementally, under the rebuild lock in
 * `"try"` mode) BEFORE `collectEligibleRefs`, otherwise an empty/stale `entries` table makes the loop
 * silently no-op with `plannedRefs = []`. With another process holding the lock it builds nothing, plans on
 * the entries it has and says so. Dry-runs consume the existing index without invoking an index writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { buildIndex } from "../../../src/indexer/index-build";
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

describe("akmImprove pre-run index (#339)", () => {
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
        // Also clear builtAt, as a build killed mid-way leaves it.
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

  test("R6: ensureIndexDurationMs is surfaced on the result when the pre-run index built", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-duration-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));

    writeLesson(stashDir, "prefer-ripgrep", "Prefer ripgrep over grep", "Searching large repos");
    await akmIndex({ stashDir, full: true });

    // Same staleness-forcing setup as the ordering test above: wipe entries
    // and builtAt so the run's pre-run index must rebuild.
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

    // Second run: the index is current, but the pre-run index still runs the
    // incremental build and lets its fingerprints decide, so the field is set.
    const freshResult = await akmImprove({
      stashDir,
      strategy: "duration-order",
      repairValidationFailures: false,
      config,
      collectEligibleRefsFn,
    });
    expect(freshResult.ok).toBe(true);
    expect(freshResult.ensureIndexDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("a live process holding the rebuild lock: improve builds nothing, plans on the existing entries and says so", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-locked-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
    writeLesson(stashDir, "locked-lesson", "Locked lesson", "Trigger");
    await akmIndex({ stashDir, full: true });
    // Added after the index was built: only a build would pick it up.
    writeLesson(stashDir, "added-late", "Added late", "Trigger");

    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    let entryCountAtCollect = -1;
    const notices: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") notices.push(args.map(String).join(" "));
    });
    try {
      const result = await akmImprove({
        stashDir,
        repairValidationFailures: false,
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          bundles: { stash: { path: stashDir, writable: true } },
          defaultBundle: "stash",
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
      expect(entryCountAtCollect).toBe(1);
      expect(notices.join("\n")).toContain("another index run holds the rebuild lock");
      // The holder's lock is untouched.
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    } finally {
      _setWarnSinkForTests(undefined);
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("dry-run never builds the index and uses only the existing one", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-dryrun-");
    mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
    saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));

    writeLesson(stashDir, "single-lesson", "Single lesson", "Trigger");

    // Drive a no-DB starting state. Dry-run must not create one merely to make
    // planning more complete.
    let indexCalls = 0;
    const result = await akmImprove({
      dryRun: true,
      stashDir,
      reindexFn: async (options) => {
        indexCalls += 1;
        return buildIndex(options, "try");
      },
    });

    expect(indexCalls).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.plannedRefs).toEqual([]);
  });
});
