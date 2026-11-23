// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one way health reads `index.db`: read-only, closed after the read, and a failed read on a damaged file says so. A read that fails
 * while a first build holds the rebuild lock reports `building` (the partial index is expected), not an error.
 */

import { toErrorMessage } from "../../core/common";
import { getDbPath } from "../../core/paths";
import { heldRebuildLock } from "../../indexer/index-rebuild-lock";
import {
  closeDatabase,
  indexDbIsDamaged,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";

type IndexDb = NonNullable<ReturnType<typeof openReadonlyExistingDatabase>>;

type HealthIndexRead<T> = { value: T } | { noIndex: true } | { building: true } | { error: string };

export function readHealthIndex<T>(
  read: (db: IndexDb) => T,
  options?: { dbPath?: string; busyTimeoutMs?: number },
): HealthIndexRead<T> {
  let dbPath: string;
  try {
    dbPath = options?.dbPath ?? getDbPath();
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
  try {
    const db = openReadonlyExistingDatabase(dbPath, options);
    if (!db) return { noIndex: true };
    try {
      return { value: read(db) };
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    if (heldRebuildLock()) return { building: true };
    // The integrity check costs a pass over the file, so only a read that has failed pays for it.
    return { error: indexDbIsDamaged(dbPath) ? "index.db is damaged" : toErrorMessage(error) };
  }
}
