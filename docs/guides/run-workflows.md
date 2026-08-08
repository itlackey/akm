# Running Workflows

This guide walks through operating a workflow run day to day: starting or
continuing one, checking on it, resuming it after it blocks, and abandoning
one you no longer want. It assumes you already know what a workflow is; see
[Workflow Schema](../reference/workflow-schema.md) for the exact frontmatter
and body syntax, and
[Architecture: The Workflow Engine](../architecture/workflow-engine.md) for
what happens under the hood (frozen plans, dispatch, resume-without-replay).
For task/schedule-driven workflow runs — akm tasks and the OS scheduler —
see [Scheduling](scheduling.md).

## Start or continue a run

`akm workflow run <run-id|workflows/ref>` starts or continues a persisted run
and executes it until completion, failure, verification rejection,
interruption, or an explicit invocation limit. Run state is scoped to the
current project directory (nearest `.akm/config.json`, git root, bundle root,
or current directory), so the same workflow can run independently in separate
projects.

```sh
akm workflow run workflows/ship-release --version 1.2.3
akm workflow run workflows/review --changed_files a.ts --changed_files b.ts
akm workflow run <run-id> --max-retries 2 --timeout 10m
```

Parameter flags must come after the target and exactly match declared
`params` keys. Values are coerced through each parameter's JSON Schema:
repeat an array flag, pass an object or whole array as JSON, and use a bare
boolean flag for `true`. There are no hyphen/underscore aliases. Parameters
are accepted only while creating a new run — a later invocation against an
active run rejects parameter flags.

`--max-steps <n>` leaves a partial run active after at most `n` steps.
`--max-retries <n>` retries a failed step on the same run up to `n` additional
times (0 through 100). `--timeout <duration>` bounds the whole invocation and
accepts `N`, `Nms`, `Ns`, or `Nm`; bare `N` is milliseconds. A timeout or
signal abort releases the run lease without advancing the active step, so the
run remains resumable. Failed, gate-rejected, timed-out, and interrupted runs
exit nonzero.

The run freezes its plan, exact models, execution limits, parameter snapshot,
and verifier selection at creation — edits to source or config do not alter
an in-flight run. See
[Architecture: Frozen plans](../architecture/workflow-engine.md#frozen-plans)
for why.

## Check status

`akm workflow status` shows the full run state — all step statuses, notes,
and evidence — for a given run ID or workflow ref.

```sh
akm workflow status <run-id>
akm workflow status workflows/ship-release
# When given a ref, resolves to the most-recently-updated run in the current scope
```

Use this to inspect where a run is after a context window break, or to verify
all steps completed cleanly before closing a PR.

**`--units` — per-unit diagnostics.** For an orchestrated run, add `--units`
to also list the run's journaled unit rows — each unit's id, status,
`failure_reason`, and any result/error diagnostic text the row carries:

```sh
akm workflow status <run-id> --units
```

This is a **diagnostic** surface, deliberately kept out of the deterministic
artifact graph. A step's promoted artifact (what `steps.x.output` resolves to,
and what a gate judges) keeps only a failed unit's structured `failure_reason`
— never the raw error text — so step evidence stays reproducible across
resumes. When you need the human-facing *why* behind a failure, `--units`
reads the unit journal directly and shows it without ever feeding that text
back into an artifact or input hash.

## List runs in scope

`akm workflow list` shows workflow runs in the current scope.

```sh
akm workflow list              # All runs in this scope (any status)
akm workflow list --active     # Only status=active (executable) runs
akm workflow list --ref workflows/ship-release  # Runs for a specific workflow
```

`--active` filters to runs whose status is exactly `active` — currently
executable work. A `blocked` run (parked awaiting a human `akm workflow
resume`) or a `failed`/`completed` run is **not** active and is excluded, so a
script that treats `--active` output as runnable never picks one up. Blocked
runs remain listed by the unfiltered `akm workflow list` with their `blocked`
status.

**Example: see what is in flight**

```sh
akm workflow list --active
# → lists runs by workflow ref, status, currentStepId, and updatedAt
```

## Resume a blocked or failed run

```sh
akm workflow resume <run-id>
```

