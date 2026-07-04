# Extending akm workflows into a harness-agnostic orchestration engine

**Status:** Draft plan for discussion. Supersedes Part F of
[`claude-code-vs-akm-workflows.md`](./claude-code-vs-akm-workflows.md).

## Goal

Give akm workflows the **deterministic orchestration features Claude Code
offers — parallel fan-out, structured per-unit output, phases/progress,
budgeted execution, resumable runs — for any agent harness**, while keeping
akm's unique value (a durable, gated, cross-session SQLite run record).

One definition, **pluggable execution backends** — a unit's runner/profile
picks which one (see *Multi-harness execution* for the full survey):

- **Delegate to Claude Code** (in-harness orchestration). akm compiles the
  workflow into a Claude Code `Workflow` script, hands execution to Claude Code,
  and Claude Code reports every unit back to akm so `workflow.db` stays the
  source of truth.
- **Native** (local runner). For the OpenCode SDK, Codex, Copilot CLI, Pi,
  Aider, Gemini, Amazon Q, OpenHands, and any headless coding-agent CLI, akm
  executes the same definition itself — providing the Claude-Code-equivalent
  fan-out, schema output, phases, budget, and resume on top of akm's
  **existing** agent-execution substrate.
- **Cloud delegate** (assign + ingest). For cloud-only agents that can't be
  spawned locally — the GitHub Copilot coding agent today — akm assigns the
  unit through the provider API and ingests the result from the produced PR.

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

