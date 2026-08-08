# OpenWorkflow as a replacement/underpinning for akm's workflow engine

Evaluated: `openworkflow` v0.9.2 (npm, published 2026-07-21) — https://github.com/openworkflowdev/openworkflow
Assessed 2026-08-01 against akm @ `/home/user/akm` (`akm-cli` 0.9.0-rc.13, MPL-2.0, Bun).

Method: repo cloned to scratch, source read directly; docs read from `apps/docs/docs/*.mdx`;
library installed from npm and **executed under Bun 1.3.11** to verify embedding, crash-resume,
long-step lease behavior, and a schema-collision hazard. No claim below rests on training knowledge.

---

## Verdict summary

| # | Rubric item | Score | Evidence |
|---|---|---|---|
| 1 | Server requirement | **PASS** | Embedded worker class, SQLite file, zero deps |
| 2 | Durability & crash-resume | **PASS** | Verified by SIGKILL probe; memoized replay |
| 3 | Orchestration primitives | **PARTIAL** | No concurrency cap, no error classification, no step timeout |
| 4 | Long-running steps | **PARTIAL** | Heartbeat holds 40s step; no in-flight cancellation |
| 5 | Runtime & platform | **PARTIAL** | Bun first-class; Windows untested in CI |
| 6 | Maturity | **PARTIAL** | 1.3k stars, 9mo old, bus factor 1, pre-1.0 |
| 7 | Integration | **PARTIAL** | ~8-12% of exec+ir deletable; adapter code added |
| 8 | Risks | **PARTIAL** | Solo maintainer, 0.x churn, well-funded competitor |

**Bottom line: technically excellent and a genuinely close conceptual match, but it replaces only
the small durable-plumbing fraction of akm's engine while imposing a second database file, a
1000-step ceiling, and loss of in-flight unit cancellation — not worth adopting as a replacement.**

---

## 1. Server requirement — PASS

**Fully embeddable in a short-lived CLI process. No daemon, broker, or DB server.**

- The `Worker` is an ordinary in-process class, not a service:
  `new Worker({ backend, workflows, concurrency })` with `start()` / `stop()` / `tick()`
  — `packages/openworkflow/worker/worker.ts:43-118`. Exported from the package root
  (`packages/openworkflow/index.ts`).
- Client and worker share one process: `OpenWorkflow.newWorker()` constructs a worker bound to the
  same backend and registry (`client/client.ts:54-60`).
- **SQLite is a first-class backend**, exported as `openworkflow/sqlite`
  (`packages/openworkflow/package.json` `exports["./sqlite"]`).
  `BackendSqlite.connect(path)` is **synchronous** and auto-migrates
  (`sqlite/backend.ts:114-128`; `apps/docs/docs/sqlite.mdx`).
- **Zero runtime dependencies.** Confirmed at install time: `bun add openworkflow` →
  "1 package installed"; `dependencies: None`, only an *optional* peer dep on `postgres`
  (needed solely for the Postgres backend). Supply-chain surface is essentially nil.
- Postgres is offered but strictly optional (`openworkflow/postgres`).

**Verified empirically.** A single Bun script that connects SQLite, defines a workflow, starts a
worker, runs a workflow to completion, stops the worker, and exits cleanly:
`/tmp/.../scratchpad/probe/run.ts` → final log line `process exiting cleanly`, exit code 0.

The only caveat: the *documented* path is `npx @openworkflow/cli worker start` as a long-lived
process (`apps/docs/docs/workers.mdx`). The embedded one-shot pattern works but is not a
documented, first-class use case, so it is not covered by the project's own regression focus.

## 2. Durability & crash-resume — PASS

This is the library's strongest dimension and it maps almost exactly onto what akm already built.

- **Deterministic replay with step memoization.** The worker re-executes the workflow function
  from the top on every claim, serving completed steps from a cache keyed on step name
  (`worker/step-history.ts:46-76`, `createStepExecutionStateFromAttempts`), so completed steps are
  never re-executed. Documented in `apps/docs/docs/workers.mdx` ("How Workers Execute Workflows").
