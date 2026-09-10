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
 * singular `task` — hard break, no alias. `init`/`enable`/`disable` are
 * dropped: the default improve-schedule task set now ships as embedded
 * templates under src/assets/tasks/improve/ (see src/tasks/embedded.ts),
 * seeded through the interactive `akm setup` task-review step instead of a
 * separate CLI command, and toggling a task's enabled state is a file edit +
 * `task sync` (tasks-sync.test.ts already proves the flip path). Every
 * subcommand (`add`/`run`/`history`/`sync`) shares one `--bundle <bundle>`
 * axis (S8.4 ratified `task add`'s `--target` → `--bundle`; a later Gate-1
 * fix reverted it to match `import`/`proposal accept`, splitting the
 * write-target axis three-vs-one against `remember`/`clone`/`improve` — the
 * final review re-applied the ratified rename here).
 */

import { defineCommand } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import { parsePositiveIntFlag } from "../../cli/parse-args";
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
import { resolveUsageEventSource } from "../../indexer/usage/usage-events";
import { getOutputMode } from "../../output/context";
import { TASK_RUN_BOOLEAN_FLAGS, TASK_RUN_VALUE_FLAGS } from "../../tasks/task-run-reserved-flags";
import { akmSearch, parseSearchSource } from "../read/search";
import { rejectRetiredSourceFlag } from "../read/search-cli";
import { akmTaskExplain } from "./explain";
import {
  akmTasksAdd,
  akmTasksDoctor,
  akmTasksHistory,
  akmTasksPrune,
  akmTasksRun,
  akmTasksSync,
  akmTasksSyncPlan,
} from "./tasks";
import { akmTaskValidate } from "./validate";

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
 * silent-discard defect these rejecters exist to close (review round 1). The
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
 * `--target` was renamed to `--bundle` on `task` in 0.9 (S8.4). citty is
 * non-strict, so the retired spelling is silently absorbed rather than
 * rejected — reject it explicitly instead (mirrors improve-cli.ts /
 * remember-cli.ts). The generic pre-dispatch gate cannot catch it either: it
 * exempts `target` on every `task` subcommand precisely so this handler can
 * answer with the rename (`../../cli/unknown-flags`'s `SELF_DIAGNOSED_FLAGS`),
 * and that exemption is keyed on the flag NAME — so `--target=team` must be
 * rejected here by name too, or nothing rejects it at all.
 *
 * Rejecting by NAME means `--target=<value>` can no longer carry a declared
 * task input named `target` either (0.9.2 review round 2). That is settled on
 * the DECLARATION side, not by narrowing this rejecter back to whole-token
 * matching: `target` is listed in `TASK_RUN_SELF_DIAGNOSED_FLAGS`
 * (`../../tasks/task-run-reserved-flags.ts`), so `parseInputDeclarations`
 * refuses `inputs: {target: …}` with TASK_SOURCE_INVALID at authoring time and
 * no task can reach `akm task run` needing the flag this throws on. Do not
 * re-narrow the match here — the silently-ignored `--target=team` that round 1
 * closed would come straight back.
 */
function rejectRetiredTaskTargetFlag(): void {
  if (!hasFlagNamed("target")) return;
  throw new UsageError(
    "`akm task --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.",
    "INVALID_FLAG_VALUE",
  );
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

// ── `akm task run` input flags — Stage 1: capture (spec §5.1) ──────────────
//
// Mirrors `parseWorkflowParameterFlags` (src/commands/workflow-cli.ts:232-289)
// exactly: the CLI carries RAW string/boolean flag values to the boundary
// that knows the task's declared contract (Stage 2, src/tasks/run/load-task.ts)
// — coercion happens once, there. `akm task run`'s own declared flags
// (GLOBAL_OUTPUT_ARGS, --bundle, --scheduled) are excluded so they are never
// mistaken for inputs (B-33); `--target` is excluded too, but only because
// `rejectRetiredTaskTargetFlag()` above always runs first and throws before
// this is ever reached (B-32) — it is not itself special-cased below.

// `TASK_RUN_VALUE_FLAGS` / `TASK_RUN_BOOLEAN_FLAGS` are re-exported here
// (unchanged in name, location, and value) from a dependency-free leaf module
// so `src/tasks/source/task-source-v4.ts` can reject a declared `inputs:`
// name that collides with one of them without importing this CLI file —
// which would cycle back through `./tasks` -> `../../tasks/source/*` into the
// parser (code-review finding, docs/plans/specs/p2b-input-bindings.md review
// round 2; see `../../tasks/task-run-reserved-flags.ts`'s own header).
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
  meta: { name: "add", description: "Register a new scheduled task and install it in the OS scheduler" },
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
      description: 'Exact shell string to run on the schedule (no AI agent), e.g. "akm improve --strategy frequent".',
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
    rebind: {
      type: "boolean",
      description: "Explicitly permit scheduler creation from this ineligible local invocation",
      default: false,
    },
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const result = await akmTasksAdd({
      id: args.id,
      schedule: args.schedule,
      target: args.bundle,
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
      rebind: args.rebind === true,
    });
    output("task-add", result);
  },
});

const tasksRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Execute a task now (this is what cron / launchd / schtasks invoke at the scheduled time)",
  },
  // Raw defineCommand (it forwards the task's exit code), so the global output
  // flags are declared here or `--format md nightly` loses the task id.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    id: { type: "positional", description: "Task id", required: true },
    ...bundleArg,
    scheduled: { type: "boolean", description: "Internal marker for scheduler-generated runs", default: false },
  },
  async run({ args, rawArgs }) {
    await runWithJsonErrors(async () => {
      rejectRetiredTaskTargetFlag();
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

/**
 * #911: `task run <id>` and `task explain <ref>` take the id positionally, so
 * `task history <id>` is the natural thing to write — and it used to be
 * accepted and silently discarded, answering with every task's newest rows.
 * A positional id now means the same as `--id`; giving both with different
 * values is a usage error rather than a silent pick.
 */
export function resolveTaskHistoryId(positional: string | undefined, flag: string | undefined): string | undefined {
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw new UsageError(
      `\`akm task history\` was given two task ids: "${positional}" and --id "${flag}". Pass one.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return flag ?? positional;
}

const tasksHistoryCommand = defineJsonCommand({
  meta: { name: "history", description: "Show recent task run history" },
  args: {
    task: { type: "positional", description: "Task id to filter to (same as --id)", required: false },
    id: { type: "string", description: "Filter to one task id" },
    limit: { type: "string", description: "Maximum rows to return (default 50)" },
    ...bundleArg,
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const id = resolveTaskHistoryId(args.task, args.id);
    const result = await akmTasksHistory({ id, limit, target: args.bundle });
    output("task-history", result);
  },
});

/**
 * #849: `task sync --dry-run`'s exit-code contract, "non-zero when the plan
 * contains removals" — factored out as a pure function (rather than left
 * inline in the command's `run()`) so it's directly unit-testable without
 * driving the whole CLI through a real scheduler backend. #867: also
 * non-zero when any source failed to parse/prepare — sync degrades (still
 * reconciles the tasks/workflows that DID parse) rather than rejecting the
 * whole set, but a dropped source must still surface as a failing exit.
 */
export function taskSyncDryRunExitCode(preview: {
  hasRemovals: boolean;
  failures?: readonly unknown[];
}): number | undefined {
  return preview.hasRemovals || (preview.failures?.length ?? 0) > 0 ? EXIT_CODES.GENERAL : undefined;
}

const tasksSyncCommand = defineJsonCommand({
  meta: {
    name: "sync",
    description: "Atomically preflight and reconcile a bundle's task/workflow schedules with the OS scheduler",
  },
  args: {
    ...bundleArg,
    rebind: {
      type: "boolean",
      description: "Replace installed bindings with the current invocation",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description:
        "Compute and print the full reconcile plan (adds/updates/removes, with owning bundle on every " +
        "removal) without touching the OS scheduler. Zero durable writes. Exits non-zero when the plan " +
        "contains removals.",
      default: false,
    },
  },
  async run({ args }) {
    rejectRetiredTaskTargetFlag();
    const rebind = args.rebind === true;
    if (args["dry-run"] === true) {
      const preview = await akmTasksSyncPlan({}, args.bundle, { rebind });
      outputWithExitCode("task-sync-dry-run", preview, taskSyncDryRunExitCode(preview));
      return;
    }
    const result = await akmTasksSync({}, args.bundle, { rebind });
    // #867: sync degrades — sources that failed to parse/prepare are
    // excluded from reconciliation and reported in `result.failures` rather
    // than poisoning the whole sync, but their presence must still fail
    // the command's exit code so the breakage stays visible. (#906: this key
    // matches the `--dry-run` preview's `failures` field — no separate name.)
    outputWithExitCode("task-sync", result, result.failures.length > 0 ? EXIT_CODES.GENERAL : undefined);
  },
});

// ── `akm task explain` — read-only introspection (P2b Lane B, spec
// docs/plans/specs/p2b-input-bindings.md §4.5, §1.7 B-N4) ──────────────────

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
    rejectRetiredTaskTargetFlag();
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
    description: "Report the active scheduler backend, akm bin path, log dir, and supported schedule subset",
  },
  args: {},
  async run() {
    const result = await akmTasksDoctor();
    output("task-doctor", result);
  },
});

/**
 * #907: `akm task validate`'s exit-code contract — `valid`/`converts` are
 * successful outcomes (exit 0); `blocked`/`invalid`/`not-a-task` are
 * diagnosed defects the caller must act on (exit 1, mirroring `task sync`'s
 * own `failures.length > 0 -> EXIT_CODES.GENERAL`). A missing path or an
 * unreadable file never reaches this function at all — `akmTaskValidate`
 * throws a `UsageError` for those, which `defineJsonCommand`'s wrapping
 * already maps to exit 2.
 */
export function taskValidateExitCode(result: { outcome: string }): number | undefined {
  return result.outcome === "valid" || result.outcome === "converts" ? undefined : EXIT_CODES.GENERAL;
}

const tasksValidateCommand = defineJsonCommand({
  meta: {
    name: "validate",
    description:
      "Parse a single task file by filesystem path — not a concept ref, and the file need not live in a " +
      "configured bundle — and report the same diagnostic `akm task sync` would produce for it. Read-only; " +
      "never touches the scheduler.",
  },
  args: {
    path: { type: "positional", description: "Filesystem path to a task source YAML file", required: true },
  },
  async run({ args }) {
    const result = await akmTaskValidate(args.path);
    output("task-validate", result);
    const exitCode = taskValidateExitCode(result);
    if (exitCode !== undefined) process.exitCode = exitCode;
  },
});

/**
 * #851: `akm task prune`'s exit-code contract mirrors `task sync --dry-run`'s
 * (`taskSyncDryRunExitCode` above) — non-zero whenever the preview lists
 * removals the invocation didn't (or couldn't, without `--yes`) execute, so
 * `akm task prune` is usable as a CI/health check the same way `sync
 * --dry-run` is.
 */
export function taskPruneExitCode(result: { dryRun: boolean; preview: { hasRemovals: boolean } }): number | undefined {
  return result.dryRun && result.preview.hasRemovals ? EXIT_CODES.GENERAL : undefined;
}

const tasksPruneCommand = defineJsonCommand({
  meta: {
    name: "prune",
    description:
      "Remove installed scheduler entries `sync` can never reclaim because their own descriptor no longer " +
      "resolves to a live bundle (corrupt/missing --scheduler-context, or the owning bundle directory is " +
      "gone). Defaults to a dry-run preview — zero scheduler writes. Requires --yes to remove anything; " +
      "--id narrows removal to specific binding ids (comma-separated).",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Execute removal of every currently-computed orphan (the plan is still printed first)",
      default: false,
    },
    id: {
      type: "string",
      description: "Comma-separated scheduler binding id(s) to limit pruning to (must already be orphan candidates)",
    },
  },
  async run({ args }) {
    const id = args.id
      ? args.id
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;
    const result = await akmTasksPrune({}, { yes: args.yes === true, id });
    outputWithExitCode("task-prune", result, taskPruneExitCode(result));
  },
});

/**
 * #951: `akm task list` — a pure, zero-logic delegating alias for
 * `akm search --type task`. 0.9.0 removed `task list` because it was a
 * second, redundant IMPLEMENTATION of task listing, not because the
 * spelling itself was off-limits; this reuses `search`'s exact envelope
 * (its `results` alias comes along for free) instead of adding a second one.
 * `query`/`--limit`/`--from` are handled identically to `searchCommand.run()`
 * for the same inputs, including the retired `--source` guard (`../read/
 * search-cli.ts`'s `rejectRetiredSourceFlag`, reused rather than copied) so
 * `akm task list --source x` fails with the same actionable rename message
 * as `akm search --type task --source x` instead of citty's silent absorb.
 */
const tasksListCommand = defineJsonCommand({
  meta: { name: "list", description: "List task assets (alias for `akm search --type task`)" },
  args: {
    query: {
      type: "positional",
      description: "Search query (omit to list all tasks)",
      required: false,
      default: "",
    },
    limit: { type: "string", description: "Maximum number of results" },
    from: { type: "string", description: "Search source (local|registry|all)", default: "local" },
  },
  async run({ args }) {
    rejectRetiredSourceFlag();
    const query = (args.query ?? "").trim();
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const source = parseSearchSource(args.from);
    const outputMode = getOutputMode();
    const result = await akmSearch({
      query,
      type: "task",
      limit,
      source,
      eventSource: resolveUsageEventSource(),
      attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
    });
    output("search", result);
  },
});

export const taskCommand = defineGroupCommand({
  meta: {
    name: "task",
    description:
      "Schedule recurring commands, prompts, and workflows through the OS scheduler (cron / launchd / schtasks)",
  },
  subCommands: {
    add: tasksAddCommand,
    run: tasksRunCommand,
    explain: tasksExplainCommand,
    validate: tasksValidateCommand,
    history: tasksHistoryCommand,
    list: tasksListCommand,
    sync: tasksSyncCommand,
    prune: tasksPruneCommand,
    doctor: tasksDoctorCommand,
  },
  // Bare `akm task` reports scheduler diagnostics. Deeper inspection of
  // individual tasks is the generic `akm show <bundle//tasks/id>`; `list`
  // above is a delegating alias for `akm search --type task` (#951).
  // No `defaultRun`: bare `akm task` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm task doctor` for what the
  // bare form used to run.
});