3. **Native resume → configurable: durable-row by default, deterministic
   replay available.** Durable-row resume is the default and the only mode the
   declarative-IR path needs: per-unit result rows, resume re-dispatches only
   incomplete units, no JS-determinism ban. A **deterministic replay mode** is
   also supported for workflows that need CC-exact semantics (primarily the
   future imperative frontend): the run caches unit results by input hash and
   replays the plan, which requires the determinism constraints
   (`Date.now`/`random` banned) to hold *for that mode only*. The two modes
   share the `workflow_run_units` store; replay mode adds an input-hash cache
   lookup before dispatch. See [Resume — two modes](#resume--two-modes).

4. **v1 parity scope → parallel fan-out + structured schema output only;**
   phases/progress-stream and budget/worktree isolation are explicitly
   **deferred** to fast-follow. Fan-out and schema output are the load-bearing
   parity features and both have existing substrate (`executeRunner`,
   `callStructured`); progress streaming and budget ceilings are additive and
   land incrementally (P3).

> These four are **decided** (owner-confirmed), not open. Decision 3 was the one
> change from the first draft: resume is *configurable* (both modes), not
> durable-row-only.

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

| Node kind | Semantics | CC analogue | Research basis |
|---|---|---|---|
| `agent` | Run one unit: prompt/instructions + runner + model + optional schema | `agent()` | ReAct; the atom of every pattern |
| `pipeline` | Run items through child stages, **no barrier** between stages | `pipeline()` | Prompt chaining |
| `parallel` | Run children concurrently with a **barrier** (sectioning) | `parallel()` | Parallelization / sectioning |
| `map` / fan-out | Run one child template over an item list — **static or LLM-generated** — with an optional **reducer** (`collect \| vote \| best-of-n`) | `parallel(items.map(...))` | Orchestrator-workers; Self-Consistency (voting) |
| `router` *(new)* | Classify an input and dispatch to one of N branches | *(agent + conditional)* | Routing |
| `gate` | Human-review / completion-criteria approval — **one-shot or loop-until-pass** with evaluator feedback | *(none — akm-unique)* | Evaluator-optimizer; Reflexion; Chain-of-Verification |
| `subworkflow` | Inline another workflow (one level); may delegate to a peer agent/harness | `workflow()` | Orchestrator-workers; A2A delegation |

The last three columns are the point: the node vocabulary is not "whatever
Claude Code happens to expose" — it is the closed set of orchestration patterns
the literature has converged on (§ *Grounding in published research*). Three
additions came directly from that review:

- **`router`** makes the *routing* pattern first-class instead of an `agent`
  whose free-text output is parsed to pick a branch.
- **`map` reducers** (`vote`, `best-of-n`) make *Self-Consistency* /
  *parallelization-voting* a declared property, not something each workflow
  re-implements; `map` also accepts a **dynamically LLM-generated** item list so
  it expresses true *orchestrator-workers*, not just static sectioning.
- **Looping `gate`s** make *evaluator-optimizer* expressible: a gate can feed
  its `missing[]`/`feedback` back to the generating node and re-run up to a
  bound, rather than only passing or blocking once.

Per-node fields: `id`, `kind`, `instructions` (template with `params`
interpolation), `runner` (`llm|agent|sdk|delegate|inherit`), `model`, `effort`,
`schema` (JSON Schema for structured output), `phase`, `isolation`
(`none|worktree`), `dependsOn[]`, `reducer` (map only), `maxLoops` (gate only),
`idempotencyKey` (defaulted to `run_id + node_id + attempt`), and `source`
(`SourceRef`, retained from the Markdown so editors/errors still point at
lines). Run-level: `params`, `budget` (`{maxTokens?, maxUnits?}`),
`resume` (`durable|replay`).

The **`idempotencyKey`** is a durability primitive borrowed from Temporal/DBOS
(§ research): every unit records one, so a crash-and-resume never re-issues a
side-effecting tool call for a unit that already completed — the piece that
makes durable-row resume *safe* rather than merely convenient.

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

- **Dispatch.** The scheduler selects a `UnitExecutor` per node (see
  *Reconciliation*). The common `SpawnUnitExecutor` builds a `RunnerSpec`
  (default `sdk` → `runOpencodeSdk`; or `agent` CLI; or `llm`) and calls the
  existing `executeRunner(spec, prompt, opts)` — no new agent-spawning code.
  `delegate` nodes use a separate `DelegateUnitExecutor`, not a `RunnerSpec`.
- **Scheduler.** A semaphore-bounded async scheduler enforces
  `concurrency = min(16, cores − 2)` (matching CC). `parallel` awaits all
  children (barrier); `pipeline` advances each item through stages
  independently (no barrier); `map` expands the item list then schedules like
  `parallel`. A lifetime unit cap backstops runaways.
- **Structured output.** Schema nodes route through the extracted
  `runStructured` core (see *Reconciliation* — `callStructured` today has no
  validation-driven retry, so this is a factor-out, not a drop-in reuse); a
  validation miss retries with feedback, then records a `parse_error` unit —
  mirroring CC's forced-`StructuredOutput` retry.
- **Worktree isolation.** `isolation: worktree` nodes get a fresh `git
  worktree` (auto-removed if unchanged), so parallel file-mutating units don't
  collide — the same guard CC offers.
- **Budget.** `maxUnits` is meterable today (count dispatches). `maxTokens`
  requires threading `usage` through `AgentRunResult` first (today
  `runOpencodeSdk` discards it — see *Reconciliation*); once landed,
  `usage-telemetry` aggregates across units and the run aborts pending units at
  the ceiling. Aborting a *running* unit needs the new `signal` seam.
- **Resume.** Configurable per run (default durable-row) — see next section.

## Resume — two modes

Resume is a per-run mode (`resume: "durable" | "replay"`, default `"durable"`),
selectable in workflow frontmatter or on the CLI. Both modes use the same
`workflow_run_units` store; they differ only in what a re-dispatch is allowed to
assume.

- **Durable-row (default).** On restart, units with a terminal status
  (`completed`/`skipped`) are treated as done; `pending`/`running` units
  re-dispatch from scratch. The plan graph is walked fresh each time, so a unit
  that ran but didn't persist simply runs again. No constraints on the workflow.
  This is the only mode the declarative-IR path needs, and the right default
  because it is robust to partial writes and non-deterministic node bodies.

- **Deterministic replay (opt-in).** For workflows that need Claude-Code-exact
  resume semantics — primarily the future imperative frontend, where the plan is
  produced by *running code* rather than a static graph — the executor caches
  each unit's result keyed by `input_hash` (a stable hash of the resolved
  prompt + runner + model + schema) and, on replay, returns the cached result
  instead of re-dispatching. This makes resume a pure prefix replay, matching
  CC's `runId` cache. The cost is CC's constraint: the workflow must be
  deterministic in replay (no wall-clock/random in node inputs), enforced only
  when `resume: "replay"` is set so it never burdens the default path.

Both modes preserve the gated spine: a `gate` unit that was `blocked` stays
blocked across resume regardless of mode (human approval is never cached).

## Multi-harness execution

The "same features regardless of harness" promise means the *same IR* must run
on any coding-agent CLI or cloud agent. Surveying the current landscape (Claude
Code, OpenCode, OpenAI Codex, GitHub Copilot, Pi, Aider, Gemini CLI, Amazon Q,
OpenHands) shows they fall into **three integration patterns**, and akm needs
all three behind one interface.

### The three integration patterns

1. **In-harness orchestration (delegate + compile).** The harness has its *own*
   parallel-orchestration runtime. akm compiles the IR to that harness's native
   program and delegates, with report-back. Today this is **Claude Code**
   (Backend A → a `Workflow` script). This is the highest-fidelity path because
   the harness runs the fan-out itself.