- **State lives entirely in the DB**, in three tables — `workflow_runs` (also the job queue),
  `step_attempts` (the memoization log), `workflow_signals`
  (`sqlite/sqlite.ts:58-227`, `migrations()`).
- **Crash detection via lease expiry**: claiming sets `available_at = now + leaseDuration`;
  a crashed worker stops heartbeating, the timestamp lapses, and any worker can re-claim
  (`ARCHITECTURE.md`; `worker/worker.ts:270-285`).

**Verified empirically — this is the decisive test.** Probe workflow: `step-a`, then a 4-way
dynamic fan-out (`unit:u1..u4`), then a 40-second child-process step. Run 1 `SIGKILL`ed itself
mid-long-step. Run 2 was a fresh process against the same SQLite file:

```
# run 1 (killed)
EXEC step-a / EXEC unit:u1 / EXEC unit:u2 / EXEC unit:u3 / EXEC unit:u4
EXEC long-agent-spawn START ... CRASHING process mid-long-step (SIGKILL self)

# run 2 (fresh process)
REPLAY: workflow fn entered            <- top-of-function replay
EXEC long-agent-spawn START            <- ONLY the incomplete step re-ran
EXEC long-agent-spawn END
RESULT {"a":{"a":1},"out":["done-u1","done-u2","done-u3","done-u4"],"long":"agent-output",...}
```

`step-a` and all four fan-out units produced **no** `EXEC` lines on resume — they were served from
the memoization cache, and their values were correctly threaded into the final result. This is
precisely akm's "durable-row resume: re-invoking a partially-executed run re-dispatches only work
that never completed" (`src/workflows/exec/run-workflow.ts` header).

**Measured friction:** the lease is a hardcoded `DEFAULT_LEASE_DURATION_MS = 30 * 1000`
(`worker/worker.ts:12`) and is **not exposed** in `WorkerOptions` (`worker/worker.ts:33-37`).
In the probe, the crash was at `23:09:16`, the new process started at `23:09:27`, and it could not
claim until `23:09:45` — an **18-second dead wait**, up to 30s worst case. akm's own lease is 90s
but akm controls it; here a user typing `akm workflow run <id>` after a crash would watch the CLI
sit idle for up to half a minute with no way to tune it short of patching the library.

## 3. Orchestration primitives — PARTIAL

The model is "durable functions", not a declarative graph engine: control flow is plain
TypeScript, and only side effects are wrapped in `step.run`.

| Primitive | Status | Evidence |
|---|---|---|
| Step graph | **N/A by design** | Ordinary TS control flow; no graph IR. `core/workflow-function.ts` |
| Fan-out | **Yes** | `Promise.all` over `step.run`; auto-disambiguates duplicate names to `name:1`, `name:2` (`apps/docs/docs/dynamic-steps.mdx`) |
| Concurrency cap | **NO** | Not implemented. Roadmap "Coming Soon: Priority and concurrency controls" (`apps/docs/docs/roadmap.mdx`); issue **#20 "Workflow concurrency limit" open since 2025-11-13**. Docs tell you to hand-roll batching (`apps/docs/docs/parallel-steps.mdx`, "Limit Parallelism for External APIs") |
| Reduction | **Manual** | Plain JS over the `Promise.all` result array |
| Conditional routing | **Manual** | `if`/`else` in the workflow body; no route/branch construct |
| Bounded retry | **Yes** | Per-step `retryPolicy` (`initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts`), default 10 attempts (`apps/docs/docs/retries.mdx`) |
| Error classification | **NO** | `RetryPolicy = BackoffPolicy & {maximumAttempts}` (`core/workflow-definition.ts:134`). No non-retryable error types; a repo-wide grep for `nonRetryable`/`NonRetryable` finds only an unrelated internal comment |
| Per-step timeout | **NO** | `StepFunctionConfig` is `{ name, retryPolicy? }` only (`core/workflow-function.ts:16-27`). `timeout` exists **only** on the *wait* primitives `runWorkflow` and `waitForSignal` |
| Cancellation | **Partial** | Run-level only, cooperative and non-preemptive (see §4) |
| Signals | **Yes** | `sendSignal` / `waitForSignal` with payloads and timeouts |
| Child workflows | **Yes** | `step.runWorkflow(spec, input, {timeout})` |
| Sleep | **Yes** | `step.sleep(name, duration)` parks the run and frees the worker slot |

