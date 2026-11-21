// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one way health reads `index.db`: read-only, refusing a damaged file, closed after the read. A read that fails
 * while a first build holds the rebuild lock reports `building` (the partial index is expected), not an error.
 */

import { getDbPath } from "../../core/paths";
import { heldRebuildLock } from "../../indexer/index-rebuild-lock";
import {
  closeDatabase,
  indexDbIsDamaged,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";

type IndexDb = NonNullable<ReturnType<typeof openReadonlyExistingDatabase>>;

type HealthIndexRead<T> = { value: T } | { noIndex: true } | { building: true } | { error: string };

export function readHealthIndex<T>(read: (db: IndexDb) => T): HealthIndexRead<T> {
  try {
    if (indexDbIsDamaged()) throw new Error("index.db is damaged");
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { noIndex: true };
    try {
      return { value: read(db) };
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    if (heldRebuildLock()) return { building: true };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