2. **Local runner (native, spawn-per-unit).** The harness is a headless CLI akm
   spawns once per `agent` unit via the existing `runAgent` + a per-harness
   `AgentCommandBuilder`. akm's own scheduler (Backend B) provides the fan-out,
   phases, budgeting, and resume the CLI lacks. This is the **default for every
   other local CLI** — Codex, Copilot CLI, Pi, OpenCode, Aider, Gemini, Q,
   OpenHands.

3. **Cloud delegate (assign + ingest artifact).** The agent is cloud-hosted and
   *cannot* be spawned as a local subprocess. akm delegates a unit by creating a
   task through the provider's API and ingests the result from the produced
   artifact (a PR/branch). Today this is the **GitHub Copilot coding agent**
   (assign issue → `copilot-swe-agent[bot]` opens a PR → akm ingests). A new
   `runner: delegate` unit kind + a `report`-style poller cover it; the same
   pattern generalizes to other cloud agents (Codex Cloud, Jules, Devin).

All three are backends over the **one IR**; a unit's `runner`/profile picks the
pattern. The conformance suite (below) asserts identical unit graphs across
patterns.

### The adapter contract — what adding a harness costs

akm already has the seam (`src/integrations/harnesses/types.ts`,
`agent/builders.ts`). Adding a harness to the workflow engine is:

1. **`AkmHarness` descriptor** — register in `HARNESS_REGISTRY` with capability
   flags; add `agentDispatch: true` and a `runtimeId`.
2. **`AgentCommandBuilder`** — translate the platform-agnostic
   `AgentDispatchRequest` (system prompt, model, prompt, tool policy) into the
   CLI's headless argv. This is the only genuinely new code per harness, and
   it's ~20 lines (see the matrix for the exact invocation).
3. **Result extractor** — normalize the harness's output into a unit result +
   validate against the node `schema` (see *Structured-output normalization*).
4. **Identity markers** — the env var(s) that reveal "a unit is running under
   this harness," added to `agent-identity.ts`.

Nothing in the IR, scheduler, persistence, or gate logic changes per harness —
that is the whole point of routing everything through `RunnerSpec` /
`executeRunner`.

### Capability matrix (as researched, July 2026)

| Harness | Headless invocation | Structured output | Native schema | Resume | MCP | Identity env | Pattern |
|---|---|---|---|---|---|---|---|
| **Claude Code** | (`Workflow` tool / `claude -p`) | tool calls | via tool schema | `runId` cache | client+server | `CLAUDE_SESSION_ID` | in-harness |
| **OpenCode** | SDK `session.prompt` / CLI | SDK events | via prompt+validate | session id | client | `OPENCODE_SESSION_ID` | local (sdk/cli) |
| **OpenAI Codex** | `codex exec "<p>"` | `--json` (JSONL events) | **`--output-schema <file>`** | `codex exec resume <id>` | client+server | `CODEX_SANDBOX`, `CODEX_HOME` | local |
| **Copilot CLI** | `copilot -p "<p>" --allow-all-tools` | `--output-format json` | via prompt+validate | `--continue`/`--resume <id>` | `~/.copilot/mcp-config.json` | `COPILOT_*`/`GH_TOKEN` | local |
| **Copilot coding agent** | assign issue / `gh agent-task` / API | task status API + PR | n/a | server-side (PR branch) | GitHub MCP (tools) | `copilot-swe-agent[bot]` | **cloud delegate** |
| **Pi** | `pi -p "<p>"` | `--mode json` (JSONL) | via prompt+validate | `-c`/`-r`/`--session` | extensions only | `PI_*` | local |
| **Gemini CLI** | `gemini -p "<p>"` | `--output-format json` | via prompt+validate | `--resume <id>` | client (`settings.json`) | `GEMINI_CLI=1` | local |
| **Amazon Q** | `q chat --no-interactive --trust-all-tools` | *(none documented)* | via prompt+validate | `--resume` | client (`mcp.json`) | *(uncertain)* | local |
| **OpenHands** | `openhands --headless -t "<p>" --json` | `--json` (JSONL) | via prompt+validate | workspace state | native | *(uncertain)* | local |
| **Aider** | `aider -m "<p>" --yes-always` | *(none — parse output)* | via prompt+validate | chat-history files | *(none native)* | *(uncertain)* | local |

*(Details are as of the research date; the adapter contract localizes every one
of these to a single builder + extractor so version churn is contained.)*

### Structured-output normalization — akm provides the deterministic feature

The parity goal is that **every** harness yields schema-validated unit results,
even the ones with no native schema support. Three tiers:

- **Native schema** (Codex `--output-schema`): pass the node `schema` straight
  through; trust the constrained output, still validate defensively.
