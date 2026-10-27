# Architecture: The Improvement Loop

## Purpose and boundary

The improvement loop turns outcomes into ranking changes and reviewable proposals. This page is the
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
consolidate) do not write asset files directly. The durable artifact they
produce is a proposal row in `state.db`, and everything else routes through
`akm proposal accept`. The writes that happen without a person reviewing the
diff are these:

- **Gated lanes**, off unless `experimental.improveAutonomy` is `true` (see
  [The autonomy gate](#the-autonomy-gate)): memory inference, memory cleanup,
  and a triage promote that runs the judgment tier.
- **Ungated writes:** a triage promote through the deterministic gates alone
  (see [The autonomy gate](#the-autonomy-gate)); session assets under
  `sessions/**` (see [Session extraction](#session-extraction)); the salience
  score distill writes into the frontmatter of the asset it reads; the graced
  archive purge at the start of every improve run (see
  [Archive purge](#archive-purge)); the local commit that follows each
  `akm proposal accept` in a git repository; and the pre-run sync and the
  end-of-run auto-sync commit and push for git-backed bundles (see
  [Auto-sync](#auto-sync)).

`akm improve` and the proposal commands are Evolving, and the
`improve.strategies.*` tuning keys can change between releases; see
[STABILITY.md](../../STABILITY.md#akm-improve-autonomy).

## Components

- **Utility recompute** (`recomputeUtilityScores`, `src/indexer/indexer.ts`) —
  the one place utility is computed from `usage_events`; `akm index` runs it
  for every entry and `akm feedback` for the entry it touched.
- **Strategies** (`src/commands/improve/improve-strategies.ts`,
  `src/assets/improve-strategies/*.json`) — named presets that decide which
  improve processes run and with what limits and gates (where each runs is `improve.processes`).
- **Autonomy gate** (`src/commands/improve/autonomy-gate.ts`) — downgrades
  the handful of processes that would otherwise mutate assets without review
  (memory inference, memory cleanup, and a judged triage promote), unless
  `experimental.improveAutonomy` is explicitly set.
- **Reflect / distill / consolidate subprocesses** — the improve pipeline's
  proposal generators, invoked per asset (reflect, distill) or across the
  whole memory corpus (consolidate). See
  [Improve Workflow](internals/improve-workflow.md) for the full per-step
  reference and flow diagram.
- **Proposal queue** (`state.db`) — written by `createProposal` (reflect,
  distill, consolidate's promote operations, and the other proposal producers)
  and by `createRetireProposal` (the pair pass's retire proposals).
- **Auto-sync** — the pre-run sync and the end-of-run commit/push step for git-backed bundles.
- **Session extraction** (`akm proposal extract`) — a separate entry point
  that mines coding-agent session transcripts for durable insights and queues
  them the same way.

## Data flow

1. An agent uses a capability and calls `akm feedback <ref> --positive|--negative`.
   `--negative` is for content that is wrong or stale; a note that simply did
   not fit the agent's task gets no feedback.
   `--negative --reason "<what is wrong and what should change>"` flags the
   asset: the next improve run may repair its frontmatter from the reason.
   `--replace`/`--with`/`--source` attach an exact fix of its text once the
   agent has verified the correct fact, which akm checks and applies at once
   through a `feedback` proposal it accepts on the spot (no review).
   `--positive` records that the asset helped (it raises its ranking) and does
   not trigger a rewrite.
2. The feedback event is appended to `state.db`. `akm search` and `akm curate`
   count a user's recorded positives and negatives per asset and scale the
   fused score by them (logarithmic in each count, the same for every asset;
   a negative whose exact fix has been accepted no longer counts),
   so ranking moves at once with no reindex. The asset's utility score, which
   improve and metrics read, is recomputed immediately by the same formula
   `akm index` uses (below).
3. `akm improve` selects assets from the one bundle it writes to. A rewrite
   (reflect) is planned only for an asset with negative feedback in the last
   30 days that is newer than the stage's last attempt, or for an explicit ref;
   a positive or note-only signal never plans one, and neither does a negative whose exact fix has since been accepted as a `feedback` proposal. Distill reads any feedback
   on a memory in that window, but skips a memory flagged wrong and not edited
   since: a negative feedback in the window judged the body it still has (or,
   recorded without that body's hash, is newer than its file's last write). It
   also skips a memory whose only feedback in the window is positive with no
   reason or note, which gives the writer nothing to distil. Unless
   `--require-feedback-signal` is set, the
   proactive-maintenance lane (where the strategy enables it, as `default`
   does) adds the stable assets due for a revisit that the retrieval scope below
   admits, and plans them with the feedback-bearing ones. At most `maxPerRun`
   (15) assets are picked per run, an asset is due only if not reflected or
   distilled for `dueDays` (30), and reflect's `limit` (25) bounds the run. It ranks the selected assets by salience, applies the limit, then
   runs whichever processes the selected strategy enables against each one (see
   [Improve Workflow](internals/improve-workflow.md#ledger-pre-filter-signal-delta)).
4. Reflect and distill each emit at most one proposal per asset per run;
   consolidate runs two passes alongside each other — the promote pass emits
   a proposal turning a memory into knowledge (and, once accepted, retires
   the source memory) unless a neighbouring `knowledge/` doc already covers
   the memory, and it offers a memory whose promotion was accepted or
   rejected, or that the model judged and left alone, again only after the
   memory's body changes; the pair pass judges
   near-duplicate and superseding pairs in the memory tier and emits a
   `retire` proposal for the `duplicate`/`subsumed`/`supersedes` classes;
   `overlap`, `unrelated` and `contradicts` are recorded as
   `judged_no_action` with no proposal. The judge first lists the durable
   claims each side alone holds, and a side with any listed claim is never
   retired. Knowledge is never retired in favour of a memory: when the judge would
   do that, the memory is retired in favour of the note if the memory lists no claim of its own,
   and the pair is left alone otherwise. A retirement whose retired side lists nothing (a duplicate: neither
   side), confirmed by a second look, is staged for the triage drain to accept; every other
   retirement waits for a person.
5. Every emitted proposal lands in the `proposals` table in `state.db`,
   status `pending`.
6. A human (via `akm proposal diff` / `accept` / `reject`) or a configured
   drain policy (`akm proposal drain`) reviews and resolves each proposal. A
   rejection is not final: `akm proposal reopen` puts a rejected proposal back
   to `pending`.
7. `akm proposal accept` promotes the proposal into the bundle. A proposal
   records the content hash of the file it was generated against, and accept
   refuses to overwrite a target that has changed since (the comparison ignores
   akm's own bookkeeping frontmatter); a proposal that creates a file likewise
   refuses when the file now exists. `akm proposal
   revert` restores the prior content from the backup captured at promotion
   time, if the proposal overwrote an existing asset. When the bundle is a git
   repository (a `.git` directory, whatever its source kind), an accept is
   committed locally with exactly the paths it wrote or removed:
   `akm accept: <generator> <proposal-id-8> <ref>`. A process that accepts
   several (`akm proposal drain`, a bulk accept, `accept <id> <id>`) commits them
   once at its end, with a summary subject and one body line per proposal; in
   `akm improve` the triage accepts join the end-of-run batch commit. A retirement's
   archived copy and tombstone, and the source memory a consolidate promotion
   retires, go in the same commit. A commit that fails warns and the accept
   stands.
8. For a git-backed bundle, `akm improve`'s end-of-run auto-sync commits the
   rest of the run's changes as a single batch and pushes (see below). The run
   began with the same sync, so it started from what other hosts had pushed.


## How it works

### Utility scoring

Utility has one formula and one implementation, `recomputeUtilityScores`
(`src/indexer/indexer.ts`), counting only user-attributed (`source='user'`)
events:

```text
rate     = max(selectRate, max(0, positives - negatives) / (positives + negatives))
nextUtil = prevUtil * 0.7^days + rate * (1 - 0.7^days)
```

`akm index` runs it for every entry. `akm feedback` runs the same function for
the one entry it touched, so the value it stores is the one the next index
would compute at that moment (a one-entry call skips the usage-event purge
and leaves the recompute watermark alone). `days` is the time since the last
full recompute, at least 1, so decay is time-proportional rather than tied to
index frequency. When a previously high-utility asset (utility >= 0.5) falls
below 0.5 after feedback, an `improve_review_needed` event is emitted. Usage
history (and the utility it drives) is preserved across schema resets and full
index rebuilds - see [Architecture: Utility Scoring](architecture.md#utility-scoring)
for the storage-level summary.

### Strategy inheritance

Improve presets live under `improve.strategies` (config) and the built-in
set: `default` and `consolidate` (`src/assets/improve-strategies/*.json`). The removed `quick`, `thorough`,
`catchup`, `reflect-distill` and `proactive-maintenance` still work as user-defined strategies. Selection
order is `--strategy`, then `defaults.improveStrategy`, then `default`.

Resolution is a two-step deep merge (`resolveImproveStrategy`): a named
built-in strategy is first merged onto the built-in `default` strategy, then
any user-defined override for that same name (under `improve.strategies` in
config) is merged on top. So a strategy — built-in or user-defined — that
omits a field, or an entire process block, inherits it from `default`; an
explicit `enabled: true`/`false` in the more specific layer always wins. This
is why, for example, `proactiveMaintenance` is on in `default` and off in
`consolidate`, and a preset that doesn't mention it at all inherits the
`default` value. A user-defined strategy named `proactive-maintenance` (the name
of the retired built-in) resolves the same way, merged onto `default`.

### Retrieval scope

Improve reworks only what gets read. Fresh feedback and an explicit ref
scope (`akm improve skills/x`) are usage evidence of their own. Every other
pick — the proactive-maintenance lane, and the memories consolidation judges — must be in the retrieval
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

Every reflect revision and every distilled lesson is scored by a judge before it
is queued (`runQualityJudge`, `src/commands/improve/stage.ts`): one call at
temperature 0, each criterion scored 1 to 5. Content passes only on a complete
verdict: with no runner, or when the call times out or returns an unparseable or
incomplete reply, it does not pass (a timeout or unparseable reply goes to
review). A reflect revision is scored on three criteria:

- **need**: does it fix a concrete problem in the source: something the
  feedback reports as wrong or missing, a factual error, or broken, garbled,
  truncated or missing text (frontmatter fields included)? A rewrite that only
  rewords, restates or reformats a correct source, or adds headings, an
  introduction or a table of contents, scores 1 or 2.
- **preservation**: does it keep every concrete fact, identifier, command, path,
  number and example, without truncation?
- **quality**: is it coherent and accurate, with nothing the source or the
  feedback does not support?

Content passes only when **every** criterion scores 4 or more. A verdict that
does not pass is a review when its mean is 2.5 or more and a rejection below
that. Reflect narrows that band: a revision whose
mean is 3.5 or more is queued for a person (reason `judge-uncertain`, with the
`scores` and `judgeReason`) and records no rejection window, and a lower mean is
refused. On 113 reviewed frontmatter-only proposals (lab 27B Q2, the shipped
judge) the non-passing ones at 3.5 or more were 17 good and 9 bad, the rest 1
good and 2 bad; on 396 labelled body rewrites a mean below 3.5 was good 6 times
in 291 (the constant and its sources are in `src/commands/improve/reflect.ts`).
A lesson is scored on `reusable`, `nonRedundancy`, and `grounding`;
`grounding` is left out of the mean, and any lesson criterion at 2 or lower
rejects whatever the mean is (see
[distill](internals/improve-workflow.md#distill-akmdistill)).

A reflect pass is stamped on the proposal as a `staged` decision from the
`quality-gate` with the per-criterion `scores` and the judge's `judgeReason`;
both stay on the proposal when the drain accepts it, so a later audit can read
why it passed (`akm proposal show --format json`). A distill pass is not staged:
the lesson or promotion is minted `deferred` for a person (reason
`distill-review`, same gate) with the same `scores` and `judgeReason`, and the
triage drain and its judgment tier leave it alone. A lesson that repeats an existing
lesson may instead be proposed as an update of that lesson (reason
`distill-update`, same gate), with only what the memory adds; the drain leaves
it for a person too. Reflect revises only an asset's
`description`, `when_to_use` and title, and edits the body only to add a missing level-1
heading; the rest of the body stays byte for byte.

### Judgment tier: promotions only

The triage drain's judgment tier (`processes.triage.judgment`, off in every
built-in strategy) may accept only a consolidate promotion, a memory proposed as
a new knowledge note. A retirement or a reflect revision it would
accept is left for a person (`judgment-not-promotion`); it may still reject.
Measured on the nightly eval with `experimental.improveAutonomy` (#1132, #1094),
judging every kind solved 0.49 (gpt-5.6-terra) and 0.53 (qwen3.8-27b) of the
items, harmed 14 and 11, and changed 18 and 21 notes outside the planted set.
Judging promotions alone: precision 0.87, recall 0.78 and 4.8% of bad promotions
accepted on qwen3.8-27b; precision 1.0, recall 0.17 on gpt-5.6-terra.

### Proactive-lane proposals wait for a person

A proposal planned by the proactive-maintenance lane (`eligibilitySource:
"proactive"`, an asset with no feedback behind it) is never accepted by the
drain, whether a deterministic gate (a staged quality-judge pass), the judgment
tier or an accept staged by an earlier drain would take it. It is left for a
person with reason `proactive-needs-review`, and the judgment tier does not see
it. An empty diff is still rejected. Proposals driven by feedback (`signal-delta`,
`scope`) follow the one rule unchanged (#1147).

### Retirement continuity

Before the consolidate pair pass mints a `retire` proposal
(`src/commands/improve/consolidate/continuity-check.ts`), it replays up to five
of the retired asset's own past `search`/`curate` queries
(`loadRetrievalQueries`, `../retrieval-queries.ts` — boilerplate, harness/tool envelopes,
pastes and near-duplicates dropped before replay) through akm's own
search, in-process — the ranking a user actually gets, no LLM. For every
query where the retired asset ranked in the top 10, the successor must too.
An asset with no recorded queries is not checked, and neither is a pair whose
two bodies are content-identical once whitespace is collapsed — search's own
content dedupe already hides the successor behind the retired asset for every
such query.

A failing pair still mints — the check flags, it does not block — but the
proposal carries `continuityRisk` in its retirement metadata: the failing
query count and the rank pairs, visible in `akm proposal show`/`list`/`diff`. A
flagged proposal is excluded from every bulk accept path (`accept
--generator …`, with or without `--yes`); a person can still accept it by id.
Bulk reject is unaffected.

A query that never ran (the search call threw) or that fell back to
keyword-only ranking instead of the real one (`mode: "fts-fallback"` — most
often a down or unreachable embedding endpoint) is "unverified": it is never
compared for rank at all, and on its own it is enough to set
`continuityRisk` (`unverifiedQueries` alongside the usual `ranks`), so an
endpoint outage reads as "risk unknown" rather than "no risk found". Once any
query in a pair-pass run falls back, every later query in that same run skips
the semantic attempt and goes straight to keyword-only — a dead endpoint costs
one failed attempt for the whole run, not one per remaining query.

`forgetting-safety` remains a valid `eligibilitySource` and event-type value so
old proposals and events still decode; nothing assigns or emits it any more.

### Dry-run planning boundary

Dry and live improve runs call the same selectors for signal-delta eligibility,
the proactive-maintenance lane, the retrieval scope, salience ranking, disk presence, and the
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
result, and it does not dispatch an LLM. Consolidation pool inspection and the extract `minNewSessions` gate use shared
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
unless `experimental.improveAutonomy` is explicitly set to `true` (the triage
lane only when its judgment tier is on; see below):

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` **with judgment on** | The judgment tier auto-accepts consolidate promotions into the bundle | downgraded to `queue` — triage still runs, it just does not auto-accept |

A deterministic-only `promote` (triage with judgment off) is not gated (#1143):
the `default` strategy drains the queue through the deterministic gates, up to
`maxAcceptsPerRun` (200) per run, with no opt-in. The nightly eval's baseline is
exactly this path (`proposal drain --promote` without judgment): 0.91 (terra) and
0.89 (qwen) of items solved, 0 to 1 harmed.

Every downgrade is reported, not silent: it warns on stderr, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, and is counted in
`akm health`'s improve skip-reason summary. The `default` strategy enables
`memoryInference`, so every live `akm improve` run on an install without the
opt-in warns `[improve] memoryInference skipped` and names
`experimental.improveAutonomy`. That is by design, because a gated lane is never
a silent no-op (`applyAutonomyGate` in `src/commands/improve/autonomy-gate.ts`,
the warning in `runImproveStageSequence` in `src/commands/improve/improve.ts`).
Consolidation stays enabled with
autonomy off: both its passes emit only reviewable proposals. The one
pair-pass `retire` proposal `triage` `applyMode: "promote"` accepts is a
retirement the pair pass staged (nothing unique to the retired side, confirmed
by a second look, no continuity risk); every other one waits for `akm proposal accept`. Triage runs as a
pre-pass at the start of an improve run, over the backlog already queued, so a proposal
a run queues is first eligible for `applyMode: "promote"` on the next run (a run scoped
to a single ref skips the pre-pass). An absent `experimental`
section, an absent key, and an explicit `false` all read as off.
`akm proposal drain --promote` is a second, explicit promote surface
independent of this gate.

### Auto-sync

For git-backed bundles (detected by a `.git` directory), `akm improve` syncs
twice: once **before** the run and once at the end. Both are the same operation
as `akm sync` — fetch and merge the upstream, commit, and push if the bundle is
writable, per the active strategy's `sync` setting. A user-defined strategy can
turn sync off, so an interrupted run does not leave an uncommitted backlog.
`--no-sync` disables both for a single run; `--no-push` commits without pushing.
Strategy sync behavior is configured via the `sync` block under
`improve.strategies.<name>`.

The pre-run sync runs right after the run takes its lock and before the index
and plan stages, so they see what another host pushed. It stages what `akm sync`
stages (the managed paths, or the content subdirectory of a repo whose content
lives in one), which means pending hand edits there are committed (and pushed)
before the run starts, not mistaken for the run's own writes. It never aborts
the run: a merge that conflicts (aborted, local commit kept), a failed fetch, or
any other error is a warning, and the run continues on the local state. The
outcome is `preRunSync` on the result (same shape as `sync`) and a `stash_synced`
event with `phase: "pre-run"`. A dry run does not sync. Scheduled `core/improve`
and `akm-improve-consolidate` runs go through the same `akm improve` entry, so
they get it too.

The sync always commits the paths it is given. It then fetches the remote and
brings the upstream in (a fast-forward when it can, otherwise git's default
merge) before it pushes, so a second host that pushed first does not stop the
push. A branch it cannot push (no upstream branch, a failed fetch, or a merge
that conflicts, which is aborted with the local commit kept) only skips the push,
and the result says why: `sync.reason` reads `not pushed: ...`. A push the remote
refuses after the commit landed still reports `sync.committed: true`. A branch that is
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
plus `git status --porcelain -uall`, checked once per sweep, not once per
directory). A `.git` directory alone does not mean a retirement was committed:
an accept commits its own paths, once per process (`commitAcceptedPaths` in
`src/core/write-source.ts`), on a `kind: "filesystem"` source with a `.git`
directory too, but a commit that failed only warns. A directory with even one
untracked or modified file (the tombstone included) is left whole for a later
sweep, so the purge removes only bytes git can recover. If git cannot report
the archive's state, the sweep removes nothing and warns. Every deleted path is
journaled individually,
so the end-of-run auto-sync commits the removal the same way it commits the
archive move itself. A bundle with no `.git` of its own has no history to
fall back on, so its archive is left untouched — `akm health` reports its
size and file count instead (`memory-cleanup-archive` advisory,
`src/commands/health/archive-usage.ts`).

### Session extraction

`akm proposal extract` is the standalone entry point for mining
coding-agent session transcripts (`--type claude`, `--type codex`,
`--type opencode`, or `--auto` to iterate every harness with a detectable
session-log location) into proposals. It runs independently of whether a
strategy's own `processes.extract` stage is enabled — no shipped strategy turns
that improve-stage extraction on, and a direct
`akm proposal extract --type <harness>` or `--auto` invocation does not depend
on that toggle. Session indexing writes `sessions/**` assets
(`processes.extract.indexSessions`, default on); these writes are additive and
are not behind the autonomy gate.

`--dry-run` keeps eligible candidate refs in `sessions[].previewRefs`. It leaves
proposal rows, seen-session tracking, the improve ledger and assets unchanged;
an explicitly labeled preview event may still be recorded. `proposals`,
`sessions[].proposalIds`, `candidatesCreated` and the `--auto` result's
`totalProposals` count only successfully persisted proposals, so they are empty
or zero in a preview. `sessions[].candidateCount` counts parsed model candidates;
`blockedCount` and `failedCount` distinguish ledger holds from failed writes.

The existing `extract_invoked` event records `dryRun`, `candidateCount`,
`previewCount`, `proposalCount`, `blockedCount` and `failedCount`.
`candidates_queued` requires at least one successful write; zero-write runs use
`candidates_blocked` or `proposal_write_failed`. A dry run with eligible refs
uses `candidates_previewed`; an empty model result remains `no_candidates`.
A session with a failed write other than a validator refusal keeps a null
content hash in its seen-session row, so the next run re-extracts it:
candidates that persisted are held by their `proposed` ledger window, or as
accepted from this session, and only the failed ones are written again. A
refusal recurs on the same content, so it alone records the hash (#1224).
Unavailable or malformed model output retains its distinct skip/failure result.
Older events without `dryRun` have unknown preview status; their historical
`candidates_queued` label cannot establish persistence. Proposal metrics use
actual proposal rows, and health uses live seen-session outcomes.

## See also

- [Improve the Library](../guides/improve-the-library.md) — the user-facing
  command guide for this loop
- [Improve Workflow](internals/improve-workflow.md) — full per-step reference
  and flow diagram for reflect/distill/consolidate
- [Architecture](architecture.md) — system-wide architecture summary,
  including the Utility Scoring and Writing to Sources sections
- [Configuration Reference — Strategies](../reference/configuration.md#strategies)
  and [Experimental opt-ins](../reference/configuration.md#experimental-opt-ins)
- [STABILITY.md](../../STABILITY.md#akm-improve-autonomy) — the stability status of
  `akm improve` and the opt-in for `experimental.improveAutonomy`
