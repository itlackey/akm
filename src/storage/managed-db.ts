// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Managed-database seam — the single home for the SQLite open/lifecycle recipe.
 *
 * Two lifecycle steps are shared across the current managed databases
 * (`state.db`, `logs.db`, and `index.db`) and their consumers:
 *
 *   1. The open recipe: `mkdir(dir) → openDatabase(path) → applyStandardPragmas
 *      → migrate`.
 *   2. The borrow-or-own lifecycle: `const db = ctx?.db ?? open(); const owns =
 *      !ctx?.db; try { … } finally { if (owns) db.close(); }`.
 *
 * {@link openManagedDatabase} owns (1); {@link withManagedDb} owns (2). Each DB
 * module supplies only a path + initializer and gets a `withXDb` loan helper
 * (see `withIndexDb`, `withStateDb`, etc.) so callers never hand-roll the
 * ownership flag or the finally/close again. This is also the one place to add
 * busy-timeout tuning, integrity checks, or test-isolation injection.
 */

import fs from "node:fs";
import path from "node:path";
import { type Database, openDatabase } from "./database";
import { applyStandardPragmas } from "./sqlite-pragmas";

export interface ManagedDbSpec {
  /** Absolute path to the database file. */
  path: string;
  /** Standard-pragma options. Defaults to `{ dataDir: dirname(path) }`. */
  pragmas?: Parameters<typeof applyStandardPragmas>[1];
  /** One-time schema setup (migrations / base DDL), run after pragmas on every open. */
  init?: (db: Database) => void;
  /**
   * When `false`, the database file must already exist: the parent dir is not
   * created and the driver opens with create-off (`fileMustExist`), throwing
   * instead of leaving a schema-less file behind. Default: create-on-open.
   */
  create?: boolean;
}

/**
 * Open a managed SQLite database: ensure the parent dir exists, open the handle,
 * apply standard pragmas, then run the schema initializer. The single home for
 * the open→pragmas→migrate recipe.
 *
 * ── On file permissions ──
 *
 * This function does not chmod the database, its `-wal`/`-shm` sidecars, or
 * THE CONTAINING DIRECTORY, deliberately:
 *
 *   - Changing modes would mutate state akm did not create. The data directory
 *     belongs to the operator; a read of the index is not consent to
 *     re-permission their disk.
 *   - This is the most-traveled path in the CLI, including `create: false`
 *     (read-only) opens, so a chmod would silently convert a `0755` directory
 *     to `0700` with no prompt, warning, or migration note.
 *   - It would break installs that share `$XDG_DATA_HOME` across uids —
 *     agent sandboxes, containers, service accounts. Worse, the read path
 *     answers an unreadable index with a false "No search index available" at
 *     exit 0 rather than an error.
 *
 * Files akm creates here get the process umask, which is the operator's lever
 * for this and always was. akm neither sets these modes nor reports on them.
 */
export function openManagedDatabase(spec: ManagedDbSpec): Database {
  const dir = path.dirname(spec.path);
  if (spec.create !== false && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = spec.create === false ? openDatabase(spec.path, { create: false }) : openDatabase(spec.path);
  try {
    applyStandardPragmas(db, spec.pragmas ?? { dataDir: dir });
    spec.init?.(db);
    return db;
  } catch (error) {
    // Initializers may open a transaction (source update does so before index
    // schema work). Never strand that transaction/handle when later setup
    // fails; closing rolls it back and releases its writer lock.
    //
    // `db.inTransaction` is INSIDE the try: reading it on an already-closed
    // handle throws "Database has closed", so it must not sit outside: that
    // throw would escape and replace `error`, masking the real initializer
    // failure this whole block exists to preserve. A concurrent close (WAL
    // contention between two writers) can reach it.
    try {
      if (db.inTransaction) db.exec("ROLLBACK");
    } catch {
      // Closing remains the final rollback backstop.
    }
    try {
      db.close();
    } catch {
      // Preserve the initializer failure, which identifies the real boundary.
    }
    throw error;
  }
}

/**
 * Run `fn` against a managed database, owning its lifecycle.
 *
 * When `opts.borrowed` is supplied the caller already owns an open handle: it is
 * passed straight through and NOT closed (borrow). Otherwise a fresh handle is
 * opened via `open` and closed in a `finally` (own). This replaces the
 * hand-rolled `ctx?.db ?? open()` + `ownsDb` flag + `finally`/close idiom — the
 * ownership decision and the close live here, once.
 *
 * Synchronous by design: the DB consumers (telemetry writers, planners) finish
 * all work within the tick, matching the inline blocks this replaces.
 */
export function withManagedDb<T>(open: () => Database, fn: (db: Database) => T, opts?: { borrowed?: Database }): T {
  if (opts?.borrowed) {
    return fn(opts.borrowed);
  }
  const db = open();
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // A close() throw here would REPLACE fn's in-flight exception — the same
      // masking openManagedDatabase above was hardened against. The handle is
      // being discarded either way; fn's error is the one that matters.
    }
  }
}
