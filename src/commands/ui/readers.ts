// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Readers shared by the UI's routes: the read-only state database, the stash directory, and per-section isolation. */

import fs from "node:fs";
import { resolveStashDir } from "../../core/common";
import { getStateDbPath, listPendingStateMigrations } from "../../core/state-db";
import { type Database, openDatabase } from "../../storage/database";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";

/**
 * Run `fn` against `state.db` opened read-only, or return `fallback` when it
 * does not exist or is behind on migrations (a read-only open must not apply
 * them; `akm health` reports that state). The handle is closed before returning,
 * so no request holds a lock past its own read.
 */
export function withReadonlyStateDb<T>(fn: (db: Database) => T, fallback: T): T {
  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath) || listPendingStateMigrations(dbPath).length > 0) return fallback;
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    applyReadonlyPragmas(db);
    return fn(db);
  } finally {
    db.close();
  }
}

export function tryStashDir(): string | null {
  try {
    return resolveStashDir();
  } catch {
    return null;
  }
}

/** Run each section of a composite response on its own: one failing store degrades one section, not the page. */
export async function section<T>(
  errors: Record<string, string>,
  name: string,
  fn: () => T | Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : String(error);
    return null;
  }
}
