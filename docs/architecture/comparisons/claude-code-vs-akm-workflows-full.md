Full technical comparison. For a short vendor-neutral decision guide, see docs/guides/claude-code-vs-akm-workflows.md.

# Workflow architecture: Claude Code workflows vs. akm workflows

A technical comparison of two things that share a name but occupy different
layers of the stack: the **Claude Code `Workflow` tool** (the harness-native
orchestration DSL) and **akm workflows** (`akm workflow …`, the workflow
subsystem in this repo).

The short version: they are not competitors. An akm workflow is a durable
workflow asset authored in either of two peer source formats, Markdown `.md`
or GitHub-shaped YAML `.yml`, and executed by the Stable
`akm workflow run` command. Both adapters compile through source IR version 1.
Every new start freezes the durable plan v4 family's executable `irVersion: 5`
before execution. The native engine
fans work out to concurrent runner units, retries, gates on typed artifacts,
and enforces budget ceilings. Execution is native: akm dispatches each unit to
a configured agent harness (ten are supported) rather than asking the calling
session to run it.

> **Scope.** This report analyzes akm's own workflow subsystem
> (`src/workflows/**`, `src/commands/workflow-cli.ts`) against the Claude Code
> `Workflow` tool. It deliberately **excludes** any `.workflow.mjs` Claude Code
> workflow scripts that may live elsewhere in this repo (e.g. under internal
> review tooling) — those are *consumers* of the Claude Code system, not
> instances of akm's own workflow engine.

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

This part deliberately stays high-level: `docs/reference/workflows.md` is the
maintained, exhaustive reference for the peer workflow source formats,
reference grammar, gates, budgets, and the run lease. What follows is the
comparison-relevant subset — read the reference doc for anything this section
doesn't answer.

### B.0 Peer source formats, one stable execution surface

Peer workflow sources are Markdown `.md` and GitHub-shaped YAML `.yml`, both
addressed as `workflows/<name>`. The Markdown form declares the orchestration
graph (`unit`/`map`/`route`, inputs, outputs, retries, isolation, and budgets)
in frontmatter, while `## <step-id>` body sections carry unit/map
instructions and optional `### gate` rubrics. The YAML form accepts the
documented local `name`/`on`/`jobs` subset. Both adapters lower into the same
strict source IR version 1.

`akm workflow run` is the stable, ungated start/resume/execute surface. The
public `start`/`next`/`complete` lifecycle is removed. `status`, `list`,
`create`, `resume`, and `abandon` remain stable support commands.

There is no external-driver protocol: the former experimental
`akm workflow brief|report` surface was removed, so `run` is the single
execution path.

### B.1 Representation

The Markdown template (`src/assets/workflows/workflow-template.md`, validated
against `schemas/akm-workflow.json`) keeps machine orchestration in
frontmatter and human-authorable prose in the body. The peer `.yml` adapter
accepts the bounded GitHub-shaped subset documented in
`docs/reference/workflow-schema.md`. Bare whole-value references
(`params.<name>` and `steps.<id>.output.<path>`) wire `map.over`,
`route.input`, and `inputs`; prose is never interpolated. Runtime params, map
items, and declared input artifacts reach units as attached context.

### B.2 Parsers & compiled models

The Markdown and YAML adapters both produce source IR v1 before target
resolution. For Markdown, `parseWorkflow` (`src/workflows/parser.ts`) parses
the frontmatter graph and binds body prose into a `WorkflowDocument`
(`src/workflows/schema.ts`). It accumulates `WorkflowError`s instead of
throwing, and every element carries a `SourceRef` line span. The IR compiler
(`src/workflows/ir/compile.ts`) lowers source IR into the durable plan graph
(`src/workflows/ir/schema.ts`) executed by the engine. Parsed documents
cached in `index.db` are regenerable; only run state (B.3, below) is not.

### B.3 Persistence: durable SQLite run state

Run state lives in **`state.db`**
(`src/storage/repositories/workflow-runs-repository.ts`; the former
`workflow.db` was folded into `state.db` in the 0.9.0 three-database cutover),
whose rows are explicitly **non-regenerable**. Four tables carry current run
state:

- `workflow_runs` — `id`, `workflow_ref`, `workflow_title`, `status`
  (`active|completed|blocked|failed`), `params_json`, `current_step_id`,
  timestamps, `scope_key`, `agent_harness`, `agent_session_id`,
  `checkin_armed_at`, plus the engine's own columns: `plan_json`/`plan_hash`
  (the frozen compiled plan) and `engine_lease_holder`/
  `engine_lease_until` (the run lease, see B.5).
