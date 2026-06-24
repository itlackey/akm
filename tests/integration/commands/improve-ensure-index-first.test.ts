/**
 * Regression test for #339: `akmImprove` must run `ensureIndex` BEFORE
 * `collectEligibleRefs`, otherwise an empty/stale `entries` table (e.g. right
 * after a DB version upgrade that drops the table) makes the improve loop
 * silently no-op with `plannedRefs = []`.
 *
 * Before this fix: ensureIndex ran AFTER collectEligibleRefs, so the very
 * first run after a DB rebuild saw an empty entries table, captured
 * `plannedRefs = []`, and the rebuild only helped the NEXT run.
 *
 * The dry-run path also goes through the new ordering, so this test exercises
 * the bug without needing the full reflect/distill pipeline.
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

function writeLesson(stashDir: string, name: string, description: string, whenToUse: string): void {
  const filePath = path.join(stashDir, "lessons", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    "---",
    `description: ${description}`,
    `when_to_use: ${whenToUse}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Body text.",
    "",
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
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
    saveConfig({ semanticSearchMode: "off" });

    // Seed two lessons on disk.
    writeLesson(stashDir, "prefer-ripgrep", "Prefer ripgrep over grep", "Searching large repos");
    writeLesson(stashDir, "lock-files", "Always commit lock files", "Adding deps");

    // Build the index so entries are populated, then wipe the entries table
    // to simulate the post-DB-version-upgrade state where handleVersionUpgrade
    // has dropped/cleared `entries`.
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

    // OLD code path: collectEligibleRefs runs first → reads empty entries →
    //                plannedRefs = []  (the bug).
    // NEW code path: ensureIndex runs first → repopulates entries →
    //                collectEligibleRefs sees fresh rows → plannedRefs has both.
    const result = await akmImprove({ dryRun: true, stashDir });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    const plannedNames = result.plannedRefs.map((p) => p.ref).sort();
    expect(plannedNames).toEqual(["lesson:lock-files", "lesson:prefer-ripgrep"]);
  });

  test("ensureIndex is invoked even when the dry-run early return is taken", async () => {
    const stashDir = makeTempDir("akm-improve-ensure-dryrun-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeLesson(stashDir, "single-lesson", "Single lesson", "Trigger");

    // Drive a no-DB starting state — akmImprove must still build the index
    // before computing plannedRefs in dry-run mode.
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

    expect(ensureCalls).toBe(1);
    expect(ensureMode).toBe("blocking");
    expect(result.ok).toBe(true);
    expect(result.plannedRefs.map((p) => p.ref)).toContain("lesson:single-lesson");
  });
});
