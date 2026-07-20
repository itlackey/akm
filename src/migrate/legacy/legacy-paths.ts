// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * Legacy on-disk path helpers for the three-DB cutover. akm 0.9.0 chunk-8,
 * WI-8.3.
 *
 * The runtime `getWorkflowDbPath` core helper is DELETED in WI-8.3 (the runtime
 * no longer opens workflow.db — its durable rows live in state.db post-cutover).
 * But the migrator home (`src/migrate/legacy/`), the backup/restore machinery
 * (`src/core/migration-backup.ts` — backup artifacts + the pre-cutover ledger
 * probe) and config-migrate.ts's backward-looking arms still need the physical
 * `<dataDir>/workflow.db` path literal to FIND, roll, merge, back up, and delete
 * a pre-cutover workflow.db. This module is that path literal's only surviving
 * home in live code, quarantined under the migrator directory so the deleted
 * core helper cannot re-appear under another name in live core.
 */

import path from "node:path";
import { getDataDir } from "../../core/paths";

/** Physical path of a pre-cutover workflow.db (`<dataDir>/workflow.db`). */
export function getLegacyWorkflowDbPath(): string {
  return path.join(getDataDir(), "workflow.db");
}
