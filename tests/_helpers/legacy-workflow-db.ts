// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test helper: construct a PRE-CUTOVER workflow.db at its final ledger (010) the
 * way the runtime used to (base schema + the workflow migration chain).
 *
 * Chunk-8 WI-8.3 deleted `src/workflows/db.ts` (`openWorkflowDatabase` / the live
 * `WORKFLOW_MIGRATIONS`). Migration/backup/cutover suites that still need a
 * faithful pre-cutover workflow.db source it here from the FROZEN migration
 * bodies (`src/migrate/legacy/workflow-migrations-bodies.ts`) through the shared
 * engine — exactly as `config-migrate.ts#runFrozenWorkflowRoll` does at
 * migrate-apply time. This keeps pre-cutover coverage alive (§15.3: extend, do
 * not rewrite) without resurrecting the deleted module.
 */

import path from "node:path";
import {
  FROZEN_WORKFLOW_BASE_SCHEMA_DDL,
  FROZEN_WORKFLOW_MIGRATIONS,
} from "../../src/migrate/legacy/workflow-migrations-bodies";
import { type Database, openDatabase } from "../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../src/storage/engines/sqlite-migrations";
import { applyStandardPragmas } from "../../src/storage/sqlite-pragmas";

/**
 * Open (creating if absent) a pre-cutover workflow.db at `dbPath`, roll it to the
 * final frozen ledger, and return the OPEN handle. Caller closes.
 */
export function openLegacyWorkflowDb(dbPath: string): Database {
  const db = openDatabase(dbPath);
  applyStandardPragmas(db, { dataDir: path.dirname(dbPath) });
  db.exec(FROZEN_WORKFLOW_BASE_SCHEMA_DDL);
  runSqliteMigrations(db, FROZEN_WORKFLOW_MIGRATIONS);
  return db;
}

/** Create a pre-cutover workflow.db at `dbPath` (schema only, no rows) and close. */
export function createLegacyWorkflowDb(dbPath: string): void {
  openLegacyWorkflowDb(dbPath).close();
}
