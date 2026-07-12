// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { UsageError } from "../core/errors";
import { createMigrationBackup, MIGRATION_BACKUP_VERSION, restoreMigrationBackup } from "../core/migration-backup";

function requireVersion(value: string): void {
  if (value !== MIGRATION_BACKUP_VERSION) {
    throw new UsageError(
      `Unsupported migration backup target ${JSON.stringify(value)}; expected ${MIGRATION_BACKUP_VERSION}.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

export const backupCommand = defineGroupCommand({
  meta: { name: "backup", description: "Create or restore a verified migration recovery run" },
  subCommands: {
    create: defineJsonCommand({
      meta: { name: "create", description: "Create a unique installation-scoped migration recovery run" },
      args: {
        for: { type: "string", required: true, description: "Migration target version (0.9.0)" },
      },
      run({ args }) {
        requireVersion(args.for);
        const result = createMigrationBackup();
        output("backup", {
          action: "create",
          for: MIGRATION_BACKUP_VERSION,
          path: result.path,
          created: result.created,
          manifest: result.manifest,
        });
      },
    }),
    restore: defineJsonCommand({
      meta: { name: "restore", description: "Restore a recovery run after preserving a rescue snapshot" },
      args: {
        for: { type: "string", required: true, description: "Migration target version (0.9.0)" },
        run: { type: "string", description: "Backup run ID (defaults to the newest applicable run)" },
        confirm: { type: "boolean", default: false, description: "Confirm destructive restoration" },
      },
      run({ args }) {
        requireVersion(args.for);
        const result = restoreMigrationBackup(args.confirm, args.run);
        output("backup", {
          action: "restore",
          for: MIGRATION_BACKUP_VERSION,
          path: result.path,
          restored: true,
          rescuePath: result.rescuePath,
          manifest: result.manifest,
        });
      },
    }),
  },
  defaultRun() {
    throw new UsageError("Choose `backup create` or `backup restore`.", "MISSING_REQUIRED_ARGUMENT");
  },
});
