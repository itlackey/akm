// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.task` key and every subcommand's
 * args/output shape are byte-identical. Handlers whose body is a plain
 * `runWithJsonErrors(...) + output(...)` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `task run` keeps a plain `defineCommand` because it forwards the
 * task's own exit code via `process.exitCode` (F4: not `process.exit()` —
 * that would skip pending cleanup).
 *
 * 0.9 CLI overhaul (S6): the group was renamed from the plural `tasks` to the
 * singular `task` — hard break, no alias. `init` was dropped: the default improve-schedule task set now ships as embedded
 * templates under src/assets/tasks/improve/ (see src/tasks/embedded.ts),
 * seeded through the interactive `akm setup` task-review step instead of a
 * separate CLI command. `enable`/`disable` mutate the host-local scheduler
 * allow-list, never the task source. Every subcommand shares one `--bundle <bundle>`
 * axis (S8.4 ratified `task add`'s `--target` → `--bundle`; a later Gate-1
 * fix reverted it to match `import`/`proposal accept`, splitting the
 * write-target axis three-vs-one against `remember`/`clone`/`improve` — the
 * final review re-applied the ratified rename here).
 */

import { defineCommand } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import { parsePositiveIntFlag, parseTimeoutFlag } from "../../cli/parse-args";
import { SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import {
  defineGroupCommand,
  defineJsonCommand,
  EXIT_CODES,
  GLOBAL_OUTPUT_ARGS,
  output,
  outputWithExitCode,
  runWithJsonErrors,
} from "../../cli/shared";
import { UsageError } from "../../core/errors";
import type { InputFlag } from "../../execution/input-contract";
import { dispatchDueTasks } from "../../tasks/dispatch";
import { TASK_RUN_BOOLEAN_FLAGS, TASK_RUN_VALUE_FLAGS } from "../../tasks/task-run-reserved-flags";
import { akmTaskExplain } from "./explain";
import {
  akmTasksAdd,
  akmTasksDisable,
  akmTasksDoctor,
  akmTasksEnable,
  akmTasksHistory,
  akmTasksRun,
  akmTasksSync,
} from "./tasks";

/** Shared `--bundle <bundle>` arg wired onto every task subcommand. */
const bundleArg = {
  bundle: {
    type: "string",
    description: "Bundle to operate on (defaults to the primary/default bundle)",
  },
} as const;

/**
 * True when argv carries a `--<name>` flag in ANY spelling — bare,
 * `--<name>=<value>` for any value, or a trailing `=` — stopping at a literal
 * `--` separator exactly as `hasFlagIn` (`../../cli/invocation.ts`) does.
 *
 * `ParsedInvocation.hasFlag` cannot be used for the rejections below: it
 * compares WHOLE tokens against `--<name>` and `--<name>=true` only, so every
 * other value spelling (`--<name>=false`, `--<name>=1`, `--<name>=`) walks
 * straight past it and is then absorbed downstream — by citty's non-strict
 * parser, or by `parseTaskInputFlags`' reserved-name skip — exactly the
 * silent-discard defect these rejecters exist to close. The
 * name is taken as everything before the FIRST `=`, which is
 * `parseTaskInputFlags`' own split (see its `body.indexOf("=")` below), so the
 * rejecter and the scanner can never disagree about what a token names.
 */
function hasFlagNamed(name: string): boolean {
  for (const token of getParsedInvocation().argv) {
    if (token === "--") return false;
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    if ((equalsAt === -1 ? body : body.slice(0, equalsAt)) === name) return true;
  }
  return false;
}

/**
 * `--scheduled` is `akm task run`'s own declared flag (an internal marker for
 * scheduler-generated runs) — `task explain` declares no such flag. Because
 * `explain` reuses `parseTaskInputFlags` (the same exact-name scanner `task
 * run` uses, see that function's docstring below) to capture input flags, and
 * `scheduled` is one of that scanner's reserved boolean-flag names
 * (`TASK_RUN_BOOLEAN_FLAG_SET`, from `../../tasks/task-run-reserved-flags`),
 * the scanner silently skips over `--scheduled` rather than ever surfacing it
 * as an input flag — so it reached neither `materializeInputFlags`' own
 * unknown-flag diagnostic nor the generic pre-dispatch flag gate (which
 * exempts `task explain`'s whole dynamic namespace, `../../cli/unknown-flags`
 * §`dynamicNamedFlagCommands`). The net effect: `akm task explain <ref>
 * --scheduled` silently accepted and discarded the flag instead of rejecting
 * it (finding F7) — `scheduled` can never be a declared input name either
 * (same reserved-name module), so this can never reject a flag that was ever
 * a valid input binding. Reject it explicitly, before the shared scanner ever
 * sees it — same UNKNOWN_FLAG diagnostic family the generic gate uses.
 *
 * Rejection is keyed on the flag NAME (`hasFlagNamed` above), not on a literal
 * token: `parseTaskInputFlags` splits on the first `=` BEFORE its reserved-name
 * check, so `--scheduled=false` and `--scheduled=1` are swallowed by that skip
 * just as the bare token is. A whole-token test would leave every spelling but
 * `--scheduled` / `--scheduled=true` in the hole this exists to close.
 */
function rejectExplainScheduledFlag(): void {
  if (!hasFlagNamed("scheduled")) return;
  throw new UsageError('Unknown flag "--scheduled".', "UNKNOWN_FLAG");
}

// ── `akm task run` input flags — Stage 1: capture ───────────────────────────
//
// Mirrors `parseWorkflowParameterFlags` (src/commands/workflow-cli.ts:232-289)
// exactly: the CLI carries RAW string/boolean flag values to the boundary
// that knows the task's declared contract (Stage 2, src/tasks/run/load-task.ts)
// — coercion happens once, there. `akm task run`'s own declared flags
// (GLOBAL_OUTPUT_ARGS, --bundle, --scheduled) are excluded so they are never
// mistaken for inputs.

// `TASK_RUN_VALUE_FLAGS` / `TASK_RUN_BOOLEAN_FLAGS` are re-exported here
// (unchanged in name, location, and value) from a dependency-free leaf module
// so `src/tasks/source/task-source-v4.ts` can reject a declared `inputs:`
// name that collides with one of them without importing this CLI file —
// which would cycle back through `./tasks` -> `../../tasks/source/*` into the
// parser (see `../../tasks/task-run-reserved-flags.ts`'s own header).
export { TASK_RUN_BOOLEAN_FLAGS, TASK_RUN_VALUE_FLAGS };

const TASK_RUN_VALUE_FLAG_SET = new Set<string>(TASK_RUN_VALUE_FLAGS);
const TASK_RUN_BOOLEAN_FLAG_SET = new Set<string>(TASK_RUN_BOOLEAN_FLAGS);

/**
 * Scan `akm task run`'s raw argv for exact-name input flags, excluding the
 * task id and every declared flag above. Input flags must come after the
 * task id (mirrors `parseWorkflowParameterFlags`'s positional rule); a bare
 * `--` is rejected, matching `workflow run`.
 */
export function parseTaskInputFlags(rawArgs: readonly string[], id: string): InputFlag[] {
  const flags: InputFlag[] = [];
  let idSeen = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index] as string;
    if (token === "--") {
      throw new UsageError("`akm task run` does not accept positional arguments after `--`.", "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      if (!idSeen) {
        if (token !== id) {
          throw new UsageError("Task input flags must come after the task id.", "INVALID_FLAG_VALUE");
        }
        idSeen = true;
        continue;
      }
      throw new UsageError(`Unexpected positional task argument "${token}".`, "INVALID_FLAG_VALUE");
    }
    if (!token.startsWith("--")) continue;

    const body = token.slice(2);
    const equalsAt = body.indexOf("=");
    const name = equalsAt === -1 ? body : body.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : body.slice(equalsAt + 1);
    if (TASK_RUN_VALUE_FLAG_SET.has(name)) {
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (TASK_RUN_BOOLEAN_FLAG_SET.has(name)) continue;
    if (!idSeen) {
      throw new UsageError("Task input flags must come after the task id.", "INVALID_FLAG_VALUE");
    }

    if (inlineValue !== undefined) {
      flags.push({ name, value: inlineValue });
      continue;
    }
    const next = rawArgs[index + 1];
    if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
      flags.push({ name, value: next });
      index += 1;
    } else {
      flags.push({ name, value: true });
    }
  }
  return flags;
}