- `workflow_run_steps` — `(run_id, step_id)` PK, `step_title`, `instructions`,
  `completion_json`, `sequence_index`, `status`
  (`pending|completed|blocked|failed|skipped`), `notes`, `evidence_json`,
  `completed_at`, `summary`.
- `workflow_run_units` — one row per dispatched unit of
  work under the native engine: `run_id`,
  `unit_id`, `step_id`, `status` (`pending|running|completed|failed|skipped`),
  `input_hash`, `result_json`, `tokens`, `failure_reason`, `worktree_path`,
  `session_id`, `last_checkin_at`, `attempts`, `claim_holder`/
  `claim_expires_at`. Every dispatched unit journals here;
  only historical runs from the removed manual lifecycle can lack unit rows.
- `workflow_run_unit_attempts` — the append-only durable-v4 dispatch journal,
  keyed by `(run_id, unit_id, attempt)`, with a unique `dispatch_id`. Explicit
  retries append a new attempt; crash reclaim reuses the existing dispatch
  identity.

Schema evolves through an additive, idempotent migration engine, recorded in
`schema_migrations`. The first three tables above are the current baseline
(`001-initial-schema` in `src/core/state/migrations.ts`), and
`022-workflow-unit-attempts` adds the append-only attempt journal. The pre-cutover
`workflow.db` history that produced it is preserved for reference in
`scripts/akm-migrate/migrate/legacy/workflow-migrations-bodies.ts` —
`004-workflow-run-units` (the table itself), `005`/`007` (unit session id /
check-in columns), `006-frozen-plan-and-lease` (the engine's frozen plan +
run lease), `008`/`009` (unit attempts / claim columns).

### B.4 Execution model: one native surface, durable memory

`akm workflow run` is the one stable native execution surface. Peer source formats use the same source IR v1 before durable freezing: Markdown `.md` and YAML `.yml`.
A new start by ref compiles source
IR v1 and freezes the resulting durable-v4-family `irVersion: 5` plan on the
run row (`plan_json`/`plan_hash`); edits to the source file need a new run.
Pre-`irVersion`-5
stored plans are rejected rather than keeping a parallel runtime. The
command dispatches each step's units to the configured runner (`llm`, `agent`,
or `sdk`), with:

- **Real concurrency.** A `map` step's units run through a scheduler
  (`src/workflows/exec/scheduler.ts`) capped by `min(map's concurrency,
  workflow.maxConcurrency, the selected engine's concurrency, a CPU-derived
  host safety limit)`. The CPU-derived default — `min(16, max(1, cores − 2))`
  — is, deliberately, the same formula Claude Code's own `agent()` cap uses
  (A.3).
- **Retries** (`retry: { max, on: [<failure-reason>…] }`), journaled per
  attempt so no attempt's row is clobbered.
- **Worktree isolation** (`isolation: worktree`) — a fresh detached git
  worktree per unit attempt for file-mutating agent/sdk units, so parallel
  fan-out can't trample a shared working tree; a clean one is auto-removed,
  a dirty one is retained and its path logged.
