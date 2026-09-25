# Architecture: The Workflow Engine

A workflow compiles to a frozen plan, persists run and unit state, dispatches
its work, verifies declared gates, and resumes without replaying completed
units. This page is the architecture-level reference for that engine — how a
run's plan is frozen and stored, how dispatch and resume actually work, how
one engine owns a run, and how isolated file-mutating units execute. For the
exact frontmatter/body syntax that produces the plan, see
[Workflow Schema](../reference/workflow-schema.md). For the day-to-day
commands that drive a run, see [Running Workflows](../guides/run-workflows.md).

> **`akm workflow run` is Stable, ungated, and the only execution surface.**
> It is the canonical start/resume/execute command; there is no separate
> external-driver protocol.

## Frozen plans

The first `akm workflow run <ref>` compiles either peer source format through
source IR v1. Every new run/start creates and atomically publishes durable
plan **`irVersion` 5** on the run row (`plan_json` + `plan_hash`); a new start
never emits an older version. `plan_ir_version` and `plan_hash` are recorded
provenance, not gates: a stored plan is decoded as it is, and one frozen by an
older or newer akm that still decodes simply runs (with one warning).

The durable plan includes a guarded, canonical `sourceReadSet` covering the
workflow and every command/persona/task/script source it owns — and, for a
step that composes a child workflow, every source the child transitively owns
too (see [Child workflows](#child-workflows)). Each entry records logical and
physical identity, content hash, and containment evidence, so aliases,
replacements, and source races fail before publication.

Dispatch-significant material is immutable. The resolved request is frozen,
the resolved target is frozen, and runner selection is frozen.
Working directory (`cwd`) identity is frozen.
Git identity and its commit OID are frozen. The executable a unit runs is
resolved at dispatch, so upgrading a CLI (say, `claude`) never strands a run.
Exact models, inference, tools and authorization,
execution limits, parameter snapshots, command/script bytes, and verifier
selection therefore cannot drift under an in-flight run.

Workflow environment asset values are the narrow live-value exception within
authored workflow inputs.
The environment owner key set and secret-token topology are frozen.
Literal values remain frozen. Pass-through bindings
materialize at dispatch from the current process, and env/secret references
materialize their current values only after owner/topology checks. Durable
plans never store secret values or enable whole-process `inheritEnv`.

**A run executes the plan compiled at creation; edits to source need a new
run.** Resuming a run re-reads its workflow source only to warn, once, when
the source changed since the freeze — the run continues on the frozen plan.
Orchestration decisions are pure functions of the frozen plan, run params,
and journaled results.

## Child workflows

A step that composes another workflow — directly (`uses: workflows/<ref>`)
or through a task whose own target is a workflow (`uses: tasks/<ref>`) —
freezes to a `child-workflow` frozen target. Unlike the `command`/`shell`/
`script` targets, a `child-workflow` target carries the child's **complete
frozen plan, embedded**: compiling the parent recursively compiles,
validates, and freezes each child in full — depth-first, all of it — before
the parent run is ever published. Nothing about a child is re-read at
dispatch time; the embedded plan is authoritative. See
[Workflow Schema: Child workflows](../reference/workflow-schema.md#child-workflows)
for the authoring-side view, including the three composition bounds (depth,
cycle, aggregate embedded bytes) enforced at freeze.

**Decoding.** An embedded child plan is decoded by the same structural
decoder as its parent, recursively. Its `planHash` and the target's
`contentHash` are recorded provenance, carried as data and never re-verified
against the bytes.

**The dispatch seam.** Dispatching a step whose target is
`kind: "child-workflow"` is the one branch point in
`dispatchJournaledAttempt` (`src/workflows/exec/native-executor.ts`) that
does not call the ordinary unit dispatcher: it calls
`driveChildWorkflowUnit` instead, with everything the composing unit already
resolved — the frozen target, the parent's dispatch context, the child's
resolved params, and the unit input hash. The branch sits **inside** the
existing retry loop, after the parent unit's attempt row is already claimed
`running` (so a crash between claiming that row and publishing the child
leaves a recoverable `running` parent unit and no orphaned child) and
**before** the ordinary post-dispatch journaling (redaction, attempt
finishing, the worktree epilogue), which runs unchanged either way — a
child-workflow unit is journaled exactly like any other.

**The drive contract.** `driveChildWorkflowUnit` validates and resolves the
child's params through the same input-binding
resolution every frozen target uses, computes the child's identity key from
`{parentRunId, parentUnitId, unitInputHash}`, and publishes the child run —
idempotently: the same three inputs always resolve to the same child row,
so a retried or resumed composing step re-drives the run it already started
rather than starting a new one, and only a change to the composing step's
own inputs (params, an upstream step output it reads, or gate feedback from
a rejected verification loop) produces a different child. A child found
already `blocked` or `failed` is not re-driven — driving happens once per
call, and a terminal-but-unhealthy child surfaces through the status mapping
below instead. The child's final status maps onto the composing unit, and
from there onto the parent step and run, exactly as described in [Workflow
Schema: Child execution](../reference/workflow-schema.md#child-execution).

**Why `runWorkflowSteps` is reused, not a second executor.** The child drive
calls the exact same exported entry point `akm workflow run` calls —
`runWorkflowSteps(options)`, pointed at the child's run id as `target` —
with no special-casing for "this target is a child": resolving a run id,
decoding the stored plan, taking that run's own lock, and walking its spine
through `completeWorkflowStep` are identical to the top-level path. That
reuse is what makes child run locks arbitrate two-parent contention with no
new mechanism, and what makes a resumed parent skip a completed child step
with zero dispatcher calls. The child drive passes a no-op
`disposeDispatchResources` (the parent's `finally` remains the sole owner of
the process-lifecycle drain for the whole process) and no `maxSteps` or
`maxRetries` (the parent's own budgets count only its own spine steps). The
lower-level `driveRun` that `runWorkflowSteps` wraps stays module-private —
reaching for it directly, instead of the public entry point, would be
exactly the second executor this design avoids.

**Why `hashVersion` is 7, and why child composition did not move it.** The
version prefix mixed into a unit's input hash is 7
(`src/workflows/exec/step-work.ts`); 0.9.2 bumped it — a single, durable
5 → 7 step, since every released tag on the line carries 5 — when
`taskInputs`, the resolved values of a composed task's reference-kind
`inputBindings`, joined the preimage (see [ADR
0002](decisions/0002-unit-reuse-and-input-hash-scope.md)). Child composition
itself contributed nothing to that bump: the parent unit's input-hash
preimage already covers everything the child drive depends on — the frozen
target carries the child's ref, plan hash, content hash, binding mode, and
its entire embedded plan, so any change anywhere in the child changes the
parent unit's own input hash transitively. The child run id (minted at
dispatch) and its exported result are unit *outputs*, not inputs, so neither
belongs in the preimage — adding either would be a hashing-boundary
violation, not a fix.

### Run outputs

A workflow may declare `outputs:` — a run-level export projected from its
steps' own artifacts once every step has finished (see [Workflow Schema:
Workflow outputs](../reference/workflow-schema.md#workflow-outputs) for the
authoring grammar). Resolution happens inside the same write transaction
that completes the run's final step, immediately after the run's terminal
status is derived: each declared output is resolved from the persisted step
evidence and, if declared, validated against its schema. If resolution or
validation fails for any entry, the **whole completion rolls back** — the
run stays `active`, its final step stays `pending`, and no completion event
is emitted — rather than leaving a run `completed` with missing or invalid
exports. A run with no `outputs:` declaration exports `{runId, status}`
instead, synthesized on read and never persisted. This exported result is
exactly what a parent composing this workflow as a child promotes as the
composing unit's own result on `completed` — the same value, read through
the same function, whether the caller is `akm workflow status` or a parent
unit's dispatch.

## Resume skips completed units

Resume never re-reads config or the asset index, and reads the workflow
source only for the drift warning above. It consumes the frozen plan plus
the journaled attempts and results. A stored plan that this akm cannot
decode is not an error to fix in place: `akm workflow run` marks such a run
abandoned (status `failed`) and says to start a new run with
`akm workflow run <ref>`; `akm workflow status`, `list`, and `abandon` never
read the plan at all. A plan frozen by a newer akm that this one cannot
decode is left untouched, and the message names upgrading akm.

Every dispatched unit is journaled under a content-derived identity — the
node id plus a hash of its item for a map unit (`<node>:solo` otherwise) —
together with an input hash over everything the unit was asked to do (its
frozen instructions and target, declared `inputs:` artifacts, the params
snapshot, gate feedback). On
re-run, a unit whose journal row is `completed` is **reused**, never
re-dispatched; a failed or missing unit is dispatched live. The recorded
input hash is informational: a completed unit stays completed even when the
params row or an upstream artifact changed since — a fresh run is what
recomputes it.

## Durable attempts and at-least-once dispatch

Workflow dispatch is at-least-once. Every unit has a stable content-derived
unit id and an append-only sequence of attempts.
A crash reclaim reuses the same stable dispatchId for the interrupted attempt.
An explicit retry gets a new dispatchId under one stable unit id and increments the attempt number.

One driver per run (below) keeps a second engine off a run, and a finished
attempt accepts no second terminal write, but neither can prove whether an
external process completed immediately before a crash. An ambiguous crash
outcome may re-run and can produce a duplicate side effect. Workflow actions
should be idempotent or use the stable dispatch identity as their own
deduplication key.

## One engine drives a run (the run lock)

`akm workflow run` takes the run's **lock file** before reading the plan or
dispatching anything: one `O_EXCL` file per run id under the data directory
(`workflow-run-locks/<run id>.lock`, next to `state.db`), recording the
holder's pid, released when the invocation exits. A second `workflow run`
against a run another live process holds refuses up front with
`RUN_LEASE_HELD` (exit 75), naming the holder pid. A lock whose holder pid is
dead is reclaimed at once, so a crashed engine never wedges a run; nothing
expires by age and nothing renews. `workflow status` and `list` never take
the lock.

## Worktree isolation

A file-mutating unit can declare `isolation: worktree` in its `unit:` bag
(agent and sdk runners) — see
[Workflow Schema: Frontmatter keys](../reference/workflow-schema.md#frontmatter-keys).
Each unit attempt gets a fresh **detached git worktree** of the run's base
repository under a run-scoped temp directory; the worktree path is journaled
on the unit row and passed to the harness as its working directory, so
parallel fan-out units can never trample each other's working tree. After the
unit finishes, a clean worktree (`git status --porcelain` empty) is removed
automatically; a dirty one is retained and its path logged, so uncollected
work is never destroyed. Declaring worktree isolation in a non-git directory
fails the step cleanly before anything dispatches.

> **Warning — outputs matched by `.gitignore` are treated as disposable.** A
> worktree-isolated unit's output survives only if it lands on a
> **collectible path**: a tracked file, or an untracked file your repository
> does **not** `.gitignore`. Anything a unit writes to a `.gitignore`d path —
> build outputs, caches, logs, dependency directories like
> `node_modules`/`dist`, or a scratch file under an ignored directory — is
> **discarded** when its clean worktree is auto-removed. If a unit produces an
> artifact that must survive, write it to a non-ignored path, or report it as
> a result (a structured `output` / free-text result), before the unit
> returns.

The clean probe deliberately does **not** pass `--ignored`, so "uncollected
work" means tracked or untracked-*unignored* changes only. A worktree whose
only residue is files your repository's own `.gitignore` matches is treated
as clean and removed: those files are disposable by the repo's own
declaration, and retaining a worktree after every package install or build
would blow up disk under the temp root.

## Concurrency limits

Native fan-out (`akm workflow run`) uses the minimum of four limits: the
map's declared `concurrency`, the run's frozen `workflow.maxConcurrency`, the
selected frozen LLM engine's `concurrency` (including an SDK engine's
fallback LLM), and the current host's CPU-derived safety limit. Reapplying
host safety keeps a run safe when it resumes on a smaller machine.

- **Unset (default):** the CPU-derived value `min(16, max(1, cores − 2))` — a
  conservative default that leaves headroom on the host and matches the
  original Claude-Code cap.
- **Set:** an explicit positive integer, clamped when frozen to `[1, 64]`
  (values above 64 are clamped down, never rejected, so one config shared
  across machines with different core counts never hard-fails).

```console
$ akm config set workflow.maxConcurrency 8   # raise the frozen workflow limit
$ akm config get workflow.maxConcurrency
8
```

A workflow that fans out is authorizing **N parallel agents**, not one — see
[Running Workflows: workflow sources are executed code](../guides/run-workflows.md#security-workflow-sources-are-executed-code)
for what that means for trust.

## Run scope and persistence

Run state (`plan_json`, `plan_hash`, step statuses, and the unit journal)
persists in the project's `state.db`; the per-run lock file sits beside it. Run state is scoped to
the current project directory — the nearest `.akm/config.json`, git root,
bundle root, or current directory — so the same workflow can run
independently in separate projects, and `akm workflow list`/`status` without
an explicit run id only ever see runs in that scope.

## See also

- [Workflow Schema](../reference/workflow-schema.md) — exact frontmatter,
  refs, gates, and outputs syntax
- [Running Workflows](../guides/run-workflows.md) — start, inspect, resume,
  and abandon a run
- [Author's Guide: Writing Workflows](../guides/author-workflows.md) — writing
  and testing a workflow definition
