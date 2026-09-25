// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * state.db integrity + reclaimable-space probes (R0).
 *
 * `akm health`'s `state-db-integrity` check (src/commands/health/checks.ts)
 * is a pure projection like every other check, so the actual IO lives here:
 * a read-only `PRAGMA quick_check` and a read-only freelist/page-count read.
 * Both open their own short-lived connection via the plain {@link openDatabase}
 * opener — deliberately bypassing `openStateDatabase`'s managed-open/migration
 * machinery (src/core/state-db.ts), since a corrupt database must not need a
 * clean migration-ledger read just to report itself as corrupt.
 *
 * {@link vacuumStateDbIfReclaimable} is the post-purge VACUUM step: given an
 * already-open read-write connection (VACUUM cannot run inside a transaction,
 * and a read-only handle cannot run it at all) and a freelist reading, it
 * VACUUMs only when the freelist ratio crosses {@link STATE_DB_FREELIST_WARN_RATIO}
 * and never throws — a locked/busy database is reported, not raised.
 *
 * @module storage/state-db-integrity
 */

import { appendEvent, type EventsContext } from "../core/events";
import { type Database, openDatabase } from "./database";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-pragmas";

/** How many corruption errors `PRAGMA quick_check` collects before it stops scanning and returns. */
const QUICK_CHECK_ERROR_LIMIT = 10;

/** Above this fraction of free pages, `state-db-integrity` warns and a post-purge pass VACUUMs. */
export const STATE_DB_FREELIST_WARN_RATIO = 0.5;

/** Event appended by {@link vacuumStateDbIfReclaimable} after a successful VACUUM. */
export const STATE_DB_VACUUMED_EVENT = "state_db_vacuumed";

export interface StateDbQuickCheckResult {
  ok: boolean;
  /** Raw pragma result rows: `["ok"]` when clean, its diagnostic lines otherwise. */
  lines: string[];
  /** Set only when the probe itself could not run (e.g. the file could not be opened). */
  error?: string;
}

export interface StateDbFreelistInfo {
  freelistCount: number;
  pageCount: number;
  /** `freelistCount / pageCount`, `0` when `pageCount` is `0`. */
  ratio: number;
  /** Set only when the probe itself could not run (e.g. the file could not be opened). */
  error?: string;
}

export interface StateDbVacuumOutcome {
  ran: boolean;
  /** Present when `ran` is `false`. */
  reason?: "below-threshold" | "busy" | "error";
  pagesBefore: number;
  /** Present only when `ran` is `true`. */
  pagesAfter?: number;
  /** Present only when `reason` is `"busy"` or `"error"`. */
  error?: string;
}

function firstColumn(row: Record<string, unknown> | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0];
}

function openReadonlyStateDb(dbPath: string): Database {
  const db = openDatabase(dbPath, { readonly: true, create: false });
  // Read-only handles cannot run journal_mode/foreign_keys (write operations),
  // but busy_timeout is legal — see openReadonlyExistingDatabase's identical
  // rationale in src/storage/repositories/index-connection.ts.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Run `PRAGMA quick_check(N)` against `dbPath` read-only. Sub-second on a
 * healthy multi-hundred-MB file; on a corrupt one, `N` bounds how many errors
 * SQLite collects before it stops scanning, which keeps the check's runtime
 * bounded even against a badly corrupt file.
 */
export function runStateDbQuickCheck(dbPath: string): StateDbQuickCheckResult {
  let db: Database | undefined;
  try {
    db = openReadonlyStateDb(dbPath);
    const rows = db.prepare(`PRAGMA quick_check(${QUICK_CHECK_ERROR_LIMIT})`).all() as Array<Record<string, unknown>>;
    const lines = rows.map((row) => String(firstColumn(row)));
    const ok = lines.length === 1 && lines[0] === "ok";
    return { ok, lines };
  } catch (err) {
    return { ok: false, lines: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

/**
 * Read `PRAGMA freelist_count` / `PRAGMA page_count` off an already-open
 * connection. Shared by {@link getStateDbFreelistInfo} (which opens its own
 * read-only handle) and the post-purge VACUUM call site, which must read the
 * freelist off the same read-write connection the purge just used rather
 * than open a second one.
 */
export function readFreelistInfo(db: Database): StateDbFreelistInfo {
  const freelistCount = Number(firstColumn(db.prepare("PRAGMA freelist_count").get() as Record<string, unknown>) ?? 0);
  const pageCount = Number(firstColumn(db.prepare("PRAGMA page_count").get() as Record<string, unknown>) ?? 0);
  return { freelistCount, pageCount, ratio: pageCount > 0 ? freelistCount / pageCount : 0 };
}

/** Read `PRAGMA freelist_count` / `PRAGMA page_count` — how much of state.db is reclaimable by VACUUM. */
export function getStateDbFreelistInfo(dbPath: string): StateDbFreelistInfo {
  let db: Database | undefined;
  try {
    db = openReadonlyStateDb(dbPath);
    return readFreelistInfo(db);
  } catch (err) {
    return { freelistCount: 0, pageCount: 0, ratio: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

/**
 * VACUUM `db` when `freelist.ratio` exceeds {@link STATE_DB_FREELIST_WARN_RATIO},
 * appending a {@link STATE_DB_VACUUMED_EVENT} recording pages before/after.
 * Intended to run immediately after the retention purge, on the same
 * read-write connection the purge just used. Never throws: a locked/busy
 * database (another writer holds the file right now) is reported via
 * `reason: "busy"` rather than raised, since this is opportunistic
 * maintenance and must not fail the purge pass it follows.
 *
 * The event is appended via `appendEvent` (not a direct `insertEvent` on
 * `db`) so it honors the caller's `EventsContext` — `readOnly` suppresses
 * the write and an injected `now` is used for `ts` — the same as every
 * other event `runRetentionPurgePass` appends in this callback.
 */
export function vacuumStateDbIfReclaimable(
  db: Database,
  freelist: StateDbFreelistInfo,
  eventsCtx?: EventsContext,
): StateDbVacuumOutcome {
  if (freelist.ratio <= STATE_DB_FREELIST_WARN_RATIO) {
    return { ran: false, reason: "below-threshold", pagesBefore: freelist.pageCount };
  }
  try {
    db.exec("VACUUM");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const busy = /busy|locked/i.test(message);
    return { ran: false, reason: busy ? "busy" : "error", pagesBefore: freelist.pageCount, error: message };
  }
  const pagesAfter = Number(firstColumn(db.prepare("PRAGMA page_count").get() as Record<string, unknown>) ?? 0);
  appendEvent(
    {
      eventType: STATE_DB_VACUUMED_EVENT,
      metadata: { pagesBefore: freelist.pageCount, pagesAfter, freelistRatioBefore: freelist.ratio },
    },
    eventsCtx,
  );
  return { ran: true, pagesBefore: freelist.pageCount, pagesAfter };
}
