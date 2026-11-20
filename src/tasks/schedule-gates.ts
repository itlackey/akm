// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The two per-source schedule gates `akm task sync` runs before it installs a
 * schedule, kept in a leaf module so `akm lint` can run them without importing
 * the scheduler's task-preparation graph (which reaches the adapter registry
 * that lint itself is part of).
 */

import { UsageError } from "../core/errors";
import type { InputContract } from "../execution/input-contract";
import { applyInputDefaults, validateInputs } from "../execution/input-contract";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import type { TaskSourceV4ScheduleBinding } from "./source/task-source-v4";

/** What the two gates read of a task source, whichever version it is. */
export interface TaskScheduleSource {
  readonly inputs?: InputContract;
  readonly schedule: readonly TaskSourceV4ScheduleBinding[];
}

/**
 * Validate every `schedule:` entry's `inputs` against the task's own
 * declared contract with defaults applied — the exact set of values a
 * compiled invocation delivers — so a violation is reported at sync rather
 * than when the scheduler fires. Shared with `akm lint`.
 */
export function assertTaskScheduleInputsSatisfyContract(source: TaskScheduleSource, refLabel: string): void {
  const contract = source.inputs ?? {};
  for (const scheduleEntry of source.schedule) {
    const defaultedInputs = applyInputDefaults(contract, { ...scheduleEntry.inputs });
    const errors = validateInputs(contract, defaultedInputs);
    if (errors.length > 0) {
      throw new UsageError(
        `Task ${JSON.stringify(refLabel)} schedule[${scheduleEntry.ordinal}].inputs does not satisfy ` +
          `its declared inputs once defaults are applied: ${errors.join("; ")}`,
        "TASK_SOURCE_INVALID",
      );
    }
  }
}

/**
 * Validate every `schedule:` entry's `cron` against the active backend's
 * dialect: cron is the most permissive of the three, so a task authored on
 * Linux can carry an expression launchd/schtasks cannot translate. Shared
 * with `akm lint`.
 */
export function assertTaskScheduleCronValid(
  source: Pick<TaskScheduleSource, "schedule">,
  backend: ScheduleBackend,
): void {
  for (const scheduleEntry of source.schedule) parseSchedule(scheduleEntry.cron, backend);
}
