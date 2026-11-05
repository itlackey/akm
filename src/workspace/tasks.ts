// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The default bundle's scheduled tasks, and the actions that enable or disable one on this host. */

import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { listSetupTaskDefinitions } from "../setup/steps/tasks";
import { runCli } from "./cli-child";

/** The tasks the default bundle holds that have a schedule, and whether this host has enabled each. Nothing is written. */
export function list() {
  if (!loadConfig().defaultBundle) return { tasks: [] as ReturnType<typeof listSetupTaskDefinitions> };
  return { tasks: listSetupTaskDefinitions() };
}

/** The arguments that name a task in the default bundle, the one `list` reads. */
function target(input: { task: string }) {
  if (typeof input?.task !== "string" || !input.task.trim()) throw new UsageError("task must name a task.");
  const bundle = loadConfig().defaultBundle;
  if (!bundle) throw new UsageError("There is no default bundle yet.");
  return [`--bundle=${bundle}`, "--", input.task.trim()];
}

/** `akm task enable`: schedule it in this host's scheduler and sync that. */
export async function enable(input: { task: string }) {
  return runCli(["task", "enable", ...target(input)]);
}

/** `akm task disable`: take it out of this host's scheduler and sync that. */
export async function disable(input: { task: string }) {
  return runCli(["task", "disable", ...target(input)]);
}
