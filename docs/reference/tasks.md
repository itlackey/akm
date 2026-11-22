# Tasks

Task assets are strict, local automation sources. They live at
`<bundle>/tasks/<id>.yml` and can be run directly or reconciled to cron,
launchd, or Windows Task Scheduler with `akm doctor scheduler sync`. The task file is
authored source; scheduler entries are derived OS state. Import a task file
with `akm import <file> --type task`, run a task with `akm run
<bundle>//tasks/<id>`, and diagnose with `akm doctor`, `akm doctor explain
<ref>` and `akm doctor log --task <id>`. The older `akm task add | run | sync |
prune | doctor | explain | history` commands are Deprecated, removed in 0.11;
see the [migration guide](../migration/v0.10-to-v0.11.md#task-and-import-consolidation).

> **Changing in 0.11.** 0.11.0 replaces task source v4 with
> [task source v5](#task-source-v5-experimental), which also takes over ordered
> steps from the Deprecated workflows, and `akm migrate apply` converts v4
> files. Task source v4 works unchanged through 0.10.x. See
> [Workflows fold into tasks](../migration/v0.10-to-v0.11.md#workflows-fold-into-tasks).

## Task source v5 (Experimental)

Task source v5 is Experimental through 0.10: a file says `version: 5-beta.1`,
and a build reads only the beta it ships with (`5-beta.<n>`; `n` goes up only
when the syntax changes). Any other `5-beta.*` is refused before anything runs,
naming the one the build reads. 0.11 releases it as `version: 5` and refuses
`version: 4`. A file with `version: 4` keeps the v4 syntax and behaviour
described below until then. `akm migrate apply <task-file>...` converts named
files; see [Converting v4 to v5](#converting-v4-to-v5).

**A task is a list of akm commands, written down and run in order.** A step is
one command: `run:` is `akm run`, `exec:` is `akm exec`, `prompt:` is
`akm exec --prompt`. A step's other keys are that command's own options, with
the same names and meaning. `run` runs only what a ref names, a known asset.
`exec` runs anything on demand, a shell line or a prompt written in the task,
without some of akm's protections.

A task behaves the same whoever starts it: a schedule, a person, an agent, or a
step of another task. A run shares nothing akm manages with any other run: not
its state, results, environment, working folder or resume record. Any number of
runs of a task can go at the same moment unless the task has `lock: true`.

```yaml
version: 5-beta.1

inputs:
  date: { type: string, required: true }

env:                              # for every step
  - LOG_LEVEL: info

timeout: 10m                      # for every step: --timeout 10m

steps:
  - name: fetch
    run: scripts/fetch.ts         # akm run scripts/fetch.ts --date <date>
    args: [--date, "${date}"]
    env: [env/service]            # --env env/service, for this step only
    timeout: 2m                   # --timeout 2m, for this step instead
    max-retries: 1                # --max-retries 1

  - name: summarize
    prompt: |                     # akm exec --prompt "..."
      Summarize this report for ${date}:
      ${fetch}

  - name: count
    exec: wc -l < report.md       # akm exec -- "wc -l < report.md"

  - name: tell
    run: tasks/post-message       # akm run tasks/post-message --message "..."
    args: [--message, "${summarize}"]
```

### A step

A step has a `name` (letters, digits, `_` and `-`; unique; not the name of an
input) and is exactly one command:

| Step | The command |
| --- | --- |
| `run: <ref>` | `akm run <ref>`. The ref names a task, a prompt asset (`commands/...`), a script (`scripts/...`) or an agent, in this bundle or another (`team//scripts/fetch.ts`). Only a ref: a script with no ref is run with `exec:`. An agent's ref needs `prompt:` beside it. |
| `exec: <command>` | `akm exec -- <command>`: any program or shell line. |
| `prompt: <text>` | `akm exec --prompt <text>`: prompt text sent to an agent. Beside `run: <agent ref>` it is that agent's prompt. |

Its other keys are the command's options:

| Key | Option | On |
| --- | --- | --- |
| `args:` | What follows the ref on the command line, as a list. Each item is one argument, passed as written, with no shell. For a task they are its input flags, `--<name> <value>` pairs | `run:` a task or a script |
| `arguments:` | `--arguments` | `run:` a prompt asset |
| `env:` | A list. An entry is an env asset's ref, as `--env <ref>` takes, or one variable and its value (`NAME: value`) | any step |
| `secret:` | `--secret <ref>:<VAR>`, a list | any step |
| `cwd:` | `--cwd` | any step |
| `timeout:` | `--timeout`: `90s`, `15m`, `1h`, `7d`; a bare number is milliseconds; at most 24 days | any step |
| `max-retries:` | `--max-retries`: a step that fails is run again, this many more times at most, whatever made it fail. Each try has the step's whole limit. A step that runs a task is tried again by resuming that task's run at the step that failed there | any step |
| `harness:`, `connection:`, `model:` | the same flags | a step an agent runs; elsewhere warned about once and ignored |
| `inherit:` | `--inherit`, a list of variable names | any step |

An option at the top of the task file is the default for every step. `timeout:`
at the top is each step's limit, not the whole run's; a step with neither has a
limit of 30 minutes. The whole run is limited by `--timeout` when it is started
or by the `timeout:` of the step that runs it. `--max-retries` and `--inherit`
given when a run is started are the default for every step of the run and of the
tasks it runs.

Two keys are a step's own and have no flag: `name`, and `expect:`, a list of
keys the agent's reply must hold as a JSON object. A reply that lacks one is
asked for once more with what was missing, then fails the step with
`reply_check_failed`. With `expect:`, the step's result is that JSON object.

A value that contains `: ` is quoted or written as a block (`|`), as YAML
requires. So is a `${name}` inside `[ ]`: `[--date, "${date}"]`.

A failed step stops the run. A task that is one command has no `steps:`, just
`run:`, `prompt:` or `exec:` and its options; that one step adds no entry to
the state, and its result is the task's result. A key a command does not take
is warned about once and ignored. A task file may also have `name`,
`description`, `when_to_use` and `tags`, which the index reads.

### Inputs, results and `${name}`

**Inputs.** `inputs:` declares the task's own flags: each is a JSON schema,
usually just a `type`, with a `default` or `required: true`; one with neither is
optional, and its `${name}` is empty text when it is not given. Text given for a
`number`, `integer` or `boolean` input is converted; a value that does not fit
its input is refused before anything runs. An input may not be named like one of
`akm run`'s own flags. Inputs are given by `akm run <task> --<name> <value>`, a
schedule entry, or the `args:` of the step that runs the task.

**Results and the state.** A step's result is what its command prints on
standard output, or the agent's reply, as text. An agent that gives no reply has
failed. The result is added to the run's state under the step's name. A task's
result is its last step's; `akm run` returns it as `result` in the `task-run`
output.

A failed script or `exec:` step's reason is `non_zero_exit: exit code N`, with
the last line its program wrote to standard error after it when there is one;
`timeout` and `aborted` stand alone. A failed agent step's reason is akm's reason
code and the error as plain text, with no terminal escapes
(`parse_error: "default" returned no answer.`; for a harness that exited with an
error, `non_zero_exit: agent CLI "claude" exited with code 3: Error: boom`, ending
with the harness's own last line). The run's history and `akm doctor explain` name each step's kind by the
key the step is written with: `run`, `exec` or `prompt`.

**`${name}`.** `${name}` names an input or an earlier step. akm fills it in
once, inside the text of `prompt:` or `arguments:`, or as a whole item of
`args:`, which is then one argument whatever it holds. Text goes in as it is;
anything else goes to a script or a prompt as JSON, and to a task as the value
itself. A script that takes options should expect such an argument to begin with
`-`. akm fills it in nowhere else. A `${name}` that names an input or a step in
an `exec:` command, an `env:` value or a `cwd:` is refused before anything runs,
because a value put into a command could be run as one; the command reads the
state file instead. Anything else in `${...}` in an `exec:` command is the
shell's own and is left alone.

**The state file.** A script or `exec:` command reads the whole state, the
inputs and every earlier step's result under their names, as JSON from the file
named by the environment variable `AKM_TASK_STATE`. The file has no size limit.
It is a copy written fresh for each step and removed when the step ends. akm
sets `AKM_TASK_STATE` for a step it runs as a process; akm does not read it.

### The environment

A script step or an `exec:` step starts with the environment `--clean` gives
(`PATH`, `HOME`, the user, shell, temporary folder, locale, time zone and
terminal, and what Windows needs), akm's own location variables
(`AKM_CONFIG_DIR`, `AKM_CONFIG_FILE`, `AKM_DATA_DIR`, `AKM_CACHE_DIR`,
`AKM_STATE_DIR`) and `AKM_EVENT_SOURCE`. Nothing else reaches such a step unless
it is given by name, and where it is given decides which steps have it.

An agent step (`prompt:`, or `run:` of an agent or command) runs your harness as
you would run it yourself: it starts with akm's environment as it is, with the
directories this akm resolved and `AKM_EVENT_SOURCE` set over it, and the `env:`
and `secret:` below are set over that. `inherit:` has nothing to add to an agent
step.

| Given | Which steps have it |
| --- | --- |
| `env:`, `secret:` or `inherit:` on a step | That step only |
| `env:`, `secret:` or `inherit:` at the top of the task | Every step of that task, not the tasks it runs |
| `--env` or `--secret` when the run is started | Every step of the run and of the tasks it runs |

Where more than one sets the same variable, the run's `--env` and `--secret` win
over the step's, which win over the task's. A task that another task runs is a
run of its own, with its own state, options and working folder; the caller's
`env:` does not pass to it. Secrets and their redaction are in
[Environment & Secrets](env-and-secrets.md#secrets-in-a-version-5-task).
`experimental.exec` does not gate a task's `exec:` and `prompt:` steps; it
guards `akm exec` typed at a prompt.

### The working folder

akm makes an empty folder for each run at `$AKM_STATE_DIR/runs/<task>/<run>/`
and every step of the run works in it, so steps share files there. akm removes
it when the run succeeds and keeps it while a failed run can be resumed; when a
later run of the task succeeds, the folders of its earlier failed runs go too
and those runs cannot be resumed.

`cwd:` on the task, or `--cwd` when the run is started, names another folder,
which akm makes if it is missing and never removes; `--cwd` wins over the task's
`cwd:`. A step's own `cwd:` is for that step only and wins over both. A `cwd:`
that is not absolute is taken from the bundle root; a `--cwd` that is not
absolute is taken from the folder akm was started in. A path that exists and is not a
folder, or a folder that cannot be
made, refuses the run, or fails the step it is the step's. What a step runs is
found whatever the folder is, because it is named by ref. A script that writes
somewhere else needs that folder named as the working folder for an agent step
to read what it wrote.

### Lock, schedules and resume

**Lock.** `lock: true` gives a task one run at a time, whoever starts each. A
start that finds the lock taken starts nothing and records nothing. `akm run`
then exits 75, or 0 when it was started with `--scheduled` or
`--skip-if-locked`. When the start came from a step of another task, that step
fails like any other. A task without `lock:` is not locked.

**Schedules.** A task file's `schedule:` entries say when it starts and give its
`inputs:`, as in v4. An entry may also have `env:` (env asset refs), `secret:`
and `timeout:`, which are what `--env`, `--secret` and `--timeout` are to a start
that is typed; a whole scheduled run's limit is given there.

**Resume.** `akm run <task> --resume` continues the most recent failed run at the
step that failed; steps that finished are not run again. It uses the flags the
run was first started with (`--env`, `--secret`, `--cwd`, `--timeout`, and the
inputs); the limit counts again from the resume. `--resume` with any input or
start flag other than `--skip-if-locked` and `--scheduled` is refused, naming
each, because the run keeps the ones it started with. It also refuses when the
task's steps changed since the failed run, or when a step the failed run had
finished has a different definition now. If the step that failed was running a task,
the resume continues inside that task's run, at the step that failed there. A
run that a step started is resumed only by resuming its caller. A run
whose akm was killed is a failed run at the step that was running: history shows
it as `interrupted` as soon as akm can see that its process is gone, naming the
step.

akm keeps what a failed run needs to resume beside its working folder, at
`$AKM_STATE_DIR/runs/<task>/<run>.state.json`, and removes it with the folder.
It is outside the folder the steps work in.

### Runs of other tasks

- Tasks may not run each other in a loop, directly or through other tasks.
- A task cannot read the state of another run. It gets another task's result
  only by running it from a step.
- A v5 task does not run a v4 task, and a v4 task's `task:` step does not run a
  v5 task; either is refused naming `akm migrate apply`.
- An akm command never waits for akm's index, in a step or typed: it skips its
  own build when another is running and goes on with the index as it stands. See
  [`akm index`](cli.md#index).

### Checked before anything runs

akm reads the task, and every task it runs, all the way down, and refuses to
start if any rule fails. `akm run <task>` and `akm doctor explain <ref>`, given
the same inputs and flags (`--env`, `--secret`, `--timeout`), call the same
check, as does `akm doctor scheduler sync` for each schedule entry. `akm lint`
checks the one file, the rules that need nothing else. A task file that is not
valid refuses only itself and the tasks that run it, not the other tasks of its
bundle.

- The file is not valid YAML, or a key has the wrong shape.
- A required input was not supplied, an input was supplied that the task does
  not declare, a value does not fit its input, or an input is named like one of
  `akm run`'s flags.
- A step is not exactly one command, or gives an option a value it does not take.
- A `run:` value is not a ref, names nothing akm can run, or names an asset that
  does not exist. A script's program is found from its `#!` first line, or from its extension.
- A step has no name or an invalid one, two steps share a name, or a step has the
  name of an input.
- A `${name}` in `prompt:`, `arguments:` or `args:` is neither an input nor an
  earlier step; in `args:` it must be a whole item.
- The `args:` of a step that runs a task are not `--<name> <value>` pairs.
- A `${name}` that names an input or a step appears in an `exec:` command, an
  `env:` value or a `cwd:`.
- A secret is written anywhere but `secret:`: a `${secrets/...}` in a command, a
  prompt, `args:` or an `env:` value.
- An `env:` entry or a `secret:` names an env asset or a secret that does not
  exist.
- Tasks run each other in a loop.

### Converting v4 to v5

`akm migrate apply <task-file>...` converts the named v4 files to
`version: 5-beta.1` after the same check a start makes of the result, keeping
each file's comments with the key they were on. In 0.10 a file not named on the
command line is not converted; 0.11 converts every v4 task file. The
[migration guide](../migration/v0.10-to-v0.11.md#task-source-v5) has the
conversion table and lists what does not convert. `akm migrate status
<file>...` reports what apply would do with the named files and changes nothing.

`akm migrate apply workflows/<name>.md` makes `tasks/<name>.yml` from a named
workflow file, which stays in place, after the same check; each prose step becomes
a `prompt:` step and each plain exec step an `exec:` step. A workflow it cannot
convert is reported `blocked` with `guidance`. Delete a workflow file once its
task works; `akm doctor` and `akm migrate status` count the workflow files that
remain, by bundle. See
[Converting a workflow](../migration/v0.10-to-v0.11.md#converting-a-workflow).

## Task source v4

**Task source v4 (`version: 4`) is the task source grammar akm reads for every file that is not `version: 5-beta.1`.**
A document with `version: 3` or `version: 2` fails to load with `UsageError`
code `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming `akm migrate apply`, which
converts it. A `version: 4` document whose `schedule[]` carries a
per-entry `enabled` key fails with `TASK_SOURCE_INVALID` (activation is
host-local, below). Each such file fails on its own:
`akm doctor scheduler sync` reports it and keeps reconciling every other task. Task
source v4 adds typed `inputs:` and a single bounded `output:` schema
(command targets only), and makes scheduling OPTIONAL rather than
mandatory. `akm import <file> --type task` imports a task source v4 file.

If you have `version: 3` or `version: 2` files on disk (from an earlier
akm release), see [Migrating to task source v4](#migrating-to-task-source-v4)
below — `akm migrate apply` converts both generations in one pass and
rewrites the file on disk (`akm upgrade` runs it after an install). The
retired v3 grammar itself is documented at the bottom of this page
([Task v3 (retired): grammar reference for migration](#task-v3-retired-grammar-reference-for-migration))
purely so you can read an old file while migrating it; it is no longer
accepted as a standing grammar by any command in this release.

## Files and schema

The only recognized task extension is `.yml`. A `.yaml` near miss is never
indexed, scheduled, or run. Every task should declare `version: 4`; a
document with no `version:` key, or a `version:` that is not a number,
fails with `TASK_SOURCE_INVALID` (`must be exactly 4.` / `is required and
must be exactly 4.`) — a genuinely malformed v4 document, not a legacy one.
`version: 3` and `version: 2` fail with `TASK_SCHEMA_VERSION_UNSUPPORTED`
naming `akm migrate apply` (see
[Migrating to task source v4](#migrating-to-task-source-v4)).
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
exclusive. (Experimental: `steps:` is a third selector, see [Steps](#steps-experimental).)

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
| `scripts/<name>.<ext>` | No `with`; declare `inputs:` for typed parameters | Allowed for the child process | First line, then the closed extension table below |

A script runs the way its `#!` first line says: the program the line names and its
one argument (`#!/bin/bash -e`, `#!/usr/bin/env -S bash -eu`), then the file. akm
ignores a carriage return that ends the line, searches a bare program name on
`PATH`, and runs a first line that names `bun` on the Bun akm runs on (a
standalone binary ignores the words after `bun`; a Node build runs the line as
written). A script with no first line uses this closed table, and any other
extension fails before dispatch, saying to add a first line. Windows has no `#!`
lines, so there the table always decides:

| Extensions | Program |
|---|---|
| `.sh` | `sh` |
| `.ts`, `.js`, `.mjs` | Bun; JavaScript and TypeScript script targets require Bun (the standalone binary uses its embedded Bun runtime) |
| `.ps1` | `pwsh -NoProfile -NonInteractive -File` (`powershell` on Windows) |
| `.cmd`, `.bat` | `cmd /d /s /c` |
| `.py` | `python3` (`python` on Windows) |
| `.rb` | `ruby` |
| `.go` | `go run` |
| `.pl` | `perl` |
| `.php` | `php` |
| `.lua` | `lua` |
| `.r` | `Rscript` |
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
bundle; the task freezes that file's bytes, not its location. With no first line, the
program comes from the name the script has in the bundle, not from the file the link
points to, so `scripts/deploy.sh` linked to `real-script.txt` runs under the
shell.

Every field that used to live under v3's `akm:` options bag is a top-level
key in task source v4: `agent`, `connection`, `harness`, `model`, `inference`, `timeout`,
`redact`, `maxSteps`, and `maxRetries`, plus `description`, `when_to_use`, and
`tags`. A v3 `akm.tools` is dropped by the migration, and a v4 `tools` is
ignored with a warning. Environment entries (`env`) are literal string,
number, or boolean values. Keep credentials out of task source; `redact`
contains environment variable names, never secret values.

`timeout:` (milliseconds, or the `--timeout` grammar: `500ms`, `30s`, `5m`, `1h`,
`7d`; at most 24 days) means a different mechanism depending on the
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
`akm run` exits non-zero for it; see [health-advisories.md's
`task-fail-rate` row](../architecture/internals/health-advisories.md)
for how `akm doctor` surfaces a timeout-dominant failure pattern.

## Scheduling

Scheduling is **optional**. Omit `schedule:` entirely for a manual-only
task: the source still parses, still runs with `akm run`, and
`akm doctor scheduler sync` silently contributes zero scheduler bindings for it (no OS
entry, no failure) rather than rejecting the source for missing a trigger.

```yaml
version: 4
name: Nightly review
run: akm improve --strategy default
schedule:
  - cron: "@daily"
```

A bare string (`schedule: "0 8 * * 1"`) is shorthand for one trigger with
no inputs. A list entry may set literal `inputs`; those literals are validated against the
task's `inputs:` declarations both at parse time and again at
`akm doctor scheduler sync` (once with declared defaults applied), and are
**delivered** to the scheduled run: `akm doctor scheduler sync` compiles each entry's
inputs into the scheduler binding's own invocation tail
(`akm task run <id> --scheduled --<name> <value>…`, names sorted), so the
fired run receives them exactly as `akm run <bundle>//tasks/<id> --<name> <value>`
would. Multiple schedule entries create deterministic scheduler bindings
for the one source task.

Task source v4 has **no enablement flag**. A source describes what may run;
it cannot authorize its own host scheduling. Activation is this host's list of
fully-qualified refs in `config.json` under `scheduler.enabled`. A ref that
is not listed is disabled. A config with no list at all (written before
0.9.17) means "keep what is installed": the first sync fills the list from
the akm-written native bindings. Use `akm task enable <bundle>//tasks/<id>`
and `akm task disable <bundle>//tasks/<id>` to change the list and
immediately sync the affected bundle. The Deprecated `akm task add` enables its new
task by default (`--disabled` writes it without listing it); `akm import <file>
--type task` imports it disabled, and `akm task enable` turns it on. `import`
writes `scheduler.enabled` deliberately: it captures the legacy activation
first and keeps the new ref out, so a stale scheduler row cannot activate the
new task.

`akm run <bundle>//tasks/<id>` executes a task immediately, including a disabled task.
`akm doctor scheduler sync` scans every enabled configured bundle, reads only locally
activated task/workflow refs, and reconciles the native scheduler one row at a
time (see [Operations](#operations)). `--bundle <name>` narrows that pass to
one active bundle. If every configured bundle is disabled, sync removes the
attributable native entries without reading task content. Workflow targets
create a fresh durable workflow freeze at fire time.

## Steps (Experimental)

First in 0.10.261121 ([#1096](https://github.com/itlackey/akm/issues/1096)):
a v4 task may declare `steps:` instead of `uses` or `run` (exactly one of the
three). Nothing changes for a task without `steps:`. 0.11 replaces it with
[task source v5](#task-source-v5-experimental), where `akm migrate apply`
converts it.

```yaml
version: 4
name: Lab status plan
inputs:
  date: { type: string, required: true }
schedule: "30 6 * * *"
timeout: 10m          # the default timeout of each step
harness: scheduled    # the default runner of each prompt step
shell: bash           # the default shell of each run step
env: { LOG_LEVEL: info }
steps:
  - name: fetch-status
    run: bun scripts/lab-status/fetch-status.ts
    env: { REGION: eu }
    retries: 1
  - name: write-plan
    prompt: commands/lab-status/write-plan   # or inline text
    expect: [title, actions]
  - name: save-plan
    run: bun scripts/lab-status/save-plan.ts
  - name: notify
    task: tasks/notify-discord
```

- **Step keys.** `name` (letters, digits, `_`, `-`; unique; at most 32 steps)
  and exactly one of `run`, `prompt`, `task`. `env` (literal values, merged
  over the task's `env`), `timeout` (the v4 grammar; unset uses the task's, then
  the unattended default) and `retries` (0 to 5, a plain count) apply to every
  step. `harness`, `connection`, `model` and `expect` apply to prompt steps.
  `uses`, `run`, `with`, `output`, `maxSteps` and `maxRetries` are not legal
  next to `steps:`; `inputs`, `schedule`, `env`, `shell`, `working-directory`,
  `timeout`, `redact` and the execution keys are, and act as defaults.
- **Values.** The task's `inputs:` reach every step as `AKM_PARAMS`, as
  canonical JSON. Earlier steps' results reach it as `AKM_STEPS`, JSON keyed by
  step name (`{}` for the first step). `AKM_INPUTS` is never set. A prompt step
  has no child environment on a direct-model connection, so it gets the same
  two values appended to its prompt as text. To load an env asset in a run
  step, run a script with `akm run --env env/<name> scripts/<file>`.
- **Results.** A `run` step's result is its stdout; a prompt step's is the
  agent's reply; a `task` step has no result, and its callee gets no values.
  A text result is kept to 32 KiB, and the serialized `AKM_STEPS` may not
  exceed 96 KiB. With `expect`, the result is the parsed JSON object, so
  `AKM_STEPS` holds an object for that step and strings for the others.
- **Reply check.** `expect: [field, ...]` on a prompt step: the reply must be a
  JSON object (code fences and surrounding prose are tolerated) holding those
  keys. The agent is told so through the usual output-schema instruction. If the
  reply lacks a key, akm asks once more with what was missing, then fails the
  step with `reply_check_failed`. The re-ask does not count against `retries`.
- **Failure and resume.** The first step that still fails after its retries
  stops the run; later steps are recorded as `skipped`. `akm run <task-ref>
  --resume` restarts at the first step the latest failed run did not complete,
  reusing the earlier steps' stored results. Pass the inputs again as for any
  run. It refuses when there is no failed steps run or the step names changed.
  `resume` is a flag of a steps task only, so such a task may not declare an
  input of that name.
- **Overlap.** A steps task takes a lock for the run (a file under the state
  directory, released when the process ends). While another run of it is alive,
  a manual `akm run` fails with `RUN_LEASE_HELD` and a scheduled run exits 0
  without a history row. There is no flag.
- **History.** One `task_history` row per run, as for any task, with
  `target_kind` `steps` and the steps in its metadata (name, kind, status
  `completed|failed|skipped|reused`, duration, attempts and, for a failed
  step, the reason). A failed run also keeps each
  completed step's bounded result for `--resume`; a successful run drops them.
- **Scheduling.** Unchanged: `schedule:` and `akm task enable` / `disable`
  work as for any task, and `akm doctor explain <ref>` lists the steps.
- **A `task:` step** must name a task that does not itself declare `steps:`
  (checked before any step runs); it runs as its own task, with its own history
  row.

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
  `shape`, `output`, `scheduled`, `quiet`, `verbose`, `help`, `no-quiet`, or
  `no-verbose`. Parsing rejects a colliding name with `TASK_SOURCE_INVALID`
  at declaration time, since `akm task run --<name>`, `akm doctor explain
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
  `inputs:` mapping is present but incomplete. `akm doctor scheduler sync` keeps its own equivalent check over the
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
- A workflow step cannot target a task: the GitHub-shaped YAML workflow format
  that carried `uses: tasks/<ref>` was removed in 0.10. A task runs a workflow
  (`uses: workflows/<ref>`), not the other way round.

### Input flags

`akm run <bundle>//tasks/<id>` accepts one exact-name flag per declared `inputs:` entry,
mirroring a workflow's parameter flags:

```sh
akm run tasks/review --scope all --strict  # doclint:ignore
```

Flag names are task-specific — they come from that task's own `inputs:`
declarations — so they are not listed on `akm run --help` and the
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
**discarded**. `akm run`'s own flags never populate an
`AKM_TASK_INPUTS` environment variable or a `## Task inputs` prompt block.
Those two surfaces existed only for a workflow step composing a task through
`uses: tasks/<ref>`, which was removed in 0.10.
A scheduled run (`schedule[].inputs`, above) reaches the target through this
same task-run path, so it inherits the identical rule: delivered as
params for a `workflows/<ref>` target, otherwise validated and discarded.
`akm doctor explain` (below) shows the materialized values regardless of where
they end up, which is the fastest way to check what a given `akm run`
invocation would actually deliver. The Deprecated `akm task add --params` renders
`--params` values as typed `inputs:` declarations with `default:` values
(typed from each JSON value's runtime type), not a `with:` bag.

<a id="akm-task-explain"></a>

### `akm doctor explain`

`akm task explain` and `akm workflow plan` are Deprecated, removed in 0.11; this
command replaces both.

`akm doctor explain <ref> [input flags]` prints a task's source path and
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
akm doctor explain review --scope all  # doclint:ignore
```

`akm doctor explain`'s default output (no `--format` flag) is the **same raw
JSON** as `--format json`, byte for byte — there is nothing to lose by
piping the default form into `jq` or a script. `--format text` is a
separate renderer: it flattens the same envelope into `dotted.path=value`
lines (the same convention `akm config list --format text` uses), not a
copy of the JSON.

A secret-shaped **input default** is redacted the same way as a supplied
value. `akm run <ref> --<name> <secret-looking-value>` does not echo the offered
value in its error envelope, whether it fails typed-flag coercion or the
declared schema (an `enum`/`minimum`/`maximum` mismatch included); both paths
report only the violated constraint.

## Migrating to task source v4

`akm migrate status` and `akm migrate apply` run **both**
migration generations against your task tree in one pass: task-v2 → task-v3
first, then task-v3 → task source v4 against the resulting files. Each
generation keeps its own lock, backup, prevalidation, and rollback — a file
blocked in the first generation does not stop the second generation from
converting files that are already `version: 3`.

```sh
akm migrate status
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
`timeout:`). Source-owned `enabled` fields are removed; native bindings that
are provably enabled seed the host-local activation list:

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
  v4 task is runnable manually with `akm run` whether or not it has a
  `schedule:`. The migrated document simply has no `schedule:` key.

The migrator is also installed as its own executable, `akm-migrate`, with the
same `status` / `apply` surface; `akm migrate` wraps it, and
`akm upgrade` runs `apply` after installing a release. A tree that is already
all `version: 3` simply reports the first generation as current.

See the [0.9.1 to 0.9.2 migration guide](../migration/v0.9.1-to-v0.9.2.md#migrating-task-v3-to-task-source-v4)
for full before/after examples and recovery guidance.

## Operations

- `akm search --type task` and
  `akm show tasks/<id>` inspect task assets.
- `akm doctor explain <ref>` prints a task's declared inputs, resolved target,
  effective execution settings, and schedule bindings without running
  anything — see [`akm doctor explain`](#akm-task-explain) above.
  For a version 5 task it runs the check a start makes (given the same input
  flags, `--env`, `--secret` and `--timeout`), then lists the declared inputs,
  the steps with the ref each runs, and each schedule entry with its `env`,
  `secret` and `timeout`.
- `akm lint <file> --type tasks` checks one draft task file, inside a bundle or not, without installing it; `akm lint --type tasks` checks every task in a bundle. Both report what `akm doctor scheduler sync` would refuse for a task
  file: a document that does not parse as task source v4, a version 2/3 file or
  a `version: 4` file still carrying a retired `schedule[].enabled` (the finding
  names `akm migrate apply`, which converts them), a cron the local scheduler
  backend cannot parse, and a schedule entry whose `inputs` leave a required
  input unsatisfied. It is read-only and needs no configured connection or harness.
  For a version 5 file it reports what the file alone decides (its keys, steps,
  `${name}` use, the schedule); what needs other files (that a `run:` ref, an env
  asset or a secret exists, loops) is checked by `akm doctor explain` and by a
  start.
- `akm import <file> --type task` validates a task source v4 file and writes
  it into the bundle, disabled; it never installs, updates or removes native
  scheduler entries. `akm task enable <ref>` activates it.
- The Deprecated `akm task add` validates a task source v4 document, writes it, adds its ref
  to local scheduler activation, and syncs its bundle. `--params` renders
  typed `inputs:` declarations instead of a `with:` bag; `--schedule` is
  required on every invocation. `--disabled` writes the same source but
  leaves the ref out of activation. `--force` overwrites an existing task of
  the same id; without it add refuses. Add also refuses, before writing
  anything, when the id is already scheduled from another bundle or
  installation. If the row itself cannot be installed, add fails and says so;
  the task stays written and enabled, and the next `akm doctor scheduler sync` retries it.
- `akm doctor log --task <id> [--bundle <name>] [--limit <n>]` reads durable run
  history from `state.db`. A row records the `bundle` its task is in, and
  `--bundle` shows that bundle's rows; rows written before the bundle was
  recorded have none and show under every bundle filter. Each row carries `trigger` (`schedule` when the OS
  scheduler started the run, `manual` otherwise; absent when not recorded).
  Scheduled activations that cannot resolve, parse or prepare their source record
  a failed row with `detail.reason: "task_load_failed"`, the typed error code,
  timestamps and an unknown target. The task body did not run. Interactive
  preparation errors and `task explain` remain non-mutating.
- `akm task enable <ref>` / `akm task disable <ref>` change only local
  scheduler config, then reconcile that bundle.
- Accepting a task retirement disables its host-local ref and reconciles its
  native bindings before archiving the source. If the task's own bindings are
  still installed afterwards, retirement is refused; a failure on another task
  in the bundle is reported as a warning and does not block it. A refused
  retirement leaves the source in place and the task enabled as it was; retry
  it after repairing the backend. A ref absent from local activation still
  checks native bindings, because a previous removal may have failed. If the
  native scheduler cannot be read, the ref is removed from local activation and
  the task archives with an incomplete-cleanup warning; native bindings are
  unknown, never reported as absent. A host with no `scheduler.enabled` list and
  no binding for the task is left unchanged. Accepting an accepted retirement
  again does not touch the scheduler. Reverting retirement restores source
  bytes without enabling it.
- Delete the `.yml` source and sync to remove its derived binding(s).
- `akm doctor scheduler sync` reads the installed rows once, compares each against what
  its source renders, and installs, rewrites, or removes rows one at a time.
  A row that fails to install or remove is reported in `failures` and every
  other row still applies. A source that fails to parse is reported the same
  way, and its installed row is left exactly as it is. Rows akm cannot attribute to a bundle this sync covers —
  another bundle's, another installation's (the row's `AKM_BUNDLE_DIR`
  names a different working stash), or anything outside akm's `# akm:task` markers,
  `com.akm.task.` labels, or `\akm\` task folder — are never touched. A
  Task Scheduler row is compared by the fingerprint akm writes into its
  `<Source>` plus its enabled state, so an edit made in Task Scheduler that
  keeps that fingerprint is left alone.
- `akm doctor scheduler sync` (including `--prune --yes`), `akm task enable` and
  `akm task disable` hold one lock file, `$STATE/locks/scheduler.lock`, while they read and write the native
  scheduler. A second one started meanwhile exits 75 (retry shortly); a lock
  left by a process that is no longer running is reclaimed.
- `akm doctor scheduler sync --dry-run` previews the reconcile (adds/updates/removes,
  removals annotated with their owning bundle) without writing to the
  scheduler; exits non-zero when removals are pending.
- `akm doctor scheduler sync --prune` removes installed scheduler entries a plain sync cannot reach
  because they no longer resolve to a live bundle: a row whose
  `AKM_BUNDLE_DIR` names a directory that is gone, or a row written before
  0.9.17-alpha.7 whose `--scheduler-context` descriptor cannot be read. It
  never touches an entry that still resolves to a live bundle.
  Defaults to a dry-run preview (zero writes); `--yes` executes it; `--id
  <id1,id2,...>` scopes to specific ids and refuses any id that isn't a
  current orphan candidate.
- A plain sync keeps each installed row's launcher. Use
  `akm doctor scheduler sync --rebind` only when deliberately changing the captured AKM
  runtime, then verify with `akm doctor`. When the launcher sync writes
  runs akm from a source checkout (`src/cli.ts`, a local build, or a package
  inside a git work tree), sync says so once: scheduled runs then run
  whatever the checkout holds.
- `akm doctor scheduler sync` writes one `PATH=` line inside a `# akm:env BEGIN`/`END`
  section directly above the first akm task block in the crontab (on macOS,
  an `EnvironmentVariables` entry in each plist). It is the PATH of the shell
  that ran the sync, rewritten on every crontab write and removed with the
  last akm block; cron applies it to every row below it.
- A task's row is its command plus its schedule:
  `<launcher> task run <id> --bundle <bundle> --scheduled`, and it sets its
  own environment. Every row sets `AKM_BUNDLE_DIR` to the working stash of
  the shell that ran the sync (its `AKM_BUNDLE_DIR`, or the default bundle),
  so the scheduled run uses the same working stash, `--bundle` finds a stash
  no config names, and sync tells rows of other installations sharing the
  scheduler apart. A row also sets `AKM_CONFIG_DIR`, `AKM_DATA_DIR`,
  `AKM_CACHE_DIR` and `AKM_STATE_DIR` for each directory that the shell that ran
  the sync resolved to something other than the default, whatever set it (an
  `AKM_*_DIR` variable or an `XDG_*_HOME` one); a directory that is the default is
  not set. Each backend does it its own way: a
  `VAR=value` prefix in the crontab, an `EnvironmentVariables` entry in the
  plist, a `$env:VAR='value';` assignment ahead of the command in Task
  Scheduler. A default resolves at fire time, so a scheduled run uses the same
  state, data and cache directories an interactive command does.
  Run the sync from a shell whose environment you would want scheduled.

  ```text
  15 2 * * * AKM_BUNDLE_DIR=/home/u/akm /home/u/.bun/bin/bun /home/u/.bun/lib/node_modules/akm-cli/dist/akm task run nightly --bundle work --scheduled > /home/u/.cache/akm/tasks/logs/nightly.log 2>&1
  ```

  A row whose command is over 1,000 bytes runs a wrapper script under the
  log directory instead (`sh <log dir>/.akm-cron-wrapper-<id>-<hash>.sh`);
  sync reads the script to tell which task the row runs.

  Releases 0.9.0 through 0.9.17-alpha.6 wrote a `--scheduler-context
  <file>` argument into each row instead, naming a descriptor file under
  `$DATA/tasks/context/` that held the same values. akm still applies that
  file when such a row fires, and the first `akm doctor scheduler sync` after upgrading
  rewrites each row in place: it shows as an update, keeps the row's
  launcher and schedule, and sets the values inline. A row the sync leaves as it is (its task file failed to load, or
  a `--bundle` sync did not cover it) still names its file; once
  `akm doctor` lists no binding with a `contextPath`, the old descriptor
  files are not read and can be deleted.

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
shape that was always rejected before dispatch. `akm.enabled` was source-owned
scheduling state. `akm migrate apply` removes it; migration preserves actual
host activation only when the native scheduler proves that the corresponding
binding is enabled.

See [Migrating to task source v4](#migrating-to-task-source-v4) above to
convert a file out of this grammar.

## See also

- [CLI Reference: task](cli.md#task)
- [Scheduling guide](../guides/scheduling.md)
- [Workflow source formats](workflow-schema.md)
- [Data and telemetry](data-and-telemetry.md)
