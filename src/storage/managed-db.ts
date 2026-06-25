// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Managed-database seam — the single home for the SQLite open/lifecycle recipe.
 *
 * Before this module, two idioms were copy-pasted across state.db / logs.db /
 * workflow.db / index.db and their consumers:
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
}

/**
 * Open a managed SQLite database: ensure the parent dir exists, open the handle,
 * apply standard pragmas, then run the schema initializer. The single home for
 * the open→pragmas→migrate recipe.
 */
export function openManagedDatabase(spec: ManagedDbSpec): Database {
  const dir = path.dirname(spec.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = openDatabase(spec.path);
  applyStandardPragmas(db, spec.pragmas ?? { dataDir: dir });
  spec.init?.(db);
  return db;
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
    db.close();
  }
}
