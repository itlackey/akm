# Claude Code Workflows vs. akm Workflows — Architectural & Technical Analysis

Status: analysis / discussion (not a spec)
Audience: akm maintainers deciding how the two "workflow" systems should relate
Scope: the technical mechanics of each system — how a workflow is authored,
how it is executed, how progress/state is tracked, and how they could interoperate.

> Note on terminology. Two unrelated things are both called "workflow" in this
> repo's orbit:
>
> - **Claude Code Workflows** — the `Workflow` *tool* exposed by the Claude Code
>   harness. A workflow is a JavaScript orchestration script that spawns
>   subagents. The repo already ships one:
>   `docs/reviews/akm-meta-review/run-review.workflow.mjs`.
> - **akm Workflows** — the `workflow` *asset type* and CLI subsystem in this
>   codebase (`src/workflows/**`). A workflow is a Markdown runbook that an agent
>   steps through via `akm workflow next/complete`.
>
> They share a name and a goal ("run a multi-step procedure reliably") but are
> architecturally opposite in almost every dimension. This document pins down
> both, then maps the overlap, the divergence, and the integration surface.

---

## Part A — Claude Code Workflows: technical details

### A.1 What it is

A Claude Code Workflow is a **JavaScript program the harness executes** to
orchestrate many subagents deterministically. It is invoked through the
`Workflow` tool (`script`, `scriptPath`, or a saved `name`, plus optional
`args`). The tool returns immediately with a `runId` and runs the script in the
**background**; a `<task-notification>` is delivered when it completes.

The orchestration logic lives in *code*, not in an agent's head. Control flow
(loops, conditionals, fan-out, barriers) is expressed with ordinary JS and a
small set of injected async primitives. The model's judgement is confined to the
*leaves* — each `agent()` call spawns a subagent that does the actual reasoning.

### A.2 The script contract

Every script begins with a **pure-literal** `meta` object and then a straight-line
async body:

```js
export const meta = {
  name: 'akm-meta-review',
  description: '…',                       // shown in the permission dialog
  whenToUse: '…',                         // optional, shown in the workflow list
  phases: [{ title: 'Gather', detail: '…' }, { title: 'Analyze' }, …],
}
// body runs in an async context; await directly
phase('Gather')
const evidence = (await parallel(buckets.map(b => () => gather(b)))).filter(Boolean)
phase('Analyze')
const analysis = await analyze(evidence)
return { … }                              // returned to the caller as the tool result
```

`meta` must be a literal (no variables, calls, spreads, or interpolation) so the
harness can statically read it for the permission dialog and the phase display.
`meta.phases[].title` must match the `phase()` calls exactly.

### A.3 Injected primitives (the "harness API")

These are provided by the harness at execution time — they are **not** importable
libraries:

