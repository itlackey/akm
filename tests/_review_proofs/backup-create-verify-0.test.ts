// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF: candidate defect "a corrupt/unreadable index.db is silently recorded
 * absent in the backup, then DELETED by the fail-closed restore/rollback,
 * destroying its durable usage_events history with no recovery source".
 *
 * The apply-rollback and the `backup restore` command both funnel into the same
 * replaceArtifactsFromBundle; testing restoreMigrationBackup() directly is a
 * faithful, deterministic reproduction of the file-deletion mechanism.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  createMigrationBackup,
  inspectMigrationState,
  restoreMigrationBackup,
} from "../../src/core/migration-backup";
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const config = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function seedLegacyConfigAndState(): void {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" }, null, 2)}\n`, { mode: 0o600 });
  fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
  const state = new Database(getStateDbPathInDataDir());
  state.exec("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
  state.close();
}

describe("index.db data-loss on fail-closed restore", () => {
  test("a garbage (corrupt) index.db present at backup time is DELETED by restore with no recovery source", () => {
    seedLegacyConfigAndState();

    // A realistic single-page/partial-write corruption of the hottest cache DB.
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    fs.writeFileSync(getDbPath(), "this is not a sqlite database");
    expect(inspectMigrationState().index.status).toBe("corrupt");

    // Backup silently records index.db absent and copies NO file.
    const backup = createMigrationBackup();
    expect(backup.manifest.artifacts["index.db"]?.present).toBe(false);
    expect(fs.existsSync(path.join(backup.path, "index.db"))).toBe(false); // no copy in the backup
    expect(fs.existsSync(getDbPath())).toBe(true); // corrupt file still on disk pre-restore

    // The fail-closed restore (== the apply-rollback's replaceArtifactsFromBundle).
    restoreMigrationBackup(true, backup.manifest.runId);

    // DEFECT: the on-disk index.db is gone, and no copy exists anywhere.
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(fs.existsSync(path.join(backup.path, "index.db"))).toBe(false);
  });

  test("recoverable usage_events survive a quick_check failure but are DESTROYED by restore", () => {
    seedLegacyConfigAndState();

    // Build a real index.db: usage_events on early pages, a large filler table
    // spanning many later pages. usage_events holds durable demand-signal rows
    // that are NOT regenerable from stash content.
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    const idx = new Database(getDbPath());
    idx.exec("PRAGMA page_size=4096");
    idx.exec("PRAGMA journal_mode=DELETE"); // single-file DB (no -wal) for a deterministic layout
    idx.exec("CREATE TABLE usage_events(entry_ref TEXT, weight INTEGER)");
    const ins = idx.prepare("INSERT INTO usage_events VALUES (?, ?)");
    for (let i = 0; i < 20; i += 1) ins.run(`stash//memories/x${i}`, i);
    idx.exec("CREATE TABLE filler(a TEXT, b TEXT)");
    const fins = idx.prepare("INSERT INTO filler VALUES (?, ?)");
    for (let i = 0; i < 5000; i += 1) fins.run(`row-${i}`, "x".repeat(200));
    idx.close();

    // Corrupt the b-tree page HEADER of the LAST page (a filler leaf page):
    // reliably trips PRAGMA quick_check while leaving usage_events readable.
    const pageSize = 4096;
    const size = fs.statSync(getDbPath()).size;
    expect(size % pageSize).toBe(0);
    const lastPageOffset = size - pageSize;
    const fd = fs.openSync(getDbPath(), "r+");
    try {
      fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, lastPageOffset);
    } finally {
      fs.closeSync(fd);
    }

    // Precondition A: it is classified "corrupt" (so the backup downgrade fires).
    expect(inspectMigrationState().index.status).toBe("corrupt");

    // Precondition B: the durable usage_events rows are STILL fully readable
    // (i.e. genuinely recoverable data lives behind the quick_check failure).
    const before = new Database(getDbPath(), { readonly: true });
    const countBefore = (before.prepare("SELECT count(*) AS n FROM usage_events").get() as { n: number }).n;
    before.close();
    expect(countBefore).toBe(20);

    // Backup records it absent (no copy of the file, so the rows are not saved).
    const backup = createMigrationBackup();
    expect(backup.manifest.artifacts["index.db"]?.present).toBe(false);
    expect(fs.existsSync(path.join(backup.path, "index.db"))).toBe(false);

    // Restore (fail-closed). Its internal rescue backup ALSO re-inspects the
    // still-corrupt live index.db and again records it absent -> no rescue copy.
    restoreMigrationBackup(true, backup.manifest.runId);

    // DEFECT: file gone -> the 20 recoverable usage_events rows are unrecoverable.
    expect(fs.existsSync(getDbPath())).toBe(false);
  });
});
