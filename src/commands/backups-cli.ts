// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { confirmDestructive } from "../cli/confirm";
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { UsageError } from "../core/errors";
import { getDataDir } from "../core/paths";
import { stderr } from "../core/stdio";
import { DURATION_UNITS, parseDuration } from "../core/time";
import { sizeOfPath } from "./health/data-dir-usage";

export const DEFAULT_BACKUP_AGE = "30d";

export interface BackupFolderPrune {
  /** The folder under `backups/` (`tasks`, `asset-engine-keys`, ...). */
  folder: string;
  /** Entries removed, or that would be under `dryRun`. */
  count: number;
  bytes: number;
  /** Entries left in the folder, the newest among them. */
  kept: number;
}

export interface BackupsPruneResult {
  dryRun: boolean;
  olderThan: string;
  /** Entries modified before this moment were eligible. */
  cutoff: string;
  count: number;
  bytes: number;
  folders: BackupFolderPrune[];
}

/**
 * Remove the entries of each folder under `<dataDir>/backups/` last modified before `now - olderThanMs`, except the
 * newest entry of each folder. Backups are only ever written (`akm migrate apply` and `akm upgrade` copy a file in
 * before they rewrite it); nothing reads an old one back, so the newest stays as the latest rollback point.
 */
export function pruneBackups(options: {
  dataDir: string;
  olderThan?: string;
  dryRun?: boolean;
  now?: number;
}): BackupsPruneResult {
  const olderThan = options.olderThan ?? DEFAULT_BACKUP_AGE;
  const age = parseDuration(olderThan, DURATION_UNITS);
  if (age === null) {
    throw new UsageError(
      `Invalid --older-than "${olderThan}". Use a duration like 30d, 12h, or 3M.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const dryRun = options.dryRun === true;
  const cutoff = (options.now ?? Date.now()) - age;
  const root = path.join(options.dataDir, "backups");
  const folders: BackupFolderPrune[] = [];
  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    // No backups directory yet: nothing to prune.
  }
  for (const { name: folder } of top.sort((a, b) => a.name.localeCompare(b.name))) {
    const entries = fs
      .readdirSync(path.join(root, folder))
      .map((name) => ({ name, mtime: fs.lstatSync(path.join(root, folder, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    const old = entries.slice(0, -1).filter((entry) => entry.mtime < cutoff);
    let bytes = 0;
    for (const { name } of old) {
      const target = path.join(root, folder, name);
      bytes += sizeOfPath(target, { remaining: Number.POSITIVE_INFINITY }).bytes;
      if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    }
    if (old.length) folders.push({ folder, count: old.length, bytes, kept: entries.length - old.length });
  }
  return {
    dryRun,
    olderThan,
    cutoff: new Date(cutoff).toISOString(),
    count: folders.reduce((sum, f) => sum + f.count, 0),
    bytes: folders.reduce((sum, f) => sum + f.bytes, 0),
    folders,
  };
}

const backupsPruneCommand = defineJsonCommand({
  meta: {
    name: "prune",
    description:
      "Remove old backups under the data directory's backups/ folder, the copies `akm migrate apply` makes before it " +
      "rewrites files. Removes entries older than --older-than (default 30d) and always keeps the newest entry of " +
      "each folder, so the latest rollback point survives. --dry-run reports what would be removed. Reports the " +
      "count and bytes per folder.",
  },
  args: {
    "older-than": {
      type: "string",
      description: `Remove backups older than this duration, such as 30d, 12h or 3M (default ${DEFAULT_BACKUP_AGE})`,
    },
    "dry-run": { type: "boolean", description: "Report what would be removed without removing it", default: false },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip the confirmation prompt (required in non-interactive mode)",
      default: false,
    },
  },
  async run({ args }) {
    const options = {
      dataDir: getDataDir(),
      ...(typeof args["older-than"] === "string" ? { olderThan: args["older-than"] } : {}),
    };
    // The preview also validates --older-than before anything is asked or removed.
    const preview = pruneBackups({ ...options, dryRun: true });
    if (args["dry-run"] === true || preview.count === 0) {
      output("backups-prune", { ...preview, dryRun: args["dry-run"] === true });
      return;
    }
    const confirmed = await confirmDestructive(
      `Remove ${preview.count} backups older than ${preview.olderThan} from ${path.join(options.dataDir, "backups")}? This cannot be undone.`,
      { yes: args.yes === true },
    );
    if (!confirmed) {
      stderr().write("Aborted.\n");
      return;
    }
    output("backups-prune", pruneBackups(options));
  },
});

export const backupsCommand = defineGroupCommand({
  meta: { name: "backups", description: "Manage the backups akm keeps in its data directory" },
  subCommands: { prune: backupsPruneCommand },
});
