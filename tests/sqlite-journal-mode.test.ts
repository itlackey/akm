// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #628 RED tests: configurable SQLite journal mode (AKM_SQLITE_JOURNAL_MODE)
 * with optional network-filesystem auto-fallback (WAL → DELETE).
 *
 * These tests pin the contract for src/storage/sqlite-pragmas.ts (the new
 * resolver + unified pragma helper) and assert that ALL FIVE journal_mode exec
 * sites across FOUR openers honor the env knob:
 *   - openStateDatabase()      (src/core/state-db.ts)
 *   - openWorkflowDatabase()   (src/workflows/db.ts)
 *   - openLogsDatabase()       (src/core/logs-db.ts)   ← the opener the issue missed
 *   - openDatabase()           (src/indexer/db/db.ts, main path)
 *   - openExistingDatabase()   (src/indexer/db/db.ts, 2nd path)
 *
 * Modeled on tests/db-busy-timeout.test.ts: mkdtempSync temp dirs + afterEach
 * cleanup, no host state. AKM_SQLITE_JOURNAL_MODE is isolated per-test via the
 * sandbox `withEnv` wrapper so it never leaks across tests.
 *
 * Maps to acceptance criteria a–f:
 *   AC-a all-5-openers honor env  AC-b default unchanged  AC-c invalid graceful
 *   AC-d DELETE roundtrip         AC-e network classifier + fallback wiring
 *   AC-f docs (verified by reading docs, see bottom)
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openLogsDatabase } from "../src/core/logs-db";
import { openStateDatabase } from "../src/core/state-db";
import { closeDatabase, openDatabase, openExistingDatabase } from "../src/indexer/db/db";
import type { Database } from "../src/storage/database";
import { openDatabase as openRawDatabase } from "../src/storage/database";
import {
  applyStandardPragmas,
  isNetworkFilesystem,
  type JournalMode,
  resolveJournalMode,
} from "../src/storage/sqlite-pragmas";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../src/workflows/db";
import { withEnv } from "./_helpers/sandbox";

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

