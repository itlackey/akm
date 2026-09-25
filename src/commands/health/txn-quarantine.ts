// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `txn-quarantine` advisory for `akm health`.
 *
 * A poisoned transaction journal `akm migrate apply` cannot recover (a fence
 * violation or a `rollback`/`finalize` throw) is quarantined rather than
 * bricking recovery — moved to `$DATA/txn-quarantine/<rootNs>/<id>/` with a
 * `reason.json` beside it (see `src/core/fs-txn.ts`'s
 * `recoverTxnsForRoot`/`QuarantinedTxn`). Quarantine is silent by design
 * (`akm migrate apply` still reports `current`); this advisory is what
 * surfaces a non-empty quarantine dir to an operator who isn't reading
 * migrate's own output.
 *
 * Best-effort and read-only, matching the data-dir-usage/stash-exposure
 * house pattern: `undefined` whenever the quarantine dir is missing or
 * empty — this is not a "always show a pass line" check.
 */

import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult } from "./types";

/**
 * Build the `txn-quarantine` advisory, or `undefined` when `$DATA/txn-quarantine`
 * is missing/unreadable/empty. `dataDir` is the caller-resolved `getDataDir()`
 * path — this module never resolves paths or reads env itself.
 */
export function collectTxnQuarantineAdvisory(dataDir: string): HealthCheckResult | undefined {
  const quarantineDir = path.join(dataDir, "txn-quarantine");
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(quarantineDir, { withFileTypes: true });
  } catch {
    return undefined; // no quarantine dir yet — nothing to report.
  }

  let count = 0;
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    try {
      count += fs
        .readdirSync(path.join(quarantineDir, ns.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
    } catch {
      // Unreadable namespace dir — best-effort, skip it.
    }
  }
  if (count === 0) return undefined;

  return {
    name: "txn-quarantine",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${count} transaction journal(s) quarantined at ${quarantineDir}. ` +
      "Each journal's reason.json names why; nothing was deleted.",
    evidence: { quarantineDir, count },
  };
}
