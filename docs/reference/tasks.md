# Tasks

Task assets are strict, local automation sources. They live at
`<bundle>/tasks/<id>.yml` and can be run directly or on a schedule: one OS
scheduler entry (cron, launchd, or Windows Task Scheduler; written by
`akm task sync`) runs `akm task dispatch` every minute, and dispatch starts the
tasks that are due. The task file is the only source; nothing about a schedule
is copied into the OS.

**Task source v4 (`version: 4`) is the only task source grammar akm reads.**
A document with `version: 3` or `version: 2` fails to load with `UsageError`
code `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming `akm migrate apply`, which
converts it. A `version: 4` document whose `schedule[]` carries a
per-entry `enabled` key fails with `TASK_SOURCE_INVALID` (activation is
host-local, below). Each such file fails on its own:
`akm task dispatch` reports it and keeps starting every other task. Task
source v4 adds typed `inputs:` and a single bounded `output:` schema
(command targets only), and makes scheduling OPTIONAL rather than
mandatory. `akm task add` authors task source v4 directly.

A `version: 2` or `version: 3` file is refused, and this release converts none: run `npm i -g akm-cli@0.9.32 && akm migrate apply && akm task sync` first, then upgrade. `akm migrate status` reports each such file as a blocker with that recipe.

## Files and schema

The only recognized task extension is `.yml`. A `.yaml` near miss is never
indexed, scheduled, or run. Every task should declare `version: 4`; a
document with no `version:` key, or a `version:` that is not a number,
fails with `TASK_SOURCE_INVALID` (`must be exactly 4.` / `is required and
must be exactly 4.`) — a genuinely malformed v4 document, not a legacy one.
`version: 3` and `version: 2` fail with `TASK_SCHEMA_VERSION_UNSUPPORTED`
naming the 0.9.32 recipe above.
The published [task schema](../../schemas/akm-task.json) describes the
hand-authored contract; `src/tasks/source/task-source-v4.ts` is the
authoritative bounded parser.

```yaml
version: 4
name: Nightly review
uses: workflows/nightly-review
inputs:
  strict:
    type: boolean
    default: true
schedule: "0 4 * * *"
timeout: 30000
```

Task YAML is bounded before expansion: source size, YAML depth, aggregate node
count, mapping width, string size, and collection sizes all have finite limits.
Aliases, merge keys, custom tags, duplicate keys, accessors, and non-plain data
are rejected rather than normalized.

## Executable targets: `uses` or `run`

A task selects exactly one of `uses` or `run`; the two fields are mutually
exclusive.

`uses` accepts these target shapes:

- `akm/command`, the built-in inline/referenced command action. Its `with`
  object requires exactly one of `with.ref` or `with.content`; they are
  mutually exclusive. `with.arguments` is one optional portable string, used
  for the single, one-pass `$ARGUMENTS` substitution. `with:` is legal
  **only** alongside `uses: akm/command` — every other target uses typed
  `inputs:` instead (see [Input flags](#input-flags)).
- Asset refs rooted at `commands/`, `workflows/`, or `scripts/`, optionally
  qualified with a bundle such as `team//commands/review`.

A GitHub Action locator (`owner/repo[/path]@ref`, e.g. `actions/checkout@v4`)
is **not** a recognized `uses:` shape — it fails at parse with
`TASK_SOURCE_INVALID` alongside every other unrecognized target. AKM does not
acquire or execute remote actions.

Agent refs such as `agents/reviewer` are personas and are not executable.
Task refs such as `tasks/nightly` are also not executable. Local actions
(`./action`) are rejected and Docker actions (`docker://image`) are unsupported.
GitHub expressions are unsupported and rejected before dispatch.

The runtime applies this target-by-target field matrix. Validation is strict;
fields are not silently discarded.

