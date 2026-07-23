// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF: `migrate backup restore` with NO --run selects the newest-by-mtime
 * backup directory (resolveBackupRun, migration-backup.ts:1318-1331). Because
 * every restore FIRST mints a rescue snapshot into the SAME root (line 1454),
 * the newest run after a first restore is that rescue (which captured the
 * pre-restore / migrated state). A nervous user who runs the DEFAULT documented
 * command twice is silently flipped BACK into the state they were escaping.
 *
 * Fully realistic FROM-state: config 0.8.0 + a pre-cutover state.db. Only the
 * documented no-id restore is used; the trap-arming rescue is minted by the
 * restore machinery itself, not by any manual `backup create`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  createMigrationBackup,
  getMigrationBackupRoot,
  restoreMigrationBackup,
} from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { insertAssetSalienceRow, openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const MARKER_REF = "skill:marker";
const BEFORE = 111;
const AFTER = 222;

function writeConfig08(): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
}

/** Build a realistic pre-cutover state.db carrying a durable marker row. */
function buildStateDb(rankScore: number): void {
  const db = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
  try {
    insertAssetSalienceRow(db, {
      assetRef: MARKER_REF,
      encodingSalience: 0.6,
      outcomeSalience: 0.4,
      retrievalSalience: 0.5,
      rankScore,
      consecutiveNoOps: 0,
      updatedAt: 1_700_000_000_000,
      homeostaticDemotedAt: null,
      encodingSource: "content",
    });
  } finally {
    db.close();
  }
}

/** Mutate the LIVE state.db durable marker in place (simulates the migrated state). */
function setLiveMarker(rankScore: number): void {
  const db = new Database(getStateDbPathInDataDir());
  try {
    db.exec("PRAGMA busy_timeout=10000");
    db.prepare("UPDATE asset_salience SET rank_score = ? WHERE asset_ref = ?").run(rankScore, MARKER_REF);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/** Read the LIVE state.db durable marker back. */
function readLiveMarker(): number {
  const db = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    const row = db.prepare("SELECT rank_score AS r FROM asset_salience WHERE asset_ref = ?").get(MARKER_REF) as
      | { r: number }
      | undefined;
    if (!row) throw new Error("marker row missing after restore");
    return row.r;
  } finally {
    db.close();
  }
}

function backupDirCount(): number {
  const root = getMigrationBackupRoot();
  if (!fs.existsSync(root)) return 0;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;
}

test("no-id restore run twice ping-pongs the user back into the escaped state", async () => {
  // --- pre-migration 0.8.x install carrying durable value BEFORE ---
  writeConfig08();
  buildStateDb(BEFORE);

  const bpre = createMigrationBackup();
  expect(readLiveMarker()).toBe(BEFORE);

  // Ensure the rescue minted during restore #1 gets a strictly-newer mtime than
  // B_pre (in reality a user runs restore minutes later; here a short delay).
  await Bun.sleep(20);

  // The install is now in the state the user wants to escape (durable => AFTER).
  setLiveMarker(AFTER);
  expect(readLiveMarker()).toBe(AFTER);

  // --- Restore #1: the DEFAULT documented command, no --run ---
  const restore1 = restoreMigrationBackup(true /* confirm */); // no runId
  // Restore #1 correctly resolved the only run (B_pre) and reverted to BEFORE.
  expect(restore1.path).toBe(bpre.path);
  expect(readLiveMarker()).toBe(BEFORE);
  // A rescue snapshot was minted into the SAME root (this arms the trap).
  expect(restore1.rescuePath).toBeDefined();
  expect(backupDirCount()).toBe(2); // B_pre + rescue R1

  await Bun.sleep(20);

  // --- Restore #2: the SAME command again (a retry / "make sure it took") ---
  const restore2 = restoreMigrationBackup(true /* confirm */); // no runId

  // DEFECT (asserting the WRONG behavior the code actually exhibits):
  // A correct recovery tool would restore the pre-migration backup again and the
  // user would still see BEFORE. Instead resolveBackupRun picks the newest run —
  // the rescue R1 minted by restore #1, which captured AFTER — so the second
  // no-id restore selects the rescue and silently reverts the good restore,
  // ping-ponging the user back into the exact state they were escaping.
  expect(restore2.path).toBe(restore1.rescuePath); // BUG: selected the rescue, not B_pre
  expect(restore2.path).not.toBe(bpre.path); // the real pre-migration backup was NOT chosen
  expect(readLiveMarker()).toBe(AFTER); // BUG: flipped back to the escaped state
});