// ── AC-pure-resolver: case-insensitive + trimmed canonicalization ────────────
describe("#628 AC-c: resolveJournalMode() pure resolver", () => {
  test("canonicalizes valid values (case-insensitive, trimmed)", () => {
    const cases: Array<[string, JournalMode]> = [
      ["wal", "WAL"],
      ["WAL", "WAL"],
      ["delete", "DELETE"],
      ["DELETE", "DELETE"],
      ["truncate", "TRUNCATE"],
      ["TRUNCATE", "TRUNCATE"],
      [" wal ", "WAL"],
      ["  DeLeTe ", "DELETE"],
    ];
    for (const [raw, expected] of cases) {
      expect(resolveJournalMode(raw)).toBe(expected);
    }
  });

  test("undefined and empty default to WAL", () => {
    expect(resolveJournalMode(undefined)).toBe("WAL");
    expect(resolveJournalMode("")).toBe("WAL");
    expect(resolveJournalMode("   ")).toBe("WAL");
  });

  test("invalid value returns WAL and never throws", () => {
    expect(() => resolveJournalMode("bogus")).not.toThrow();
    expect(resolveJournalMode("bogus")).toBe("WAL");
    // Repeated calls stay graceful (warn-once is an internal concern; no throw).
    expect(resolveJournalMode("also-bad")).toBe("WAL");
    expect(resolveJournalMode("xyz")).toBe("WAL");
  });
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

// ── AC-a: every opener honors AKM_SQLITE_JOURNAL_MODE=DELETE ─────────────────
describe("#628 AC-a: all 5 openers honor AKM_SQLITE_JOURNAL_MODE", () => {
  test("openStateDatabase() reports delete", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openStateDatabase(makeTempDbPath("state.db"));
      openHandles.push(() => db.close());
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("openWorkflowDatabase() reports delete", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openWorkflowDatabase(makeTempDbPath("workflow.db"));
      openHandles.push(() => closeWorkflowDatabase(db));
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("openLogsDatabase() reports delete (the opener the issue missed)", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openLogsDatabase(makeTempDbPath("logs.db"));
      openHandles.push(() => db.close());
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("openDatabase() (indexer main path) reports delete", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openDatabase(makeTempDbPath("index.db"));
      openHandles.push(() => closeDatabase(db));
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("openExistingDatabase() (indexer 2nd path) reports delete", async () => {
    const dbPath = makeTempDbPath("index.db");
    // Build the schema first (default WAL) so the existing-open path has a file.
    closeDatabase(openDatabase(dbPath));
    // bun:sqlite releases the underlying OS file lock on GC finalization, not
    // synchronously on close(). Force GC so the seed handle's lock is gone
    // before we reopen and switch WAL→DELETE in this SAME process (a test-only
    // concern; in production the existing-open happens in a fresh process).
    (globalThis as unknown as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openExistingDatabase(dbPath);
      openHandles.push(() => closeDatabase(db));
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("TRUNCATE is also honored end-to-end", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "TRUNCATE" }, () => {
      const db = openStateDatabase(makeTempDbPath("state.db"));
      openHandles.push(() => db.close());
      expect(journalModeOf(db)).toBe("truncate");
    });
  });
});

// ── AC-b: default (env unset) is byte-identical to today ─────────────────────
describe("#628 AC-b: default mode unchanged (WAL) when env unset", () => {
  test("all 5 openers report wal + busy_timeout=30000 + correct foreign_keys", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: undefined }, () => {
      const state = openStateDatabase(makeTempDbPath("state.db"));
      openHandles.push(() => state.close());
      expect(journalModeOf(state)).toBe("wal");
      expect(busyTimeoutOf(state)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
      expect(foreignKeysOf(state)).toBe(1);

      const wf = openWorkflowDatabase(makeTempDbPath("workflow.db"));
      openHandles.push(() => closeWorkflowDatabase(wf));
      expect(journalModeOf(wf)).toBe("wal");
      expect(busyTimeoutOf(wf)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
      expect(foreignKeysOf(wf)).toBe(1);

      const logs = openLogsDatabase(makeTempDbPath("logs.db"));
      openHandles.push(() => logs.close());
      expect(journalModeOf(logs)).toBe("wal");
      expect(busyTimeoutOf(logs)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
      // logs-db must remain byte-identical: it never set foreign_keys=ON.
      expect(foreignKeysOf(logs)).toBe(0);

      const idxPath = makeTempDbPath("index.db");
      const idx = openDatabase(idxPath);
      openHandles.push(() => closeDatabase(idx));
      expect(journalModeOf(idx)).toBe("wal");
      expect(busyTimeoutOf(idx)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
      expect(foreignKeysOf(idx)).toBe(1);
    });
  });
});

// ── AC-d: DELETE roundtrip (data survives) + durability pragmas ──────────────
describe("#628 AC-d: DELETE mode roundtrip", () => {
  test("CREATE/INSERT/SELECT roundtrip works in DELETE mode", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "DELETE" }, () => {
      const db = openStateDatabase(makeTempDbPath("state.db"));
      openHandles.push(() => db.close());

      db.exec("CREATE TABLE t628 (id INTEGER PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO t628 (id, v) VALUES (?, ?)").run(1, "hello-628");
      const row = db.prepare("SELECT v FROM t628 WHERE id = ?").get(1) as { v: string };

      expect(row.v).toBe("hello-628");
      expect(journalModeOf(db)).toBe("delete");
      expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
      // Rollback-journal mode sets synchronous=FULL (2) explicitly.
      expect(synchronousOf(db)).toBe(2);
    });
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

  test("WAL default + network probe falls back to DELETE", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: undefined }, () => {
      const { db, dir } = makeRawDb();
      const mode = applyStandardPragmas(db, {
        dataDir: dir,
        fsTypeProbe: () => 0x6969, // NFS
      });
      expect(mode).toBe("DELETE");
      expect(journalModeOf(db)).toBe("delete");
    });
  });

  test("WAL default + local probe stays WAL", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: undefined }, () => {
      const { db, dir } = makeRawDb();
      const mode = applyStandardPragmas(db, {
        dataDir: dir,
        fsTypeProbe: () => 0xef53, // ext4
      });
      expect(mode).toBe("WAL");
      expect(journalModeOf(db)).toBe("wal");
    });
  });

  test("explicit TRUNCATE is NOT overridden by a network probe", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: "TRUNCATE" }, () => {
      const { db, dir } = makeRawDb();
      const mode = applyStandardPragmas(db, {
        dataDir: dir,
        fsTypeProbe: () => 0x6969, // NFS — must not downgrade an explicit request
      });
      expect(mode).toBe("TRUNCATE");
      expect(journalModeOf(db)).toBe("truncate");
    });
  });

  test("foreignKeys:false leaves foreign_keys OFF (logs-db parity)", async () => {
    await withEnv({ AKM_SQLITE_JOURNAL_MODE: undefined }, () => {
      const { db, dir } = makeRawDb();
      applyStandardPragmas(db, { dataDir: dir, foreignKeys: false, fsTypeProbe: () => 0xef53 });
      expect(foreignKeysOf(db)).toBe(0);
    });
  });
});

// ── AC-f: docs carry the env-var row (assert on disk content) ────────────────
describe("#628 AC-f: docs document AKM_SQLITE_JOURNAL_MODE", () => {
  test("data-and-telemetry.md and configuration.md mention the env var", () => {
    const telemetry = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "data-and-telemetry.md"), "utf8");
    const config = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "configuration.md"), "utf8");
    expect(telemetry).toContain("AKM_SQLITE_JOURNAL_MODE");
    expect(config).toContain("AKM_SQLITE_JOURNAL_MODE");
  });
});
