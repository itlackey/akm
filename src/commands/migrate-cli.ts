// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, EXIT_CODES, outputWithExitCode } from "../cli/shared";
import { stderr } from "../core/stdio";
import { runMigrationTool } from "./migration-tool";

export type RunMigrationTool = typeof runMigrationTool;

/**
 * `akm migrate` is a thin wrapper over the standalone `akm-migrate`
 * executable, which owns every migration step (`scripts/akm-migrate/`). This module only spawns it, re-emits its one JSON
 * plan through the normal output pipeline so `--format` applies, and mirrors
 * its exit code. `akm upgrade` calls the same executable after an install.
 * Passed the runner as a parameter so a test can hand it a stand-in.
 */
export async function runMigrateSubcommand(
  command: "migrate-status" | "migrate-apply",
  args: readonly string[],
  runTool: RunMigrationTool = runMigrationTool,
): Promise<void> {
  const result = await runTool(args);
  if (result.stderr) stderr().write(result.stderr);
  const line = result.stdout.trim();
  let plan: Record<string, unknown> | undefined;
  try {
    plan = line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  } catch {
    plan = undefined;
  }
  if (plan) {
    outputWithExitCode(command, plan, result.status);
    return;
  }
  if (line) console.log(line);
  if (result.status !== EXIT_CODES.SUCCESS) process.exitCode = result.status;
}

export const migrateCommand = defineGroupCommand({
  meta: {
    name: "migrate",
    description:
      "Inspect or apply pending migrations: config.json, state.db, asset keys and refs, the OS scheduler entry, and named task and workflow files to version 5",
  },
  subCommands: {
    status: defineJsonCommand({
      meta: {
        name: "status",
        description:
          "Read-only check of every pending migration; for task and workflow files named after it, what apply would convert to version 5",
      },
      args: {
        files: {
          type: "positional",
          required: false,
          description: "Task files or workflow files (workflows/<name>.md) to check for conversion to version 5",
        },
        "read-only": {
          type: "boolean",
          default: false,
          description: "Records no CLI usage, so the invocation writes nothing at all",
        },
      },
      run({ args }) {
        return runMigrateSubcommand("migrate-status", ["status", ...args._.map(String)]);
      },
    }),
    apply: defineJsonCommand({
      meta: {
        name: "apply",
        description:
          "Back up and apply every pending migration (`akm upgrade` runs this after an install); task files named after it are converted to version 5, and a workflow file named after it (workflows/<name>.md) becomes a new task file",
      },
      args: {
        files: {
          type: "positional",
          required: false,
          description: "Task files or workflow files (workflows/<name>.md) to convert to version 5",
        },
      },
      run({ args }) {
        return runMigrateSubcommand("migrate-apply", ["apply", ...args._.map(String)]);
      },
    }),
  },
  // No `defaultRun`: bare `akm migrate` is a usage error (exit 2), the
  // canonical bare-group behavior shared with every other group.
});