const tasksAddCommand = defineJsonCommand({
  meta: { name: "add", description: "Register a new scheduled task (`akm task dispatch` runs it on its schedule)" },
  args: {
    id: { type: "positional", description: "Task id (used as filename and scheduler entry)", required: true },
    schedule: { type: "string", description: 'Cron-style schedule, e.g. "0 9 * * *" or "@daily"', required: true },
    ...bundleArg,
    workflow: { type: "string", description: "Workflow ref to invoke (e.g. workflows/my-flow)" },
    prompt: {
      type: "string",
      description: "Inline text prompt for the configured agent harness (asset refs and file paths are rejected)",
    },
    command: {
      type: "string",
      description:
        'Exact shell string to run on the schedule (no AI agent), e.g. "akm improve --strategy consolidate".',
    },
    ...SELECTION_ARGS,
    timeout: {
      type: "string",
      description: "Timeout for prompt or command targets: a duration (30s, 2m) or milliseconds",
    },
    params: { type: "string", description: "Workflow params as a JSON object" },
    name: { type: "string", description: "Human-readable name for the task" },
    "when-to-use": { type: "string", description: "Guidance on when this task runs or should be used" },
    description: { type: "string", description: "Human-readable description" },
    tags: { type: "string", description: "Comma-separated tags" },
    disabled: { type: "boolean", description: "Register but leave disabled: dispatch will not run it", default: false },
    force: { type: "boolean", description: "Overwrite an existing task with the same id", default: false },
  },
  async run({ args }) {
    const result = await akmTasksAdd({
      id: args.id,
      schedule: args.schedule,
      target: args.bundle,
      workflow: args.workflow,
      prompt: args.prompt,
      command: args.command,
      ...selectionFromArgs(args),
      timeoutMs: parseTimeoutFlag(args.timeout),
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
    output("task-add", result);
  },
});

export const tasksRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Execute a task now (`akm task dispatch` starts a due task this way)",
  },
  // Raw defineCommand (it forwards the task's exit code), so the global output
  // flags are declared here or `--format md nightly` loses the task id.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    id: { type: "positional", description: "Task id", required: true },
    ...bundleArg,
    // Hidden for good: `task dispatch` passes it, and so do the per-task rows of akm 0.9 until `task sync` replaces
    // them. It selects the unattended default timeout.
    scheduled: {
      type: "boolean",
      description: "Internal marker for scheduler-generated runs",
      default: false,
      hidden: true,
    },
  },
  async run({ args, rawArgs }) {
    await runWithJsonErrors(async () => {
      const inputFlags = parseTaskInputFlags(rawArgs, args.id);
      const envelope = await akmTasksRun(args.id, {
        scheduled: args.scheduled === true,
        ...(args.bundle !== undefined ? { target: args.bundle } : {}),
        inputFlags,
      });
      output("task-run", envelope);
      // F4: was `process.exit(envelope.exitCode)`, terminating synchronously
      // and skipping any pending cleanup (this command forwards a run task's
      // own exit code, so it can be any value, not just 0/1). output() has
      // already run and this is the last statement, so process.exitCode +
      // the implicit return is equivalent without the synchronous cutoff.
      if (envelope.exitCode !== 0) process.exitCode = envelope.exitCode;
    });
  },
});

