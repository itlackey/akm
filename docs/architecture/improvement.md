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
- **Proposal queue** (`state.db`) — written by `createProposal` (reflect,
  distill, consolidate's promote operations, and the other proposal producers)
  and by `createRetireProposal` (the pair pass's retire proposals).
- **Auto-sync** — the end-of-run commit/push step for git-backed bundles.
- **Session extraction** (`akm proposal extract`) — a separate entry point
  that mines coding-agent session transcripts for durable insights and queues
  them the same way.

## Data flow

1. An agent uses a capability and calls `akm feedback <ref> --positive|--negative`.
   `--negative --reason "<what is wrong and what should change>"` flags the
   asset for review: the next improve run proposes a fix based on the reason.
   `--positive` records that the asset helped (it raises its ranking) and does
   not trigger a rewrite.
2. The feedback event is appended to `state.db`, and the asset's utility
   score is updated immediately via the bounded-step formula (below) — no
   reindex required.
3. `akm improve` selects assets from the one bundle it writes to. A rewrite
   (reflect) is planned only for an asset with negative feedback in the last
   30 days that is newer than the stage's last attempt, or for an explicit ref;
   a positive or note-only signal never plans one. Distill reads any feedback
   on a memory in that window. Unless `--require-feedback-signal` is set, the
   fallback lanes (high salience, and proactive maintenance where the strategy
   enables it) pick what the retrieval scope below admits, for scoring only:
   they plan nothing, so improve does not rewrite assets on a proactive
   cadence. It ranks the selected assets by salience, applies the limit, then
   runs whichever processes the selected strategy enables against each one (see
   [Improve Workflow](internals/improve-workflow.md#ledger-pre-filter-signal-delta)).
4. Reflect and distill each emit at most one proposal per asset per run;
   consolidate runs two passes alongside each other — the promote pass emits
   a proposal turning a memory into knowledge (and, once accepted, retires
   the source memory) unless a neighbouring `knowledge/` doc already covers
   the memory, and it offers a memory whose promotion was accepted or
   rejected again only after the memory's body changes; the pair pass judges
   near-duplicate and superseding pairs in the memory tier and emits a
   reviewed `retire` proposal for the `duplicate`/`subsumed`/`supersedes`
   classes; `overlap`, `unrelated` and `contradicts` are recorded as
   `judged_no_action` with no proposal.
5. Every emitted proposal lands in the `proposals` table in `state.db`,
   status `pending`.
6. A human (via `akm proposal diff` / `accept` / `reject`) or a configured
   drain policy (`akm proposal drain`) reviews and resolves each proposal. A
   rejection is not final: `akm proposal reopen` puts a rejected proposal back
   to `pending`.
7. `akm proposal accept` promotes the proposal into the bundle; `akm proposal
   revert` restores the prior content from the backup captured at promotion
   time, if the proposal overwrote an existing asset. When the bundle is a git
   repository (a `.git` directory, whatever its source kind), each accept is
   committed as it happens, locally and with exactly the paths it wrote or
   removed: `akm accept: <generator> <proposal-id-8> <ref>`. A retirement's
   archived copy and tombstone, and the source memory a consolidate promotion
   retires, go in the same commit. A commit that fails warns and the accept
   stands.
8. For a git-backed bundle, `akm improve`'s end-of-run auto-sync commits the
   rest of the run's changes as a single batch and pushes (see below).

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
set: `default`, `quick`, `thorough`, `consolidate`, `catchup`,
`reflect-distill`, and `proactive-maintenance`
(`src/assets/improve-strategies/*.json`). Selection
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

Improve reworks only what gets read (#986). Fresh feedback and an explicit ref
scope (`akm improve skills/x`) are usage evidence of their own. Every other
pick — the proactive-maintenance and high-salience lanes (which only score what
they pick), and the memories consolidation judges — must be in the retrieval
scope (`src/commands/improve/retrieval-scope.ts`):

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

### Quality judge

Every reflect rewrite and every distilled lesson is scored by a judge before it
is queued (`runQualityJudge`, `src/commands/improve/stage.ts`): one call at
temperature 0, each criterion scored 1 to 5, failing closed (no runner, a
timeout, or an unparseable or incomplete reply never passes content and goes to
review). A reflect rewrite is scored on three criteria:

- **need**: does it fix a concrete problem in the source: something the
  feedback reports as wrong or missing, a factual error, or broken, garbled,
  truncated or missing text (frontmatter fields included)? A rewrite that only
  rewords, restates or reformats a correct source, or adds headings, an
  introduction or a table of contents, scores 1 or 2.
- **preservation**: does it keep every concrete fact, identifier, command, path,
  number and example, without truncation?
- **quality**: is it coherent and accurate, with nothing the source or the
  feedback does not support?

Content passes only when **every** criterion scores 4 or more (a lesson's
grounding is judged apart, see
[distill](internals/improve-workflow.md#distill-akmdistill)); a mean of 3.5
passed it before. A verdict that does not pass is a review when its mean is 2.5
or more and a rejection below that. The rubric and the rule were chosen on 90
labelled real rewrites, where judging on the mean let rewrites that only
reworded a correct asset through.

A pass is stamped on the proposal as a `staged` decision from the `quality-gate`
with the per-criterion `scores` and the judge's `judgeReason`; both stay on the
proposal when the drain accepts it, so a later audit can read why it passed
(`akm proposal show --format json`).

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

### Retirement continuity

Before the consolidate pair pass mints a `retire` proposal (rule R3,
`src/commands/improve/consolidate/continuity-check.ts`), it replays up to five
of the retired asset's own past `search`/`curate` queries
(`loadRetrievalQueries`, the same cleaned set `../retrieval-gate.ts` replays
for the retrieval regression gate — boilerplate, harness/tool envelopes,
pastes and near-duplicates dropped before replay, S3a) through akm's own
search, in-process — the ranking a user actually gets, no LLM. For every
query where the retired asset ranked in the top 10, the successor must too
(N2: compared directly — search itself returns at most the top 10 hits, so
"ranked" and "absent from those hits" are the only two states there are, no
generic rank-change-report abstraction needed). An asset with no recorded
queries is not checked at all, and neither is a pair whose two bodies are
content-identical once whitespace is collapsed (S3b) — search's own
content-dedupe already hides the successor behind the retired asset for
every such query, so a "successor missing" finding there would not be a
real risk.

A failing pair still mints — the check flags, it never blocks — but the
proposal carries `continuityRisk` in its retirement metadata: the failing
query count and the rank pairs, visible in `akm proposal show`/`list`/`diff`. A
flagged proposal is excluded from every bulk accept path (`accept
--generator …`, with or without `--yes`); a person can still accept it by id.
Bulk *reject* is unaffected, since declining a flagged proposal is always the
safe direction.

A query that never ran (the search call threw) or that fell back to
keyword-only ranking instead of the real one (`mode: "fts-fallback"` — most
often a down or unreachable embedding endpoint) is "unverified": it is never
compared for rank at all, and on its own it is enough to set
`continuityRisk` (`unverifiedQueries` alongside the usual `ranks`), so an
endpoint outage reads as "risk unknown," never as the silent "no risk
found" a search that quietly used a degraded ranking would otherwise
produce. Once any query in a pair-pass run falls back, every later query in
that same run skips the semantic attempt entirely and goes straight to
keyword-only — a dead endpoint costs one failed attempt for the whole run,
not one per remaining query.

This check replaces the old per-run forgetting-safety lane (a one-time WS-1
cutover guard that compared improve's own salience ranking before and after
each run). The 30-day event window showed it made no pick the signal-delta
lane or the retrieval scope would not also have made, and it protected
`asset_salience.rank_score`, which only improve itself ever read — a rank drop
could not hide anything from search. `forgetting-safety` stays a valid
`eligibilitySource`/event-type value so old proposals and events still decode,
but nothing assigns or emits it any more.

### Dry-run planning boundary

Dry and live improve runs call the same selectors for signal-delta eligibility,
the fallback lanes (proactive maintenance and high salience, which score and
plan nothing), the retrieval scope, salience ranking, disk presence, and the
final cap, and resolve the bundle they plan the same way: `--bundle`, else
`defaultWriteTarget`, else the working bundle (`AKM_BUNDLE_DIR`, else
`defaultBundle`). Each invocation reports a best-effort observation assembled
while it runs; it is not an atomic cross-store snapshot, a reservation, or a
durable frozen plan. A later live invocation re-inspects mutable index, state,
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

`plan.limits.effective` is the cap on the refs a run dispatches, resolved from
`--limit`, then the reflect process's `limit`, then the strategy's `limit`. The
replay lane is retired, so `additiveReplayAllowance` is always `0` (the field
stays so the schema-v2 plan shape keeps validating) and a finite `totalCeiling`
equals `effective`. When the run is unbounded, `totalCeiling` is omitted.

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
autonomy off: both its passes only ever emit a reviewable proposal, and a
pair-pass `retire` proposal is never auto-accepted by `triage`
`applyMode: "promote"` regardless of this gate — it always waits for
`akm proposal accept`. An absent `experimental`
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

The sync always commits the paths it is given. A branch it cannot push (no
upstream branch, or behind or diverged from its upstream) only skips the push,
and the result says why: `sync.reason` reads `not pushed: ...`. A branch that is
ahead of its upstream, as it is after the accept commits above, is pushed with
the sync commit. A clean tree that is ahead is not pushed: the sync pushes what
it commits.

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

### Archive purge

A retirement's archived bytes (`.akm/memory-cleanup/archive/<stamp>-<ref>/`)
are not deleted at accept time — only the tombstone (`cleanup.md`) resolves
the ref going forward. `purgeGracedArchive`
(`src/commands/improve/memory/memory-improve.ts`) sweeps them later: run once
at the very start of every `akm improve` invocation, deterministic, no LLM,
before index bootstrap or triage. For a git-backed bundle, it deletes the
archived asset file(s) — never `cleanup.md` — of every retirement whose
tombstone `retiredAt` is more than 30 days old (`RETIRE_GRACE_DAYS`) AND
whose archive directory is entirely git-tracked and clean (`git ls-files`
plus `git status --porcelain -uall`, both checked once per sweep, not once
per directory). `.git` presence alone does not guarantee a retirement was
ever committed: an accept commits its own paths (`commitAcceptedPaths` in
`src/core/write-source.ts`), on a `kind: "filesystem"` source with a `.git`
directory too, but a commit that failed only warned, and a retirement accepted
by an older akm left archived bytes sitting on disk with no commit behind them
at all. A directory with even one untracked or modified file (the tombstone
included) is left whole for a later sweep, so the purge only ever removes
bytes git can already recover. Every deleted path is journaled individually,
so the end-of-run auto-sync commits the removal the same way it commits the
archive move itself. A bundle with no `.git` of its own has no history to
fall back on, so its archive is left untouched — `akm health` reports its
size and file count instead (`memory-cleanup-archive` advisory,
`src/commands/health/archive-usage.ts`).

### Session extraction

`akm proposal extract` is the standalone entry point for mining coding-agent
session transcripts (`--type claude`, `--type opencode`, or `--auto` to
iterate every harness with a detectable session-log location) into proposals.
It replaced the legacy session-checkpoint hook and runs independently of
whether a strategy's own `processes.extract` stage is enabled — no shipped
strategy turns that improve-stage extraction on, and a direct
`akm proposal extract --type <harness>` or `--auto` invocation is never gated
by that toggle. Session indexing writes are additive
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
