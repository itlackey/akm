# Tasks

Task assets are strict, local automation sources. They live at
`<bundle>/tasks/<id>.yml` and can be run directly or reconciled to cron,
launchd, or Windows Task Scheduler with `akm task sync`. The task file is
authored source; scheduler entries are derived OS state.

**Task source v4 (`version: 4`) is the only task source grammar this
release accepts.** A document with `version: 3` or `version: 2` (or any
other value) fails to load with `UsageError` code
`TASK_SCHEMA_VERSION_UNSUPPORTED`, naming the migrator. Task source v4 adds
typed `inputs:` and a single bounded `output:` schema (command targets
only), and makes scheduling OPTIONAL rather than mandatory. `akm task add`
authors task source v4 directly.

If you have `version: 3` or `version: 2` files on disk (from an earlier
akm release), see [Migrating to task source v4](#migrating-to-task-source-v4)
below — `akm migrate apply` converts both generations in one pass. The
retired v3 grammar itself is documented at the bottom of this page
([Task v3 (retired): grammar reference for migration](#task-v3-retired-grammar-reference-for-migration))
purely so you can read an old file while migrating it; it is not accepted
by any command in this release.

## Files and schema

The only recognized task extension is `.yml`. A `.yaml` near miss is never
indexed, scheduled, or run. Every task must declare `version: 4`; a
document with no `version:` key, or a `version:` that is not a number,
fails with `TASK_SOURCE_INVALID` (`must be exactly 4.` / `is required and
must be exactly 4.`) — a genuinely malformed v4 document, not a legacy one.
`version: 3` and `version: 2` fail with `TASK_SCHEMA_VERSION_UNSUPPORTED`
instead (see [Migrating to task source v4](#migrating-to-task-source-v4)).
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
`TASK_SOURCE_INVALID` alongside every other unrecognized target. AKM never
acquired or executed a remote action in any release; this is the removal of
a recognized-but-rejected spelling, not a capability that used to work.

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
shell from `uses`. `working-directory` must be a relative, contained path under
the task's workspace root. Absolute paths, traversal, dangling links, and
symlink escapes fail before execution.

Every field that used to live under v3's `akm:` options bag is a top-level
key in task source v4: `agent`, `engine`, `model`, `inference`, `tools`,
`timeout`, `redact`, `maxSteps`, and `maxRetries`, plus `description`,
`when_to_use`, and `tags`. Environment entries (`env`) are literal string,
number, or boolean values. Keep credentials out of task source; `redact`
contains environment variable names, never secret values.

`timeout:` (milliseconds) means a different mechanism depending on the
target. For `run:` (native shell/script) and `workflows/<name>` targets it is
an outer supervisory deadline: the runner kills the child process, or aborts
the workflow run at its next step boundary, when it fires. For `uses:
akm/command`, `commands/<name>`, and any other agent/LLM dispatch target
there is no outer process kill — `timeout:` instead resolves through the
execution cascade (config/persona/command/task layers) into the dispatch's
own deadline, and the SDK/CLI runner races each phase against it internally.
Either way, a dispatch that times out is recorded as `status: failed` with
`detail.reason: "timeout"` in `task_history` — not a silent `completed` — and
`akm task run` exits non-zero for it; see [health-advisories.md's
`task-fail-rate` row](https://github.com/itlackey/akm/blob/main/docs/architecture/internals/health-advisories.md)
for how `akm health` surfaces a timeout-dominant failure pattern.

## Scheduling

Scheduling is **optional**. Omit `schedule:` entirely for a manual-only
task: the source still parses, still runs with `akm task run`, and
`akm task sync` silently contributes zero scheduler bindings for it (no OS
entry, no failure) rather than rejecting the source for missing a trigger.

```yaml
version: 4
name: Nightly review
run: akm improve --strategy default
schedule:
  - cron: "@daily"
    enabled: false
```

A bare string (`schedule: "0 8 * * 1"`) is shorthand for one enabled
binding with no inputs. A list entry may set its own `enabled` (default
`true`) and literal `inputs`; those literals are validated against the
task's `inputs:` declarations both at parse time and again at
`akm task sync` (once with declared defaults applied), and are
**delivered** to the scheduled run: `akm task sync` compiles each entry's
inputs into the scheduler binding's own invocation tail
(`akm task run <id> --scheduled --<name> <value>…`, names sorted), so the
fired run receives them exactly as `akm task run <id> --<name> <value>`
would. Multiple schedule entries create deterministic scheduler bindings
for the one source task.

Task source v4 has **no document-level `enabled` flag** — enablement is
per schedule binding. Disable one binding by setting its own
`enabled: false`. `--schedule` is a required flag on every `akm task add`
invocation, `--disabled` included — not a check specific to `--disabled` —
so `akm task add --disabled` always has a schedule to write `enabled: false`
onto and never needs to reject a schedule-less task with "nothing to
disable."

`akm task run <id>` executes a task immediately, including a disabled task.
`akm task sync` validates the complete desired set before atomically
reconciling scheduler state. Scheduled invocations re-read the guarded current
task bytes; workflow targets then create a fresh durable workflow freeze.

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
    enabled: true
    inputs: { scope: all, ticket: OPS-1234 }
timeout: 45000
engine: reviewer
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
  `shape`, `output`, `scheduled`, `quiet`, `verbose`, `help`, `no-quiet`, or
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
  `inputs:` mapping is present but incomplete — including one written
  `enabled: false`, so enabling it later can never turn a parsed document
  unrunnable. `akm task sync` keeps its own equivalent check over the
  defaulted values and still rejects the whole desired set before touching
  any scheduler state. Give every schedule entry an explicit value for the
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
- A task source v4 document **can** be the target of a workflow step's
  `uses: tasks/<ref>` — see the
  [GitHub-shaped YAML subset](workflow-schema.md#github-shaped-yaml-subset)
  for how a workflow step's `with:` binds a v4 task's declared `inputs:`.

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
Those two surfaces are a *different* delivery path: they exist only when a
**workflow step** composes this task through `uses: tasks/<ref>` and a
`with:` binding, resolved fresh for that step's own dispatch — see
[`with:` on a task-composed step](workflow-schema.md#github-shaped-yaml-subset).
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

> A secret-shaped **input default** (as opposed to a supplied value) is
> redacted the same way, but its accompanying explanation currently reuses
> workflow-parameter wording that does not quite fit a task input — treat
> the redaction itself as reliable even where the prose reads oddly.
> `akm task run --<name> <secret-looking-value>` never echoes the offered
> value in its error envelope, whether the value fails typed-flag coercion
> or fails the declared schema (an `enum`/`minimum`/`maximum` mismatch
> included) — both paths report only the violated constraint.

## Migrating to task source v4

`akm migrate status` and `akm migrate apply [--dry-run]` run **both**
migration generations against your task tree in one pass: task-v2 → task-v3
first, then task-v3 → task source v4 against the resulting files. Each
generation keeps its own lock, backup, prevalidation, and rollback — a file
blocked in the first generation does not stop the second generation from
converting files that are already `version: 3`.

```sh
akm migrate apply --dry-run
akm migrate apply
```

The planner reports every input file as `changed`, `skipped`, or `blocked`,
for both generations combined. Resolve every blocked file manually, then
preview again. Apply validates a complete replacement before writing and
backs up each original immediately before replacement.

Common v2 → v3 blocked reasons and what to do about each — these need a
hand-authored replacement, not a re-run; see [the 0.9.1 to 0.9.2 migration
guide](../migration/v0.9.1-to-v0.9.2.md#v2--v3-blocked-cases) for the full v2
to v4 field mapping (`command:` array → `run:` + `shell:`, `timeoutMs:` →
`timeout:`, document-level `enabled:` → per-`schedule:`-entry `enabled`):

| Reason | Meaning | Fix |
|---|---|---|
| `argv-array-has-no-portable-shell-string` | The task's `command:` is an argv array; no single shell string is provably equivalent. | Rewrite the file by hand — a `run:` string plus `shell:` — using the field mapping above. |
| `shell-quoting-changes-v2-whitespace-split-semantics`, `shell-operators-change-v2-literal-argv-semantics`, `shell-command-resolution-changes-v2-literal-argv-semantics` | The `command:` string contains quoting, shell operators, or a bare executable name whose v2 argv-exec behavior a v3 `run:` (host-shell) invocation cannot reproduce unambiguously. | Review the command's intended shell semantics and author the v3/v4 `run:`/`shell:` fields by hand. |

Common v3 → v4 blocked reasons and what to do about each:

| Reason | Meaning | Fix |
|---|---|---|
| `github-action-target-removed` | The task's `uses:` is a GitHub Action locator (`owner/repo[/path]@ref`); that spelling has no task source v4 equivalent. | Rewrite the target as `commands/`, `scripts/`, `workflows/`, or `akm/command` by hand. |
| `with-on-non-command-target` | A `with:` block is authored on a target other than `uses: akm/command`. | Task-call inputs are declared and bound separately in v4 — author `inputs:` on the task and, if it is a workflow step's own composition, bind them with the step's `with:` instead. |
| `ambiguous-scheduling-source` | The document declares both `akm.schedule` and `on:`. | Pick one; the migrator will not guess which one wins. |
| `enabled-false-has-no-schedule-entry` | `akm.enabled: false` with no cron trigger to attach it to (the only trigger is `on.workflow_dispatch`). | Task source v4 has no document-level `enabled` flag — decide whether the task should be scheduled (add a cron) or left manual-only (drop `akm.enabled`), then re-run. |
| `read-only-source` | The owning source or file is not writable. | Move or re-source the file somewhere writable, or edit it by hand. |
| `invalid-v3-task` | The v3 document itself is structurally invalid (unknown fields, missing selector, malformed trigger, etc). | Fix the underlying v3 document first — the migrator translates structure, it does not repair it. |
| `generated-v4-validation-failed` | The converted bytes fail the real task source v4 parser; the detail carries the parse error. | Read the detail — it names the offending field and why v4 refuses it — then fix that field in the v3 file and preview again. |

The migrator translates structure, never intent: it never invents an
`inputs:` declaration on a file's behalf, regardless of how inferable a
`with:` value's shape looks — declaring `inputs:` (and rewriting a step to
bind it) is left to the person editing the migrated file by hand.

A `changed` file can still carry an informational **notice** alongside its
converted bytes, for a translation that is faithful but not one-to-one. Each
notice is reported on that file's own plan entry, and it is the only record of
a field the migrator resolved by dropping rather than rewriting — read them.
Two cases produce one today:

- **`akm.outputSchema` on a `run:`, `uses: scripts/`, or `uses: workflows/`
  target is dropped, not hoisted to `output:`.** v4 accepts `output:` only on
  a command target (`uses: commands/<ref>` or `uses: akm/command`) — the only
  kinds whose runtime enforces it — and on the other three v3 never enforced
  it either, so nothing enforceable is lost. The file migrates as `changed`
  with a notice naming the dropped field; it is not blocked, and there is
  nothing to edit by hand first. If you *wanted* that schema enforced, move
  the work behind a command target and author `output:` there.
- **`on.workflow_dispatch` with no `on.schedule` drops silently**, since every
  v4 task is runnable manually with `akm task run` whether or not it has a
  `schedule:`. The migrated document simply has no `schedule:` key.

The migrator is also installed as its own executable, `akm-migrate`, with the
same `status` / `apply [--dry-run]` surface; `akm migrate` wraps it, and
`akm upgrade` runs `apply` after installing a release. A tree that is already
all `version: 3` simply reports the first generation as current.

See the [0.9.1 to 0.9.2 migration guide](../migration/v0.9.1-to-v0.9.2.md#migrating-task-v3-to-task-source-v4)
for full before/after examples and recovery guidance.

## Operations

- `akm search --type task` (or its alias `akm task list`) and
  `akm show tasks/<id>` inspect task assets.
- `akm task explain <ref>` prints a task's declared inputs, resolved target,
  effective execution settings, and schedule bindings without running
  anything — see [`akm task explain`](#akm-task-explain) above.
- `akm task validate <path>` parses one task file by filesystem path (the
  file need not live in a configured bundle) and reports the same
  `valid`/`converts`/`blocked`/`invalid`/`not-a-task` diagnostic
  `akm task sync` would produce for it — including sync's own cron-dialect
  check and its per-schedule-entry input-contract check — without touching
  the scheduler and without requiring a configured engine, even for a
  command-kind task. The envelope's own `sourceVersion` field names the
  file's originally declared schema version (2, 3, or 4).
- `akm task add` writes a task source v4 document and installs it after
  validation. `--params` renders typed `inputs:` declarations instead of a
  `with:` bag; `--schedule` is required on every invocation, and
  `--disabled` writes `schedule: [{cron: …, enabled: false}]` instead of a
  document-level flag.
- `akm task history` reads durable run history from `state.db`.
- Disable a binding by editing the source and syncing: set that schedule
  entry's own `enabled: false`.
- Delete the `.yml` source and sync to remove its derived binding(s).
- `akm task sync --dry-run` previews the reconcile (adds/updates/removes,
  removals annotated with their owning bundle) without writing to the
  scheduler; exits non-zero when removals are pending.
- `akm task prune` removes installed scheduler entries `sync` cannot reach
  because their own descriptor no longer resolves to a live bundle
  (corrupt/missing `--scheduler-context`, or the owning bundle directory is
  gone). It never touches an entry that still resolves to a live bundle.
  Defaults to a dry-run preview (zero writes); `--yes` executes it; `--id
  <id1,id2,...>` scopes to specific ids and refuses any id that isn't a
  current orphan candidate.
- Use `akm task sync --rebind` only when deliberately changing the captured
  AKM runtime, then verify with `akm task doctor`.

Scheduler execution is at least once. Backends provide a stable invocation
identity and AKM fences stale attempts, but an ambiguous process crash can be
observed only after the external work has started. Make scheduled side effects
idempotent where possible.

## Task v3 (retired): grammar reference for migration

Nothing in this section is accepted by `src/` in this release — it exists
only so you can read an already-authored `version: 3` file while deciding
how to migrate it. The v3 grammar used an `akm:` options bag, an `on:`
trigger block, and exactly one required scheduling source:

```yaml
version: 3
name: Nightly review
uses: workflows/nightly-review
with:
  strict: true
akm:
  schedule: "0 4 * * *"
  enabled: true
  timeout: 30m
```

or, with the GitHub-shaped local trigger subset:

```yaml
version: 3
uses: commands/review
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch: {}
```

`with:` on any `uses:` target carried v3's untyped params bag (workflow
refs consumed it as run params; command/script refs rejected it outright).
A GitHub Action locator (`owner/repo[/path]@ref`) was a recognized `uses:`
shape that was always rejected before dispatch — remote action acquisition
was never implemented in any akm release. `akm.enabled: false` disabled the
whole document, not a specific schedule binding.

See [Migrating to task source v4](#migrating-to-task-source-v4) above to
convert a file out of this grammar.

## See also

- [CLI Reference: task](cli.md#task)
- [Scheduling guide](https://github.com/itlackey/akm/blob/main/docs/guides/scheduling.md)
- [Workflow source formats](workflow-schema.md)
- [Data and telemetry](data-and-telemetry.md)