const tasksEnableCommand = defineJsonCommand({
  meta: {
    name: "enable",
    description:
      "Enable a task: add it to this host's `scheduler.enabled` list and install the scheduler entry if needed",
  },
  args: {
    ref: { type: "positional", description: "Task ref or id", required: true },
    ...bundleArg,
  },
  async run({ args }) {
    output("task-enable", await akmTasksEnable(args.ref, { target: args.bundle }));
  },
});

const tasksDisableCommand = defineJsonCommand({
  meta: {
    name: "disable",
    description:
      "Disable a task: remove it from this host's `scheduler.enabled` list; the entry goes with the last one",
  },
  args: {
    ref: { type: "positional", description: "Task ref or id", required: true },
    ...bundleArg,
  },
  async run({ args }) {
    output("task-disable", await akmTasksDisable(args.ref, { target: args.bundle }));
  },
});

const tasksHistoryCommand = defineJsonCommand({
  meta: { name: "history", description: "Show recent task run history" },
  args: {
    task: { type: "positional", description: "Task id to filter to", required: false },
    limit: { type: "string", description: "Maximum rows to return (default 50)" },
    ...bundleArg,
  },
  async run({ args }) {
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const result = await akmTasksHistory({ id: args.task, limit, target: args.bundle });
    output("task-history", result);
  },
});

