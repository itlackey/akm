// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run`'s own declared flag names, exposed as a dependency-free leaf
 * module so `src/tasks/source/task-source-v4.ts` (the parser) can reject a
 * declared `inputs:` name that collides with one, without creating an import
 * cycle back through the CLI layer.
 *
 * Code-review finding (docs/plans/specs/p2b-input-bindings.md, P2b review
 * round 2): `schedulerInputFlagTail` (`../tasks/scheduler-binding.ts`) and
 * `akm task run <id> --<name> <value>` both let an authored/declared input
 * NAME collide with a flag `akm task run` already binds to itself
 * (`--bundle`, `--scheduled`, …). `parseTaskInputFlags`
 * (`../commands/tasks/tasks-cli.ts`) always treats those names as its OWN
 * flags, never as input flags — so a colliding name is either silently
 * absorbed into the wrong flag (`--bundle other-bundle` re-targets which
 * bundle the task loads from) or left as an orphaned positional token that
 * throws `Unexpected positional task argument`. Rejecting the collision at
 * DECLARATION time (in `parseInputDeclarations`) closes every path that can
 * ever reach it — a bare `akm task run --<name>`, `akm task explain
 * --<name>`, and a `schedule[i].inputs` entry (whose keys are already
 * checked against the declared contract, so a name banned here can never
 * appear there either) — instead of special-casing each caller separately.
 *
 * `src/commands/tasks/tasks-cli.ts` re-exports `TASK_RUN_VALUE_FLAGS` /
 * `TASK_RUN_BOOLEAN_FLAGS` from here unchanged, so this module is the single
 * source of truth both the CLI's own argv scanner and the source parser read
 * — the two can never drift apart. `TASK_RUN_SELF_DIAGNOSED_FLAGS` (below)
 * covers the third category the scanner sets cannot express: a name the CLI
 * claims by REJECTING it rather than by declaring it. This file imports
 * nothing, and nothing it
 * exports depends on IO, config, or any other `src/tasks/**` module, so it
 * can be imported from either side of that boundary without participating in
 * a cycle.
 */

/** Every VALUE-taking flag `akm task run` declares (GLOBAL_OUTPUT_ARGS' value flags plus `--bundle`). */
export const TASK_RUN_VALUE_FLAGS: readonly string[] = ["bundle", "format", "detail", "shape", "output"];

/** Every BOOLEAN flag `akm task run` declares, including citty's `--no-` negations of the boolean pair above. */
export const TASK_RUN_BOOLEAN_FLAGS: readonly string[] = [
  "scheduled",
  "quiet",
  "verbose",
  "help",
  "no-quiet",
  "no-verbose",
];

/**
 * Flag names `akm task` claims WITHOUT declaring them as citty args, so they
 * appear in neither list above and must be reserved separately.
 *
 * `target` is the only member: the 0.9 rename of `akm task --target` to
 * `--bundle` (S8.4) is self-diagnosed rather than merely dropped —
 * `rejectRetiredTaskTargetFlag` (`../commands/tasks/tasks-cli.ts`) throws the
 * rename hint for a `--target` in ANY spelling, bare or `--target=<value>`,
 * and the generic pre-dispatch gate exempts the name on every `task`
 * subcommand precisely so that handler can answer (`../cli/unknown-flags.ts`'s
 * `SELF_DIAGNOSED_FLAGS`). That rejection runs before `parseTaskInputFlags`
 * ever scans argv, so a declared input named `target` is unreachable through
 * every spelling of its own flag — the exact value-misrouting hole the union
 * below exists to close, just reached from the CLI's diagnostic side instead
 * of from its declared-arg side (0.9.2 review round 2). Rejecting the
 * DECLARATION keeps the rename hint intact for everyone typing the retired
 * spelling while making the unusable declaration impossible to author, rather
 * than trading one silent failure for another.
 *
 * It deliberately stays OUT of `TASK_RUN_VALUE_FLAGS` /
 * `TASK_RUN_BOOLEAN_FLAGS`: those two are `parseTaskInputFlags`' own scanner
 * sets (a value flag makes the scanner swallow the following token), and
 * `--target` must keep reaching the rename diagnostic rather than being
 * silently consumed as one of `akm task run`'s own flags.
 */
export const TASK_RUN_SELF_DIAGNOSED_FLAGS: readonly string[] = ["target"];

/** The union of all three lists above, for a single membership check against a candidate input name. */
export const TASK_RUN_RESERVED_FLAG_NAMES: ReadonlySet<string> = new Set([
  ...TASK_RUN_VALUE_FLAGS,
  ...TASK_RUN_BOOLEAN_FLAGS,
  ...TASK_RUN_SELF_DIAGNOSED_FLAGS,
]);