Three gaps land directly on features akm already has and relies on:

1. **No concurrency cap.** akm's `src/workflows/exec/scheduler.ts` takes the minimum of the map
   request, the frozen workflow cap, the frozen LLM-engine cap, and a CPU-derived host cap —
   deliberately re-applying host safety at dispatch "when a frozen run resumes on a smaller
   machine." OpenWorkflow has no equivalent, so akm's scheduler would be **kept, not deleted**.
2. **No error classification.** akm's `isRetryEligibleFailure` (`src/workflows/exec/step-work.ts:831`)
   retries only when `retry.on.includes(failureReason)`. Under OpenWorkflow you would re-implement
   this by catching inside the step and re-throwing or returning a discriminated result.
3. **No per-step timeout.** akm resolves one at freeze time — `effectiveTimeout`
   (`src/workflows/ir/freeze.ts`) layers the unit's `timeout:`, the document's `defaults.timeout`,
   `engines.<name>.timeoutMs`, then the engine-kind default (`DEFAULT_LLM_TIMEOUT_MS = 600_000`;
   `DEFAULT_AGENT_TIMEOUT_MS = null`, i.e. agent units are unbounded unless declared) — and freezes
   the result into `IrInvocation.timeoutMs`, which dispatch applies verbatim. There is no engine-side
   backstop on top of it, deliberately: `timeout: none` freezes to `null` and must stay unbounded.
   Workaround is a `Promise.race` inside every step — easy, but it is akm's code again, not the
   library's.

**Hard capacity ceiling.** `WORKFLOW_STEP_LIMIT = 1000` step attempts per run, enforced, and
retries count against it (`worker/step-history.ts:8`; `apps/docs/docs/retries.mdx`). akm permits
`WORKFLOW_MAX_MAP_EXPANSION = 10_000` (`src/workflows/resource-limits.ts:15`). **A 10x reduction in
maximum fan-out.** Escaping it means one child workflow per unit, i.e. a full `workflow_runs` row
per agent invocation.

## 4. Long-running steps — PARTIAL

**Heartbeats: PASS, and verified.** The heartbeat is a `setInterval` at half the lease (15s) that
extends the lease independently of the step promise (`worker/worker.ts:270-285`). In the probe, a
**40-second** step (an actual `Bun.spawn` child process) ran under a 30-second lease and completed
normally — the lease was held throughout, nothing was stolen, no duplicate execution. Minutes-long
agent-CLI spawns and LLM calls are safe.

**Stalled recovery: PASS.** A dead worker's run becomes claimable once `available_at` lapses
(verified in §2).

**Sleep/wait: PASS.** `step.sleep` durably parks the run and releases the worker slot rather than
blocking it (`ARCHITECTURE.md`), and `waitForSignal` supports waits up to a 1-year default
(`worker/step-history.ts:83-87`, `defaultWaitTimeoutAt`).

**Cancellation of in-flight work: FAIL — the sharpest functional regression.**

- `StepFunction<Output> = () => Promise<Output | undefined> | Output | undefined`
  (`core/workflow-function.ts:32`). The step function receives **no arguments** — no `AbortSignal`,
  no context, no attempt number.
- The docs are explicit: "If a workflow is mid-execution when canceled, the current step may
  complete, but no new steps will run on the next poll" (`apps/docs/docs/canceling.mdx`).

akm's scheduler deliberately does the opposite: "Cooperative cancellation via AbortSignal (workers
stop claiming items; **the same signal is passed into each dispatch so in-flight units can be
preempted too**)" (`src/workflows/exec/scheduler.ts:16-18`). Under OpenWorkflow, cancelling an akm
run would leave a 20-minute agent CLI running to completion with its output discarded. There is no
clean fix inside the model — you would keep akm's abort plumbing *outside* `step.run`, which
fights the framework rather than using it.