| Primitive | Semantics |
| --- | --- |
| `agent(prompt, opts?)` | Spawn one subagent. Returns its final text, or — with `opts.schema` (a JSON Schema) — a validated object (the subagent is forced to call a `StructuredOutput` tool and the result is schema-checked with model-side retries). Returns `null` if the agent is skipped/dies. `opts`: `label`, `phase`, `schema`, `model`, `effort`, `isolation:'worktree'`, `agentType`. |
| `parallel(thunks)` | **Barrier.** Runs thunks concurrently, awaits all. A thrown/failed thunk resolves to `null` (never rejects) — filter with `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | **No barrier.** Each item flows through all stages independently; item A can be in stage 3 while B is in stage 1. Wall-clock = slowest single-item chain. The default for multi-stage work. |
| `phase(title)` | Starts a progress group; subsequent `agent()` calls are grouped under it. |
| `log(msg)` | Emits a narrator line above the live progress tree. |
| `workflow(nameOrRef, args?)` | Runs another workflow inline as a sub-step (one level of nesting only). |
| `args` | The `args` value passed to the `Workflow` tool, verbatim. |
| `budget` | `{ total, spent(), remaining() }` — the turn's shared output-token target; a hard ceiling. Used for budget-scaled loops. |

The runtime deliberately **removes** `Date.now()`, `Math.random()`, and argless
`new Date()` (they would break resume — see A.6). There is **no filesystem or
Node API access** from the script itself; agents do file I/O, the script only
orchestrates. This is visible in the real script: the comment "The script has no
filesystem access, so agents Read the prompt file themselves" and the
`resolveReviewId()` helper that defensively re-parses `args` in case the harness
delivered it as a JSON string.

### A.4 Execution model

- The script runs **inside the harness** as a background task, not as a shell
  subprocess and not inside the main agent loop.
- Concurrent `agent()` calls are capped at **min(16, cores−2)** per workflow;
  excess calls queue. Lifetime agent count is capped at **1000** (a runaway
  backstop).
- A single `parallel()`/`pipeline()` call accepts at most **4096 items**.
- Each subagent's model/effort/tools come from the `agent()` opts (falling back
  to the session's resolved model). Subagents can reach session-connected MCP
  tools via on-demand `ToolSearch`.
- Subagents are told their final text *is* the return value, so they emit raw
  data, not human-facing prose.

### A.5 Progress tracking

Progress is **harness-native**, not something the script maintains:

- `phase()` / `agent({phase})` group agents into boxes in a live tree, watchable
  with `/workflows`.
- `log()` writes narrator lines.
- On completion the harness delivers a `<task-notification>` and the tool result
  carries the script's `return` value.
- A **journal** (`<transcriptDir>/journal.jsonl`) records each `agent()` call's
  actual return value; per-agent transcripts are `agent-<id>.jsonl`. These are
  the ground truth for debugging what a completed run actually produced.

### A.6 Resume & determinism

- Re-invoking with `{scriptPath, resumeFromRunId}` replays the **longest unchanged
  prefix** of `agent()` calls from cache instantly; the first edited/new call and
  everything after runs live. Same script + same args ⇒ 100% cache hit.
- Determinism is why `Date.now`/`Math.random` are banned — a resumed run must
  reproduce the same call sequence. Timestamps are passed in via `args` or stamped
  after the workflow returns.

### A.7 Isolation & structured output

- `opts.isolation:'worktree'` runs an agent in a fresh git worktree (expensive;
  only when agents mutate files in parallel and would conflict). Auto-removed if
  unchanged.
- `opts.schema` turns an agent into a typed function: the harness enforces the
  JSON Schema at the tool-call layer and retries on mismatch, so the script gets a
  validated object with no parsing. The real script defines `EVIDENCE_SCHEMA`,
  `ANALYSIS_SCHEMA`, etc. and threads them through every stage.

### A.8 The canonical shape (from the shipped script)

`run-review.workflow.mjs` is a textbook single-phase-per-turn pipeline:

```
Gather   → parallel() over evidence buckets, agentType:'Explore', model:'sonnet',
           schema:EVIDENCE_SCHEMA   (barrier: analysis needs all buckets)
Analyze  → one agent, model:'fable', schema:ANALYSIS_SCHEMA
Verify   → optional adversarial agent (only for reviews flagged adversarial)
Synthesize → one agent that writes the findings doc
return   → { review, findings, headline, buckets, adversarial, summary }
```

Model tier is chosen in exactly one place; safety rules are embedded verbatim in
every agent prompt so they hold even if a file read is skipped. This is the
important cultural point: **the orchestration, the model policy, and the safety
envelope are all *code*, versioned in the repo.**

---

## Part B — akm Workflows: technical details

### B.1 What it is

An akm workflow is a **Markdown runbook** (`workflow` asset type) that an agent
**steps through** by calling `akm workflow next` / `akm workflow complete` in a
loop. akm is a short-lived, per-invocation **CLI** — there is no resident process.
The engine's job is to *parse* the runbook, *persist* run state in SQLite, and
*hand the agent one actionable step at a time*, resuming across context-window
breaks. The agent (Claude Code, OpenCode, a human) supplies all the judgement and
does the actual work; akm is the durable state machine and the completion gate.

### B.2 Authoring model — Markdown, not code

`src/assets/workflows/workflow-template.md` and `src/workflows/parser.ts`:

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

Structural rules enforced by `parser.ts` / `looksLikeWorkflow()`: exactly one
`# Workflow: <title>`, each step is `## Step: <title>` + a `Step ID:` line + a
`### Instructions` section, with optional `### Completion Criteria` bullets.
The parser (`parseWorkflow`) composes existing infra (`yaml`,
`parseMarkdownToc`, `extractLineRange`) and produces a `WorkflowDocument`
(`src/workflows/schema.ts`) that carries `SourceRef` **line spans** for every
element, so editors/agents can rewrite content in place without a full re-parse.
Parse errors are accumulated (`WorkflowError[]`) rather than thrown, formatted
uniformly as `path:line — message`. The document is cached into
`workflow_documents` in `index.db`.

