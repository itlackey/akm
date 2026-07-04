# Extending akm workflows into a harness-agnostic orchestration engine

**Status:** Draft plan for discussion. Supersedes Part F of
[`claude-code-vs-akm-workflows.md`](./claude-code-vs-akm-workflows.md).

## Goal

Give akm workflows the **deterministic orchestration features Claude Code
offers — parallel fan-out, structured per-unit output, phases/progress,
budgeted execution, resumable runs — for any agent harness**, while keeping
akm's unique value (a durable, gated, cross-session SQLite run record).

Two execution backends, one definition:

- **Delegate to Claude Code.** akm compiles the workflow definition into a
  Claude Code `Workflow` script, hands execution to Claude Code, and Claude
  Code reports every unit back to akm so `workflow.db` stays the source of
  truth.
- **Native.** For the OpenCode SDK and other CLI harnesses, akm executes the
  same definition itself, providing the Claude-Code-equivalent features on top
  of akm's **existing** agent-execution substrate.

The organizing principle: **steps remain the durable, gated, sequential spine;
execution *within* a step fans out.** Human/criteria gates stay between steps
(akm's differentiator); parallelism and subagents live inside a step (Claude
Code's differentiator). This reconciles the two models instead of replacing
one with the other.

## What already exists (so this is a build-on, not a rewrite)

akm is already multi-harness and already spawns agents. The native executor
reuses, rather than reinvents, this substrate:

| Capability | Existing code |
|---|---|
| Harness-agnostic runner union `llm \| agent \| sdk` + single dispatch seam | `src/integrations/agent/runner.ts` (`RunnerSpec`), `runner-dispatch.ts` (`executeRunner`) |
| OpenCode SDK session runner (fs access) | `src/integrations/harnesses/opencode-sdk/sdk-runner.ts` (`runOpencodeSdk`) |
| Agent CLI spawn: timeouts, process-group kill, structured failure reasons | `src/integrations/agent/spawn.ts` (`runAgent`, `AgentRunResult`) |
| Per-platform argv construction | `src/integrations/agent/builders.ts`, `harnesses/{claude,opencode}/agent-builder.ts` |
| Structured (schema-validated) LLM output with retry | `src/llm/structured-call.ts` (`callStructured`, `responseSchema`) |
| Token/usage metering | `src/llm/usage-telemetry.ts`, `usage-persist.ts` |
| Durable run state + additive migrations | `src/workflows/db.ts`, `storage/repositories/workflow-runs-repository.ts` |
| Driving-harness/session identity capture | `src/workflows/runtime/agent-identity.ts` |

What is **missing** and must be built: an orchestration layer (a plan IR + a
concurrency scheduler + fan-out/phase semantics), a Claude Code script emitter
with a report-back protocol, per-unit persistence, and a live event stream.

## Open decisions (assumed defaults — tell me to change any)

The plan below is written against these defaults. Each is a real fork; the
rationale is given so you can override.

1. **Definition format → backend-agnostic IR, Markdown as the primary
   frontend.** Extend the Markdown grammar for the common cases and compile it
   to a structured **Workflow Plan Graph** IR that *both* backends consume.
   Rationale: directly serves "same features regardless of harness" and is the
   only design that keeps the CC-delegation path and the native path from
   drifting (they share the IR + a conformance suite). An optional imperative
   frontend can be added later without touching the backends.
   *Rejected for now:* a pure imperative `.mjs` as akm's native format — it
   forces akm to build a deterministic JS sandbox and inherits CC's
   `Date.now`/`random` ban.

2. **CC delegation → akm stays source of truth via callbacks.** The generated
   CC script reports each unit to akm (`akm workflow report …`) as it runs.
   Rationale: preserves the durability/gating that is akm's reason to exist and
   survives a mid-run crash. *Cost:* the generated script depends on the `akm`
   CLI being on PATH inside the CC session.

3. **Native resume → durable-row, no determinism ban.** Keep akm's SQLite
   model; add per-unit result rows; resume re-dispatches only incomplete units.
   Rationale: fits the declarative IR, avoids a JS-determinism sandbox, and
   reuses the existing migration discipline.

4. **v1 parity scope → parallel fan-out + structured schema output first;**
   phases/progress-stream and budget/worktree isolation as fast-follow.
   Rationale: fan-out and schema output are the load-bearing parity features and
   both have existing substrate (`executeRunner`, `callStructured`); progress
   streaming and budget ceilings are additive and can land incrementally.

## Architecture

```
                 ┌─────────────────────────────────────────────┐
   authoring     │  Markdown workflow (extended grammar)        │
   frontend      │  (future: imperative frontend)               │
                 └───────────────────┬─────────────────────────┘
                                     │  compile (parser + ir/compile.ts)
                                     ▼
                 ┌─────────────────────────────────────────────┐
      IR         │  Workflow Plan Graph  (ir/schema.ts)         │
                 │  nodes: agent | parallel | pipeline | map |  │
                 │         gate | subworkflow                   │
                 └──────────┬───────────────────────┬──────────┘
                            │                        │
        backend A           │                        │   backend B
   (delegate to CC)         ▼                        ▼   (native)
   ┌───────────────────────────────┐   ┌──────────────────────────────────┐
   │ cc-emitter.ts                 │   │ native-executor.ts + scheduler.ts │
   │  IR → CC Workflow .mjs        │   │  IR → executeRunner() fan-out     │
   │  agents call `akm workflow    │   │  concurrency cap, schema, budget, │
   │  report` back to akm          │   │  worktree isolation               │
   └───────────────┬───────────────┘   └───────────────┬──────────────────┘
                   │        reports / unit results      │
                   ▼                                     ▼
        ┌──────────────────────────────────────────────────────┐
 shared │  workflow.db  (+ workflow_run_units, migration 004)   │
 state  │  event stream (appendEvent + `akm workflow watch`)    │
        │  budget meter (usage-telemetry)                       │
        └──────────────────────────────────────────────────────┘
```

## The IR — Workflow Plan Graph

A JSON, versioned, serialized-alongside-`WorkflowDocument` structure. Node
kinds mirror the Claude Code primitives so the CC emitter is a near-direct
mapping and the native executor has a small, closed vocabulary:

| Node kind | Semantics | CC analogue |
|---|---|---|
| `agent` | Run one unit: prompt/instructions + runner + model + optional schema | `agent()` |
| `parallel` | Run children concurrently with a **barrier** | `parallel()` |
| `pipeline` | Run items through child stages, **no barrier** between stages | `pipeline()` |
| `map` / fan-out | Run one child template over a runtime item list | `parallel(items.map(...))` |
| `gate` | Human-review / completion-criteria gate (akm-unique) | *(none — akm's differentiator)* |
| `subworkflow` | Inline another workflow (one level) | `workflow()` |

Per-node fields: `id`, `kind`, `instructions` (template with `params`
interpolation), `runner` (`llm|agent|sdk|inherit`), `model`, `effort`,
`schema` (JSON Schema for structured output), `phase`, `isolation`
(`none|worktree`), `dependsOn[]`, and `source` (`SourceRef`, retained from the
Markdown so editors/errors still point at lines). Run-level: `params`,
`budget` (`{maxTokens?, maxUnits?}`).

Backward compatibility: an existing linear workflow compiles to a chain of
`agent` nodes, one per step, each preceded by its `gate` — identical behavior
to today.

## Frontend — extended Markdown grammar

Additive, backward-compatible. A step body may declare orchestration; steps
that declare none behave exactly as they do now. Illustrative additions
(names TBD):

```markdown
## Step: Review changed files
Step ID: review

### Runner
sdk            # llm | agent | sdk | inherit (default: inherit run default)

### Fan-out
over: changed_files            # a run param or a prior step's evidence key
concurrency: 8                 # capped by the engine's global limit

### Instructions
Review {{item}} for correctness bugs. Return findings.

### Schema
findings: array of { file: string, line: number, summary: string }

### Completion Criteria
- every changed file has a verdict
```

`## Phase: <name>` headings group subsequent steps for progress display.
`### Depends On` lets a step declare non-linear ordering (compiles to IR
edges). Parsing extends `src/workflows/parser.ts` and the `WorkflowDocument`
schema; the new subsections slot into the existing `collectSubsections`
machinery, so the parser keeps accumulating `WorkflowError`s rather than
throwing.

## Backend A — delegate to Claude Code

`src/workflows/exec/cc-emitter.ts` compiles the IR into a Claude Code
`Workflow` script:

- `meta` from the workflow title/description; `meta.phases` from the IR phases.
- Each IR node → the matching CC hook (`agent`/`parallel`/`pipeline`/`workflow`).
- **Report-back wrapper.** Every emitted `agent()` is wrapped so that, on
  completion, it shells `akm workflow report --run <id> --unit <nodeId>
  --status … --result <json> --tokens …`. akm thus records each unit live.
  A run-level preamble reports `run started`; a `finally` reports terminal
  state.
- Schema nodes emit `agent(prompt, { schema: <jsonSchema> })` directly — CC's
  `schema` option is a 1:1 match for the IR `schema` field.
- akm launches the script (writes it under the run scope and asks the CC
  session to run it via the `Workflow` tool), then waits on reported units;
  the check-in mechanism (below) covers a CC session that goes silent.

New command: **`akm workflow report`** — the ingest endpoint. It writes
`workflow_run_units` rows and, when a unit maps to a step's terminal unit,
advances the step through the existing `completeWorkflowStep` path (so the
summary-validation gate still runs). This is the one place the delegation
boundary crosses back into akm's durable model.

## Backend B — native executor

`src/workflows/exec/native-executor.ts` + `scheduler.ts`:

- **Dispatch.** Each `agent` node builds a `RunnerSpec` (default `sdk` →
  `runOpencodeSdk`; or `agent` CLI; or `llm`) and calls the existing
  `executeRunner(spec, prompt, opts)`. No new agent-spawning code — the
  substrate is done.
- **Scheduler.** A semaphore-bounded async scheduler enforces
  `concurrency = min(16, cores − 2)` (matching CC). `parallel` awaits all
  children (barrier); `pipeline` advances each item through stages
  independently (no barrier); `map` expands the item list then schedules like
  `parallel`. A lifetime unit cap backstops runaways.
- **Structured output.** Schema nodes route through `callStructured` with
  `responseSchema`; a validation failure retries, then records a `parse_error`
  unit — mirroring CC's forced-`StructuredOutput` retry.
- **Worktree isolation.** `isolation: worktree` nodes get a fresh `git
  worktree` (auto-removed if unchanged), so parallel file-mutating units don't
  collide — the same guard CC offers.
- **Budget.** `usage-telemetry` aggregates tokens across units; the run aborts
  pending units when `budget.maxTokens`/`maxUnits` is hit (hard ceiling).
- **Resume.** On restart, completed `workflow_run_units` rows are treated as
  done; only incomplete units re-dispatch. No script replay, so no
  determinism constraints.

## Persistence changes

New table (migration `004`, additive per `db.ts` contract):

```sql
CREATE TABLE workflow_run_units (
  run_id        TEXT NOT NULL,
  unit_id       TEXT NOT NULL,          -- unique within run
  step_id       TEXT,                   -- owning step (the gated spine)
  node_id       TEXT NOT NULL,          -- IR node this unit instantiates
  parent_unit_id TEXT,                  -- fan-out / subworkflow parent
  phase         TEXT,
  runner        TEXT,                   -- llm | agent | sdk
  model         TEXT,
  status        TEXT NOT NULL,          -- pending|running|completed|failed|skipped
  input_hash    TEXT,                   -- for resume idempotency
  result_json   TEXT,
  tokens        INTEGER,
  worktree_path TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  PRIMARY KEY (run_id, unit_id),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
```

`workflow_run_steps` stays as the top-level gated spine; units hang off a step.
**Write-concurrency:** N parallel units completing at once contend on
SQLite's single writer. Serialize unit writes through one in-process writer
queue (Bun is single-threaded, so a promise-chained queue suffices) and keep
the LLM summary gate outside the write transaction, exactly as
`completeWorkflowStep` already does.

## Progress & events

Both backends emit the **same** event vocabulary via the existing
`appendEvent` (`unit_started`, `unit_finished`, `phase_entered`, plus the
current `workflow_*` events). A new `akm workflow watch <run> --stream` tails
them as NDJSON, giving a single live view whether execution is native or
delegated to Claude Code — closing the push-vs-pull gap the comparison report
identified, without a resident daemon (consistent with the check-in ADR).

## Check-in, extended

The timestamp check-in (`runtime/checkin.ts`, no background thread) extends to
units: a run with a `running` unit idle past the stall window surfaces the
`continue` directive on the next poll. For the delegated backend this is the
safety net for a CC session that stops reporting.

## Anti-drift: the conformance suite

A set of golden workflows runs through **both** backends with mocked runners;
the suite asserts an identical unit graph and identical per-unit results. This
is the structural guarantee that "same features regardless of harness" stays
true as both backends evolve (pitfall #2).

## Trust & limits

Native fan-out changes the blast radius: today a step is one shell command; a
`map` node is N concurrent agents with filesystem/worktree access. The native
executor must enforce what CC enforces and akm currently lacks — concurrency
cap, lifetime unit cap, per-run budget ceiling, per-unit timeout (already in
`runAgent`), and worktree isolation. The existing "workflow sources are trusted
executable code" doc guidance extends to: a workflow that fans out is
authorizing N parallel agents, not one.

## Rollout phases

- **P0 — IR + compiler.** `ir/schema.ts`, `ir/compile.ts`. Existing linear
  workflows compile to a linear IR; execution still goes through today's
  step loop. No behavior change; pure refactor + new tests.
- **P1 — native fan-out + schema (v1 parity core).** `scheduler.ts`,
  `native-executor.ts`, `workflow_run_units` (migration 004), extended
  Markdown grammar for `Runner`/`Fan-out`/`Schema`. New `akm workflow run`
  drives a step's IR subgraph natively.
- **P2 — CC delegation.** `cc-emitter.ts`, `akm workflow report`, launch/handoff
  glue. Delegation path reaches parity with native for the shared IR.
- **P3 — phases, progress stream, budget, worktree.** `akm workflow watch`,
  budget ceilings, `isolation: worktree`.
- **P4 — hardening.** Conformance suite across backends; optional imperative
  frontend.

## File-by-file touch list

New:
- `src/workflows/ir/schema.ts`, `src/workflows/ir/compile.ts`
- `src/workflows/exec/scheduler.ts`, `native-executor.ts`, `cc-emitter.ts`, `report.ts`
- `tests/workflows/conformance/**` (golden IR + both-backend assertions)

Extend:
- `src/workflows/schema.ts` (orchestration fields), `parser.ts` (new subsections)
- `src/workflows/db.ts` (migration 004 + units table), `workflow-runs-repository.ts`
- `src/workflows/runtime/runs.ts` (route a step to the executor; ingest reports)
- `src/workflows/cli.ts` + `src/commands/workflow-cli.ts` (`run`, `watch`, `report`)
- `src/workflows/runtime/checkin.ts` (unit-level stall)
- `src/workflows/renderer.ts` (surface orchestration in `show`)

Reuse unchanged:
- `src/integrations/agent/runner-dispatch.ts`, `spawn.ts`, `runner.ts`, `builders.ts`
- `src/integrations/harnesses/opencode-sdk/**`
- `src/llm/structured-call.ts`, `usage-telemetry.ts`