| Target | `with` / `inputs` | task `env` | Interpreter / execution |
|---|---|---|---|
| `run` | No `with`; declare `inputs:` for typed parameters | Allowed | One authored string through the selected closed host `shell` |
| `akm/command` | Required action object: exactly one of `ref` or `content`, plus optional portable `arguments` | Allowed and passed through the command resolver | Shared command authorization and lowering |
| `commands/<name>` | No `with`; declare `inputs:` for typed parameters | Allowed and passed through the command resolver | Shared command authorization and lowering |
| `workflows/<name>` | Declared `inputs:` become the child run's params | A nonempty task `env` is rejected because the durable workflow runtime cannot consume it | Fresh durable workflow start |
| `scripts/<name>.<ext>` | No `with`; declare `inputs:` for typed parameters | Allowed for the child process | Closed extension-to-interpreter table below |

Script refs use this closed table; any other extension fails before dispatch:

| Extensions | Interpreter |
|---|---|
| `.sh` | `sh` |
| `.ts`, `.js` | Bun; JavaScript and TypeScript script targets require Bun (the standalone binary uses its embedded Bun runtime) |
| `.ps1` | `powershell -NoProfile -NonInteractive -File` |
| `.cmd`, `.bat` | `cmd /d /s /c` |
| `.py` | `python` |
| `.rb` | `ruby` |
| `.go` | `go run` |
| `.pl` | `perl` |
| `.php` | `php` |
| `.lua` | `lua` |
| `.r` | `rscript` |
| `.swift` | `swift` |
| `.kt`, `.kts` | Kotlin (`kotlin` for `.kt`, `kotlinc -script` for `.kts`) |

`run` is one non-empty shell string. It may specify `shell` from the closed host
shell table `bash`, `sh`, `zsh`, `pwsh`, `powershell`, or `cmd`. Shell expansion
is runtime behavior for an explicitly authored task `run`; AKM does not infer a
shell from `uses`. `working-directory` is a non-empty string, relative to the
task's bundle root or absolute, like a workflow's `exec.cwd`. akm does not
keep it inside the bundle or check it when the task source is parsed, so a
symlink that resolves outside the bundle works. The task runs in
`<bundle root>/<working-directory>` (or the absolute path as written): akm does
not capture the directory's identity or re-check it when the task runs. A
`uses: scripts/<file>` target may itself be a symlink to a file outside the
bundle; the task freezes that file's bytes, not its location. The interpreter
comes from the name the script has in the bundle, not from the file the link
points to, so `scripts/deploy.sh` linked to `real-script.txt` runs under the
shell.

Every field that used to live under v3's `akm:` options bag is a top-level
key in task source v4: `agent`, `connection`, `harness`, `model`, `inference`, `timeout`,
`redact`, `maxSteps`, and `maxRetries`, plus `description`, `when_to_use`, and
`tags`. A v4 `tools` is
ignored with a warning. Environment entries (`env`) are literal string,
number, or boolean values. Keep credentials out of task source; `redact`
contains environment variable names, never secret values.