- **Native JSON stream** (Copilot, Pi, Gemini, OpenHands): parse the
  documented JSONL/JSON, extract the final message, then validate against the
  node `schema`.
- **No structured output** (Aider, Q): akm injects the schema into the prompt
  ("return only JSON matching …"), extracts embedded JSON from stdout (the
  existing `parseEmbeddedJsonResponse` in `spawn.ts` already does this), and
  validates.

All three funnel through one **retry-until-valid** loop reusing
`callStructured`'s discipline (`src/llm/structured-call.ts`): on a validation
miss, re-dispatch with corrective feedback up to a bound, then record a
`parse_error` unit. So akm *supplies* CC's forced-`StructuredOutput` guarantee
uniformly — that is the "deterministic features regardless of harness" promise
made concrete.

### Session, MCP, and identity across harnesses

- **Session/resume.** akm's `workflow_run_units` is the source of truth; a
  harness's native session id is stored opportunistically on the unit row and
  reused (e.g. `codex exec resume <id>`) to preserve the harness's own context
  cache, but akm never *depends* on it — resume works even against a harness
  with no session model (Aider).
- **MCP for tools.** akm should expose stash search / `show` / memory as an
  **MCP server**, so any MCP-client harness (Codex, Copilot, Gemini, Q,
  OpenHands, Claude, OpenCode) can pull exactly the knowledge a unit needs
  in-band — the same "pull what you need" model akm already champions, now
  available inside a workflow unit regardless of harness.
- **A2A for delegation.** For `subworkflow`/`delegate` units that hand work to a
  *separate* agent/service (including the cloud pattern), Agent2Agent is the
  cross-vendor wire protocol; MCP is for reaching tools, A2A for reaching peer
  agents (§ research).
- **Identity.** `agent-identity.ts` extends its detection table:
  `CLAUDE_SESSION_ID`→claude-code, `OPENCODE_SESSION_ID`→opencode,
  `CODEX_SANDBOX`/`CODEX_HOME`→codex, `GEMINI_CLI`→gemini,
  `COPILOT_*`→copilot, `PI_*`→pi. This is what lets a workflow that akm drives
  *also* record which harness actually executed each unit.

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