Related: `handle.result()` defaults to a **5-minute** timeout (`client/client.ts:298`). Trivially
overridden per call (`result({ timeoutMs })`, as the probe does with 180s), but the default is
wrong for akm's workloads and would bite on first use.

## 5. Runtime & platform — PARTIAL

- **TypeScript: excellent.** The package *is* TypeScript, ships `.d.ts`, and uses
  Standard Schema so Zod/Valibot/ArkType/Yup all work for input validation
  (`apps/docs/docs/standard-schema.mdx`). `@tsconfig/strictest` in the root devDeps.
- **Bun: first-class and CI-tested.** The SQLite driver explicitly branches on
  `process.versions["bun"]` and loads `bun:sqlite`, falling back to `node:sqlite`
  (`sqlite/sqlite.ts:23-52`). CI runs a dedicated `ci-bun` job (`bun run ci:bun`) alongside the
  Node job (`.github/workflows/ci.yaml`). Verified working under Bun 1.3.11 in every probe.
  This matters — Bun support in this space is usually an afterthought, and here it is not.
- **Node:** requires >= 20 per `engines`, but the SQLite path needs `node:sqlite`, i.e.
  **Node 22.5+** (`apps/docs/docs/sqlite.mdx`). akm already requires Node >= 22 (`package.json`
  `preinstall`), so no conflict.
- **Windows: untested.** CI is `runs-on: ubuntu-latest` for every job — no Windows, no macOS
  (`.github/workflows/ci.yaml`). Nothing in the code is obviously Unix-bound (no native modules,
  no `child_process` in the library, paths handled by the SQLite driver), so it will *probably*
  work, but akm ships `install.ps1` and supports Windows, and this dependency would be carrying
  zero Windows regression coverage.

## 6. Maturity — PARTIAL

| Metric | Value | Source |
|---|---|---|
| Stars | ~1,286-1,300 | GitHub repo page; dependents page |
| Forks | 53-61 | same |
| Age | **9 months** — first commit 2025-10-27 | `git log` on the clone |
| Commits | 1,135 | `git rev-list --count HEAD` |
| Last commit | 2026-07-29 (3 days before assessment) | `git log -1` |
| Releases | 25 npm versions, `0.0.1` (2025-10-26) → **`0.9.2`** (2026-07-21) | registry.npmjs.org |
| Open issues | **10**, all enhancements/questions — zero open bug reports | GitHub issues |
| License | **Apache-2.0** | `LICENSE.md` |
| Tests | 19 test files; `worker/execution.test.ts` is 128 KB, `worker/worker.test.ts` 64 KB, plus a `chaos.test.ts` | clone |
| Coverage gates | statements/functions/lines **90%**, branches 80%, and **100% on `core/**`** | `vitest.config.ts:17-28` |
| Dependents | **9 repositories / 11 packages** | GitHub dependents page |

**Strengths.** The engineering discipline is unusually high for a 9-month-old project: enforced
coverage thresholds including 100% on core, a chaos test, `knip` dead-code checks, `jscpd`
duplication checks, `cspell`, ESLint with `boundaries`/`functional`/`sonarjs`, commitlint, Postgres
service containers in CI, and a separate Bun CI lane. Zero runtime dependencies. Clean, fully
parameterized SQL (`sqlite/backend.ts`), no `eval`, no `new Function`, no `child_process` anywhere
in the shipped library. The architecture doc is genuinely good.

**Weaknesses.**
- **Bus factor 1.** `git shortlog -sne`: James Martinez **663** commits; dependabot 436;
  github-actions 19; **the largest outside human contributor has 3 commits**, and 11 of the 13
  other humans have exactly 1. This is one person's project with drive-by PRs.
