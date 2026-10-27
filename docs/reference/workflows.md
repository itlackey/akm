# Workflows

A workflow is a multi-step procedure authored as AKM Markdown. `akm workflow run`
compiles the source, freezes a durable plan, persists run and unit state,
dispatches work, verifies declared gates, and can resume after an interruption
without replaying completed units.

The `akm workflow` surface, the workflow asset format and the workflow engine
are Experimental; see [STABILITY.md](../../STABILITY.md). Workflow steps run as
the invoking user. See [Architecture: Invariants](../architecture/architecture.md#invariants)
for where workflows sit among AKM's execution surfaces.

This page is a short map. The full contract lives across four pages, split by
what you're doing:

- **[Running Workflows](../guides/run-workflows.md)** — operating a run:
  start, check status, resume a blocked run, abandon one, and follow its
  events.
- **[Author's Guide: Writing Workflows](../guides/author-workflows.md)** —
  writing and testing a workflow definition: choosing a source format, the Markdown structure, a
  minimal complete example, common authoring mistakes, choosing where a step
  runs and which model, and troubleshooting a missing harness or connection.
- **[Workflow Schema](workflow-schema.md)** — the exhaustive,
  authoritative reference: every frontmatter key, the bare-reference grammar,
  failure policy, gates, and budget ceilings, with exact syntax.
- **[Architecture: The Workflow Engine](../architecture/workflow-engine.md)**
  — how a frozen plan actually executes: persistence, the run lease, dispatch,
  concurrency limits, and resume-without-replay.

For task- or schedule-driven workflow runs — an `akm task` bound to
`uses: workflows/<ref>` and reconciled with the OS scheduler — see
[Scheduling](../guides/scheduling.md).

## Source formats and execution versions

Markdown `.md` is the one workflow source format; it preserves AKM's full prose,
gates, maps, typed artifacts, and exec vocabulary. New starts resolve source
owners and executable targets, then freeze a durable plan at `irVersion` 8. A
stored plan is read back as it is: one frozen at an older `irVersion` that
still decodes runs with a single warning; one frozen by a newer akm asks you to
upgrade; and one this akm cannot decode is abandoned by
`akm workflow run` with a message naming how to start a new run. See
[Architecture: The Workflow Engine](../architecture/workflow-engine.md#resume-skips-completed-units).

A step can run another workflow as a child (`unit: { workflow: workflows/<ref> }`,
**Experimental**) — frozen completely into the parent's plan before the parent
run is published. See
[Workflow Schema: Child workflows](workflow-schema.md#child-workflows)
for the form and its limits. Running a step that composes a child
workflow drives that child to completion (or as far as it gets) with the
same engine the parent uses, then maps the child's final status onto the
composing step: a completed child's last step output becomes the step's own
output and the parent continues; a failed child fails the step and the run; a blocked
child blocks the composing step and the run, with recovery notes naming the
exact `akm workflow resume`/`akm workflow run` sequence. `akm workflow
status` on a run that composes children renders a `children:` tree showing
every descendant run's ref and status. See
[Workflow Schema: Child execution](workflow-schema.md#child-execution)
for the full status mapping and the blocked-child recovery flow, and
[Running Workflows: Child runs](../guides/run-workflows.md#child-runs) for a
walkthrough.

## Inspecting a workflow without running it

`akm workflow plan <ref>` compiles, resolves, and freezes a workflow exactly
as starting a run would, then stops — zero durable writes, no published run.
It prints the canonical step graph, per-step frozen target kinds,
task/child expansion, input bindings, and freeze-time lowering notices. Use
it to check what a workflow would actually do — including which child
workflows it would compose — before committing to a run. See
[CLI reference: workflow](cli.md#workflow).

## Removed in 0.10

The GitHub-shaped YAML workflow format (`.yml` with `name`/`on`/`jobs`), `route`
steps, `unit.isolation: worktree`, and top-level `outputs:` were removed in 0.10;
see the CHANGELOG. A task that runs a workflow (`uses: workflows/<name>`, or a
`run:` that calls `akm workflow run`) is unaffected.

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