- **Typed step artifacts** — a step's declared `output` JSON Schema validates
  the promoted artifact (a solo unit's result, a `collect` fan-out's array, or
  a `vote` fan-out's majority winner) before the step can complete.
- **Gates that judge the artifact**, with `gate.max_loops` turning a rejection
  into a bounded evaluator-optimizer loop (re-run with the judge's feedback
  threaded into every unit prompt). Omitted or empty rubrics skip validation;
  criteria-bearing gates freeze `workflow.judgeEngine`, and unavailable or
  malformed verdicts fail closed.
- **Budget ceilings** (`budget.max_units`/`max_tokens`), enforced across
  resumes because both counters are seeded from the unit journal.

Execution is always the engine's: `akm workflow run` dispatches each unit to
a configured harness (`src/workflows/exec/step-work.ts` holds the shared step
semantics) and a run lease (B.5) keeps a single invocation on the spine. akm
formerly shipped an experimental `brief`/`report` protocol that let a calling
agent session execute units itself; it was removed in favour of the single
native path, since native dispatch already covers ten harnesses — Claude Code
among them — for less code than the protocol cost.

### B.5 Scoping & concurrency guards (two different guards)

Runs are partitioned by **`scope_key`** — a `sha256` of the nearest project
anchor (`.akm/config.json` root → git root → bundle dir → cwd),
`src/workflows/authoring/scope-key.ts`. Within a `(workflow_ref, scope_key)`
pair, `startWorkflowRun` enforces a **single active run** unless `--force` is
passed internally. The public CLI exposes no parallel-start flag: invoking
`workflow run` by ref continues the active run in that scope. This guard is
scope-local by design (two unrelated projects sharing one `state.db` must be
able to run the same-named workflow independently), so two *different*
scopes can each hold their own active run of the same ref — starting one
warns about an active run in another scope (naming its id and scope) rather
than blocking it, and `akm workflow list --all-scopes` / `status` / `resume`
/ `abandon <run-id>` see and act across scopes (#942).

Orchestrated runs add a second, unrelated guard: the **run lease**. `akm
workflow run` takes a lease (a random holder id, 90s expiry, renewed between
steps) before dispatching anything; a second `run` invocation against a
live-leased run refuses. The native engine owns the step spine while it drives.
An expired lease is claimable, so a crashed engine never
wedges a run. `status` stays read-only and always works.

### B.6 Progress tracking

Progress inspection is **pull-based**: `workflow status` reports step rows,
notes, evidence, and summaries; there is no daemon.

What's new: **`akm log --run <run-id>`** reads a run's `workflow_*` /
`workflow_unit_*` events off the general append-only events stream;
`--since '@offset:<id>'` resumes from the last seen row-id cursor, so a
cooperating process can poll it on an interval — there's no daemon, and
no dedicated workflow-watch command (0.9.0 dropped one; this is the general
`log` surface instead). It's not a push channel in Claude Code's
`/workflows`-live-tree sense (there's no server pushing to a client — the
poller polls under the hood), but it closes most of the practical gap: a
second terminal polling `akm log --run <run-id> --since '@offset:<id>'` next
to `akm workflow run <run-id>` gets a live-feeling tail with no daemon of its
own. Event metadata is ids/status/enums only, never workflow-authored
content, so it's safe to pipe into logs or dashboards.

### B.7 Quality gates

Native completion evaluates the step's **promoted artifact**
(real JSON data, clipped at 4000 chars) against the rubric, not a
machine-generated prose summary. A non-empty rubric requires the frozen
`workflow.judgeEngine`, which may be an LLM or agent engine. Only a well-formed
affirmative verdict advances the step; missing, failed, and malformed verifier
results reject. Invoked gates are journaled. `akm workflow resume` can reopen a
failed or blocked run after the underlying issue is corrected.

### B.8 Check-in: stall nudging without a daemon

Unchanged from before the engine: akm records the invoking harness/session
context (`agent_harness`, `agent_session_id`) from environment hints
(`src/workflows/runtime/agent-identity.ts`), arms a **check-in** timestamp
(`checkin_armed_at`) — not a background thread — and on the next `workflow
status` poll by a supervising observer, `evaluateCheckin()`
(`src/workflows/runtime/checkin.ts`) compares `now` against
`max(updated_at, checkin_armed_at)`; past a 90s stall window it surfaces a
`continue` notification through the normal command output. The design ADR
explicitly rejects a background-thread alternative: "No daemon in a CLI… the
command loop is already the heartbeat." A parallel, independent check-in
exists at the *unit* level (`last_checkin_at` marks a long-running unit live
so a stalled one can be reclaimed) — same no-daemon, pure-timestamp design,
different granularity.

The supervising observer receives that `continue` notification only while
polling; akm does not push it in the background.

### B.9 CLI surface

`akm workflow` (`src/commands/workflow-cli.ts`) exposes exactly six public subcommands, derived here from `workflowCommand.subCommands`, not hand-listed:

```
akm workflow status|list|create|resume|abandon|run
```

All six are stable and ungated. `create --print` prints a starter without writing, and `akm lint
--type workflows` structurally validates it. The removed `start`/`next`/
`complete` lifecycle and older `template`/`validate`/`watch` subcommands have
no aliases. Bare `akm workflow` is a usage error (exit 2).

---

## Part C — Side-by-side

akm has peer `.md` and `.yml` asset source formats with one stable native
orchestration surface.

| Dimension | Claude Code workflow | akm workflow |
|---|---|---|
| **Artifact** | Imperative JS program (`script`) | Declarative workflow asset (`.md` or `.yml`), compiled through source IR v1 to durable-v4-family `irVersion: 5` |
| **Authored by** | The agent, inline, per-task, ephemeral | Human or agent, saved as a reusable bundle asset |
| **Who executes work** | The harness runs the script; subagents do the work | The native engine, dispatching to a configured harness |
| **Unit of work** | `agent()` — a fresh LLM subagent context | One dispatch or one `map` item under the engine |
| **Concurrency** | Massively parallel (≤16 concurrent, ≤1000 total, `pipeline`/`parallel`) | Bounded map concurrency, frozen into the plan |
| **Control flow** | Full JS: loops, conditionals, fan-out, budget-scaled | `unit`/`map`/`route`, bare reference strings, and bounded gate retries; no backward routes |
| **State store** | Transcript dir (`journal.jsonl`, `agent-*.jsonl`) | SQLite `state.db`; native-engine runs add unit rows and a frozen `plan_json`/`plan_hash` |
| **Scope / lifetime** | One session, one turn-shaped fan-out | Cross-session, per-project `scope_key`, resumable indefinitely |
| **Progress model** | Push: live `/workflows` tree + `task-notification` | Pull via `status`, with near-live NDJSON event polling via `akm log` |
| **Resume** | Prefix-cache replay keyed on `runId` (needs determinism) | Durable row resume; native-engine units add journaled replay keyed on content-derived identity |
| **Quality gates** | Agent-authored (adversarial verify, judge panels, schemas) | Fail-closed LLM or agent verification of typed artifacts; `gate.max_loops` bounds retries |
| **Sandbox / trust** | Restricted JS interpreter, no FS; subagents use tools | No sandbox; engine units can opt into `isolation: worktree`, which is not a security boundary |
| **Nesting** | `workflow()`, one level deep, sharing the parent's concurrency cap/budget | None built in |
| **Stability** | Stable harness feature | Format and `run` both Stable and ungated |

---

## Part D — Where they overlap

Despite living on different layers, they converge on several ideas — and the
native engine (Part B.4) made two of these convergences much closer than they
used to be:

1. **Task decomposition into named units** — phases/agents vs. steps/units.
2. **Durable run identity and resume** — `runId` prefix-cache vs. `state.db`
   workflow-run rows. Both are built to survive interruption and pick up where
   they left off; the native engine's resume is also **journaled replay**
   keyed on content-derived unit identity, close in spirit to Claude Code's
   cache-and-replay.
3. **Per-unit status + evidence** — journal return values vs. step
   `status`/`notes`/`evidence`/`summary`, plus per-unit
   `workflow_run_units` rows with the same shape.
4. **A "keep going" nudge** — Claude Code's `task-notification`/resume vs.
   akm's run-level `continue` check-in directive and its unit-level
   `last_checkin_at` heartbeat.
5. **Structured validation of results** — Claude Code's `schema` option
   (forced `StructuredOutput`, retried) vs. akm's per-unit `output` JSON
   Schema and fail-closed artifact verifier under the native engine.
6. **Scaffolding + validation of the artifact** — `meta` shape checks vs.
   `akm workflow create --print` / `akm lint --type workflows`, the peer
   source adapters, and their shared source IR.
7. **Bounded, capped concurrency with the same default formula.** Claude
   Code's `agent()` cap and akm's unit scheduler both default to
   `min(16, cores − 2)` — not a coincidence; the engine's CPU-derived default
   was written to match it (B.4).
8. **Awareness of the invoking session** — Claude Code owns the session; akm
   *records* it (`CLAUDE_SESSION_ID` → `claude`). Under the engine this
   awareness becomes load-bearing, not just descriptive: the run lease (B.5)
   uses it to arbitrate which invocation may hold a given run right now.
9. **Native dispatch spans harnesses.** akm executes each unit by invoking a
   configured agent CLI — ten harnesses are supported, Claude Code among them —
   so an akm run composes with the same tools without either system embedding
   the other.

---

## Part E — Where they still diverge, and where they no longer do

The old axis — "who holds the execution loop" — is still the right frame.
Claude Code owns its session-native loop; akm's one public execution surface,
`akm workflow run`, owns the durable workflow loop.

- **Claude Code workflows always own execution.** The harness is the runtime;
  the script is the plan; subagents are the workers. Because the harness
  replays the script to resume, it must constrain the script (no wall-clock,
  no randomness, no FS) and keep it ephemeral. Parallelism is free because the
  runtime schedules it.

- **An akm workflow under `akm workflow run` owns execution.** The native engine
  dispatches real concurrent units through the multi-harness
  substrate: `RunnerSpec` `llm|agent|sdk` + `executeRunner`, the same spawner
  `akm improve`/`reflect` already uses. It retries them, isolates them in
  worktrees, judges their typed artifacts, and enforces budget ceilings — a
  genuine, Stable executor. It keeps a durable spine through a frozen plan and
  journaled resume rather than trading those properties away for parallelism.

- **akm owns the plan and the durable completion semantics** — routing,
  artifact promotion, verification, and replay — while the harness it
  dispatches to owns only the work inside a single unit.

Concretely, per surface:

| | Claude Code workflow | akm native engine (`run`) |
|---|---|---|
| Lifetime | Ephemeral (session-scoped) | Durable (SQLite, cross-session) |
| Parallel? | Yes, by construction | Yes, bounded (B.4) |
| Self-contained? | Yes — carries its own workers | Yes, when a configured engine is available (or `opencode` is on PATH) |
| Sandbox | Restricted JS interpreter, no FS for the script itself | None for the shell/agent substrate; optional `isolation: worktree` is not a security boundary |
| Artifact | Executable script | Managed `.md` or `.yml` workflow asset, compiled and frozen |

The genuinely durable conclusion, restated for 0.9.2: Claude Code is strong
at in-session parallel LLM execution, while akm is strong at durable,
cross-session procedures. The native engine keeps the second half of that
trade while buying back some of the first — dispatching units to whichever
harness the operator configured, Claude Code included.

---

## Part F — What's left to integrate

Most of what this section used to propose as *future* integration work has
**shipped** as the native engine described in Part B — not as
Claude-Code-specific features, but as harness-agnostic ones:

| Formerly-proposed idea | Status |
|---|---|
| A blessed loop pattern for invoking an akm run with structured per-step results | **Shipped**, generalized: an invoking agent or orchestrator invokes the native `akm workflow run`, which dispatches to any of ten configured harnesses (Part B.4) — not Claude-Code-specific |
| Machine-readable, near-live progress instead of polling `status` | **Shipped**: `akm log --run <id> --since '@offset:<id>'` (Part B.6) |
| Structural (schema) validation of step output, not just an LLM prose judge | **Shipped**: per-unit `output` JSON Schema + typed step artifacts, validated before a gate ever runs (Part B.4/B.7) |
| An explicit fan-out step type | **Shipped**: `map` steps with `over`/`concurrency`/`reducer` (Part B.4) |

What's genuinely still not built, as of this writing:

### F.1 Correlate an akm run with the invoking harness's own run/session id

`agent-identity.ts` captures `agent_harness`/`agent_session_id` from
environment hints, and each unit records its harness-native session id
(Part B.3). Neither captures a *workflow-
level* id from an external orchestrator (e.g. a Claude Code `Workflow` tool's
own `runId`) when it invokes an akm run — there is no env-hint or CLI flag for
it today, so correlating an akm run with its invoking Claude Code workflow
invocation still has to be done by hand (matching timestamps, logs).

### F.2 Notify a supervising observer instead of waiting for its next poll

The check-in (Part B.8) is still exactly as passive as the ADR mandates: it
surfaces only on the next `workflow status` poll, never proactively.
There is no signal-file or other out-of-band mechanism that lets a stalled
run *notify* a supervising or polling observer capable of receiving one (the ADR's own design
contemplates "a best-effort checkin signal file under the run scope" as a
future extension) — this remains unbuilt.

### F.3 Two-way compilation between the artifacts

Neither direction exists: there is no `akm workflow export` that emits a
script/pattern specialized to a given workflow for a specific harness, and
there is no `akm workflow ingest-journal` (or equivalent) that converts an
external orchestration journal into an akm run. The former live
external-driver protocol is retired; an external agent can invoke
`akm workflow run` and inspect `status` or `akm log`, but it does not drive an
alternate akm execution surface.

### F.4 Suppress the check-in when an observer already provides liveness

The check-in fires uniformly for any active run past the stall window
(`evaluateCheckin`, Part B.8) — it does not special-case a recorded
invoking harness/session context when an external observer already supplies
its own liveness/orchestration (so it would not stall the way a free-form chat
agent can). This is a small, purely local trim on top of the existing check-in
logic, not a new subsystem, but it is not implemented today.

### F.5 Distribute non-akm executable workflow scripts as akm assets

The `workflow` asset type carries akm's peer `.md` and `.yml` source formats.
There is no mechanism for it to carry or reference an
externally-executable script (a Claude Code `Workflow` tool script, or
anything else) as an alternate form alongside the runbook, which would let
akm's package-manager strengths (`add`, search, `curate`, version pinning,
feedback/improve) apply to *that* artifact too. This is the largest and most
speculative item on this list.

The guiding principle is to preserve each layer's strength. The native engine
gives akm concurrency without discarding its durable, verified spine, and it
dispatches the work itself to whichever harness the operator configured —
Claude Code included — instead of either side reimplementing the other.
