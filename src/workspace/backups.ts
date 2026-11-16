// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The old backups akm keeps in its data directory. */

import { UsageError } from "../core/errors";
import { runCli } from "./cli-child";

/**
 * `akm backups prune`: remove backups older than `olderThan` (a duration such as `30d`; default 30d), keeping the newest
 * of each folder. `dryRun` reports what would be removed and removes nothing; a real run needs `confirm`.
 */
export async function prune(input: { olderThan?: string; dryRun?: boolean; confirm?: boolean } = {}) {
  const dryRun = input.dryRun === true;
  if (!dryRun && input.confirm !== true) throw new UsageError("Confirm removing the old backups first.");
  return runCli(
    [
      "backups",
      "prune",
      ...(dryRun ? ["--dry-run"] : ["--yes"]),
      ...(input.olderThan ? [`--older-than=${input.olderThan}`] : []),
    ],
    "backups-prune",
  );
}