### B.3 Run engine — `src/workflows/runtime/runs.ts`

The public surface is a small command set:

- `startWorkflowRun(ref, params, opts)` — snapshots the step list at start time
  (later edits to the source file don't affect in-flight runs), inserts a
  `workflow_runs` row + one `workflow_run_steps` row per step, records agent
  identity, and **arms a check-in**. A concurrency guard (#485) refuses a second
  active run for the same `(workflow_ref, scope_key)` unless `--force`.
- `getNextWorkflowStep(specifier, params?)` — the loop primitive. Resolves a run
  id *or* a workflow ref (auto-starting a run if none is active in scope), returns
  the current step (or `done:true`), and — if the run looks stalled — a `checkin`
  directive.
- `completeWorkflowStep(input)` — marks the current step
  completed/blocked/failed/skipped, requires a `--summary`, runs the LLM
  validation gate, then re-derives run state.
- `resumeWorkflowRun(runId)` — flips a blocked/failed run back to active and
  reopens the current step.

**Run-state derivation** (`deriveRunState`) is a pure function over the step rows:
first failed/blocked step ⇒ run failed/blocked; else first pending ⇒ active with
that as current; else completed (with the latest `completed_at`). Sequential by
construction — there is no fan-out, no parallel steps.

### B.4 Persistence — `workflow.db` (SQLite)

`src/workflows/db.ts` + `src/storage/repositories/workflow-runs-repository.ts`.
Unlike `index.db`, these rows are **non-regenerable** (losing them is data loss),
so schema evolves only via additive migrations recorded in `schema_migrations`:

- `workflow_runs`: `id, workflow_ref, scope_key, workflow_entry_id,
  workflow_title, status, params_json, current_step_id, created_at, updated_at,
  completed_at, agent_harness, agent_session_id, checkin_armed_at`.
- `workflow_run_steps`: `run_id, step_id, step_title, instructions,
  completion_json, sequence_index, status, notes, evidence_json, completed_at,
  summary` (PK `(run_id, step_id)`, FK cascade to the run).

Migrations `001` (scope_key), `002` (agent identity), `003` (check-in +
per-step summary) illustrate the additive discipline, including a
`bootstrapPreVersioningDb()` hook that back-fills the migrations table for
databases created before versioning existed. The repository fully materialises
every read (`.all()`/`.get()`) so no live cursor escapes the connection scope.

### B.5 Scope keying — `src/workflows/authoring/scope-key.ts`

Runs are partitioned by a **directory scope**: the nearest `.akm/config.json`,
then git root, then stash root, then cwd — SHA-256'd into `dir:v1:<digest>`.
Concurrent runs in different project directories stay independent; `next` with a
bare ref resolves to the active run *in the current scope*.

### B.6 Check-in — a timestamp, not a thread (ADR: `workflow-agent-checkin-adr.md`)

The design decision that most defines akm's model: **no daemon in a CLI.** Issues
#506 (file/command-loop signal) and #501 (background thread) were reconciled in
favour of #506. Arming a check-in writes `checkin_armed_at`; the *next* time the
agent polls (`next`/`status`), the pure `evaluateCheckin(now, run)`
(`src/workflows/runtime/checkin.ts`) decides purely from timestamps whether the
run has been idle past `CHECKIN_STALL_MS` (90 s) and, if so, surfaces a strong
`continue` directive through the normal command output. Re-arming on every state
change keeps a healthy run from ever firing it. "The agent already polls the
engine … that natural cadence is the heartbeat — no second mechanism needs to
exist to wake the agent." Deterministic in `now`, so trivially unit-testable and
free of timer flakiness.

### B.7 Agent identity — `src/workflows/runtime/agent-identity.ts`

Best-effort capture of *who is driving* a run: `harness` (from `AKM_AGENT_HARNESS`
or inferred from `CLAUDE_SESSION_ID` / `OPENCODE_SESSION_ID`) and `sessionId`. It
"deliberately does NOT start any background thread" — it only reads env the
harness already exports. Note the direct coupling point: **akm already reads
`CLAUDE_SESSION_ID`** to stamp a run with the Claude Code session that owns it.

### B.8 Completion gate — required summary + LLM judge

`completeWorkflowStep` requires a `summary` and validates it against the step's
`completionCriteria` via `validateStepSummary()` and the configured LLM
(`buildDefaultSummaryJudge()`). On `complete:false` it returns structured
corrective feedback (`missing[]`, `feedback`), leaves the step **pending**, and
re-arms the check-in — the run does not advance until the work actually satisfies
the criteria. The gate is **fail-open**: no LLM configured or no criteria ⇒
skipped, so offline use still works. Critically, the LLM call runs *outside* the
write transaction so a slow/hung judge never holds a DB write lock.

### B.9 Security model

Documented bluntly in `docs/features/workflows.md`: workflow steps run with the
**full environment and PATH of the invoking user** — no sandbox, no env allowlist.
A workflow source is treated like a package dependency ("`akm add github:x/stash`
+ `akm workflow next` is functionally piping a stranger's bash into your shell").
Trust is by pinning versions and auditing before run.

### B.10 (Aside) akm *does* have a code-driven agent spawner

Separately from the markdown-runbook workflow engine, akm can **shell out to a
harness CLI** — `src/integrations/harnesses/claude/agent-builder.ts` builds
`claude [--system-prompt] [--model] [--allowedTools] --print -- <prompt>`
(non-interactive captured mode), dispatched via
`src/integrations/agent/spawn.ts` with hard timeouts and a fixed failure-reason
vocabulary. akm invariant #222: it **never imports an LLM SDK** — agents are
reachable only via shell-out. This is akm's nearest analog to Workflow's
`agent()` primitive, but it is used by the `improve`/`reflect` pipeline, **not**
by the workflow engine. The workflow engine has no agent-spawn capability at all.

---

## Part C — Side-by-side

| Dimension | Claude Code Workflow | akm Workflow |
| --- | --- | --- |
| Author writes | JavaScript orchestration script | Markdown runbook |
| Unit of work | `agent()` subagent (LLM leaf) | `## Step` instruction block (agent does it) |
| Who orchestrates | The script, in the harness | The agent, in a CLI poll loop |
| Control flow | Real JS: loops, `parallel`, `pipeline`, conditionals | Strictly sequential; run-state derived from step rows |
| Parallelism / fan-out | First-class (cap min(16,cores−2), ≤4096/call, ≤1000 lifetime) | None — one current step at a time |
| Execution host | Harness background task | Short-lived CLI process per command |
| State | Ephemeral journal/transcripts (`journal.jsonl`, `agent-<id>.jsonl`) | Durable SQLite (`workflow.db`), non-regenerable |
| Progress tracking | Harness-native: `phase()`, `/workflows` tree, `log()`, task-notification | Poll-driven; `status`/`list`; stall surfaced via `evaluateCheckin` |
| Resume | Cached-prefix replay via `resumeFromRunId`; determinism enforced | Reopen current step; state persists across process death |
| Structured output | `schema` → validated object, model-side retries | `--summary` + LLM judge vs `completionCriteria` (fail-open) |
| Model / token control | Per-`agent()` `model`/`effort`; shared `budget` ceiling | Judge LLM only; the driving agent's model is the harness's |
| Human gates | `AskUserQuestion` from the driving agent | `completionCriteria` gate; blocked/failed status |
| Isolation | `isolation:'worktree'` per agent | Directory `scope_key`; no per-step isolation |
| "Continue when stalled" | Not needed — harness owns the run to completion | `checkin` directive on the next poll (no thread) |
| Determinism | Enforced (no `Date.now`/`Math.random`) | Not required (agent-driven, wall-clock timestamps) |
| Security | Subagents run under harness tool-permission model | Steps run in the user's shell, no sandbox |
| Nesting | `workflow()` one level deep | none (a step could shell out to another `akm workflow`) |

---

## Part D — Where they overlap

1. **Same intent.** Both exist to make a multi-step procedure *reliable* rather
   than relying on one long free-form agent turn.
2. **Structured-output validation.** Workflow's `schema` and akm's
   summary-vs-`completionCriteria` LLM judge are two implementations of the same
   idea: don't let a step "complete" unless its output meets a declared contract.
   akm's is looser (prose judged by an LLM, fail-open); Workflow's is strict
   (JSON Schema, enforced, retried).
3. **Explicit phase/step decomposition.** `meta.phases` + `phase()` ≈ the
   `## Step` list. Both give a human a legible map of the procedure.
4. **Resumability as a first-class concern.** Both assume interruption is normal —
   Workflow via cached-prefix replay, akm via durable run rows.
5. **Identity is already wired.** akm's `agent-identity.ts` reads
   `CLAUDE_SESSION_ID`; a Workflow subagent (or the main loop) is exactly the
   process that would set it. The correlation key already exists on both sides.
6. **They already coexist in this repo.** `run-review.workflow.mjs` is a real
   Claude Code Workflow whose *agents operate on akm* (read-only) — the two
   systems are one `git clone` apart today.

## Part E — Where they fundamentally diverge

The single load-bearing difference: **who holds the control flow.**

- Claude Code Workflow puts orchestration in **code the harness runs**. Fan-out,
  barriers, budget loops, and adversarial-verify panels are expressible because a
  real interpreter with concurrency primitives is driving. The model is confined
  to leaves. State is ephemeral because the orchestrator lives for the whole run.

- akm Workflow puts orchestration in **the agent's hands, one poll at a time**.
  The engine is deliberately a dumb, durable sequential state machine because akm
  is a CLI with no resident process (the check-in ADR is explicit about this).
  Everything durable is a SQLite row polled by the next command. There is no
  fan-out and no way for akm to *make* the agent do anything — it can only hand
  out the next step and, at most, surface a `continue` string the agent may read.

Consequences that follow directly:

- **Parallelism:** native in Workflow, absent in akm.
- **Determinism:** required in Workflow (bans `Date.now`), irrelevant in akm.
- **Progress:** harness-owned live tree in Workflow; poll-and-infer in akm.
- **Failure to progress:** impossible-by-construction in Workflow (the script
  runs to completion or errors); the central hazard in akm, hence the check-in.
- **Where the procedure lives:** a `.mjs` in the repo vs a Markdown *asset* that
  akm can index, search, `curate`, version, and improve over time. This is akm's
  genuine edge — workflows are *managed content*, not just executable files.

They are not competitors; they sit at different layers. Workflow is an
*execution engine* for one turn. akm is a *content + durable-run-state manager*
that spans turns, sessions, and harnesses.

---

## Part F — How akm could better integrate with Claude Code Workflows

Ordered from lowest-effort/highest-leverage to more speculative. None of these
require akm to grow a daemon or abandon its CLI model.

### F1. Ship a first-class "drive an akm workflow" skill/command (low effort)

Today an agent inside a Workflow `agent()` prompt would have to know the raw
`akm workflow next/complete --summary …` loop. Provide a tiny akm-authored
skill (asset) that encodes the loop contract — call `next`, do the step, call
`complete` with a summary satisfying the criteria, honour a `checkin` directive.
Then a Workflow script can `agent("Drive akm workflow:ship-release to
completion", …)` and get correct behaviour. This makes akm workflows *callable
as a Workflow leaf* with zero engine changes.

### F2. Correlate the two run ids (low effort, high diagnostic value)

akm already stamps `agent_harness` + `agent_session_id` from `CLAUDE_SESSION_ID`.
Extend `resolveAgentIdentity()` to also read a **workflow run id** (e.g. a new
`AKM_WORKFLOW_PARENT` / a Claude-Code-provided `runId` env) and persist it on the
`workflow_runs` row via an additive migration `004`. Result: an akm run can be
traced back to the exact Claude Code Workflow (and `journal.jsonl` entry) that
spawned it, and vice-versa. This is the cheapest concrete "integration" and it
fits akm's existing identity-capture seam exactly.

### F3. Compile an akm workflow → a Claude Code Workflow script (medium effort)

akm already parses a workflow into a structured `WorkflowDocument` with steps,
instructions, and completion criteria. Add an emitter
(`akm workflow export <ref> --format claude-workflow`) that generates a `.mjs`
with a `meta.phases` per step and a `pipeline()`/sequential body where each stage
is `agent(step.instructions, { schema: criteriaSchema })`. Completion criteria
become the `schema`/verification contract. This lets a user *author once in
managed Markdown* and *execute with the harness's real orchestration + progress
tree* — akm becomes the content layer, Workflow the execution layer. The
`run-review.workflow.mjs` shape is the proof this maps cleanly.

### F4. Let akm be the durable store for Workflow runs (medium effort)

Workflow state is ephemeral (`journal.jsonl`). akm has a durable, migratable,
scope-partitioned run store. A thin `akm workflow ingest-journal <path>` (or a
Workflow that calls `akm workflow complete` at each phase boundary) would give
Workflow runs the cross-session durability, `status`/`list` querying, and
feedback/improve hooks that akm already provides for its own runs — without
Workflow having to grow a database.

### F5. Unify the two structured-output contracts (medium effort)

akm's completion gate is an LLM judge over prose; Workflow's is a JSON Schema.
Let an akm step optionally declare a JSON Schema (in frontmatter or a fenced
`schema` block) and, when the run is driven inside a harness that supports it,
validate `evidence` against that schema *deterministically* (reusing the existing
`schemas/` infra) instead of — or before — the fail-open LLM judge. This makes an
akm step's contract portable to Workflow's `schema` with no semantic gap, and
tightens akm's own gate.

### F6. Reconcile progress models rather than duplicate them (design)

akm's check-in exists because akm can't see whether the agent is alive. Inside a
Claude Code Workflow, the harness *does* own the run and *does* have a live
progress tree — so the check-in is redundant there. When a run's
`agent_harness` indicates it is being driven under a harness that owns
orchestration, akm could **suppress the check-in directive** (the harness won't
stall the way a free-form chat agent does) and instead treat phase transitions as
the heartbeat. Small change, avoids two systems both trying to "nudge" the agent.

### F7. Distribute Workflow scripts *as akm assets* (larger, strategic)

The `workflow` asset type today is Markdown-only. Allow a workflow asset to carry
(or reference) a Claude Code Workflow `.mjs` as an alternate executable form.
Then akm's real strengths — `add` from GitHub/npm, unified FTS search, `curate`,
version pinning, feedback/improve — apply to *executable* Workflow scripts too.
`akm curate "release"` could surface either a runbook to step through *or* a
harness-executable Workflow, and `akm show workflow:x` would display the script
for the mandatory pre-run audit (which akm's security model already demands).
This is the version where akm becomes the **package manager for Claude Code
Workflows**, which is squarely on-mission ("a package manager for AI agent
capabilities … workflows").

### Recommended near-term slice

F2 + F1 together are cheap, additive, and immediately useful: an akm workflow run
becomes callable from a Workflow leaf (F1) and traceable back to it (F2), with no
changes to akm's CLI-only, no-daemon architecture and one additive migration.
F3/F7 are the strategic bets that make the two systems genuinely complementary —
akm as the managed content + durable-state layer, Claude Code Workflow as the
in-turn execution engine — rather than two things that happen to share a name.

---

## Appendix — key source references

- akm parser / schema: `src/workflows/parser.ts`, `src/workflows/schema.ts`
- akm run engine: `src/workflows/runtime/runs.ts`
- akm persistence: `src/workflows/db.ts`,
  `src/storage/repositories/workflow-runs-repository.ts`
- akm check-in (no-thread ADR): `src/workflows/runtime/checkin.ts`,
  `docs/technical/workflow-agent-checkin-adr.md`
- akm agent identity: `src/workflows/runtime/agent-identity.ts`
- akm scope keying: `src/workflows/authoring/scope-key.ts`
- akm CLI surface: `docs/features/workflows.md`, `src/workflows/cli.ts`
- akm agent shell-out (the code-driven analog): 
  `src/integrations/harnesses/claude/agent-builder.ts`,
  `src/integrations/agent/spawn.ts`
- Real Claude Code Workflow in-repo:
  `docs/reviews/akm-meta-review/run-review.workflow.mjs`
