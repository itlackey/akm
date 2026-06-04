// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI command surface for `akm db ...`.
 *
 * MVP scope: only `akm db backups` is exposed. It lists the pre-upgrade
 * snapshots written by `backupDataDir()` under `<dataDir>/backups/`.
 *
 * Restoration is intentionally NOT a CLI subcommand for MVP — operators are
 * expected to stop akm and use `scripts/migrations/restore-data-dir.sh` (or a
 * plain `mv`/`cp`) to recover. Keeping the surface narrow lets us evolve the
 * backup format under the hood without locking in an API.
 */

import { getDataDir } from "../core/paths";
import { listBackups } from "../indexer/db-backup";

export interface AkmDbBackupsResult {
  /** Absolute path to the data directory inspected. */
  dataDir: string;
  /** Newest first. Empty when no backups exist (no error). */
  backups: Array<{
    path: string;
    name: string;
    createdAt: string;
    sizeBytes: number;
    sourceVersion: number | null;
  }>;
}

export function akmDbBackups(): AkmDbBackupsResult {
  const dataDir = getDataDir();
  return {
    dataDir,
    backups: listBackups(dataDir),
  };
}