Flips a `blocked` or `failed` run back to `active`. Completed runs cannot be
resumed. Use `akm workflow list` to find runs by status. Once resumed,
`akm workflow run <run-id>` continues it — already-journaled units are reused
rather than replayed (see
[Architecture: Resume is journaled replay](../architecture/workflow-engine.md#resume-is-journaled-replay)).

## Abandon a run

```sh
akm workflow abandon <run-id>
```

Marks a run failed so it stops counting as active. This only changes the
run's status — `resume` can still reopen it later if you change your mind.

## Follow a run's events

There is no `akm workflow watch` (0.9.0: dropped — a foreground polling
daemon in a one-shot CLI). `akm log --run <run-id>` reads the same
`workflow_*` / `workflow_unit_*` events from the general append-only events
stream: `--since '@offset:<id>'` gives a durable row-id cursor a cooperating
process can poll from, in place of `watch --stream`'s in-process loop.

```sh
akm workflow run <run-id> &                                  # engine in one shell
akm log --run <run-id> --since '@offset:0'                   # backlog so far
akm log --run <run-id> --since '@offset:<nextOffset>'        # poll for more, from the prior call's nextOffset
```

Event metadata is ids/status/enums only — never workflow-authored content —
so following a run's events is safe to pipe into logs or dashboards.

## Security: workflow sources are executed code

Workflow steps that include shell commands run with **the full filesystem and
network access of the user invoking `akm workflow run`** — same as if the user
had typed those commands in their shell. There is no sandbox and no separation
between trusted and untrusted workflows. An `exec` unit's *environment* is
narrowed to an allowlist by default
([Workflow Schema](../reference/workflow-schema.md#the-childs-environment-is-an-allowlist)),
which bounds accidental exposure of unrelated credentials — but a command that
runs at all can still read those credentials off disk, so it is a hygiene
boundary, not a containment one. AKM
directly orchestrates workflows as a defined execution surface — it does not
blindly execute arbitrary indexed content — but that orchestration still runs
the workflow's own declared shell commands with your full access once you
choose to run it.

This is by design: a workflow is a runbook authored by you or by a bundle
maintainer you trust. The flexibility of "run any shell command, read any
file, hit any network" is what makes workflows useful as automation.

The consequence is that **you should treat workflow sources the same way you
treat package dependencies**:

- **Only add workflow sources you trust.** `akm bundle add github:<some-user>/<bundle-repo>`
  followed by `akm workflow run workflows/<their-thing>` is functionally
  equivalent to piping a stranger's bash script into your shell. Read the
  workflow file first (`akm show workflows/<name>`) before running it.
- **Audit before run** for any workflow that touches secrets, deploys to
  production, or writes outside the project tree. Read the `env:` bindings a
  workflow declares, and read its `exec.pass_env` / `exec.inherit_env` lines —
  `inherit_env: true` hands that command every environment variable visible to
  the akm process, including secrets exported by your shell or injected via
  `akm env run` / `akm secret run`.
- **Pin known-good versions** when adding workflow sources from a registry
  or git remote (`akm bundle add github:owner/repo#v1.2.3`), and update
  deliberately rather than via `akm bundle update --all`. A trusted workflow
  source can become hostile if its upstream is compromised.
- **Workflow steps cannot escape this trust model** by being labeled
  `dryRun` or `interactive` — those flags affect bookkeeping, not execution.
  `akm workflow status` is read-only; `akm workflow run` executes configured
  units with your process's access.

If you operate a CI runner or shared host where untrusted workflows might be
executed, scope the process: a dedicated user account with no secrets in its
environment, ephemeral working directory, and a network/filesystem allowlist
enforced outside akm.

## See also

- [Workflow Schema](../reference/workflow-schema.md) — exact frontmatter,
  refs, gates, and outputs syntax
- [Author's Guide: Writing Workflows](../guides/author-workflows.md) —
  writing and testing a workflow definition
- [Architecture: The Workflow Engine](../architecture/workflow-engine.md) —
  persistence, dispatch, and resume internals
- [Scheduling](scheduling.md) — running akm tasks (including workflow runs)
  through the OS scheduler
- [CLI Reference](../reference/cli.md) — full flag documentation for all
  `workflow` subcommands
