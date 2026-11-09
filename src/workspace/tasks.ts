// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The default bundle's scheduled tasks, and the actions that enable or disable one on this host. */

import { akmTasksDisable, akmTasksEnable, akmTasksSync } from "../commands/tasks/tasks";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { listSetupTaskDefinitions } from "../setup/steps/tasks";
import { redactForUi } from "./redact";

/** The tasks the default bundle holds that have a schedule, and whether this host has enabled each. Nothing is written. */
export function list() {
  if (!loadConfig().defaultBundle) return { tasks: [] as ReturnType<typeof listSetupTaskDefinitions> };
  return { tasks: listSetupTaskDefinitions() };
}

/** The default bundle's name and the task the input names. */
function target(input: { task: string }) {
  if (typeof input?.task !== "string" || !input.task.trim()) throw new UsageError("task must name a task.");
  const bundle = loadConfig().defaultBundle;
  if (!bundle) throw new UsageError("There is no default bundle yet.");
  return { ref: input.task.trim(), options: { target: bundle } };
}

/**
 * `akm task enable`, then `akm task sync`: the task joins this host's `scheduler.enabled`, and the OS scheduler entry
 * that runs it (`akm task dispatch`) is installed if it is not there yet. Desktop has no terminal to run the sync from.
 */
export async function enable(input: { task: string }) {
  const { ref, options } = target(input);
  const activation = akmTasksEnable(ref, options);
  return redactForUi({ ...activation, sync: await akmTasksSync() }) as Record<string, unknown>;
}

/** `akm task disable`, then `akm task sync`: the entry goes when no task is left enabled. */
export async function disable(input: { task: string }) {
  const { ref, options } = target(input);
  const activation = akmTasksDisable(ref, options);
  return redactForUi({ ...activation, sync: await akmTasksSync() }) as Record<string, unknown>;
}