- **Pre-1.0 with real churn.** 25 releases in 9 months; `succeeded` status already deprecated in
  favor of `completed` (`client/client.ts:345`), `declareWorkflow` already deprecated in favor of
  `defineWorkflowSpec` (`core/workflow-definition.ts:41`). Both are visible in the current public
  surface, i.e. breaking renames are happening at roughly the pace of minor versions.
- **Cadence is uneven.** Commits/month: Nov 158, Dec 149, Jan 203, Feb 246, Mar 46, Apr 106,
  **May 15**, Jun 74, Jul 113. The Mar-May trough coincides with a 3-month release gap
  (0.9.0 on 2026-04-10 → 0.9.1 on 2026-07-18). Recovered, but it shows what a single maintainer's
  availability does to the project.
- **Adoption is thin.** ~1.3k stars but only **9 dependent repositories**, the largest of which
  (`mistlehq/mistle`) has 88 stars. Stars are interest; dependents are usage. I found no
  independent production write-ups or third-party reviews via search — only the project's own site
  and docs.

**On the "Security Disclosure: Database Credentials Exposed" issue (#482, closed 2026-04-23):
this is a false positive and should not count against the project.** I verified the claim directly
against the clone. Every `postgres://` string in the repo is
`postgresql://postgres:postgres@localhost:5432/postgres` — the standard local-dev default — in
`examples/*`, `openworkflow/client.ts`, and the Postgres backend's default constant
(`postgres/postgres.ts:4`), plus placeholder text like `user:password@localhost` in
`apps/cli/commands.ts:1059` and the docs. There is no real credential and no rotation commit in the
surrounding history. It reads as automated bug-bounty spam.

## 7. Integration sketch

### How akm's concepts would map

| akm | OpenWorkflow | Fit |
|---|---|---|
| Frozen plan (`plan_json` + `plan_hash`) | Workflow run `input` (JSON) | Good — one registered generic workflow interpreting the plan from input |
| `workflow_run_units` rows | `step_attempts` rows | Partial — see below |
| Engine lease (90s, holder id, renewed between steps) | Worker lease + heartbeat (30s, fixed) | Direct replacement, but not tunable |
| Durable-row resume | Step memoization | Direct replacement — verified working |
| Unit retry with `retry.on` classification | `retryPolicy` | Partial — loses classification |
| Unit concurrency caps | — | **No equivalent; keep akm's scheduler** |
| Judge-gate loop (`gate.max_loops`, feedback threading) | — | **No equivalent; entirely akm's** |
| Driver protocol (`brief`/`report`) | `waitForSignal` / `sendSignal` | **Good fit conceptually** — `report` becomes `sendSignal` |
| Route/branch (`evaluateRoute`, `cascadeSkippedRouter`) | plain `if`/`else` | Rewrite, not reuse |
| Markdown → IR compile/freeze | — | **No equivalent; entirely akm's** |

The `brief`/`report` protocol is the pleasant surprise: an external harness reporting unit results
maps naturally onto `sendSignal`, with the workflow parked on `waitForSignal` in between. That part
of akm's design is genuinely idiomatic OpenWorkflow.

### Blocking hazard: table-name collision (verified)

OpenWorkflow's SQLite backend creates a table literally named **`workflow_runs`**
(`sqlite/sqlite.ts:77`) — and akm **already has** a `workflow_runs` table with a completely
different schema (`src/core/state/migrations.ts:881`), plus `workflow_run_steps` (`:910`) and
`workflow_run_units` (`:929`).

Because the migration uses `CREATE TABLE IF NOT EXISTS`, pointing OpenWorkflow at akm's state DB
**fails silently at migration time and then explodes at query time**. Reproduced:

```
COLLISION ERROR: SQLite backend failed to open database. ...: no such column: parent_step_attempt_id
```

There is **no table-prefix option**: `BackendSqliteOptions` is `{ namespaceId?, runMigrations? }`
(`sqlite/backend.ts:55-58`), and `namespaceId` is a row-level discriminator, not a naming scheme.
The Postgres backend supports a custom `schema` (`postgres/backend.ts:64`); **the SQLite backend
does not**. The private constructor also means you cannot inject akm's existing Bun `Database`
handle.

So adoption forces **a second SQLite file**. That is the real cost: akm currently writes step
completion, unit rows, and `usage_events` under one transaction in one database. Split across two
files, **run-state advancement and akm's domain journal are no longer atomic** — a crash between
the two writes leaves them inconsistent, and akm's gate-spine invariant ("every step advances
through `completeWorkflowStep`... so the summary-validation gate and run-state derivation stay
authoritative", `run-workflow.ts` header) would now straddle two durability domains.

The escape hatch is to implement the `Backend` interface over akm's own tables — it *is* public via
`openworkflow/internal` (`internal.ts` re-exports `core/backend.js`). But that is **~20 methods** of
subtle claim/lease/transaction semantics; the reference SQLite implementation is ~35 KB. You would
be writing more durability code than you deleted.

Separately, `step_attempts` cannot absorb `workflow_run_units`: akm's unit rows carry `tokens`,
`model`, `runner`, `engine`, `phase`, `worktree_path`, `session_id`, `last_checkin_at`,
`input_hash`, `parent_unit_id` (`migrations.ts:929-953`). OpenWorkflow's step attempts model none
of these, so akm keeps its unit table regardless — meaning the two systems would journal the same
work twice.

### What gets replaced vs orphaned

`src/workflows/exec` = **7,070** LOC, `src/workflows/ir` = **1,635** LOC; **total 8,705**.

**Replaced (deletable):**
- Engine lease acquire/renew/release in `run-workflow.ts` (~80)
- Resume/journal-reuse logic in `native-executor.ts` — `classifyUnitReuse`, `reuseCompletedUnit`,
  `dispatchJournaledAttempt` bookkeeping (~300)
- Step-advance/resume orchestration in `run-workflow.ts` (~170)
- Row-selection/terminality helpers in `step-work.ts` — `selectUnitAttemptRow`,
  `unitStillNeedsReport`, `isWorkListFullyTerminal`, part of `isRetryEligibleFailure` (~120)

**≈ 670 LOC ≈ 8% of exec+ir.** Even on a generous reading — akm abandoning its own unit journal
and accepting `step_attempts` as the sole record, which would forfeit token/model/worktree/session
tracking — it does not exceed **~12%**.

**Orphaned / kept (the other ~88-92%):**
- **All of `ir/` (1,635, 0% deletable)** — markdown→IR compile, freeze, plan-hash, params, schema.
  OpenWorkflow has no plan compiler and no concept of a frozen plan.
- `report.ts` (1,977) and `brief.ts` (713) — driver protocol; the transport changes to signals but
  the work-list computation, validation, and merge logic stay.
- `step-work.ts` (~1,400 of 1,536) — work-list computation, unit ids, input hashes, prompt
  assembly, reducers, routing, gate loops, artifact schema validation.
- `native-executor.ts` (~1,000 of 1,334) — agent-CLI/LLM dispatch, env bindings, secret redaction,
  frozen runner materialization.
- `scheduler.ts` (118) — kept in full; OpenWorkflow has no concurrency caps.
- `frozen-judge.ts`, `workflow-engine-gate.ts`, `param-secrets.ts`, `worktree.ts`,
  `unit-dispatch.ts`, `unit-writer.ts` (578 total) — all kept.

**And new code is added:** a second-DB adapter (or a ~20-method custom `Backend`), a
plan-interpreter workflow function, per-step `Promise.race` timeouts, error-classification
wrappers, and a dual-journal reconciliation path. **Net LOC is plausibly negative** — i.e. adopting
it likely means *more* code in akm, not less.

## 8. Risks

- **Abandonment — MODERATE-HIGH.** One maintainer with 663 of 682 human commits; the next-largest
  contributor has 3. The May 2026 trough (15 commits, 3-month release gap) shows the project tracks
  one person's availability. 9 dependent repos means little community pressure to keep it alive.
- **API instability — MODERATE-HIGH.** 0.9.2 after 25 releases in 9 months, with two deprecations
  already visible in the shipped surface (`succeeded` status, `declareWorkflow`). Four features akm
  needs — concurrency controls, manual retry (#520), OTEL (#501), custom serializers (#506) — are
  unshipped, so the surface will keep moving in exactly the areas akm depends on.
- **Commercial/open-core — LOW-MODERATE.** The README advertises "OpenWorkflow Cloud" managed
  hosting, so there is a commercial entity behind the OSS. Apache-2.0 is irrevocable for shipped
  versions, but open-core projects tend to route features toward the hosted product, and
  "Priority and concurrency controls" is precisely the kind of feature that lands there first.
- **Ecosystem consolidation — MODERATE.** Vercel shipped a directly competing TypeScript durable-
  execution library (`vercel/workflow`, "Workflow Development Kit", public beta) with far greater
  resourcing. A solo-maintained competitor in the same niche is at elevated risk of losing
  mindshare and contributors.
- **Security — LOW.** Zero runtime dependencies (minimal supply-chain surface), fully parameterized
  SQL, no `eval`/`new Function`/`child_process` in the library, no network I/O of its own. The one
  filed "security disclosure" (#482) is a verified false positive (see §6). Note the library will
  execute *any* registered workflow whose name appears in a run row — akm must keep treating the
  plan as untrusted input, exactly as it does today.
- **License — NONE.** Apache-2.0 dependency in an MPL-2.0 project is clean: MPL-2.0 is file-level
  copyleft and akm merely consumes the library. Apache-2.0 imposes attribution and, if upstream
  ever adds a `NOTICE`, redistribution of that notice (there is none today). Apache-2.0 also grants
  an express patent license, which is a mild plus. No relicensing of akm files is implied.
- **Capacity — MODERATE.** The 1,000-step-attempt hard cap vs akm's 10,000-unit expansion is a real
  ceiling on large fan-outs, with child workflows as the only escape.
- **Operational UX — LOW-MODERATE.** The fixed, unconfigurable 30s lease imposes a measured
  18-30s stall on post-crash CLI resume.

---

## Recommendation

**Do not adopt as a replacement, and do not adopt as an underpinning.**

OpenWorkflow is a well-built library — the crash-resume semantics are correct and verified, Bun
support is genuine and CI-tested, the engineering hygiene is better than most projects ten times
its age, and it has no dependencies. If akm were starting from zero and needed durable execution,
it would be a reasonable candidate.

But akm is not starting from zero, and the overlap is in the wrong place. OpenWorkflow supplies the
generic durable-execution core — lease, memoized replay, retry/backoff, status machine — which is
roughly 8-12% of `exec+ir`. Everything that makes akm's engine large is domain logic OpenWorkflow
has no opinion about: the markdown→IR compiler, the frozen plan, judge gates with bounded feedback
loops, unit dispatch to agent CLIs, artifact promotion and schema validation, worktrees, secret
redaction, and the brief/report driver protocol. Meanwhile adoption *subtracts* three capabilities
akm currently has (in-flight unit cancellation, concurrency caps, retry error classification),
imposes a 10x lower fan-out ceiling, and forces run state into a second database file that breaks
the single-transaction invariant akm's gate spine is built on.

**Worth stealing instead of adopting:** the `available_at`-as-both-queue-and-lease trick that makes
one column serve as job queue, sleep timer, and crash detector (`ARCHITECTURE.md`); the automatic
`name:1`/`name:2` disambiguation for dynamic fan-out with the documented "use a stable ID for
mutable collections" caveat (`apps/docs/docs/dynamic-steps.mdx`) — akm's `unitIdFor` already does
something similar but the failure mode is worth reviewing; and the 100%-coverage gate scoped to the
`core/**` directory only (`vitest.config.ts:22-27`), which is a nice pattern for holding a
durability kernel to a higher bar than the surrounding code.

**Reconsider if** the project reaches 1.0 with a stable API, gains a second sustained maintainer,
ships intra-workflow concurrency controls (#20) and configurable leases, and adds either a SQLite
table prefix or a supported way to inject an existing database handle.