A set of golden workflows runs through **all backends** with mocked runners;
the suite asserts an identical unit graph and identical per-unit results. This
is the structural guarantee that "same features regardless of harness" stays
true as the backends (CC-delegate, native-local, cloud-delegate) evolve
(pitfall #2).

## Grounding in published research

The node vocabulary and durability model are deliberately aligned with the
patterns the agent-orchestration literature has converged on, so akm unifies
the field's best ideas rather than inventing a parallel one. Summary of the
cross-reference (sources listed at the end):

### Orchestration patterns → IR node kinds

Anthropic's **Building Effective Agents** (Dec 2024) taxonomy is the spine, and
its five workflow patterns map onto the IR almost 1:1 — which is the evidence
that the node set is *complete* rather than arbitrary:

| Pattern (source) | akm IR expression |
|---|---|
| Prompt chaining | `pipeline` |
| Routing | **`router`** (added after this review) |
| Parallelization — sectioning | `parallel` |
| Parallelization — voting | `map` + `reducer: vote` (Self-Consistency, Wang 2022) |
| Orchestrator–workers | `subworkflow` + `map` over a **runtime, LLM-generated** list |
| Evaluator–optimizer | **looping `gate`** (Reflexion, Shinn 2023; Chain-of-Verification, Dhuliawala 2023) |

The review drove four concrete IR changes already folded in above: the
`router` node, `map` reducers (`vote`/`best-of-n`), looping gates with feedback,
and dynamic fan-out lists. Tree-of-Thoughts-style search is intentionally left
as an agent-internal strategy, not an IR construct (out of scope).

### Framework execution models → what akm borrows

- **LangGraph** — checkpoint-per-node + thread-scoped resume + `interrupt()`
  for human-in-the-loop. Validates akm's durable per-unit rows and `gate`
  pause/resume. *Caveat from the field (Diagrid, 2025):* checkpoints are not
  durable execution if non-deterministic replay re-fires side effects — which is
  exactly why akm journals each unit's **result** and defaults to durable-row
  resume rather than replay.
- **CrewAI** (sequential vs hierarchical) and **AutoGen** (group-chat manager)
  — validate `subworkflow` + an orchestrator `agent`; their role/task shape maps
  to `agent`-node config.
- **OpenAI Agents SDK / Swarm** — *handoffs* and *guardrails*. Guardrails
  motivate a lightweight concurrent-validation `gate` variant; handoffs map to
  `delegate`/A2A edges in the cloud pattern.
- **MetaGPT / ChatDev** — SOP "assembly line" with **typed intermediate
  artifacts**. Reinforces schema'd edge payloads between `pipeline` stages
  rather than free-text hand-offs.

### Durable execution → the resume model

- **Temporal** (deterministic replay over event-sourced history; non-determinism
  must be wrapped as "activities") and **DBOS** (workflow IDs as idempotency
  keys) are the reference points. Because LLM/tool steps are non-deterministic,
  full Temporal-style replay is risky for agents — so akm's **default is
  durable-row resume**, with deterministic replay as the *opt-in* mode for the
  imperative frontend only (matching the decision recorded above).
- **12-Factor Agents** — *own your control flow*, *stateless reducer*
  (`(state, event) → state`), *launch/pause/resume*, *unify execution + business
  state*. akm's event log (`appendEvent`) + `workflow_run_units` is precisely a
  stateless-reducer fold; the manifesto validates modeling a run as an
  append-only event stream and giving every unit an **idempotency key** so a
  crash-resume never double-issues a side-effecting tool call (now an IR field).

### Interop protocols

- **MCP** (Model Context Protocol, Anthropic 2024; now Linux Foundation) — the
  de-facto agent→tool standard; akm exposes the stash as an MCP server so every
  MCP-client harness reaches akm knowledge in-band.
- **A2A** (Agent2Agent, Google 2025; Linux Foundation) — agent→agent delegation;
  the wire protocol for cross-harness `delegate`/`subworkflow` units. Rule of
  thumb: **MCP down to tools, A2A across to peers.**

### Sources

- Anthropic, *Building Effective Agents* (2024-12-19) — <https://www.anthropic.com/engineering/building-effective-agents>
- Wang et al., *Self-Consistency* (arXiv:2203.11171, 2022)
- Yao et al., *ReAct* (arXiv:2210.03629, 2022)
- Shinn et al., *Reflexion* (arXiv:2303.11366, 2023)
- Yao et al., *Tree of Thoughts* (arXiv:2305.10601, 2023)
- Dhuliawala et al., *Chain-of-Verification* (arXiv:2309.11495, 2023)
- Hong et al., *MetaGPT* (arXiv:2308.00352, ICLR 2024)
- LangGraph — durable execution / interrupts — <https://docs.langchain.com/oss/python/langgraph/interrupts>
- Diagrid, *Checkpoints are not durable execution* (2025-11) — <https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows>
- OpenAI Agents SDK / Swarm (handoffs, guardrails)
- Anthropic, *Introducing MCP* (2024-11-25) — <https://www.anthropic.com/news/model-context-protocol>
- Google, *Announcing A2A* (2025-04) — <https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/>
- HumanLayer, *12-Factor Agents* — <https://github.com/humanlayer/12-factor-agents>
- Temporal / DBOS durable-execution docs; Vanlightly, *Demystifying Determinism in Durable Execution* (2025-11)

## Trust & limits

Native fan-out changes the blast radius: today a step is one shell command; a
`map` node is N concurrent agents with filesystem/worktree access. The native
executor must enforce what CC enforces and akm currently lacks — concurrency
cap, lifetime unit cap, per-run budget ceiling, per-unit timeout (already in
`runAgent`), and worktree isolation. The existing "workflow sources are trusted
executable code" doc guidance extends to: a workflow that fans out is
authorizing N parallel agents, not one.

## Reconciliation with existing akm seams (critical-review findings)

A code-level review of the existing agent seams (runner-dispatch, harness
registry, structured-output/LLM, and the improve-slice/tasks orchestration
precedent) surfaced concrete alignment work. The governing rule: **the new
engine grafts onto akm's existing seams as a thin layer above them — it does not
fork a parallel execution stack.** The findings below correct several loose
statements earlier in this plan; where they conflict, this section wins.

### Layering — one new port, existing seams underneath

```
DOMAIN     workflows/ir/*            Plan Graph, gate spine (pure, no IO)
              │
APPLICATION  workflows/exec/
  scheduler.ts        ── generalize core/concurrent.ts (concurrentMap) — do NOT fork
  native-executor.ts  ── walks IR, selects a UnitExecutor per node
  UnitExecutor (NEW port)  interface: run(unit, {signal, emit, budget}) → UnitResult
       ├─ SpawnUnitExecutor      ─► executeRunner(spec,…)   // llm|agent|sdk — REUSE as-is
       ├─ StructuredUnitExecutor ─► runStructured(core)     // schema nodes + gates
       └─ DelegateUnitExecutor   ─► cloud assign/poll/ingest// NOT a RunnerSpec arm
              │
INFRA      integrations/agent/*, harnesses/*  (REUSE) ; workflow-runs repo (EXTEND)
```

Dependency direction is one-way: `workflows/exec/* → integrations/agent/*`,
never back. `executeRunner` (`runner-dispatch.ts:62`) stays the **leaf spawn
port** for the three synchronous, in-process kinds; the scheduler owns
concurrency, abort, budget, and schema *above* it.

### `delegate` is a strategy, not a fourth `RunnerSpec` arm

Earlier this plan said `RunnerSpec` "gains `delegate`." **Reverted.** The union
`llm|agent|sdk` is exhaustively switched across the improve slice and fused to
the config `mode` type (`runner.ts:42-60,240`; `runner-dispatch.ts:85`
`assertNever`). A cloud delegate is semantically alien — async *assign → poll →
ingest-PR*, not a single-prompt spawn returning `AgentRunResult`. It belongs as
a sibling **`DelegateUnitExecutor`** strategy the scheduler selects, leaving the
spawn union and every existing switch untouched.

### Unify structured output by extracting a transport-free core

There are two structured paths today and they do **not** share code:
`callStructured` (LLM HTTP, `responseSchema`) and agent `parseOutput:"json"`
(`spawn.ts:492`, embedded-JSON scan, **no schema, no retry**). Critically,
`callStructured` has **no validation-driven retry** — its only retry is
transport-level inside `chatCompletion` (`client.ts:290-313`). So the earlier
"schema nodes reuse `callStructured`'s retry discipline" would in fact be
*reimplementing* it.

Fix: extract `runStructured<T>({ dispatch, parse, validate, maxAttempts })`
where `dispatch: (feedback?) => Promise<string>` is injected transport. Then:
- **llm adapter** = `chatCompletion` + `responseSchema`;
- **native-schema adapter** (Codex `--output-schema`) = pass schema through, still validate;
- **agent/sdk adapters** = `runAgent`/`runOpencodeSdk` + prompt-injected schema + `parseEmbeddedJsonResponse`;
- **gate/summary** = the same core in judge flavor.

**Layering constraint:** this core must live at a **neutral layer** (`core/` or
`workflows/exec/`), not in `llm/`. `spawn.ts:15` forbids the agent path from
importing an LLM SDK, and `core/parse.ts` was split out precisely to keep
`agent/ ⇏ llm/`. Today `runs.ts:522-534` already `require()`s `llm/client`
from `workflows/` — the refactor must **remove** that coupling, not entrench it.

### The step summary gate is a special case of the general gate

`validateStepSummary` (`validate-summary.ts:79`) is structurally a looping
`gate`: LLM judge → `{complete, missing[], feedback}` → block-or-pass, fail-open.
`buildDefaultSummaryJudge` (`runs.ts:518`) is a bespoke `chatCompletion` closure
with no schema/retry/usage. Refactor it into one gate-flavored `runStructured`
adapter; fail-open vs. block becomes a per-node policy flag, not a separate
mechanism.

### Budget is unmeterable for agent/sdk today — additive fields required

`emitLlmUsage` fires **only** in `chatCompletionReal` (`client.ts:434`).
`AgentRunResult` has no token fields (`spawn.ts:164-175`) and `runOpencodeSdk`
**discards** the SDK's token accounting (`sdk-runner.ts:254-264`). So
`budget.maxTokens` is a **no-op for the default `sdk` runner**. `maxUnits` is
meterable today (count dispatches); `maxTokens` needs usage threaded through
(additive change below). The plan's earlier "usage-telemetry aggregates tokens
across units" holds only once this lands.

### Scheduler and writer-queue — generalize one, add the other

- **Scheduler:** `core/concurrent.ts` (`concurrentMap`, semaphore + `allSettled`)
  already is the bounded pool — but it's used only in indexer passes, never on
  the agent path. Generalize it (add `AbortSignal`, budget, unit cap) rather
  than writing a second primitive.
- **Writer-queue:** `withWorkflowRunsRepo` opens a **fresh connection per call**
  (`workflow-runs-repository.ts:286`); N concurrent unit completions contend on
  SQLite's single writer + 30 s `busy_timeout`. The serialized writer-queue in
  *Persistence changes* is therefore genuinely new and load-bearing — route all
  `workflow_run_units` writes through one promise-chained queue; keep reads and
  gates concurrent and off it.

### Invariant: never bypass the gate spine

The durable/gated contract lives in `completeWorkflowStep` (`runs.ts:293-314`,
gate-outside-txn). Both the native executor and the `report` ingest path **must
re-enter `completeWorkflowStep`** to advance a step, not write step rows
directly — otherwise the summary-validation gate (akm's differentiator) is
silently dropped for speed.

### Kill registry drift: derive execution lists from the descriptor

`#562` unified *ids + capability membership* into `HARNESS_REGISTRY`, but the
**execution machinery is still ~6 hand-maintained parallel lists**:
`BUILTIN_BUILDERS` (+ `-headless` keys, `builders.ts:64`), `profiles.ts`
`BUILTINS`/`HEADLESS_BUILTINS`, the `session-logs` provider array,
`model-aliases`, the `agent-identity` if/else chain, and the `detectHarness`
chain. The drift is already real: `codex`/`gemini`/`aider` have **profiles but
no descriptor and no builder** (`profiles.ts:93-116`), so dispatching them hits
the **default builder** (`builders.ts:43-60`) — whose `--system-prompt/--model/--`
convention is wrong for all of them, producing a silently broken command.

Fix, before adding harnesses:
1. Add descriptor fields to `AkmHarness`: `pattern`
   (`in-harness|local-runner|cloud-delegate`), `structuredOutput`
   (`native-schema|native-json|none`), `resume?: {flag}`, `identityEnv?: string[]`,
   and optional harness-owned `builder?` / `extractor?`.
2. **Derive** `BUILTIN_BUILDERS`, the identity table, the session-log provider
   array, and model-alias columns *from the registry* — so "add a harness = one
   directory + one `HARNESS_REGISTRY` entry."
3. Make a **missing builder an error**, not a silent fallback to the default —
   the default builder is a footgun for these CLIs.

### `tasks/` stays orthogonal

`src/tasks/` is a cron/OS-scheduler **frontend** (`schema.ts` target =
`workflow|prompt|command`; it just calls `startWorkflowRun`). It has no
reusable scheduler/queue and no per-step state. Don't grow cron/polling inside
the executor — periodic cloud-delegate re-checks should lean on `tasks/` or the
existing check-in, not a new daemon.

### Required seam changes (additive, backward-compatible)

Every consumer signature below is depended on by the improve slice / tasks and
must not change shape — these are **additive optional fields only**:

| Seam | Change | Why |
|---|---|---|
| `AgentRunResult` (`spawn.ts:164`) | add `usage?: TokenUsage`, `sessionId?` | budget metering; harness session reuse |
| `runOpencodeSdk` (`sdk-runner.ts:254`) | stop discarding SDK usage; per-call `cwd`/server keyed by cwd | budget + **`isolation: worktree` on the default harness** |
| `RunAgentOptions` (`spawn.ts:123`) | add `signal?: AbortSignal`, `onEvent?` | cooperative cancel + `watch --stream` |
| `AgentDispatchRequest` (`builder-shared.ts:27`) | add `effort?`, `schema?`/`schemaPath?` | IR `effort`; Codex `--output-schema` |
| `AkmHarness` (`types.ts:65`) | add `pattern`, `structuredOutput`, `resume`, `identityEnv`, `builder?`, `extractor?` | route without a parallel switch |
| `callStructured` (`structured-call.ts`) | factor out transport-free `runStructured` core | reuse validate/retry across runners |

The plan's *Reuse unchanged* list is accordingly narrowed: `executeRunner`,
`runAgent`/`runOpencodeSdk`, and `callStructured` are reused *through additive
extension*, not literally untouched.

### Two open seam decisions (assumed defaults — override if desired)

Both surfaced from the review and affect the **default** native path; the plan
assumes the first option in each:

1. **SDK worktree isolation.** `runOpencodeSdk` is a process-wide singleton with
   no per-call cwd (`sdk-runner.ts:48,117`), so `isolation: worktree` is
   unimplementable against it as-is. *Assumed:* refactor the SDK runner to key
   its server by working directory (also fixes the concurrent-run test-isolation
   hazard). *Cheaper interim:* keep the singleton for non-isolated units and
   route `isolation: worktree` units to the CLI runner (`runAgent` honors `cwd`
   today) — two default paths, less refactor. *Smallest:* defer worktree
   isolation past v1 with a documented gap.
2. **Mid-unit abort.** No `AbortSignal` exists today; `runAgent` only self-cancels
   via its timeout. *Assumed:* thread `signal` through in P0.5 so budget ceilings
   can preempt a *running* unit and `watch` can cancel. *Cheaper:* v1 only skips
   un-started units at the ceiling (a runaway unit overshoots until it finishes),
   add `signal` later.

## Rollout phases

- **P0 — IR + compiler.** `ir/schema.ts`, `ir/compile.ts`. Existing linear
  workflows compile to a linear IR; execution still goes through today's
  step loop. No behavior change; pure refactor + new tests.
- **P0.5 — seam alignment (prerequisite, no new features).** The additive seam
  changes from *Reconciliation*: `usage`/`signal` on the runner result/options,
  SDK usage + per-call cwd, extracted `runStructured` core, generalized
  `concurrentMap` scheduler, and **deriving the builder/identity/model-alias
  lists from `HARNESS_REGISTRY`** (closing the existing codex/gemini/aider
  drift). Each is independently landable and independently useful.
- **P1 — native fan-out + schema (v1 parity core).** `scheduler.ts`,
  `native-executor.ts`, `workflow_run_units` (migration 004), extended
  Markdown grammar for `Runner`/`Fan-out`/`Schema`, plus `router` node and
  `map` reducers. New `akm workflow run` drives a step's IR subgraph natively
  on the **default local harness** (OpenCode SDK). Resume: durable-row mode
  only. Structured-output normalization + retry-until-valid loop.
- **P2 — harness adapters.** A builder + result-extractor + identity marker per
  harness: Codex, Copilot CLI, Pi, then Gemini / Aider / Amazon Q / OpenHands.
  Each is contained to `harnesses/<name>/{agent-builder,result-extractor}.ts`;
  the conformance suite runs the golden workflows across all of them.
- **P3 — CC delegation.** `cc-emitter.ts`, `akm workflow report`,
  launch/handoff glue. In-harness path reaches parity with native for the
  shared IR.
- **P4 — cloud delegate + progress + budget.** `runner: delegate` + the GitHub
  Copilot-coding-agent adapter (assign issue → poll → ingest PR); `akm workflow
  watch` NDJSON stream; budget ceilings; `isolation: worktree`; looping-gate
  feedback.
- **P5 — hardening + imperative frontend.** Cross-backend conformance
  hardening; MCP server exposing the stash to units; optional imperative
  frontend and, with it, the opt-in deterministic **replay** resume mode
  (`exec/replay-cache.ts`, `input_hash` lookup). Durable-row remains the
  default throughout.

## File-by-file touch list

New:
- `src/workflows/ir/schema.ts`, `src/workflows/ir/compile.ts`
- `src/workflows/exec/scheduler.ts`, `native-executor.ts`, `cc-emitter.ts`, `report.ts`
- `src/workflows/exec/normalize.ts` (per-harness result-extractor + schema-validate loop)
- `src/workflows/exec/cloud-delegate.ts` (P4 — assign/poll/ingest for cloud agents)
- `src/workflows/exec/replay-cache.ts` (P5 — deterministic replay resume mode)
- `src/integrations/harnesses/{codex,copilot,pi,gemini,aider,amazonq,openhands}/agent-builder.ts` (+ `result-extractor.ts`) — one small builder + extractor per harness
- `tests/workflows/conformance/**` (golden IR + all-backend assertions)

Extend:
- `src/workflows/schema.ts` (orchestration fields), `parser.ts` (new subsections: `Runner`/`Fan-out`/`Schema`/`Route`/`Depends On`)
- `src/workflows/db.ts` (migration 004 + units table), `workflow-runs-repository.ts`
- `src/workflows/runtime/runs.ts` (route a step to the executor; ingest reports)
- `src/workflows/runtime/agent-identity.ts` (detect codex/copilot/pi/gemini + markers)
- `src/integrations/agent/spawn.ts` (additive: `usage?`/`sessionId?` on `AgentRunResult`; `signal?`/`onEvent?` on `RunAgentOptions`; make missing builder an error), `sdk-runner.ts` (stop discarding usage; per-call cwd), `builder-shared.ts` (`effort?`/`schema?`), `builders.ts` + `harnesses/index.ts` (**derive** `BUILTIN_BUILDERS`/identity/model-aliases from `HARNESS_REGISTRY`; new descriptor fields) — `RunnerSpec` itself is unchanged (`delegate` is a `UnitExecutor` strategy, not a union arm)
- `src/llm/structured-call.ts` (factor out transport-free `runStructured` core), `core/concurrent.ts` (generalize `concurrentMap` → scheduler with abort/budget)
- `src/workflows/cli.ts` + `src/commands/workflow-cli.ts` (`run`, `watch`, `report`)
- `src/workflows/runtime/checkin.ts` (unit-level stall)
- `src/workflows/renderer.ts` (surface orchestration in `show`)

Reuse unchanged:
- `src/integrations/agent/runner-dispatch.ts`, `spawn.ts`, `runner.ts` (core), `builders.ts` (mechanism)
- `src/integrations/harnesses/opencode-sdk/**`, `harnesses/{claude,opencode}/agent-builder.ts`
- `src/llm/structured-call.ts`, `usage-telemetry.ts`
