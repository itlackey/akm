// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { getConfigPath, getDataDir } from "./paths";

let afterPendingCheckHook: (() => void) | undefined;

/** TEST-ONLY: run once after a clear pending-operation check. */
export function _setAfterPendingOperationCheckHookForTests(hook?: () => void): void {
  afterPendingCheckHook = hook;
}

function installationId(): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(path.dirname(getConfigPath())))
    .update("\0")
    .update(path.resolve(getDataDir()))
    .digest("hex")
    .slice(0, 24);
}

export function getMigrationOperationRoot(): string {
  return path.join(getDataDir(), "backups", "migrations", installationId());
}

export function getMigrationRestoreJournalPath(): string {
  return path.join(getMigrationOperationRoot(), "restore-active.json");
}

export function getMigrationApplyJournalPath(): string {
  return path.join(getMigrationOperationRoot(), "apply-active.json");
}

export function assertNoPendingMigrationOperation(): void {
  for (const [kind, journalPath] of [
    ["restore", getMigrationRestoreJournalPath()],
    ["migration apply", getMigrationApplyJournalPath()],
  ] as const) {
    if (fs.existsSync(journalPath)) {
      throw new ConfigError(
        `AKM ${kind} recovery is pending at ${journalPath}; refusing canonical config/database access until recovery completes.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  const hook = afterPendingCheckHook;
  afterPendingCheckHook = undefined;
  hook?.();
}
