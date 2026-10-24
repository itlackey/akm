# Workflows

A workflow is a multi-step procedure authored as either AKM Markdown or the
bounded GitHub-shaped YAML subset. `akm workflow run` compiles either source
format, freezes a durable plan, persists run and unit state, dispatches work,
verifies declared gates, and can resume after an interruption without
replaying completed units.

The `akm workflow` surface, the workflow asset format and the workflow engine
are Experimental; see [STABILITY.md](../../STABILITY.md). Workflow steps run as
the invoking user. See [Architecture: Core Principles](../architecture/akm-core-principles.md)
for where workflows sit among AKM's execution surfaces.

This page is a short map. The full contract lives across four pages, split by
what you're doing:

- **[Running Workflows](../guides/run-workflows.md)** — operating a run:
  start, check status, resume a blocked run, abandon one, and follow its
  events.
- **[Author's Guide: Writing Workflows](../guides/author-workflows.md)** —
  writing and testing a workflow definition: choosing a source format, the Markdown structure, a
  minimal complete example, common authoring mistakes, choosing engines and
  models, and engine-selection troubleshooting.
- **[Workflow Schema](workflow-schema.md)** — the exhaustive,
  authoritative reference: every frontmatter key, the bare-reference grammar,
  routing, failure policy, gates, and budget ceilings, with exact syntax.
- **[Architecture: The Workflow Engine](../architecture/workflow-engine.md)**
  — how a frozen plan actually executes: persistence, the run lease, dispatch,
  worktree isolation, concurrency limits, and resume-without-replay.

For task- or schedule-driven workflow runs — an `akm task` bound to
`uses: workflows/<ref>` and reconciled with the OS scheduler — see
[Scheduling](../guides/scheduling.md).

## Source formats and execution versions

Markdown `.md` and GitHub-shaped YAML `.yml` are peer source formats. The
Markdown adapter preserves AKM's full prose, gates, maps, routes, typed
artifacts, and exec vocabulary. The YAML adapter accepts the documented local
`name`/`on`/`jobs` subset. `.yaml` is not a workflow source.

New starts resolve source owners and executable targets, then freeze a durable
plan at `irVersion` 6. A stored plan is read back as it is: one frozen at an
older `irVersion` that still decodes runs with a single warning; one frozen by
a newer akm asks you to upgrade; and one this akm cannot decode is abandoned by
`akm workflow run` with a message naming how to start a new run. See
[Architecture: The Workflow Engine](../architecture/workflow-engine.md#resume-skips-completed-units).

A step can compose another workflow as a child — directly
(`uses: workflows/<ref>`) or through a task whose own target is a workflow
(`uses: tasks/<ref>`) — frozen completely into the parent's plan before the
parent run is published. See
[Workflow Schema: Child workflows](workflow-schema.md#child-workflows)
for both forms and their limits. Running a step that composes a child
workflow drives that child to completion (or as far as it gets) with the
same engine the parent uses, then maps the child's final status onto the
composing step: a completed child promotes its declared `outputs:` (or
`{runId, status}` when it declares none) as the step's own output and the
parent continues; a failed child fails the step and the run; a blocked
child blocks the composing step and the run, with recovery notes naming the
exact `akm workflow resume`/`akm workflow run` sequence. `akm workflow
status` on a run that composes children renders a `children:` tree showing
every descendant run's ref and status. See
[Workflow Schema: Child execution](workflow-schema.md#child-execution)
for the full status mapping and the blocked-child recovery flow, and
[Running Workflows: Child runs](../guides/run-workflows.md#child-runs) for a
walkthrough.

## Workflow outputs

A workflow may declare a run-level export in its Markdown frontmatter —
`outputs: {<name>: {from: steps.<id>.output(.<segment>)*, schema?}}` — resolved
once, from persisted step evidence, at run completion. A run with no `outputs:` declaration exports `{runId, status}`
instead; a composing parent step promotes a completed child's `outputs:`
(or that same `{runId, status}` fallback) as its own step output — see
[Workflow Schema: Workflow outputs](workflow-schema.md#workflow-outputs).

## Inspecting a workflow without running it

`akm workflow plan <ref>` compiles, resolves, and freezes a workflow exactly
as starting a run would, then stops — zero durable writes, no published run.
It prints the canonical step graph, per-step frozen target kinds,
task/child expansion, input bindings, and freeze-time lowering notices. Use
it to check what a workflow would actually do — including which child
workflows it would compose — before committing to a run. See
[CLI reference: workflow](cli.md#workflow).

## Unsupported boundary

The GitHub-shaped adapter is a local interoperability seam, not GitHub
Actions. Full GitHub expressions and contexts, local and Docker actions,
service events and hosted runners are not supported. **Multi-job YAML is
rejected**: `jobs:` must contain exactly one job, and a document with zero, two
or more jobs fails to compile. Split a multi-job source into single-job
workflows and compose them with a child-workflow step instead. A `uses:` that
names a remote action is rejected.

## See also

- [Discover and Load](../guides/discover-and-load.md) — find available
  workflows with `akm curate` before running one
- [Capture Knowledge](../guides/capture-knowledge.md) — turn a workflow run's
  outputs into searchable memories
- [Improve the Library](../guides/improve-the-library.md) — review improvement
  proposals for workflow assets
- [Concepts](../guides/concepts.md) — the workflow asset type and run-state
  storage in the broader AKM model
- [CLI Reference](cli.md) — full flag documentation for all `workflow`
  subcommands
