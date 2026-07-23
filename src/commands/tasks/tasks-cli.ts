// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm tasks` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.tasks` key and every subcommand's
 * args/output shape are byte-identical. Handlers whose body is a plain
 * `runWithJsonErrors(...) + output(...)` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `tasks run` keeps a plain `defineCommand` because it forwards the
 * task's own exit code via `process.exit`. The private helper
 * `makeTasksToggleCommand` and the `TASKS_SUBCOMMAND_SET` routing constant move
 * with the family.
 */

import { defineCommand } from "citty";
import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineGroupCommand, defineJsonCommand, output, runWithJsonErrors } from "../../cli/shared";
import { detectServerDefault, registerDefaultTasks } from "./default-tasks";
import {
  akmTasksAdd,
  akmTasksDoctor,
  akmTasksHistory,
  akmTasksRun,
  akmTasksSetEnabled,
  akmTasksSync,
  parseTaskRef,
} from "./tasks";

/** Shared `--target <bundle>` arg wired onto every bundle-resolving subcommand. */
const targetArg = {
  target: {
    type: "string",
    description: "Bundle to operate on (defaults to the primary/default bundle)",
  },
} as const;

const tasksAddCommand = defineJsonCommand({
  meta: { name: "add", description: "Register a new scheduled task and install it in the OS scheduler" },
  args: {
    id: { type: "positional", description: "Task id (used as filename and scheduler entry)", required: true },
    schedule: { type: "string", description: 'Cron-style schedule, e.g. "0 9 * * *" or "@daily"', required: true },
    ...targetArg,
    workflow: { type: "string", description: "Workflow ref to invoke (e.g. workflows/my-flow)" },
    prompt: {
      type: "string",
      description: "Prompt for the configured agent harness — inline text, an asset ref like agent:foo, or ./path.md",
    },
    command: {
      type: "string",
      description:
        'Shell command to run on the schedule (no AI agent), e.g. "akm improve --strategy frequent". Split on whitespace; quote the whole flag value.',
    },
    engine: { type: "string", description: "Engine to use for prompt targets (default: defaults.engine)" },
    model: { type: "string", description: "Model override for prompt targets" },
    "timeout-ms": { type: "string", description: "Positive timeout in milliseconds for prompt or command targets" },
    params: { type: "string", description: "Workflow params as a JSON object" },
    name: { type: "string", description: "Human-readable name for the task" },
    "when-to-use": { type: "string", description: "Guidance on when this task runs or should be used" },
    description: { type: "string", description: "Human-readable description" },
    tags: { type: "string", description: "Comma-separated tags" },
    disabled: { type: "boolean", description: "Register but leave disabled in the OS scheduler", default: false },
    force: { type: "boolean", description: "Overwrite an existing task with the same id", default: false },
  },
  async run({ args }) {
    const result = await akmTasksAdd({
      id: args.id,
      schedule: args.schedule,
      target: args.target,
      workflow: args.workflow,
      prompt: args.prompt,
      command: args.command,
      engine: args.engine,
      model: args.model,
      timeoutMs: args["timeout-ms"] === undefined ? undefined : parsePositiveIntFlag(args["timeout-ms"]),
      params: args.params,
      name: args.name,
      when_to_use: args["when-to-use"],
      description: args.description,
      tags: args.tags
        ? args.tags
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      disabled: args.disabled === true,
      force: args.force === true,
    });
    output("tasks-add", result);
  },
});

const tasksInitCommand = defineJsonCommand({
  meta: {
    name: "init",
    description: "Idempotently register the default improve task set (skips when CI=true)",
  },
  args: {
    server: {
      type: "boolean",
      description: "Treat this as a server install (enables the nightly sweep). Defaults to platform detection.",
    },
    laptop: {
      type: "boolean",
      description: "Treat this as a laptop install (leaves the nightly sweep disabled).",
    },
  },
  async run({ args }) {
    const serverInstall = args.server === true ? true : args.laptop === true ? false : detectServerDefault();
    const result = await registerDefaultTasks({ serverInstall });
    output("tasks-init", result);
  },
});

function makeTasksToggleCommand(enabled: boolean) {
  const verb = enabled ? "enable" : "disable";
  const description = enabled
    ? "Enable a previously-disabled task"
    : "Disable a task in the OS scheduler without removing the file";
  return defineJsonCommand({
    meta: { name: verb, description },
    args: { id: { type: "positional", description: "Task id", required: true }, ...targetArg },
    async run({ args }) {
      const { id } = parseTaskRef(args.id);
      const result = await akmTasksSetEnabled(id, enabled, {}, args.target);
      output(`tasks-${verb}`, result);
    },
  });
}

const tasksEnableCommand = makeTasksToggleCommand(true);
const tasksDisableCommand = makeTasksToggleCommand(false);

const tasksRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Execute a task now (this is what cron / launchd / schtasks invoke at the scheduled time)",
  },
  args: {
    id: { type: "positional", description: "Task id", required: true },
    ...targetArg,
    scheduled: { type: "boolean", description: "Internal marker for scheduler-generated runs", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const envelope = await akmTasksRun(args.id, {
        scheduled: args.scheduled === true,
        ...(args.target !== undefined ? { target: args.target } : {}),
      });
      output("tasks-run", envelope);
      if (envelope.exitCode !== 0) process.exit(envelope.exitCode);
    });
  },
});

const tasksHistoryCommand = defineJsonCommand({
  meta: { name: "history", description: "Show recent task run history" },
  args: {
    id: { type: "string", description: "Filter to one task id" },
    limit: { type: "string", description: "Maximum rows to return (default 50)" },
    ...targetArg,
  },
  async run({ args }) {
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const result = await akmTasksHistory({ id: args.id, limit, target: args.target });
    output("tasks-history", result);
  },
});

const tasksSyncCommand = defineJsonCommand({
  meta: {
    name: "sync",
    description: "Reconcile the on-disk task files of a bundle with the OS scheduler",
  },
  args: { ...targetArg },
  async run({ args }) {
    const result = await akmTasksSync({}, args.target);
    output("tasks-sync", result);
  },
});

const tasksDoctorCommand = defineJsonCommand({
  meta: {
    name: "doctor",
    description: "Report the active scheduler backend, akm bin path, log dir, and supported schedule subset",
  },
  args: { ...targetArg },
  async run({ args }) {
    const result = await akmTasksDoctor({ target: args.target });
    output("tasks-doctor", result);
  },
});

export const tasksCommand = defineGroupCommand({
  meta: {
    name: "tasks",
    alias: "task",
    description:
      "Schedule version-2 workflows, prompts, or commands via the OS-native scheduler (cron / launchd / schtasks)",
  },
  subCommands: {
    add: tasksAddCommand,
    init: tasksInitCommand,
    enable: tasksEnableCommand,
    disable: tasksDisableCommand,
    run: tasksRunCommand,
    history: tasksHistoryCommand,
    sync: tasksSyncCommand,
    doctor: tasksDoctorCommand,
  },
  // Bare `akm tasks` reports scheduler diagnostics. Inspection of individual
  // tasks moved to the generic `akm search` / `akm show <bundle//tasks/id>`.
  async defaultRun() {
    const result = await akmTasksDoctor();
    output("tasks-doctor", result);
  },
});
