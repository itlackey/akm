// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand } from "../cli/shared";
import { UsageError } from "../core/errors";

const configArg = {
  type: "string" as const,
  description: "Complete operator-prepared current config; optional when the active config is current",
};

export const migrateCommand = defineGroupCommand({
  meta: { name: "migrate", description: "Inspect or apply config and durable database migrations" },
  subCommands: {
    status: defineJsonCommand({
      meta: { name: "status", description: "Read-only cross-artifact migration eligibility check" },
      args: { config: configArg },
      async run({ args }) {
        const { runMigrationStatus } = await import("../cli/config-migrate.js");
        await runMigrationStatus({ preparedConfigPath: args.config });
      },
    }),
    apply: defineJsonCommand({
      meta: { name: "apply", description: "Create a verified backup and atomically apply pending migrations" },
      args: {
        config: configArg,
        dryRun: { type: "boolean", default: false, description: "Run the same eligibility checks without mutation" },
      },
      async run({ args }) {
        const { runMigrationApply } = await import("../cli/config-migrate.js");
        await runMigrationApply({ preparedConfigPath: args.config, dryRun: args.dryRun });
      },
    }),
  },
  defaultRun() {
    throw new UsageError("Choose `migrate status` or `migrate apply`.", "MISSING_REQUIRED_ARGUMENT");
  },
});
