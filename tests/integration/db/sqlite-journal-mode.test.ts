// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #628 — SQLite journal mode: WAL, with network-filesystem auto-fallback
 * (WAL → DELETE). The `AKM_SQLITE_JOURNAL_MODE` override is gone: the
 * fallback is the only way the mode changes.
 *
 * These tests pin the contract for src/storage/sqlite-pragmas.ts and the openers:
 *   - openStateDatabase()      (src/core/state-db.ts)
 *   - openLogsDatabase()       (src/core/logs-db.ts)   ← the opener the issue missed
 *   - openIndexDatabase()           (src/indexer/db/db.ts, main path)
 *   - openExistingDatabase()   (src/indexer/db/db.ts, 2nd path)
 *
 * (Chunk-8 WI-8.3: openWorkflowDatabase() is deleted with workflow.db; its rows
 * live in state.db, already covered by openStateDatabase() above.)
 *
 * Modeled on tests/db-busy-timeout.test.ts: mkdtempSync temp dirs + afterEach
 * cleanup, no host state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openLogsDatabase } from "../../../src/core/logs-db";
import { openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { openDatabase as openRawDatabase } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { applyStandardPragmas, isNetworkFilesystem } from "../../../src/storage/sqlite-pragmas";

const EXPECTED_BUSY_TIMEOUT_MS = 30_000;

const tempDirs: string[] = [];
const openHandles: Array<() => void> = [];

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-journal-mode-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function journalModeOf(db: Database): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  return String(row.journal_mode).toLowerCase();
}

function busyTimeoutOf(db: Database): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  return row.timeout;
}

function foreignKeysOf(db: Database): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  return row.foreign_keys;
}

function synchronousOf(db: Database): number {
  const row = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
  return row.synchronous;
}

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    try {
      close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC-e: pure network-filesystem classifier ────────────────────────────────
describe("#628 AC-e: isNetworkFilesystem() pure classifier", () => {
  test("known network magics classify as network", () => {
    expect(isNetworkFilesystem(0x6969)).toBe(true); // NFS
    expect(isNetworkFilesystem(0xff534d42)).toBe(true); // CIFS/SMB
    expect(isNetworkFilesystem(0xfe534d42)).toBe(true); // SMB2
    expect(isNetworkFilesystem(0x517b)).toBe(true); // old SMB_SUPER_MAGIC
    expect(isNetworkFilesystem(0x65735546)).toBe(true); // FUSE (sshfs etc.)
  });

  test("local magics and undefined classify as NOT network", () => {
    expect(isNetworkFilesystem(0xef53)).toBe(false); // ext4
    expect(isNetworkFilesystem(undefined)).toBe(false);
  });
});

// ── Default: every opener reports WAL + busy_timeout + foreign_keys ──────────
describe("#628: default journal mode is WAL on every opener", () => {
  test("all openers report wal + busy_timeout=30000 + correct foreign_keys", () => {
    const state = openStateDatabase(makeTempDbPath("state.db"));
    openHandles.push(() => state.close());
    expect(journalModeOf(state)).toBe("wal");
    expect(busyTimeoutOf(state)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
    expect(foreignKeysOf(state)).toBe(1);

    const logs = openLogsDatabase(makeTempDbPath("logs.db"));
    openHandles.push(() => logs.close());
    expect(journalModeOf(logs)).toBe("wal");
    expect(busyTimeoutOf(logs)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
    // logs-db must remain byte-identical: it never set foreign_keys=ON.
    expect(foreignKeysOf(logs)).toBe(0);

    const idx = openIndexDatabase(makeTempDbPath("index.db"));
    openHandles.push(() => closeDatabase(idx));
    expect(journalModeOf(idx)).toBe("wal");
    expect(busyTimeoutOf(idx)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
    expect(foreignKeysOf(idx)).toBe(1);
  });

  test("openExistingDatabase() reopens in wal", () => {
    const dbPath = makeTempDbPath("index.db");
    closeDatabase(openIndexDatabase(dbPath));
    const db = openExistingDatabase(dbPath);
    openHandles.push(() => closeDatabase(db));
    expect(journalModeOf(db)).toBe("wal");
  });
});

// ── AC-e: applyStandardPragmas network-fallback wiring (injected probe) ──────
describe("#628 AC-e: applyStandardPragmas() network-FS fallback wiring", () => {
  function makeRawDb(): { db: Database; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-journal-apply-"));
    tempDirs.push(dir);
    const db = openRawDatabase(path.join(dir, "probe.db"));
    openHandles.push(() => db.close());
    return { db, dir };
  }

  test("a network probe falls back to DELETE and sets synchronous = FULL", () => {
    const { db, dir } = makeRawDb();
    const mode = applyStandardPragmas(db, { dataDir: dir, fsTypeProbe: () => 0x6969 }); // NFS
    expect(mode).toBe("DELETE");
    expect(journalModeOf(db)).toBe("delete");
    expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
    expect(synchronousOf(db)).toBe(2);
  });

  test("a local probe stays WAL", () => {
    const { db, dir } = makeRawDb();
    const mode = applyStandardPragmas(db, { dataDir: dir, fsTypeProbe: () => 0xef53 }); // ext4
    expect(mode).toBe("WAL");
    expect(journalModeOf(db)).toBe("wal");
  });

  test("foreignKeys:false leaves foreign_keys OFF (logs-db parity)", () => {
    const { db, dir } = makeRawDb();
    applyStandardPragmas(db, { dataDir: dir, foreignKeys: false, fsTypeProbe: () => 0xef53 });
    expect(foreignKeysOf(db)).toBe(0);
  });
});