const tasksSyncCommand = defineJsonCommand({
  meta: {
    name: "sync",
    description:
      "Install, update or remove the one OS scheduler entry that runs `akm task dispatch` every minute, " +
      "and remove akm 0.9's per-task scheduler rows",
  },
  args: {
    rebind: {
      type: "boolean",
      description: "Point the installed entry at this akm invocation and PATH instead of keeping them",
      default: false,
    },
  },
  async run({ args }) {
    output("task-sync", await akmTasksSync({}, { rebind: args.rebind === true }));
  },
});

/**
 * `akm task dispatch`: the one command the OS scheduler runs, once a minute.
 * Starts every enabled task that is due, detached, and exits.
 */
const tasksDispatchCommand = defineJsonCommand({
  meta: {
    name: "dispatch",
    description:
      "Start the enabled tasks that are due this minute, each detached, and exit. " +
      "The OS scheduler entry (`akm task sync`) or your own supervisor runs this every minute",
  },
  args: {},
  async run() {
    const result = await dispatchDueTasks();
    outputWithExitCode("task-dispatch", result, result.failures.length > 0 ? EXIT_CODES.GENERAL : undefined);
  },
});

// ── `akm task explain` — read-only introspection ────────────────────────────

const tasksExplainCommand = defineJsonCommand({
  meta: {
    name: "explain",
    description:
      "Print a task's source, declared inputs (with provenance), resolved target, execution settings, and " +
      "schedule bindings — read-only and secret-free; never spawns anything",
  },
  args: {
    ref: { type: "positional", description: "Task ref or id", required: true },
    ...bundleArg,
  },
  async run({ args, rawArgs }) {
    // `--scheduled` must be rejected BEFORE the shared scanner below ever
    // sees it — the scanner treats it as `task run`'s own reserved flag
    // (silently skipped, never surfaced as unknown) rather than explain's,
    // since it has no way to know which command called it (F7 fix).
    rejectExplainScheduledFlag();
    // Stage 1 (capture): the SAME exact-name flag scanner `akm task run`
    // uses (`parseTaskInputFlags` above) — `explain` never declares
    // `--scheduled`, but reusing the identical scanner is deliberate: one
    // implementation of "which argv tokens are task input flags", not two.
    const inputFlags = parseTaskInputFlags(rawArgs, args.ref);
    const result = await akmTaskExplain(args.ref, {
      ...(args.bundle !== undefined ? { target: args.bundle } : {}),
      inputFlags,
    });
    output("task-explain", result);
  },
});

const tasksDoctorCommand = defineJsonCommand({
  meta: {
    name: "doctor",
    description: "Report the scheduler backend and its entry, akm bin path, log dir, and schedule grammar",
  },
  args: {},
  async run() {
    const result = await akmTasksDoctor();
    output("task-doctor", result);
  },
});

export const taskCommand = defineGroupCommand({
  meta: {
    name: "task",
    description:
      "Schedule recurring commands, prompts, and workflows: one OS scheduler entry (cron / launchd / schtasks) runs `akm task dispatch` every minute\n" +
      "Definitions are assets: `akm search --type task`, then `akm show <ref>`. " +
      "`task doctor` reports the scheduler entry; `task explain` the resolved inputs and target; " +
      "`task history` the executions.",
  },
  subCommands: {
    add: tasksAddCommand,
    enable: tasksEnableCommand,
    disable: tasksDisableCommand,
    dispatch: tasksDispatchCommand,
    run: tasksRunCommand,
    explain: tasksExplainCommand,
    history: tasksHistoryCommand,
    sync: tasksSyncCommand,
    doctor: tasksDoctorCommand,
  },
  // Bare `akm task` reports scheduler diagnostics. Deeper inspection of
  // individual tasks is the generic `akm show <bundle//tasks/id>`; listing is
  // `akm search --type task`.
  // No `defaultRun`: bare `akm task` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm task doctor` for what the
  // bare form used to run.
});
