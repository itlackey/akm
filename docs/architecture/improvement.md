# Architecture: The Improvement Loop

## Purpose and boundary

AKM learns from outcomes, but changes remain reviewable. This page is the
architecture-level reference for that loop — how a feedback signal becomes a
ranking change, how ranking and usage evidence become a proposal, and the
boundary around what AKM is allowed to write without a human or policy
reviewing the diff first.

The loop itself:

```text
agent selects capability -> agent records outcome -> AKM updates utility and analyzes evidence ->
AKM creates a proposal -> human or policy reviews the diff -> accept / reject / revert
```

The user-facing command surface for this loop (`akm feedback`, `akm log`,
`akm improve`, `akm proposal ...`) is documented in
[Improve the Library](../guides/improve-the-library.md) and
[CLI Reference](../reference/cli.md). This page covers the implementation
detail behind those commands: how utility moves, how strategies configure
what runs, what the autonomy gate does and does not allow, how sync happens
at the end of a run, and how session extraction fits in.

**Boundary:** `akm improve` (and its subprocesses — reflect, distill,
consolidate) never write asset files directly. The only durable artifact they
produce is a proposal row in `state.db`. The narrow set of writes that *are*
allowed to happen without review is enumerated below, under
[The autonomy gate](#the-autonomy-gate);
everything else routes through `akm proposal accept`.

## Components

- **Utility policy** (`src/indexer/feedback/utility-policy.ts`) — pure
  domain math that turns accumulated feedback counts into a new utility
  score. No database access; unit-testable in isolation.
- **Strategies** (`src/commands/improve/improve-strategies.ts`,
  `src/assets/improve-strategies/*.json`) — named presets that decide which
  improve processes run and with what engine/model/limits.
- **Autonomy gate** (`src/commands/improve/autonomy-gate.ts`) — downgrades
  the handful of processes that would otherwise mutate assets without review,
  unless `experimental.improveAutonomy` is explicitly set.
- **Reflect / distill / consolidate subprocesses** — the improve pipeline's
  proposal generators, invoked per asset (reflect, distill) or across the
  whole memory corpus (consolidate). See
  [Improve Workflow](internals/improve-workflow.md) for the full per-step
  reference and flow diagram.
- **Proposal queue** (`state.db`) — the single write point (`createProposal`)
  used by reflect, distill, and consolidate's promote operations.
- **Auto-sync** — the end-of-run commit/push step for git-backed bundles.
- **Session extraction** (`akm proposal extract`) — a separate entry point
  that mines coding-agent session transcripts for durable insights and queues
  them the same way.

## Data flow

1. An agent uses a capability and calls `akm feedback <ref> --positive|--negative`.
2. The feedback event is appended to `state.db`, and the asset's utility
   score is updated immediately via the bounded-step formula (below) — no
   reindex required.
3. `akm improve` selects assets (recent feedback first, retrieval-count
   fallback for high-traffic assets with no feedback yet) inside the
   retrieval scope below, then runs whichever processes the selected strategy
   enables against each one.
4. Reflect and distill each emit at most one proposal per asset per run;
   consolidate emits proposals for memory `promote` operations and returns
   `merge`/`delete`/`contradict` operations as advisory (non-writing) output.
5. Every emitted proposal lands in the `proposals` table in `state.db`,
   status `pending`.
6. A human (via `akm proposal diff` / `accept` / `reject`) or a configured
   drain policy (`akm proposal drain`) reviews and resolves each proposal.
7. `akm proposal accept` promotes the proposal into the bundle; `akm proposal
   revert` restores the prior content from the backup captured at promotion
   time, if the proposal overwrote an existing asset.
8. For a git-backed bundle, `akm improve`'s end-of-run auto-sync commits the
   run's changes as a single batch (see below).

## Current decisions

### Utility scoring

Utility moves by the MemRL bounded-step EMA formula (arXiv:2601.03192),
implemented in `computeNextUtility` (`src/indexer/feedback/utility-policy.ts`):

```text
reward   = weighted average of positive (1.0) and negative (0.0) feedback in the batch
nextUtil = clamp(currentUtil + FEEDBACK_LR * (reward - currentUtil), 0, 1)
```

`FEEDBACK_LR` is `0.1`, so a single feedback batch moves utility by at most
0.1 in either direction regardless of how lopsided the batch is — `reward` is
a proportion of the counts, not their magnitude. When a previously
high-utility asset (utility ≥ 0.5) crosses back below 0.5, the update is
flagged as a review-threshold crossing so callers can escalate it. Decay is
time-proportional rather than tied to index frequency, and usage history
(and the utility it drives) is preserved across schema resets and full index
rebuilds — see [Architecture: Utility Scoring](architecture.md#utility-scoring)
for the storage-level summary.

### Strategy inheritance

Improve presets live under `improve.strategies` (config) and the built-in
set: `default`, `quick`, `thorough`, `memory-focus`,
`frequent`, `consolidate`, `catchup`, `reflect-distill`, and
`proactive-maintenance` (`src/assets/improve-strategies/*.json`). Selection
order is `--strategy`, then `defaults.improveStrategy`, then `default`.

Resolution is a two-step deep merge (`resolveImproveStrategy`): a named
built-in strategy is first merged onto the built-in `default` strategy, then
any user-defined override for that same name (under `improve.strategies` in
config) is merged on top. So a strategy — built-in or user-defined — that
omits a field, or an entire process block, inherits it from `default`; an
explicit `enabled: true`/`false` in the more specific layer always wins. This
is why, for example, `proactiveMaintenance` stays off in `default` and
`reflect-distill`, but a preset that doesn't mention it at all still inherits
that "off" rather than defaulting to on.

### Retrieval scope

Improve reworks only what gets read (#986). Fresh feedback and an explicit
`--scope <ref>` are usage evidence of their own. Every other pick — the
proactive-maintenance, high-salience and forgetting-safety lanes, and the
memories consolidation judges — must be in the retrieval scope
(`src/commands/improve/retrieval-scope.ts`):

- **Retrieved:** a user-attributed `search`, `curate` or `show` returned the
  asset, or user `feedback` named it, inside the window. A hit on a
  `.derived` memory counts for its parent. Machine traffic (`improve`, `task`,
  `audit`) does not count.
- **New material:** the file was written inside the window and no improve
  stage has processed the asset — no `improve_ledger` row and no proposal from
  any source but a capture (`extract`, `propose`, `remember`, `import`).

The window is the usage log's retention (`USAGE_EVENT_RETENTION_DAYS`, 90
days): the log keeps nothing older, and a shorter window would drop assets
read less often than it. There is no config key. Refs left out are counted by
the plan's `retrieval` gate and reported as the `not_retrieved` skip reason;
consolidation reports them in its warnings. A bulk rewrite of old files
(a rename, a lint fix, a fresh clone) makes them look new until improve has
processed each once.

### Retrieval regression gate

Reflect refuses a rewrite of an existing asset that grades lower on the
asset's own retrieval queries (#722, `src/commands/improve/retrieval-gate.ts`).
After the quality judge passes, up to five distinct user `search`/`curate`
queries that returned the asset (envelopes, the stash README line and inputs
over 2,000 characters dropped) are each graded 0–3 against the old and the new
content with the retrieval eval's prompt, `retrieval-relevance-judge.md`, and
its document shape: type, ref, name, description and the first 1,500 body
characters. A lower mean for the new content is a `quality_rejected` refusal
with the reflect rejection window. A grade that cannot be obtained refuses the
rewrite, as the quality judge fails closed. An asset with no such queries is
not graded.

The gate exists because it was measured first. Of 60 accepted reflect rewrites
(since 2026-07-01, stratified by lane) judged this way, 14 graded lower (23%,
95% CI 14–35%) and 12 higher. Grading the same content twice flipped 11 of 174
query grades, which puts 3 of 60 rewrites in the "lower" bucket by noise
alone. The threshold for building it was fixed before judging: a lower bound of
at least 10%.

### Dry-run planning boundary

Dry and live improve runs call the same selectors for signal-delta eligibility,
proactive maintenance, salience ranking, replay, disk presence, and the final
cap. Each invocation reports a best-effort observation assembled while it
runs; it is not an atomic cross-store snapshot, a reservation, or a durable
frozen plan. A later live invocation re-inspects mutable index, state,
filesystem, and session-log inputs and can therefore differ from an earlier
dry preview. Given equivalent observed inputs, both paths produce the same
selection. The public schema-v2 result projects the observation as `plan`: raw
in-scope count, each gate's removals, configured and effective limits, final
ranked refs with lane attribution, proactive due statistics, consolidation
pool/delta/minimum gates and chunk estimate, maintenance-stage decisions,
triage mode/caps, and the read-side index snapshot status. `plannedRefs` means
the effective post-limit work set in both modes.

The dry path stops at that projection boundary. It may read indexed assets,
the filesystem, and an existing `state.db`, but opens state read-only and does
not create it when absent. It does not acquire the improve lock or write the
index, state, events, proposals, assets, cache, sync journal, or persisted run
result, and it never dispatches an LLM. SQLite inputs are inspected through
disposable main/WAL copies so even a held source SHM file is not touched.
Consolidation pool inspection and the extract `minNewSessions` gate use shared
zero-LLM selectors, while live execution re-inspects mutable inputs immediately
before dispatch. A missing index or one without the current `entries` table
yields an explicit empty `plan.snapshot` (`missing` or `incompatible`) rather
than creating or migrating the database.

`plan.limits.effective` is the base cap for ordinary refs. Replay is explicitly
additive: `additiveReplayAllowance` reports its separate budget, and a finite
`totalCeiling` is `effective + additiveReplayAllowance`. When the base run is
unbounded, `totalCeiling` is omitted.

### The autonomy gate

`akm improve` runs by default and is review-first: reflect, distill, extract
candidates, validation, and proactive-maintenance selection are proposal-only
and never write assets directly regardless of this gate.
Three specific lanes *would* mutate assets without review and are downgraded
unless `experimental.improveAutonomy` is explicitly set to `true`:

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` | Auto-accepts queued proposals into the bundle | downgraded to `queue` — triage still runs, it just does not auto-accept |

Every downgrade is reported, not silent: it warns on stderr, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, and is counted in
`akm health`'s improve skip-reason summary. Consolidation stays enabled with
autonomy off, because its merge/delete/contradict operations are advisory and
promotion only ever emits a reviewable proposal. An absent `experimental`
section, an absent key, and an explicit `false` all read identically as off —
autonomy is never inferred. `akm proposal drain --promote` is a second,
explicit promote surface independent of this gate.

### Auto-sync

For git-backed bundles (detected by a `.git` directory), `akm improve`
automatically commits its changes as a single batch at the end of the run —
the same operation as `akm sync` — and pushes if the bundle is writable, per
the active strategy's `sync` setting. The `reflect-distill` and
`proactive-maintenance` strategies skip sync entirely, so an interrupted run
does not leave an uncommitted backlog. `--no-sync` disables sync for a single
run; `--no-push` commits without pushing. Strategy sync behavior is
configured via the `sync` block under `improve.strategies.<name>`.

The commit is scoped by **write provenance**, not by directory: every akm write
path records the file it mutated into a run-scoped journal
(`src/core/write-provenance.ts`), and the end-of-run sync stages exactly the
journaled paths that Git still reports as changed. A file someone else edits
under a managed directory while the run is in flight is therefore left dirty for
its author, while a file that was already dirty when the run started and was
then rewritten by the run IS committed. Deletions are journaled like writes, so
the final on-disk state is what lands — a path written and then reverted or
purged produces no commit at all. The run reports its journal as
`writtenPaths` on the improve result. Callers that supply no explicit path list
(`akm sync`, `akm push`) keep the managed-pathspec fallback in `saveGitStash`.

### Session extraction

`akm proposal extract` is the standalone entry point for mining coding-agent
session transcripts (`--type claude`, `--type opencode`, or `--auto` to
iterate every harness with a detectable session-log location) into proposals.
It replaced the legacy session-checkpoint hook and runs independently of
whether a strategy's own `processes.extract` stage is enabled — the shipped
`default` and `frequent` strategies leave that improve-stage extraction off,
but a direct `akm proposal extract --type <harness>` or `--auto` invocation is
never gated by that toggle. Session indexing writes are additive
(`sessions/**`), which is why they are one of the writes left deliberately
ungated by the autonomy gate above.

## See also

- [Improve the Library](../guides/improve-the-library.md) — the user-facing
  command guide for this loop
- [Improve Workflow](internals/improve-workflow.md) — full per-step reference
  and flow diagram for reflect/distill/consolidate
- [Architecture](architecture.md) — system-wide architecture summary,
  including the Utility Scoring and Writing to Sources sections
- [Configuration Reference — Strategies](../reference/configuration.md#strategies)
  and [Experimental opt-ins](../reference/configuration.md#experimental-opt-ins)
- [STABILITY.md](../../STABILITY.md#akm-improve-autonomy--opt-in-in-090) — the
  normative autonomy-gate contract
