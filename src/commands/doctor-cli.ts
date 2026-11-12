// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm doctor scheduler sync` and `akm doctor explain <ref>`: the replacements
 * for `task sync` and `task explain`/`workflow plan`. Each routes
 * to the existing handler, so its output and exit codes are the old command's.
 */

import { defineGroupCommand, defineJsonCommand } from "../cli/shared";
import { runTaskExplain, runTaskSync, taskSyncArgs } from "./tasks/tasks-cli";
import { runWorkflowPlan } from "./workflow-cli";

const schedulerSyncCommand = defineJsonCommand({
  meta: {
    name: "sync",
    description:
      "Install, update or remove the one OS scheduler entry that runs `akm task dispatch` every minute (as `task sync`)",
  },
  args: taskSyncArgs,
  async run({ args }) {
    await runTaskSync(args);
  },
});

export const doctorSchedulerCommand = defineGroupCommand({
  meta: { name: "scheduler", description: "Maintain the OS scheduler entries for scheduled tasks" },
  subCommands: { sync: schedulerSyncCommand },
});

/** A workflow ref names `workflows/<name>`, optionally behind `<bundle>//`; every other ref is a task. */
function isWorkflowRef(ref: string): boolean {
  const separator = ref.indexOf("//");
  return (separator < 0 ? ref : ref.slice(separator + 2)).trim().startsWith("workflows/");
}

export const doctorExplainCommand = defineJsonCommand({
  meta: {
    name: "explain",
    description:
      "Print what a task (as `task explain`) or workflow (as `workflow plan`, ref `workflows/<name>`) would " +
      "run, with provenance — read-only and secret-free; never executes anything",
  },
  args: {
    ref: { type: "positional", description: "Task ref or id, or workflow ref (workflows/<name>)", required: true },
    bundle: {
      type: "string",
      description: "Bundle to operate on (defaults to the primary/default bundle); tasks only",
    },
  },
  async run({ args, rawArgs }) {
    if (isWorkflowRef(args.ref)) await runWorkflowPlan(args.ref);
    else await runTaskExplain(args, rawArgs);
  },
});
