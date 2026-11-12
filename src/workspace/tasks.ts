// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The default bundle's scheduled tasks, and the actions that enable or disable one on this host. */

import { akmTasksDisable, akmTasksEnable } from "../commands/tasks/tasks";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { listSetupTaskDefinitions } from "../setup/steps/tasks";
import { type HostCli, runCli } from "./cli-child";
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
 * Run a task action on the host's `akm` when Desktop has one, so the OS entry it writes names that install; the bundled
 * engine writes none. Without one, or when it fails or answers in another shape (an older akm), the action runs here:
 * the change is saved and the result says what the scheduler did not get.
 */
export async function viaHost(
  host: HostCli | undefined,
  args: string[],
  shape: string,
  here: () => Promise<object>,
): Promise<Record<string, unknown>> {
  if (host) {
    try {
      return await runCli(args, shape, host);
    } catch (error) {
      const result = redactForUi(await here()) as Record<string, unknown>;
      const reason = (error as Error).message.replace(/\.$/, "");
      const note = `The akm at ${host.path} could not run this (${reason}), so the OS scheduler was not updated. Run \`akm doctor scheduler sync\` there.`;
      return { ...result, warnings: [...((result.warnings as string[] | undefined) ?? []), note] };
    }
  }
  return redactForUi(await here()) as Record<string, unknown>;
}

/** `akm task enable`: the task joins this host's `scheduler.enabled`, and the OS entry that runs it is installed if needed. */
export async function enable(input: { task: string }, host?: HostCli) {
  const { ref, options } = target(input);
  return viaHost(host, ["task", "enable", `--bundle=${options.target}`, "--", ref], "task-enable", () =>
    akmTasksEnable(ref, options),
  );
}

/** `akm task disable`: the entry goes when no task is left enabled. */
export async function disable(input: { task: string }, host?: HostCli) {
  const { ref, options } = target(input);
  return viaHost(host, ["task", "disable", `--bundle=${options.target}`, "--", ref], "task-disable", () =>
    akmTasksDisable(ref, options),
  );
}
