// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `BEGIN IMMEDIATE` transactions and the one SQLite contention classifier.
 *
 * `db.transaction()` is DEFERRED by default on both Bun and better-sqlite3,
 * which means two writers can both perform stale preflight reads and only race
 * when they finally attempt the write. Proposal creation, queue mutation and
 * schema migration need the write lock BEFORE those reads so concurrent
 * processes serialize on the live state rather than clobbering each other.
 *
 * Every open already carries a 30 s `busy_timeout` (`sqlite-pragmas.ts`), so a
 * single blocked statement waits before failing. {@link beginImmediateTransaction}
 * additionally retries `BEGIN IMMEDIATE` itself ({@link WITH_IMMEDIATE_TX_MAX_ATTEMPTS}
 * attempts) for the rarer case of two writers racing the BEGIN statement
 * back-to-back. If every attempt is still contention-shaped
 * ({@link isSqliteContentionError} — SQLITE_BUSY/LOCKED, the matching message
 * text, or the phantom-BEGIN marker), the exhaustion throw is reclassified
 * into `TransientError("STATE_DB_CONTENDED")` (exit 75, #948 addendum) instead
 * of surfacing the raw driver text: another akm process (an unrelated
 * `improve`, `workflow run`, or task run — not necessarily contending for the
 * same row) is writing the database right now. A genuinely unrelated error
 * (real corruption, a body-thrown failure) is never reclassified and rethrows
 * exactly as raised.
 *
 * This is the single place SQLITE_BUSY/LOCKED becomes exit 75 for state.db:
 * `openStateDatabase`'s migration transaction, every repository write and the
 * shared migration runner (`engines/sqlite-migrations.ts`) all go through it.
 * `core/state-db.ts` re-exports these helpers for its callers.
 *
 * @module storage/sqlite-transaction
 */

import { TransientError } from "../core/errors";
import { sleepSync } from "../runtime";
import type { Database } from "./database";

/**
 * Whether `err` is one of the SQLite conditions a concurrent-writer race can
 * throw that are transient — the statement did NOT corrupt anything, another
 * writer just holds the lock right now — and therefore safe to retry or
 * reclassify as ordinary contention rather than a genuine failure:
 *   - `SQLITE_BUSY` / `SQLITE_LOCKED` (either driver's `.code`).
 *   - "database is locked" / "database table is locked" message text.
 *   - the phantom-BEGIN marker synthesized below when `BEGIN IMMEDIATE`
 *     returns without actually opening a transaction.
 *
 * This is the single shared classifier for "is this ordinary contention"
 * (#948): `reclassifyIndexDbContention` (indexer) and the workflow-runs
 * repository's lease-contention classifier (which additionally matches a
 * couple of corruption-shaped texts specific to its own narrower cross-process
 * race and keeps its own live-lease confirmation before reclassifying) both
 * delegate to it. Matching this set alone is never sufficient to declare
 * something DEFINITELY contention when a caller needs corroborating evidence
 * (see the lease path); for `beginImmediateTransaction`'s own exhaustion case
 * there is no such evidence available, so the five 30 s `busy_timeout` waits
 * already spent stand as the evidence instead.
 */
export function isSqliteContentionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database table is locked") ||
    // Phantom BEGIN (see below) — synthesized when BEGIN IMMEDIATE returns
    // without opening a transaction. Safe to retry: fn() has not run.
    msg.includes("did not open a transaction")
  );
}

const WITH_IMMEDIATE_TX_MAX_ATTEMPTS = 5;

/**
 * Reclassify an exhausted-retry BEGIN failure that is still contention-shaped
 * (#948) into a `TransientError("STATE_DB_CONTENDED")`, the same class as a
 * held workflow run lock (`RUN_LEASE_HELD`): the driver text is accurate but unhelpful (`{"ok":false,"error":"database is
 * locked"}`, exit 70/INTERNAL) — this instead reads as a retryable-shortly
 * signal (exit 75, sysexits EX_TEMPFAIL) with the original error preserved as
 * `cause` for `--verbose`/debugging. A genuinely unrelated error (not
 * contention-shaped) is rethrown exactly as raised, never reclassified.
 */
function throwBeginFailure(err: unknown): never {
  if (isSqliteContentionError(err)) {
    const contended = new TransientError(
      "akm's state database is busy (another akm process is writing it); retry shortly.",
      "STATE_DB_CONTENDED",
    );
    contended.cause = err;
    throw contended;
  }
  throw err;
}

/**
 * Open, but deliberately do not finish, an immediate transaction.
 *
 * This is the split-phase counterpart to {@link withImmediateTransaction} for
 * the source-update coordinator: index finalization must mutate state.db in a
 * transaction that remains pending until content, lockfile, and index
 * publication have all succeeded. The caller that asked for this split phase
 * owns the matching COMMIT/ROLLBACK.
 *
 * Only a contention-shaped BEGIN failure is retried. "cannot start a
 * transaction within a transaction" is deliberately NOT: it means a
 * transaction is already open on this connection (a re-entrant call — handled
 * by the entry guard in {@link withImmediateTransaction}), and "retrying" it
 * with a ROLLBACK would destroy the caller's transaction (issue #686).
 */
export function beginImmediateTransaction(db: Database): void {
  if (db.inTransaction) {
    throw new Error("beginImmediateTransaction requires a connection with no active transaction");
  }
  let lastBeginErr: unknown;
  for (let attempt = 1; attempt <= WITH_IMMEDIATE_TX_MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      if (!db.inTransaction) {
        throw new Error("BEGIN IMMEDIATE did not open a transaction (phantom contention state)");
      }
      return;
    } catch (err) {
      lastBeginErr = err;
      if (isSqliteContentionError(err) && attempt < WITH_IMMEDIATE_TX_MAX_ATTEMPTS) {
        if (db.inTransaction) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Transaction already gone — safe to retry BEGIN.
          }
        }
        sleepSync(2 ** (attempt - 1));
        continue;
      }
      throwBeginFailure(err);
    }
  }
  throwBeginFailure(lastBeginErr);
}

/** Run `fn` inside a `BEGIN IMMEDIATE` transaction, joining one that is already open on `db`. */
export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  // Re-entrancy guard (issue #686): if a transaction is already open on this
  // connection (e.g. a nested withImmediateTransaction call inside an outer
  // frame's fn), join it — run fn directly with no BEGIN/COMMIT/ROLLBACK of
  // our own. Without this, the nested BEGIN throws "cannot start a transaction
  // within a transaction", which the old retry path answered with an
  // unconditional ROLLBACK — destroying the OUTER transaction and leaving its
  // COMMIT to fail with "cannot commit - no transaction is active".
  if (db.inTransaction) {
    return fn();
  }
  beginImmediateTransaction(db);
  try {
    const result = fn();
    if (!db.inTransaction) {
      // The transaction we opened vanished while fn() ran (e.g. an
      // auto-rollback or a stray ROLLBACK inside fn). fn's writes may have
      // escaped serialization, so retrying is unsafe — fail loudly instead of
      // letting COMMIT throw the opaque "cannot commit - no transaction is
      // active" SQLiteError.
      throw new Error(
        "withImmediateTransaction invariant violated: transaction opened by BEGIN IMMEDIATE was no longer active after the transaction body ran; refusing to COMMIT (writes may have escaped serialization)",
      );
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so the original error is preserved.
      }
    }
    throw err;
  }
}
