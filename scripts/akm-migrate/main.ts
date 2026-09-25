// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-migrate` command surface, importable without side effects.
 * `scripts/akm-migrate.ts` is the executable shim around it, and the compiled
 * standalone binary (`scripts/akm-standalone.ts`) dispatches here directly:
 * importing the shim from inside a single-file bundle trips its "am I the
 * entry module" guard, and the plan is printed -- and apply run -- twice.
 */

import { EXIT_CODES } from "../../src/cli/shared";
import { UsageError } from "../../src/core/errors";
import helpText from "./help.txt" with { type: "text" };
import { type CombinedMigrationPlan, runMigration } from "./run-migrate";

function printPlan(plan: CombinedMigrationPlan): void {
  console.log(JSON.stringify(plan));
  // C3: `runMigration` no longer throws for one step's own anomaly — it
  // records the step in `plan.failedSteps` and folds `status` to "blocked"
  // instead, so a poisoned step already lands here as an ordinary blocked
  // plan (GENERAL/1) rather than an uncaught throw reaching
  // `runWithJsonErrors` and exiting INTERNAL(70) with no plan printed.
  if (plan.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      console.log(helpText.trimEnd());
      return;
    case "status": {
      const unknown = rest.find((arg) => arg !== "--host-local");
      if (unknown !== undefined) throw new UsageError(`\`status\` does not accept ${unknown}.`, "INVALID_FLAG_VALUE");
      printPlan(await runMigration({ apply: false, hostLocal: rest.includes("--host-local") }));
      return;
    }
    case "apply": {
      const unknown = rest.find((arg) => arg !== "--dry-run" && arg !== "--host-local");
      if (unknown !== undefined) throw new UsageError(`\`apply\` does not accept ${unknown}.`, "INVALID_FLAG_VALUE");
      printPlan(await runMigration({ apply: !rest.includes("--dry-run"), hostLocal: rest.includes("--host-local") }));
      return;
    }
    default:
      throw new UsageError("Choose `status` or `apply [--dry-run]`.", "MISSING_REQUIRED_ARGUMENT");
  }
}
