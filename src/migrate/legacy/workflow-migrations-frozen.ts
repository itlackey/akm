// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * FROZEN copy of the `WORKFLOW_MIGRATIONS` ledger IDENTITY — the 10
 * `{ id, checksum }` pairs of the pre-cutover workflow.db schema ledger
 * (`src/workflows/db.ts` `WORKFLOW_MIGRATIONS`, 001-add-scope-key …
 * 010-ir-v3-engine). akm 0.9.0 chunk-8, WI-8.1 (plan §3.3 item 1 / §3.4 /
 * §8.2; `docs/design/execution/chunk-8/brief.md`).
 *
 * ## Why this frozen copy exists
 *
 * The three-DB cutover (WI-8.2) merges workflow.db into state.db and then
 * (WI-8.3) DELETES `src/workflows/db.ts` outright, taking the live
 * `WORKFLOW_MIGRATIONS` array with it. But pre-cutover backups
 * (`src/core/migration-backup.ts`) captured a physical `workflow.db` and
 * recorded its ledger status, and plan §3.3 item 1 requires that those
 * pre-cutover backups remain VERIFIABLE and RESTORABLE by the post-cutover
 * binary. Backup verification classifies a SQLite ledger by walking
 * `schema_migrations` and comparing each row's sealed checksum against the
 * expected release checksum. Once the live array is gone the post-cutover
 * binary has no other source for those expected checksums — so they live
 * here, frozen, until the pre-cutover-backup support window closes (0.10.0).
 *
 * ## Why a copy of IDs + CHECKSUMS, not the migration bodies
 *
 * The engine's checksum is `sha256(id + "\0" + up)` (`migrationChecksum()` in
 * `src/storage/engines/sqlite-migrations.ts`). Freezing the pre-computed
 * checksum literals — rather than re-copying the 10 `up` DDL bodies — keeps
 * this module tiny and, crucially, means it imports NOTHING from
 * `src/workflows/`, so it survives that directory's deletion in WI-8.3. The
 * literals below were computed once from the live array via `migrationChecksum`
 * and inlined; `tests/migrate/legacy/workflow-migrations-frozen.test.ts` pins
 * them to the live array's computed checksums so any drift while the live
 * module still exists fails CI.
 *
 * The only `src/` import here is the shared-engine `SealedMigration` TYPE (not
 * `src/workflows/`), which is part of the migration engine preserved through
 * the cutover (plan §8.3).
 */

import type { SealedMigration } from "../../storage/engines/sqlite-migrations";

/**
 * Frozen `{ id, checksum }` snapshot of `WORKFLOW_MIGRATIONS` at the akm 0.9.0
 * pre-cutover HEAD. Order is significant — it is the exact ordered ledger
 * prefix that `inspectSealedMigrationLedger` asserts against a backed-up
 * `workflow.db`.
 */
export const WORKFLOW_MIGRATIONS_CHECKSUMS: readonly SealedMigration[] = [
  { id: "001-add-scope-key", checksum: "1147ac9875ab87fcef446ffc24f405e65d0230ab041aa160a997746f9a63fa38" },
  { id: "002-add-agent-identity", checksum: "4fd912886ee0a54e0eb19f019bbe44e0da9344193a7ad9984d4182f74bd823c1" },
  { id: "003-checkin-and-step-summary", checksum: "dff0184eb8f8cb5e104ea311f4816b263b96679d13d7117e0b66eab589f2f51b" },
  { id: "004-workflow-run-units", checksum: "5b58d50274a557bf6bffdff3cfc622ed7c90b1383d44d183af3d50a30cd4970b" },
  { id: "005-unit-session-id", checksum: "ddd01c2788f3c5fd2829fcb9349285f47f9f7245efe9382fe3819020bca823e9" },
  { id: "006-frozen-plan-and-lease", checksum: "6df7a0079a718a9a46b88533e5f2e00baa5d9f55a0540a5ed0680c422a915eed" },
  { id: "007-unit-last-checkin", checksum: "a839af5677548f5cb37f9ff39218aecb639e9278909386568f3f7fb4add641dc" },
  { id: "008-unit-attempts", checksum: "a125dd744dd4eb3f5251a2e713dfdc257c4d5950b025563a8d6ea1d290da2b45" },
  { id: "009-unit-claim", checksum: "885e2c28fca0e98e51e45e7e26d1598a6ff1a2e873a17bf6184b3dd4b6d5613c" },
  { id: "010-ir-v3-engine", checksum: "89bd2d741b3961bebcfcf6fafc826033001954be9125585911787cff2bb8a34c" },
];
