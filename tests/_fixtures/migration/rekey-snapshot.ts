// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7b -- reads a full row dump of the 4 ref-keyed state.db tables the
 * re-key merge harness covers (`asset_salience`, `asset_outcome`, `events`,
 * `proposals`; see `rekey-generator.ts`'s module doc comment for the full
 * table census). Used both by `rekey-invariants.ts` (before/after snapshots)
 * and directly by the smoke test (generator-determinism proof).
 *
 * Opens via `openStateDatabase` -- the real migration runner, same as every
 * other WI-0b.6/0b.7 fixture builder -- rather than the raw driver, so a
 * snapshot of an ALREADY-migrated db is itself proof the schema is current
 * (mirrors `migration-fixtures.test.ts`'s own `currentMigrationCeiling`
 * pattern).
 */

import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import type { RawRow, RekeySnapshot } from "./rekey-model";

/** Read every row of the 4 covered tables from the state.db at `dbPath`, ordered for stable comparison. */
export function snapshotRekeyState(dbPath: string): RekeySnapshot {
  const db = openStateDatabase(dbPath);
  try {
    return {
      assetSalience: db.prepare("SELECT * FROM asset_salience ORDER BY asset_ref").all() as RawRow[],
      assetOutcome: db.prepare("SELECT * FROM asset_outcome ORDER BY asset_ref").all() as RawRow[],
      events: db.prepare("SELECT * FROM events ORDER BY ref, id").all() as RawRow[],
      proposals: db.prepare("SELECT * FROM proposals ORDER BY ref, id").all() as RawRow[],
    };
  } finally {
    db.close();
  }
}

/**
 * Copy a (closed) state.db file to `destPath`, including its WAL/SHM
 * sidecars if still present (defensive -- `openStateDatabase`'s WAL journal
 * mode normally checkpoints into the main file on the last connection's
 * `close()`, but this tolerates a driver that leaves sidecars behind, same
 * spirit as `migration-fixtures.test.ts`'s WAL-sidecar tolerance comment).
 * Callers MUST close every handle on `srcPath` before calling this.
 */
export function copyStateDb(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const src = `${srcPath}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${destPath}${suffix}`);
  }
}
