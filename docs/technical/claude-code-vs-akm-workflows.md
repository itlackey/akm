# Workflow architecture: Claude Code workflows vs. akm workflows

A technical comparison of two things that share a name but occupy different
layers of the stack: the **Claude Code `Workflow` tool** (the harness-native
orchestration DSL) and **akm workflows** (`akm workflow …`, the durable
step-run engine in this repo).

The short version: they are not competitors. Claude Code workflows are an
**ephemeral, parallel, self-executing** orchestration layer that lives inside a
single agent session and runs LLM subagents. akm workflows are a **durable,
sequential, human-in-the-loop** run-state tracker that outlives sessions and
delegates all actual execution to whatever agent is driving. One *executes*;
the other *remembers*. That difference explains almost every technical
divergence below, and it is also the reason the two compose unusually well.

> **Scope.** This report analyzes akm's own workflow subsystem
> (`src/workflows/**`, `src/commands/workflow-cli.ts`) against the Claude Code
> `Workflow` tool. It deliberately **excludes**
> `docs/reviews/akm-meta-review/run-review.workflow.mjs`, which is not part of
> akm's workflow engine — it is a *Claude Code* workflow script that happens to
> live in this repo (a consumer of the other system, not an instance of akm's).

---

## Part A — Claude Code workflows: technical details

### A.1 Representation: an imperative JavaScript program

A Claude Code workflow **is a program**, not a document. The model authors a
self-contained JavaScript script, passed inline to the `Workflow` tool via its
`script` parameter. Every script begins with a **pure-literal** `meta` export:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
// body: uses agent()/parallel()/pipeline()/phase()/log()
```

`meta` must be a static literal (no variables, calls, spreads, or template
interpolation) so the harness can read the workflow's shape — its name,
description, and declared phases — **without executing the body**. The body
is arbitrary control flow: loops, conditionals, fan-out, accumulation.

The scripting surface is a small set of injected hooks and globals:

| Hook / global | Role |
|---|---|
| `agent(prompt, opts?)` | Spawn a subagent (a fresh LLM context). Returns its final text, or — with `opts.schema` — a validated structured object (the subagent is forced to call a `StructuredOutput` tool and the result is schema-checked with retries). Returns `null` if the agent is skipped mid-run or dies after retries are exhausted. |
| `parallel(thunks)` | Run tasks concurrently with a **barrier** — awaits all before returning. Failed thunks resolve to `null` (the call itself never rejects — filter with `.filter(Boolean)`). |
| `pipeline(items, ...stages)` | Run each item through all stages independently with **no barrier** between stages — item A can be in stage 3 while item B is still in stage 1. Each stage callback receives `(prevResult, originalItem, index)`. |
| `phase(title)` | Open a progress group; subsequent `agent()` calls are grouped under it. |
| `log(message)` | Emit a narrator line to the user. |
| `workflow(nameOrRef, args?)` | Run another workflow inline as a sub-step (one level of nesting only; the nested run shares the parent's concurrency cap, agent counter, and token budget). |
| `args` | The caller-supplied input value, verbatim. |
| `budget` | The turn's token target (`total`, `spent()`, `remaining()`) — a hard ceiling once reached. |

The unit of work is `agent()` — **a subagent with its own LLM context, model,
effort, and tool set**. Options include `label`, `phase`, `schema`, `model`,
`effort`, `isolation: 'worktree'` (an isolated git worktree so parallel file
mutations don't collide — expensive, so reserved for agents that mutate files
in parallel and would otherwise conflict; auto-removed if left unchanged), and
`agentType` (a named custom subagent). A subagent's model/effort/tools default
to the session's resolved model when unset, and subagents can reach
session-connected MCP tools via on-demand `ToolSearch`. Subagents are told
their final text *is* the return value, so a well-written `agent()` prompt
asks for raw data, not human-facing prose.

### A.2 Execution engine: the harness runs the script

The defining fact: **the Claude Code harness itself executes the script**, in a
controlled JavaScript interpreter. The model *writes* the orchestration; the
harness *runs* it deterministically, intercepting each `agent()` call to spawn a
real subagent, meter tokens, and update progress.

The script runs in a **restricted sandbox**, not full Node:

- Standard JS built-ins are available (`JSON`, `Math`, `Array`, …).
- **No filesystem or Node API access** — a workflow script cannot read or write
  files directly; only its subagents (which have tools) touch the world.
- **`Date.now()`, `Math.random()`, and argless `new Date()` throw** — they would
  make replay non-deterministic and break resume (see A.5). Timestamps come in
  via `args`; randomness is faked by varying prompts/labels by index.
- It is **TypeScript-hostile**: plain JS only, no type annotations/generics.

Invocation is **asynchronous / background by default**: the tool returns
immediately with a `runId` (`wf_…`), and a `<task-notification>` fires when the
workflow completes. `/workflows` streams live progress in the meantime.

### A.3 Concurrency model: parallel by construction

Concurrency is the entire point. Fan-out is first-class:

- Concurrent `agent()` calls are capped at `min(16, cores − 2)` per workflow;
  excess calls queue and drain as slots free.
- A single `parallel()`/`pipeline()` call accepts up to **4096 items**; total
  agents across a workflow's lifetime are capped at **1000** (a runaway
  backstop).
- `pipeline()` is the default multi-stage primitive precisely because it has no
  barrier: wall-clock equals the slowest single-item chain, not sum-of-slowest
  per stage.

On top of these primitives the ecosystem layers *quality patterns* — adversarial
verify (N skeptics per finding), judge panels, loop-until-dry discovery,
multi-modal sweeps, completeness critics — all expressed as ordinary control
flow over `agent()`. A handful of shapes recur often enough to be canonical:
review-then-verify as a `pipeline()` (each dimension's findings verify as soon
as that dimension finishes, no cross-dimension barrier), loop-until-count or
loop-until-budget (keep spawning finders until a target count or
`budget.remaining()` falls below a threshold), and adversarial/perspective-
diverse verify (N skeptics per finding, kept only if a majority survive).
`parallel()`'s barrier is reserved for the cases that genuinely need every
prior result together (dedup/merge, early-exit on zero); everything else
defaults to `pipeline()`. The load-bearing point underneath all of this: the
orchestration, the model policy, and any safety envelope are all *code* —
versioned, reviewable, and re-runnable, not something reconstructed from
scratch in an agent's head each time.

### A.4 Progress tracking

Progress is **push-based and live**:

- `meta.phases` declares named phase groups up front; `phase()` / `opts.phase`
  assign agents to them. Titles are matched exactly.
- `/workflows` renders a live progress tree (phases → agents → status).
- `log()` emits narrator lines above the tree.
- Completion delivers a `<task-notification>` back into the session.

Under the hood each run has a **transcript directory** containing
`journal.jsonl` (each `agent()` call's actual return value) and `agent-<id>.jsonl`
files (per-subagent transcripts) — the durable record used for diagnosis and
resume.

### A.5 State, resume, and budget

- **Resume** keys on `runId`. Relaunching with `{scriptPath, resumeFromRunId}`
  replays the longest unchanged **prefix** of `agent()` calls from cache
  (same `(prompt, opts)` → instant cached result); the first edited/new call
  and everything after it runs live. Same script + same args → 100% cache hit.
  This is why determinism (A.2) is enforced.
- **Iteration** is file-based: every invocation persists its script under the
  session directory and returns the path; you edit that file and re-invoke with
  `scriptPath`.
- **Budget** ties depth to the user's "+Nk" directive. `budget.total` is a hard
  ceiling; `budget.spent()`/`remaining()` are shared across the main loop and
  all workflows, enabling `while (budget.remaining() > 50_000) { … }` scaling.

### A.6 Lifecycle & trust

A Claude Code workflow is **session-scoped and turn-shaped**: it is one
well-bounded fan-out inside the current agent session, gone when the session
ends (only the transcript persists). Trust is handled by the harness sandbox —
the script can't touch the filesystem; only its tool-bearing subagents can, under
the session's normal permission model.

---

## Part B — akm workflows: technical details

### B.1 Representation: a declarative Markdown document

An akm workflow **is a document**, not a program. It is Markdown with a fixed
heading grammar (`src/assets/workflows/workflow-template.md`):

```markdown
---
description: Ship a tagged release to production
tags: [release]
params:
  version: The semver version string to release
---

# Workflow: Ship Release

## Step: Validate inputs
Step ID: validate

### Instructions
Check that `version` follows semver and the tag does not already exist.

### Completion Criteria
- `git tag v<version>` does not already exist
```

The grammar is strict: exactly one `# Workflow: <title>`, each step is a
`## Step: <title>` with a `Step ID:` line, a required `### Instructions` body,
and optional `### Completion Criteria` bullets. Nothing else is permitted at
levels 1–2 (`src/workflows/parser.ts`).

### B.2 Parser & validated document model

`parseWorkflow` (`src/workflows/parser.ts`) compiles the Markdown into a
`WorkflowDocument` (`src/workflows/schema.ts`, `WORKFLOW_SCHEMA_VERSION = 1`).
Notable properties:

- It **composes existing infrastructure** — `yaml` for frontmatter,
  `parseMarkdownToc` for headings, line-range slicing for bodies — rather than a
  bespoke parser.
- It **accumulates `WorkflowError`s rather than throwing**; each error is
  `path:line — message` with the fix baked into the message (no severity/code).
- Every element carries a **`SourceRef` line span** (`{ path, start, end }`), so
  editors/agents can rewrite content in place without a full re-parse.
- A cheap `looksLikeWorkflow()` structural probe keeps the indexer matcher and
  the parser from drifting.

The compiled document is cached into `index.db` (`workflow_documents`) and is the
single source consumed by the renderer, indexer, and run engine.

### B.3 Persistence: durable SQLite run state

Run state lives in **`state.db`** (`src/storage/repositories/workflow-runs-repository.ts`;
the former `workflow.db` was folded into `state.db` in the 0.9.0 cutover), whose
rows are explicitly **non-regenerable** ("losing them is data loss"), unlike the
regenerable `index.db`. Two tables:

- `workflow_runs` — `id`, `workflow_ref`, `workflow_title`, `status`
  (`active|completed|blocked|failed`), `params_json`, `current_step_id`,
  timestamps, plus columns added by migration: `scope_key`, `agent_harness`,
  `agent_session_id`, `checkin_armed_at`.
- `workflow_run_steps` — `(run_id, step_id)` PK, `step_title`, `instructions`,
  `completion_json`, `sequence_index`, `status`
  (`pending|completed|blocked|failed|skipped`), `notes`, `evidence_json`,
  `completed_at`, and `summary`.

Schema evolves through an **additive, idempotent migration engine** (shared with
`state.db`) recorded in `schema_migrations` — migrations `001` (scope_key),
`002` (agent identity), and `003` (check-in + per-step summary) illustrate the
additive discipline — with a `bootstrapPreVersioningDb()` hook that back-fills
the migrations table for databases created before versioning existed. Standard
pragmas apply a 30s busy timeout so concurrent writers don't fail immediately
with `SQLITE_BUSY`. The repository layer fully materializes every read
(`.all()`/`.get()`) so no live cursor escapes the connection scope.

### B.4 Execution model: akm tracks; the agent executes

This is the crux. **akm does not execute workflow steps.** It is a persisted
state machine driven by an external agent through a CLI command loop
(`src/workflows/runtime/runs.ts`, `src/commands/workflow-cli.ts`):

```
akm workflow start   → snapshot steps into state.db, set currentStepId
akm workflow next    → return the current step's instructions (auto-starts if none)
   … the AGENT reads the instructions and does the work in its own environment …
akm workflow complete → validate summary, advance currentStepId
   … repeat until deriveRunState() reports "completed" …
```

Key semantics:

- **Snapshot-at-start.** `startWorkflowRun` copies the step list into
  `workflow_run_steps` at start time; later edits to the source `.md` do not
  affect in-flight runs.
- **Strict sequentiality.** There is exactly one `current_step_id`.
  `completeWorkflowStep` refuses any step that isn't the current one
  ("Complete `<current>` first"). `deriveRunState` walks steps in order: any
  `failed`/`blocked` step sets the run to that status; else the first `pending`
  step is the current one; else the run is `completed`.
- **Execution is the agent's shell.** Any shell commands in a step's
  instructions run with the **full environment and PATH of the invoking user** —
  no sandbox, no env allowlist. The docs (`docs/features/workflows.md`) are
  explicit that a workflow source is executed code and must be trusted like a
  package dependency: "`akm add github:x/stash` + `akm workflow next` is
  functionally piping a stranger's bash into your shell." Trust is by pinning
  versions and auditing before run.
- **The write path is transactional and lock-careful.** The LLM validation gate
  (B.7) runs *outside* the DB write transaction so a slow model never holds a
  write lock.

### B.5 Scoping & concurrency guard

Runs are partitioned by **`scope_key`** — a `sha256` of the nearest project
anchor (`.akm/config.json` root → git root → stash dir → cwd),
`src/workflows/authoring/scope-key.ts`. This keeps concurrent runs in different
directories independent.

Within a `(workflow_ref, scope_key)` pair, `startWorkflowRun` enforces a
**single active run** unless `--force` is passed (#485) — so two terminals
running `akm workflow start <ref>` can't leave two runs racing for `next` to
pick between.

### B.6 Progress tracking

Progress is **pull-based and durable** — the opposite of Claude Code's live
push:

- Each `workflow next` / `status` call reads step rows and reports statuses,
  `notes`, `evidence` (arbitrary JSON), and per-step `summary`.
- There is no live tree and no notification channel; the agent (or human)
  **polls** `akm workflow next` / `status` / `list`. Each command emits a JSON
  envelope.
- State survives context-window breaks and process exits by construction: it's
  all rows, read back on the next command.

### B.7 Quality gates: summary validation + human review

Completion is gated (#506):

- Completing a step **requires a `--summary`** of work done.
- When the step has `### Completion Criteria` and an LLM is configured,
  `validateStepSummary` (`src/workflows/validate-summary.ts`) asks the model to
  judge the summary against each criterion. A well-formed `complete: false`
  verdict leaves the step **pending** and returns structured corrective feedback
  (`missing[]`, `feedback`). The gate is **fail-open**: no criteria, no judge, or
  an unparseable/errored verdict all let the step complete — offline use keeps
  working.
- `blocked` status models **human-review gates**; `resumeWorkflowRun` flips a
  `blocked`/`failed` run back to `active` and reopens the current step.

### B.8 Check-in: stall nudging without a daemon

akm records the driving **agent identity** (`agent_harness`, `agent_session_id`)
from environment hints — notably `CLAUDE_SESSION_ID` → harness `claude-code`
(`src/workflows/runtime/agent-identity.ts`). It then arms a **check-in**: a
timestamp (`checkin_armed_at`), *not* a background thread. On the next
`workflow next` / `status` poll, the pure `evaluateCheckin()`
(`src/workflows/runtime/checkin.ts`) compares `now` against
`max(updated_at, checkin_armed_at)`; past a 90s stall window it surfaces a strong
`continue` directive **through the normal command output**. The ADR
(`docs/technical/workflow-agent-checkin-adr.md`) explicitly rejects the
background-thread alternative (#501): "No daemon in a CLI… the command loop is
already the heartbeat."

### B.9 CLI surface

`akm workflow` (`src/commands/workflow-cli.ts`) exposes:
`start`, `next`, `complete`, `status`, `list`, `create`, `template`, `resume`,
`validate`. Authoring (`create`/`validate`/`template`) and execution
(`start`/`next`/`complete`/`resume`) are the same family; `create` re-indexes the
new file so `start` can resolve it immediately.

---

## Part C — Side-by-side

| Dimension | Claude Code workflow | akm workflow |
|---|---|---|
| **Artifact** | Imperative JS program (`script`) | Declarative Markdown document (`.md`) |
| **Authored by** | The agent, inline, per-task, ephemeral | Human or agent, saved as a reusable stash asset |
| **Who executes work** | The harness runs the script; subagents do the work | The external agent does the work; akm only tracks state |
| **Unit of work** | `agent()` — a fresh LLM subagent context | A step — an instruction handed to the driving agent |
| **Concurrency** | Massively parallel (≤16 concurrent, ≤1000 total, `pipeline`/`parallel`) | Strictly sequential — one `current_step_id` |
| **Control flow** | Full JS: loops, conditionals, fan-out, budget-scaled | Fixed linear step sequence |
| **State store** | Transcript dir (`journal.jsonl`, `agent-*.jsonl`) | SQLite `state.db` (durable, non-regenerable) |
| **Scope / lifetime** | One session, one turn-shaped fan-out | Cross-session, per-project `scope_key`, resumable indefinitely |
| **Progress model** | Push: live `/workflows` tree + `task-notification` | Pull: poll `workflow next`/`status`, JSON envelopes |
| **Resume** | Prefix-cache replay keyed on `runId` (needs determinism) | Re-read durable rows; `resume` reopens blocked/failed |
| **Determinism constraint** | `Date.now`/`random`/`new Date()` forbidden | None — it advances rows, it doesn't replay a script |
| **Quality gates** | Agent-authored (adversarial verify, judge panels, schemas) | Built-in LLM summary judge + `blocked` human gates |
| **Sandbox / trust** | Restricted JS interpreter, no FS; subagents use tools | No sandbox — steps run in the user's full shell |
| **Identity** | `runId`, token budget | `agent_harness` + `agent_session_id`, check-in timestamp |
| **Nesting** | `workflow()`, one level deep, sharing the parent's concurrency cap/budget | None built-in — a step could shell out to another `akm workflow` |

---

## Part D — Where they overlap

Despite living on different layers, they converge on several ideas:

1. **Task decomposition into named units** — phases/agents vs. steps.
2. **Durable run identity and resume** — `runId` prefix-cache vs. `state.db`
   workflow-run rows. Both are built to survive interruption and pick up where they left off.
3. **Per-unit status + evidence** — journal return values vs. step
   `status`/`notes`/`evidence`/`summary`.
4. **A "keep going" nudge** — Claude Code's `task-notification`/resume vs. akm's
   `continue` check-in directive.
5. **Structured validation of results** — Claude Code's `schema` option
   (forced `StructuredOutput`, retried) vs. akm's LLM summary-vs-criteria judge.
6. **Scaffolding + validation of the artifact** — `meta` shape checks vs.
   `akm workflow template` / `validate` and the accumulating parser.
7. **Awareness of the driving session** — Claude Code owns the session; akm
   *records* it (`CLAUDE_SESSION_ID` → `claude-code`), already anticipating
   correlation across the two systems.

---

## Part E — Where they fundamentally diverge

Every difference reduces to one axis: **who holds the execution loop.**

- **Claude Code workflows own execution.** The harness is the runtime; the script
  is the plan; subagents are the workers. Because the harness replays the script
  to resume, it must constrain the script (no wall-clock, no randomness, no FS)
  and keep it ephemeral. Parallelism is free because the runtime schedules it.

- **akm workflows own memory, not execution.** akm's *workflow engine* never
  runs a step; it hands instructions to an external agent and records what came
  back. Because it never replays anything, it needs no determinism constraints —
  but as an engine it also doesn't parallelize and doesn't spawn workers of its
  own. Its value is *durability and gating*: state that outlives any session,
  plus completion criteria and human `blocked` gates that a fire-and-forget
  fan-out has no place to put.

  > **Important qualification.** This is a property of the *current workflow
  > engine*, not of akm the tool. akm is already multi-harness and already
  > spawns agents elsewhere: `RunnerSpec` (`llm|agent|sdk`) + `executeRunner`
  > (`src/integrations/agent/`), the OpenCode SDK runner (`runOpencodeSdk`), the
  > agent-CLI spawner (`runAgent`), and schema-validated output
  > (`callStructured`). Concretely, `agent-builder.ts`
  > (`src/integrations/harnesses/claude/agent-builder.ts`) builds a
  > `claude [--system-prompt] [--model] [--allowedTools] --print -- <prompt>`
  > invocation (non-interactive captured mode), dispatched by
  > `src/integrations/agent/spawn.ts` with hard timeouts and a fixed
  > failure-reason vocabulary (`timeout`, `spawn_failed`, `non_zero_exit`,
  > `parse_error`). This is akm's nearest existing analog to Workflow's
  > `agent()` primitive — and it never imports an LLM SDK; agents are reachable
  > only via shell-out, a pre-emptive guarantee against invariant #222. That
  > spawner is used today by the `improve`/`reflect` pipeline, **not** by the
  > workflow engine — the workflow engine simply doesn't *use* that substrate
  > yet. That is exactly what the extension plan changes — see
   > [the current workflow documentation](../features/workflows.md).

Concretely:

- **Ephemeral vs. durable.** A Claude Code workflow evaporates with the session;
  an akm run persists in SQLite across sessions, machines (via the repo), and
  context resets.
- **Parallel vs. sequential.** Claude Code fans out to thousands of agents; akm
  advances one step at a time by design.
- **Self-contained vs. delegated.** A Claude Code workflow carries its own
  workers; an akm workflow is inert without an agent to execute its
  instructions.
- **Sandbox vs. shell.** Claude Code isolates the orchestrator and permissions
  the workers; akm runs steps with the user's full environment and treats
  workflow sources as trusted executable code.
- **Executable script vs. managed content.** A Claude Code workflow is an
  executable script; an akm workflow is a Markdown *asset* that akm can index,
  search, `curate`, version, and improve over time like any other stash asset.
  This is akm's genuine edge on the authoring side — its workflows are managed
  content, not just executable files.

They are complementary: Claude Code is strong exactly where akm is weak
(in-session parallel LLM execution) and akm is strong exactly where Claude Code
is weak (durable, gated, cross-session procedures a human signs off on).

---

## Part F — How akm could integrate better with Claude Code workflows

> **Superseded by the extension plan.** The integration ideas below were written
> for the *current* passive-tracker engine. The direction akm is taking is more
> ambitious: extend the workflow engine into a **harness-agnostic orchestrator**
> that either compiles a workflow to a Claude Code script and delegates (with
> report-back), or executes the same definition natively on the OpenCode SDK /
> other harnesses — providing Claude-Code-equivalent parallelism, structured
> output, phases, and budgeting on top of akm's existing agent-execution
> substrate, while keeping akm's durable/gated spine. See
> [the current workflow documentation](../features/workflows.md)
> for the full technical design. The lighter-weight ideas below remain valid as
> incremental stepping stones.

The two systems are natural partners: a Claude Code workflow is the ideal
*driver* for an akm run, and an akm run is the ideal *durable spine* for a
long-lived procedure that a single Claude Code turn can't hold. Concrete steps,
roughly in order of leverage:

### F.1 Ship a first-party "akm-driver" Claude Code workflow pattern

Provide a documented, copy-pasteable Claude Code workflow that pipelines the akm
command loop:

```js
// pseudo-shape
let step = await agentRunsCli(`akm workflow next ${ref} --json`)
while (!step.done) {
  const result = await agent(`Do this akm step:\n${step.step.instructions}`,
                             { schema: STEP_RESULT, phase: step.step.title })
  await agentRunsCli(`akm workflow complete ${step.run.id} --step ${step.step.id} ` +
                     `--summary ${quote(result.summary)}`)
  step = await agentRunsCli(`akm workflow next ${step.run.id} --json`)
}
```

This gives akm runs live `/workflows` progress and Claude Code's subagent
execution *for free*, while akm keeps the durable, gated state. Today the two
systems can already interoperate via the shell, but there's no blessed recipe;
publishing one (and a `whenToUse` note) turns an implicit possibility into a
supported path.

A lighter-weight variant of the same idea: ship the loop contract as an
**akm-authored skill/asset** instead of an inline script — call `next`, do the
step, call `complete` with a summary that satisfies the criteria, honour a
`checkin` directive. A Workflow script could then simply
`agent("Drive akm workflows/ship-release to completion", …)` and get correct
behaviour, making an akm workflow callable as a single Workflow leaf with zero
engine changes.

### F.2 Record the Claude Code workflow `runId`, not just the session

`agent-identity.ts` already captures `agent_harness` / `agent_session_id`. When
an akm run is driven from inside a Claude Code workflow, also capture the
workflow `runId` (e.g. via an `AKM_CC_WORKFLOW_RUN_ID` env hint) in a new
nullable column. That makes an akm run traceable back to the exact orchestration
that drove it, and lets a future monitor correlate the two progress views.

### F.3 Emit machine-readable progress for a live consumer

akm progress is pull-only JSON envelopes. Add an opt-in **NDJSON progress
stream** (or a stable event on `appendEvent` that a wrapper can tail) so a
Claude Code workflow — or any external UI — can render akm step transitions
live instead of re-polling `status`. This narrows the biggest UX gap
(push vs. pull) without adding a daemon, staying faithful to the check-in ADR's
"no resident process" principle.

### F.4 Structured step evidence via a schema, mirroring `agent(..., {schema})`

Claude Code's `schema` option validates a subagent's output *structurally* with
retries. akm validates a step's `--summary` only *semantically* (LLM judge).
Let a step declare an optional **evidence JSON Schema** (in frontmatter or the
step body); `completeWorkflowStep` would validate `--evidence` against it before
the LLM gate. That gives akm the same structural guarantee Claude Code workflows
rely on, and makes an akm step a clean drop-in target for a schema-returning
Claude Code subagent.

### F.5 Bounded parallelism as an explicit, opt-in step attribute

akm's strict sequentiality is the right default for gated runbooks, but it
forecloses the one thing Claude Code does best. akm already supports parallel
runs via `scope_key` + `--force`; a natural next step is a **fan-out step type**
— a step that declares "run this instruction over N items" and records N child
results — which a Claude Code driver could satisfy with a single `parallel()` /
`pipeline()` call while akm still tracks the aggregate as one durable step.
Kept opt-in, this doesn't compromise the sequential-by-default gating model.

### F.6 Let the check-in wake the driver instead of waiting to be polled

akm's check-in is deliberately passive — it only surfaces on the next poll. When
the driving harness is Claude Code (already detected), akm could additionally
drop the check-in directive into a location the harness watches, so a stalled run
can be *re-targeted* rather than waiting for a poll that may never come if the
agent has stopped. The ADR's file-signal design already contemplates "a
best-effort checkin signal file under the run scope"; formalizing that path for
the `claude-code` harness closes the loop with Claude Code's
`task-notification` / `ScheduleWakeup` mechanics.

### F.7 Two-way compilation between the artifacts

- **akm `.md` → Claude Code driver script**: a `akm workflow export --harness
  claude-code` that emits the F.1 pattern specialized to a given workflow — so a
  durable akm runbook can be *launched* as a Claude Code workflow with one
  command. Since akm already parses a workflow into a structured
  `WorkflowDocument` with steps, instructions, and completion criteria, the
  emitted script is close to mechanical: a `meta.phases` entry per step and a
  sequential body where each stage is
  `agent(step.instructions, { schema: criteriaSchema })` — completion criteria
  become the `schema`/verification contract.
- **Claude Code workflow → akm run (for the durable spine)**: when a Claude Code
  workflow represents a long-lived, resumable, human-gated procedure (not a
  one-turn fan-out), backing it with an akm run gives it cross-session
  persistence and `blocked` gates that the transcript-only model lacks. A thin
  `akm workflow ingest-journal <path>` (or a Workflow that calls
  `akm workflow complete` at each phase boundary) would give a Claude Code run
  the cross-session durability, `status`/`list` querying, and feedback/improve
  hooks akm already provides for its own runs — without Workflow having to grow
  a database.

### F.8 Suppress the check-in when the harness already owns the run

akm's check-in exists because akm can't see whether the driving agent is
alive. Inside a Claude Code workflow, the harness *does* own the run and *does*
have a live progress tree, so the check-in is redundant there. When a run's
`agent_harness` indicates it is being driven by a harness that owns
orchestration end-to-end, akm could suppress the `continue` check-in directive
(that harness won't stall the way a free-form chat agent can) and treat phase
transitions as the heartbeat instead — avoiding two systems both trying to
nudge the same agent.

### F.9 Distribute Claude Code workflow scripts as akm assets

A more strategic, larger step: let the `workflow` asset type carry (or
reference) a Claude Code workflow script as an alternate executable form
alongside the Markdown runbook. Then akm's existing strengths — `add` from
GitHub/npm, unified FTS search, `curate`, version pinning, feedback/improve —
would apply to *executable* Workflow scripts too. `akm curate "release"` could
surface either a runbook to step through or a harness-executable workflow, and
`akm show workflows/x` would display the script for the mandatory pre-run audit
that akm's security model already demands. This is the version where akm
becomes a package manager for Claude Code workflows specifically — squarely
on-mission, but a larger commitment than F.1–F.8.

The guiding principle: **don't make akm imitate Claude Code's executor, and
don't make Claude Code imitate akm's durability.** Let akm remain the durable,
gated, cross-session memory of *what a procedure is and where a run stands*, and
let Claude Code remain the in-session parallel executor — with clean, documented
seams (F.1–F.4) so each drives the other instead of reinventing it.
