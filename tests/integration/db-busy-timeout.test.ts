// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #589 regression: every SQLite open path must set `busy_timeout = 30000`.
 *
 * SQLITE_BUSY errors were observed in production when concurrent improve runs
 * contended on index.db or state.db writer locks — most often when a
 * post-inference reindex overlapped an event write from a parallel cron task.
 * The previous 5 s window was too narrow for this workload; 30 s matches
 * common resilient-SQLite guidance and eliminated the observed failures.
 *
 * Covered open paths:
 *   - index.db:    openIndexDatabase() and openExistingDatabase() (src/indexer/db/db.ts)
 *   - state.db:    openStateDatabase()                       (src/core/state-db.ts)
 *   - workflow.db: openWorkflowDatabase()                    (src/workflows/db.ts)
 *     (previously set NO busy_timeout at all → 0 ms default, instant
 *     SQLITE_BUSY on any concurrent writer)
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStateDatabase } from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../src/storage/repositories/index-connection";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";

const EXPECTED_BUSY_TIMEOUT_MS = 30_000;

const tempDirs: string[] = [];
const openHandles: Array<() => void> = [];

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-busy-timeout-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function busyTimeoutOf(db: Database): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  return row.timeout;
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

describe("#589: busy_timeout is 30 000 ms on every DB open path", () => {
  test("index.db: openIndexDatabase()", () => {
    const db = openIndexDatabase(makeTempDbPath("index.db"));
    openHandles.push(() => closeDatabase(db));
    expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
  });

  test("index.db: openExistingDatabase()", () => {
    const dbPath = makeTempDbPath("index.db");
    // Create the schema first so the existing-DB open path has a real file.
    closeDatabase(openIndexDatabase(dbPath));
    const db = openExistingDatabase(dbPath);
    openHandles.push(() => closeDatabase(db));
    expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
  });

  test("state.db: openStateDatabase()", () => {
    const db = openStateDatabase(makeTempDbPath("state.db"));
    openHandles.push(() => db.close());
    expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
  });

  test("workflow.db: openWorkflowDatabase()", () => {
    const db = openWorkflowDatabase(makeTempDbPath("workflow.db"));
    openHandles.push(() => closeWorkflowDatabase(db));
    expect(busyTimeoutOf(db)).toBe(EXPECTED_BUSY_TIMEOUT_MS);
  });
});