`timeout:` (milliseconds) means a different mechanism depending on the
target. For `run:` (native shell/script) and `workflows/<name>` targets it is
an outer supervisory deadline: the runner stops the child process (SIGINT, then
SIGTERM, then SIGKILL; see [How akm runs a
harness](configuration.md#how-akm-runs-a-harness)), or aborts the workflow run at
its next step boundary, when it fires. For `uses:
akm/command`, `commands/<name>`, and any other agent/LLM dispatch target
there is no outer process kill — `timeout:` instead resolves through the
execution cascade (config/persona/command/task layers) into the dispatch's
own deadline, and the runner (a harness's process, or akm's own runtime) enforces it.
Either way, a dispatch that times out is recorded as `status: failed` with
`detail.reason: "timeout"` in `task_history` — not a silent `completed` — and
`akm task run` exits non-zero for it; see [health-advisories.md's
`task-fail-rate` row](../architecture/internals/health-advisories.md)
for how `akm health` surfaces a timeout-dominant failure pattern.

## Scheduling

Scheduling is **optional**. Omit `schedule:` entirely for a manual-only
task: the source still parses, still runs with `akm task run`, and
`akm task dispatch` never starts it (no failure) rather than rejecting the
source for missing a trigger.

```yaml
version: 4
name: Nightly review
run: akm improve --strategy default
schedule:
  - cron: "@daily"
```

A bare string (`schedule: "0 8 * * 1"`) is shorthand for one trigger with
no inputs. A list entry may set literal `inputs`; those literals are validated against the
task's `inputs:` declarations both at parse time and again by `akm lint --type tasks`
(once with declared defaults applied), and are
**delivered** to the scheduled run: when an entry is due, `akm task dispatch`
starts the run as `akm task run <id> --bundle <bundle> --scheduled --<name> <value>…`
(names sorted), so the fired run receives them exactly as `akm task run <id>
--<name> <value>` would. A task with several schedule entries starts at most
one run per minute: the first entry that is due supplies the inputs.

The schedule is the five-field cron grammar (or `@hourly`, `@daily`, `@weekly`,
`@monthly`, `@yearly`) on every OS, evaluated in local time by dispatch: steps,
ranges, lists, names (`MON-FRI`, `JAN`), and day-of-month together with
day-of-week (either may match, as in vixie-cron) all work everywhere.
`@reboot` is not a schedule.

Task source v4 has **no enablement flag**. A source describes what may run;
it cannot authorize its own host scheduling. Activation is this host's list of
fully-qualified refs in `config.json` under `scheduler.enabled`. A ref that
is not listed is disabled, and a config with no list has never chosen. Use
`akm task enable <bundle>//tasks/<id>` and
`akm task disable <bundle>//tasks/<id>` to change the list; dispatch reads it
on the next minute. `akm task add` enables its new task by
default; `--disabled` writes the same task source but does not list it.

`akm task run <id>` executes a task immediately, including a disabled task.
`akm task dispatch` reads only the refs in `scheduler.enabled`. If a bundle is
disabled its refs are inert. Workflow targets
create a fresh durable workflow freeze at fire time.

## Typed inputs and output

```yaml
version: 4
name: Review code
description: Summarize a pull request's changed surface
inputs:
  scope:
    type: string
    enum: [changed, all]
    default: changed
  strict:
    type: boolean
    default: true
  ticket:
    type: string
    required: true
output:
  type: object
  properties:
    summary: { type: string }
uses: commands/review
schedule:
  - cron: "0 8 * * 1"
    inputs: { scope: all, ticket: OPS-1234 }
timeout: 45000
harness: reviewer
redact: [TOKEN]
```

- `inputs:` declares named, typed parameters. Each declaration is a bounded
  JSON Schema (`type`, `enum`, `properties`, `items`, `minimum`/`maximum`,
  `allOf`/`anyOf`/`oneOf`/`not`, and similar keywords — an unlisted keyword is
  rejected) plus two keys unique to task source v4: `default` (which must
  itself satisfy the rest of the declaration) and `required: true` (mutually
  exclusive with `default`). Declaration names follow the same identifier
  grammar as workflow parameters, and additionally may not name a flag `akm
  task run` already declares for itself — `bundle`, `format`, `detail`,
  `output`, `scheduled`, `quiet`, `verbose`, `help`, `no-quiet`, or
  `no-verbose`. Parsing rejects a colliding name with `TASK_SOURCE_INVALID`
  at declaration time, since `akm task run --<name>`, `akm task explain
  --<name>`, and a `schedule[].inputs` entry would otherwise route the value
  into `akm task run`'s own flag instead of the declared input.
- **A `required: true` input with no default must be satisfied by every
  schedule binding.** A scheduled run supplies no input flags — the entry's
  own `inputs:` literals plus the declared defaults are the whole value set
  it gets — and a `required: true` input may not carry a `default`, so an
  entry that names no value for one could never run. Parsing rejects that
  contradiction with `TASK_SOURCE_INVALID` at the offending entry's own
  field path (`schedule`, or `schedule[<i>]`), naming the unsatisfied
  input. The rule covers every entry: the `schedule: "<cron>"` string
  shorthand, a list entry with no `inputs:` key, and an entry whose
  `inputs:` mapping is present but incomplete. `akm lint --type tasks` keeps its own equivalent check over the
  defaulted values. Give every schedule entry an explicit value for the
  input, or declare a `default` instead; manual runs are unaffected — a
  task with no `schedule:` stays valid whatever it requires, and `akm task
  run` takes the value from the input's own flag.
- `output:` is a single bounded JSON Schema, replacing v3's
  `akm.outputSchema`. It is legal only on a command target
  (`uses: commands/<ref>` or `uses: akm/command`), where it is forwarded to
  the prepared invocation as a response-shaping schema. `run:`,
  `uses: scripts/`, and `uses: workflows/` executions have no output-schema
  consumer — a native run's status comes from its exit code alone — so
  declaring `output:` on them fails parsing with `TASK_SOURCE_INVALID`
  instead of silently recording a contract nothing enforces.
- A workflow step cannot target a task: the GitHub-shaped YAML workflow format
  that carried `uses: tasks/<ref>` was removed in 0.10. A task runs a workflow
  (`uses: workflows/<ref>`), not the other way round.

### Input flags

`akm task run <id>` accepts one exact-name flag per declared `inputs:` entry,
mirroring `akm workflow run`'s parameter flags:

```sh
akm task run review --scope all --strict  # doclint:ignore
```

Flag names are task-specific — they come from that task's own `inputs:`
declarations — so they are not listed on `akm task run --help` and the
example above uses one task's actual declared names, not a fixed syntax.
An undeclared flag fails with `UNKNOWN_FLAG`; a value that does not satisfy
its declaration, or a missing `required: true` input supplied by neither a
flag nor a default, fails with `INPUT_BINDING_INVALID` — both exit `2` with
the usual `{ok:false,error,code}` envelope on stderr.

Where the materialized values go next depends on the task's own target, and
is narrower than it may look: when the target is `uses: workflows/<ref>`,
the values become the child run's params (the same `with:` → params path a
workflow step's own composition uses); for every other target — `run:`
shell, `scripts/<ref>`, `commands/<ref>` — the values are validated and then
**discarded**. `akm task run`'s own flags never populate an
`AKM_TASK_INPUTS` environment variable or a `## Task inputs` prompt block.
Those two surfaces existed only for a workflow step composing a task through
`uses: tasks/<ref>`, which was removed in 0.10.
A scheduled run (`schedule[].inputs`, above) reaches the target through this
same `akm task run` path, so it inherits the identical rule: delivered as
params for a `workflows/<ref>` target, otherwise validated and discarded.
`akm task explain` (below) shows the materialized values regardless of where
they end up, which is the fastest way to check what a given `akm task run`
invocation would actually deliver. `akm task add --params` renders
`--params` values as typed `inputs:` declarations with `default:` values
(typed from each JSON value's runtime type), not a `with:` bag.

### `akm task explain`

`akm task explain <ref> [input flags]` prints a task's source path and
version, its declared `inputs:` (name, type, `enum`, `required`, `default`),
the values that would actually be supplied — with provenance
(`default` | `flag` | `schedule-binding`) — the resolved target kind/ref,
effective execution settings with field-level provenance, and schedule
bindings. It is **read-only**: it never spawns anything, writes history, or
touches the scheduler. A secret-shaped value (a declared default, a supplied
value, or a schedule binding's literal) prints as `"<redacted>"` with its row
marked `redacted: true` instead of the real value; an `env:` binding is shown
as a name/ref only, never its resolved value.

```sh
akm task explain review --scope all  # doclint:ignore
```

`akm task explain`'s default output (no `--format` flag) is the **same raw
JSON** as `--format json`, byte for byte — there is nothing to lose by
piping the default form into `jq` or a script. `--format text` is a
separate renderer: it flattens the same envelope into `dotted.path=value`
lines (the same convention `akm config list --format text` uses), not a
copy of the JSON.

A secret-shaped **input default** is redacted the same way as a supplied
value. `akm task run --<name> <secret-looking-value>` does not echo the offered
value in its error envelope, whether it fails typed-flag coercion or the
declared schema (an `enum`/`minimum`/`maximum` mismatch included); both paths
report only the violated constraint.

## Operations

- `akm search --type task` and
  `akm show tasks/<id>` inspect task assets.
- `akm task explain <ref>` prints a task's declared inputs, resolved target,
  effective execution settings, and schedule bindings without running
  anything — see [`akm task explain`](#akm-task-explain) above.
- `akm lint --type tasks` reports what `akm task dispatch` would refuse to start
  for a task file: a document that does not parse as task source v4, a version 2/3 file or
  a `version: 4` file still carrying a retired `schedule[].enabled` (the finding
  names `akm migrate apply`, which converts them), a cron that does not parse,
  and a schedule entry whose `inputs` leave a required
  input unsatisfied. It is read-only and needs no configured connection or harness.
- `akm task add` validates a task source v4 document, writes it, and adds its ref
  to `scheduler.enabled`. It does not touch the OS scheduler. `--params` renders
  typed `inputs:` declarations instead of a `with:` bag; `--schedule` is
  required on every invocation. `--disabled` writes the same source but
  leaves the ref out of the list. `--force` overwrites an existing task of
  the same id; without it add refuses.
- `akm task history` reads durable run history from `state.db`.
- `akm task enable <ref>` / `akm task disable <ref>` change only
  `scheduler.enabled`.
- Delete the `.yml` source and `akm task disable` its ref; until then dispatch
  reports the missing file.
- `akm task sync` keeps the one OS entry in step with the list: installed when any
  task is enabled, removed when none is, and an installed entry keeps its
  launcher and PATH unless `--rebind`. In the same write it removes akm 0.9's
  per-task rows, except those that name another installation. An
  installation that moves any location never writes the OS scheduler
  (see the [scheduling guide](../guides/scheduling.md)).
- `akm task sync --dry-run` previews that without writing to the scheduler;
  exits non-zero when it would remove anything.
- `akm task prune` removes akm 0.9 per-task rows that `sync` left because they
  name a bundle directory that is gone (a row whose `AKM_BUNDLE_DIR` names a
  directory that no longer exists). Defaults to a dry-run preview (zero writes);
  `--yes` executes it; `--id <id1,id2,...>` scopes to specific ids and refuses
  any id that isn't a current candidate.
- The entry is a single crontab block (on macOS one plist, on Windows one task)
  that runs `<launcher> task dispatch` every minute, with the `PATH` of the shell
  that wrote it. It sits at the end of the crontab, so cron's `PATH=` line
  reaches nothing but akm's own line.

  ```text
  # akm:dispatch BEGIN
  PATH=/home/u/.bun/bin:/usr/local/bin:/usr/bin:/bin
  * * * * * /home/u/.bun/bin/bun /home/u/.bun/lib/node_modules/akm-cli/dist/akm task dispatch > /home/u/.cache/akm/tasks/logs/dispatch.log 2>&1
  # akm:dispatch END
  ```

  It names no bundle, no task and no `AKM_*` variable: dispatch resolves config
  and directories like any other akm command.

- Dispatch starts each due task as a detached process, so a task outlives the
  dispatch that started it (on launchd the agent also sets `AbandonProcessGroup`;
  Task Scheduler is `IgnoreNew`). A task that is still running when its next
  minute comes is skipped. Dispatch finds a running task by the process
  recorded in its `task_history` row; a row whose process is gone (a crash, a
  reboot) does not block it.

Scheduler execution is at least once. Backends provide a stable invocation
identity and AKM fences stale attempts, but an ambiguous process crash can be
observed only after the external work has started. Make scheduled side effects
idempotent where possible.

## See also

- [CLI Reference: task](cli.md#task)
- [Scheduling guide](../guides/scheduling.md)
- [Workflow source formats](workflow-schema.md)
- [Data and telemetry](data-and-telemetry.md)
