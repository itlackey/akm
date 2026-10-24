# akm improve: Workflow Reference

`akm improve` is the scheduled self-improvement loop. It selects assets that have fresh feedback (or a scoped subset), runs reflect and distill on them, consolidates memories, optionally extracts proposals from coding-agent session transcripts, drains the proposal backlog under the strategy's triage settings, and runs maintenance passes. Everything it produces is a proposal in `state.db`; proposals stay queued until `akm proposal` review or the triage drain resolves them. Reflect rewrites an asset only from negative feedback on it or for an explicit ref, never on a proactive cadence.

The design and rationale are in [Improvement Loop](../improvement.md). This page is the per-step reference. The code is in `src/commands/improve/`.

## Command surface

| Option | Purpose |
|---|---|
| `[scope]` (positional) | A single ref (`[bundle//]conceptId`), an asset type, or omitted for all assets. `akm improve report` and `akm improve judge` are subcommands, not scopes. |
| `--strategy <name>` | A named strategy from `improve.strategies` or a built-in: `catchup`, `consolidate`, `default`, `proactive-maintenance`, `quick`, `reflect-distill`, `thorough`. |
| `--task` | Extra guidance for this pass, passed to the reflect prompt. |
| `--dry-run` | Compute the plan and analyze memory cleanup. Takes no lock, emits no events, calls no model, writes nothing. |
| `--plan` | Alias for `--dry-run`, for previewing the resolved process, engine, and model routing (`plan.processes`). |
| `--show-prompt` | Print the composed reflect prompt for one fully-qualified ref and exit. No lock, index write, or engine call. |
| `--bundle` | The bundle the run improves and writes to, overriding `defaultWriteTarget` and the working bundle. Only its assets are planned. |
| `--limit` | Cap the number of assets processed, highest salience first. |
| `--timeout-ms` | Wall-clock budget for the whole run. Default 7 200 000 ms (2 hours). |
| `--skip-if-locked` | If another improve run holds the lock, return an exit-0 no-op. Without it, contention is `IMPROVE_LOCK_HELD`, exit 75. |
| `--require-feedback-signal` | Turn the proactive-maintenance and high-salience fallback lanes off. They only select and score assets, and a rewrite needs negative feedback. |
| `--require-engines` | Abort with exit 78, before any side effect, if an enabled process has no usable engine or credential or its endpoint fails the reachability probe. Without it, improve skips those processes and lists them in `skippedProcesses`. |
| `--sync` / `--no-sync`, `--push` / `--no-push` | Override the strategy's `sync` block (end-of-run commit and push for a git-backed bundle). |
| `--json-to-stdout` | Also print the full persisted run result as JSON. |
| `--run`, `--since` | Only for `akm improve report`. |

`--auto-accept` is parsed, warned about, and ignored. `--target` was renamed `--bundle` and is rejected.

## Run order

A live run:

1. Resolve the scope and the strategy plan (`resolveImprovePlan`): which processes are enabled and which engine each uses.
2. Take the whole-run lock, `$STATE/locks/<stash>/improve.lock` (see [Storage Locations](storage-locations.md)).
3. Delete aged retirement archives (`purgeGracedArchive`, git-backed bundles only; see [Archive purge](../improvement.md#archive-purge)).
4. Bring the index current (`runIndexBootstrapPass`), then drain the pending-proposal backlog under the strategy's `triage` settings (`runTriagePrePass`), then index what triage wrote.
5. Collect eligible refs from the index.
6. Preparation (`runImprovePreparationStage`, `preparation.ts`), in this order:
   1. consolidation (promote pass and pair pass);
   2. session extract, when the strategy enables it;
   3. memory cleanup: archive redundant derived memories and write belief-state transitions, then reindex if anything changed;
   4. validation: a ref whose file is missing, or a lesson without a `description`, is excluded; schema repair tries to fix those when `validation` is enabled;
   5. selection: the signal-delta filter, the fallback lanes, salience ranking, a disk check, and `--limit`.
7. The per-asset loop (`runImproveLoopStage`, `loop-stages.ts`): for each selected ref, reflect, then distill for a distillable memory. The wall-clock budget is checked before each ref.
8. Post-loop maintenance (`runImprovePostLoopStage`), skipped when the budget is spent: memory inference (reindex if it wrote anything), proposal hygiene (orphan purge and expiry), orphaned-state GC, the retention purges (events, `improve_runs`, `logs.db`, task log files), and, for a whole-bundle scope, a dead-link check on URLs in knowledge bodies.
9. Assemble the result, emit `improve_completed`, run the end-of-run sync, release the lock.

A dry run skips steps 2 to 4. It collects refs (step 5), evaluates the preparation gates read-only (`planOnly`), and reports the plan; nothing is dispatched or persisted.

`experimental.improveAutonomy` gates three lanes: memory inference, memory cleanup apply, and triage `applyMode: promote` (downgraded to `queue`). A gated lane produces an `improve_skipped` event with reason `autonomy_gated` and a warning that names the config key (`src/commands/improve/autonomy-gate.ts`).

## reflect (akmReflect)

Reflect changes only an asset's `description`, `when_to_use`, and title. The engine replies with those fields (each `null` when it needs no fix) and akm applies them to the asset it read. The body is kept byte for byte, apart from a `# <title>` heading added when the body has none. Reflect never writes an asset; it queues a proposal with `source: "reflect"`.

1. `reflect_invoked` is emitted once the dispatch has validated its credentials; every call ends with one `reflect_completed` event.
2. The ref is looked up in the index and the file read. A file that is not at the path a proposal would write (`<root>/<type dir>/<name>.md`) is refused as `unsupported_type` before any model call; a skill's `references/a.md` is the ref `knowledge/skills/<name>/references/a`.
3. The engine is the strategy's `reflect.engine`, falling back to `defaults.llmEngine`. Any engine kind that confines the model-work tool policy can run it ([Configuration](../../reference/configuration.md#engines-for-unattended-model-work)). The reply's JSON Schema is the request's output schema.
4. The reply is validated by `parseSchemaReflectOutput`. An invalid reply gets one repair turn; one still invalid fails with `parse_error` and queues nothing.
5. `applyReflectPatch` applies the patch. A patch that changes nothing is the `no_change` outcome (`reflect_skipped_noop`; `reflect_skipped_cosmetic` for a cosmetic-only change) and queues nothing.
6. Defect filter (`findReflectDefect`): a revision that adds placeholder text, talks about its own edit, or copies frontmatter into the body is refused as `quality_rejected`. `processes.reflect.defectFilter` replaces or turns off the wording lists.
7. Quality gate (`processes.reflect.qualityGate`, on unless disabled): a judge scores need, preservation, and quality from 1 to 5 and the revision passes only when every score is 4 or more ([Quality judge](../improvement.md#quality-judge)). A judge that errors or times out defers the proposal for review (`judge-error`).
8. Retrieval regression gate: a revision that grades lower on the asset's own retrieval queries is refused ([Retrieval regression gate](../improvement.md#retrieval-regression-gate)).
9. The proposal is minted (`mintProposal`). A pass the judge passed is stamped `staged` and the triage drain may accept it; one with no judge or no verdict is deferred for a person.

Agent and SDK runners get the asset content capped at `REFLECT_CONTENT_CAP` (12 000 characters) because it travels through argv; a direct LLM call derives its cap from the engine's `contextLength`.

## distill (akmDistill)

Distill turns a memory and its feedback into a lesson proposal, or into a knowledge proposal for a reinforced memory. It makes one bounded call through the configured LLM endpoint and never runs an agent. Every call emits a `distill_invoked` event with an `outcome`; a disabled process (`config_disabled`) emits none.

1. Validate the ref and load the asset through the index.
2. Read the ref's feedback events, minus those named in `excludeFeedbackFromRefs`.
3. Promotion fast path: when `proposalKind` is `auto` or `knowledge` and `assessMemoryKnowledgePromotionCandidate` returns `promote: true`, queue a knowledge proposal without a model call.
4. A lesson already at the target ref is not regenerated: distill returns `skipped` with `skipReason: "lesson_exists"` before any model call.
5. Call the writer on the strategy's `distill.engine` (falling back to `defaults.llmEngine`); the default timeout is 600 000 ms. The prompt carries the memory, its feedback, and the lessons, knowledge notes, and skills nearest it (top 3; `processes.distill.cls.enabled: false` turns them off). A timeout, error, or empty reply is `llm_failed` and leaves the ref eligible.
6. The writer may find no lesson (`NONE`, or `decision: "none"`): distill returns `skipped` with `skipReason: "nothing_reusable"` and makes no judge call.
7. Strip fences and `<think>` blocks, then validate (`lintLessonContent` for lessons, `validateKnowledgeContent` for knowledge). A failure is `validation_failed` and throws `UsageError`.
8. Quality gate (`processes.distill.qualityGate`, on unless disabled): a judge scores `reusable`, `nonRedundancy`, and `grounding` from 1 to 5. `grounding` is left out of the mean. A criterion at 2 or below is `quality_rejected` (no proposal; a ledger row). Otherwise the lesson passes when the lowest scored criterion is 4 or more, and a mean of 2.5 or more is `review_needed`. A pass is minted `deferred` for a person (reason `distill-review`), not staged for the drain. An optional fidelity check (`processes.distill.fidelityCheck.enabled`, off by default) sends a lesson that contradicts its source to review.
9. Mint the proposal with `source: "distill"` and emit `distill_invoked` with `outcome: "queued"`.

The lesson ref is `lessons/[<scope>/]<type>-<name>-lesson`, derived from the input ref (`deriveLessonRef`, `distill.ts`): the first segment of a nested name is kept as `<scope>/`, and the rest is lower-cased with non-alphanumerics replaced by `-`. `memories/project-a/deploy` becomes `lessons/project-a/memory-deploy-lesson`; `skills/deploy` becomes `lessons/skill-deploy-lesson`.

The loop skips distill for a memory (a `distill-skipped` action and an `improve_skipped` event) when:

- it has no recent feedback (`memory_distill_requires_feedback`);
- a negative feedback in the last 30 days judged the body it still has (`distill_flagged_wrong`);
- its only feedback is positive without a reason or note (`distill_positive_without_reason`);
- its frontmatter says `beliefState: deprecated` or `superseded` (`distill_deprecated_or_superseded`);
- no signal is newer than the ref's last distill attempt (`distill_no_new_signal`).

An explicit ref scope bypasses these.

## consolidate (akmConsolidate)

`akmConsolidate` runs during preparation, before session extract and the per-asset loop. It returns immediately when the strategy's `processes.consolidate.enabled` is false.

**Promote pass.** It loads eligible non-`.derived` memories, minus those the improve ledger holds (see [Ledger pre-filter](#ledger-pre-filter-signal-delta)). The pool is clustered by embedding similarity, split into chunks (size from the engine's context window, capped by `maxChunkSize`, at most 50), and each chunk is sent to the consolidate engine with a JSON Schema asking for `promote` operations, the only operation offered. `mergePlans` keeps one promotion per source memory. For each operation, the checks below run cheapest first and the first that applies skips the memory, recording a skip reason; otherwise a `knowledge/` proposal is queued with `source: "consolidate"`. If the remaining wall-clock budget cannot cover every chunk, the oldest memories are taken first and the rest are deferred. `minPoolSize` (default 0) skips the pass when fewer memories are eligible (`pool_below_min_size`), unless `--strategy` was given, the scope is a ref, or more than 100 memories are eligible.

Skip reasons, in check order (`consolidation.skipReasons` in the result):

| Reason | Meaning |
|---|---|
| `promote_already_promoted_this_run` | The memory was already promoted earlier in this run. |
| `promote_pending_proposal_exists` | A pending proposal exists for the target `knowledge/<slug>`. |
| `promote_already_exists` | `knowledge/<slug>.md` already exists in the write target. |
| `promote_read_failed` | The memory file could not be read. |
| `promote_sanitization_failed` | The memory could not be re-serialized as an asset (unbalanced code fence, malformed frontmatter). |
| `promote_superseded` | The memory has `status: superseded`. |
| `promote_source_too_small` | The memory body is under 100 characters. |
| `dedup_existing_knowledge` | A `knowledge/` doc in the write target has an identical body. |
| `dedup_pending_proposal` | A pending consolidate proposal has an identical body. |
| `dedup_covered_by_knowledge` | One of the 20 `knowledge/` docs nearest to the memory in its bundle holds at least 30% of the memory's distinct 5-word shingles (`COVERAGE_MIN_CONTAINMENT`, `consolidate/coverage.ts`). Needs a stored vector for the memory. |
| `promote_invalid_frontmatter` | The description to use is missing or truncated. |
| `promote_dedup_window` | The target slug is a variant of a pending consolidate proposal's slug. |
| `promote_create_failed` | `createProposal` threw. No ledger row is written, so the next run retries. |

A skipped memory is recorded in the ledger as `judged_no_action`, except one already promoted this run and `promote_create_failed`.

Accepting a consolidate promotion archives the source memory (and its `.derived` twin) through `archiveCleanupCandidate` with reason `promoted`. This happens in `promoteProposal`, not in `akmConsolidate`; an archive failure warns and does not undo the promotion.

**Pair pass** (`consolidate/pair-pass.ts`), alongside the promote pass under the same gate. It proposes retiring duplicate, subsumed, and superseded memories, always review-gated.

1. Initiators are memories (base or `.derived`) and flat `knowledge/` or lesson assets in the write-target bundle, in the retrieval scope, that are content-eligible: no ledger row with source `consolidate-pair`, or a row whose recorded body hash differs from the asset's current one. These rows carry no `next_eligible_at`.
2. For each initiator, the 20 nearest neighbours by stored vector are fetched (`PAIR_NEIGHBOR_FETCH_K`) and the first 5 that clear the filters are kept (`PAIR_NEIGHBOR_K`): same bundle, memory tier only, not its own `.derived` twin or parent, cosine at least `T_PAIR` (0.93). An initiator with no prior ledger row needs `BACKFILL_FLOOR` (0.95) instead, unless it was first added to git within `NEW_MATERIAL_DAYS` (7), in which case `T_PAIR` applies. At most `MAX_PAIRS_PER_RUN` (300) pairs are judged per run, admitted a whole initiator at a time: new or changed initiators first, then the backlog by best cosine.
3. One judge call per pair (`src/assets/prompts/consolidate-pair.md`) lists the durable claims only each side holds, then labels the pair `duplicate`, `subsumed`, `supersedes`, `contradicts`, `overlap`, or `unrelated`. Each side is shown up to 12 000 body characters.
4. `duplicate`, `subsumed`, and `supersedes` queue one `retire` proposal with `source: "consolidate-pair"`, subject to guards: not a `captureMode: hot` memory, not a `.derived` memory whose parent exists, not across bundles, not when either side already has a pending retire proposal, not an asset already spent earlier in the same run, and not a side for which the judge listed a claim. `contradicts`, `overlap`, and `unrelated` are recorded `judged_no_action`; `contradicts` is counted in the run report and left to a person.
5. A retirement with nothing listed on the retired side, and no continuity risk, gets a second call (`consolidate-pair-check.md`) asking what the retired note holds that the kept one lacks. An empty answer stages the proposal (gate `consolidate-pair`) and the triage drain may accept it under its `applyMode`. Every other retire proposal waits for a person.
6. A ledger row (the initiator's body hash and outcome `proposed` or `judged_no_action`) is written only when all of the initiator's candidates were admitted and resolved to a verdict. Otherwise no row is written and the next run reconsiders it. A pair a person rejected or reverted is not re-minted while both bodies are unchanged: the pair and its two content hashes are checked against those proposals before the judge is called.

**Continuity check** (`consolidate/continuity-check.ts`). Before a retire proposal is queued, up to five of the retired asset's past `search` and `curate` queries are replayed through akm's own search. For each query where the retired asset ranked in the top 10, the successor must too. A failure does not block the proposal; it is recorded as `retirement.continuityRisk`, and a proposal carrying it is excluded from bulk `accept`. A query that threw or fell back to keyword-only ranking is recorded as unverified and also sets `continuityRisk`. See [Retirement continuity](../improvement.md#retirement-continuity).

**Retire proposals** (`akm proposal accept` and `revert`). Accept first checks the successor still exists and both recorded body hashes still match, then moves the retired asset (and its `.derived` twin) into `.akm/memory-cleanup/archive/` through `archiveCleanupCandidate`. A `supersedes` proposal first writes the supersede edge on the older asset. Accept records its intent on the pending proposal before moving anything, so a crashed accept resumes. `revert` restores the archived files and the exact pre-retire bytes recorded as `backupContent`. Review them as their own list: `akm proposal list --generator consolidate-pair`, with bulk `accept` and `reject` taking `--generator consolidate-pair`. `akm proposal reopen <id>` moves a rejected retire proposal back to `pending` unless the retired document or the successor changed, or another pending retire proposal now involves either.

## Proposal queue

`createProposal` is the write point for reflect, distill, consolidate (promote), extract, schema repair, and `akm proposal new`; the pair pass's retire proposals use `createRetireProposal`. Both write the `proposals` table in `state.db`, partitioned by `stash_dir` (see [Storage Locations](storage-locations.md)). Pending, accepted, rejected, and reverted are statuses on one row; `akm proposal reopen` moves a rejected row back to pending.

## Scope

`akm improve` reads and writes one bundle, its write target: `--bundle`, else `defaultWriteTarget`, else the working bundle. Only that bundle's assets are planned, because every proposal is filed in the write target. To improve another writable bundle, pass `--bundle <name>` or a bundle-qualified scope such as `team//skills/code-review`; a scheduled run covers only its own write target, so each other bundle needs its own scheduled `akm improve --bundle <name>`. A dry run resolves the bundle the same way a live run does.

## Ledger pre-filter (signal delta)

Every stage reads the improve ledger (`improve_ledger` in `state.db`; columns in [Storage Locations](storage-locations.md)) before it spends a model call, and writes it after. The ledger `source` is `reflect`, `distill`, `consolidate`, `consolidate-pair`, `extract`, `schema-repair`, or `propose`.

`nextEligibleAt` (`src/storage/repositories/improve-ledger-repository.ts`) decides when a ref may be tried again:

| Outcome | Window |
|---|---|
| `rejected`, `quality_rejected` | 14 days for reflect, 30 for distill, 7 for any other source |
| `expired` | 1 day |
| `proposed`, `review_needed`, `judged_no_action`, `unchanged` | 7 days |
| `accepted`, `failed` | none |

The consolidate pair pass, and a decided consolidate promotion that recorded a body hash, have no clock: the ref waits until its body differs. `rejected`, `quality_rejected`, and `expired` are hard windows. Every other window is a revisit cadence that a newer signal lifts (`isLedgerBlocked`).

**Selection.** Before the loop, `buildSnapshotManifest` reads the feedback events and the ledger's reflect and distill rows once, and `partitionBySignalDelta` (both in `preparation.ts`) sorts the refs. A ref passes reflect when it has negative feedback dated within the last 30 days and newer than the ref's last reflect attempt, with no hard window blocking it. A positive or note-only signal never plans a reflect. Neither does a negative that came with an exact fix (`akm feedback --replace/--with`, `--outdated`, `--superseded-by`) once an accepted `feedback` proposal has applied the fix. A ref passes distill when it has feedback carrying a signal or a note, positive included, under the same date and ledger rules. Then:

- A ref that passes reflect is planned for the loop. If it does not pass distill, distill is skipped for it.
- A ref that passes only distill, and is a distill candidate, is planned distill-only.
- A ref with no in-window feedback is left to the fallback lanes (proactive maintenance and high salience), which pick only what retrieval returned or new material ([Retrieval scope](../improvement.md#retrieval-scope)). The lanes select and score; they do not plan a reflect or distill.
- Every ref the loop does not take is counted in the plan's gates and reported once, in aggregate, as an `improve_skipped` event (`no_new_signal`, `not_retrieved`).
- Selected refs are ranked by salience (`scoreSalience` in `preparation.ts`, `computeSalience` in `salience.ts`: encoding, outcome, and retrieval frequency and recency, discounted for file size, with repeated no-ops ranked lower). Refs missing on disk are dropped, then `--limit` cuts the list: reflect-path refs first, then distill-only refs.

An explicit ref scope bypasses every gate. Consolidation, extract, and schema repair read their own ledger sources in their own stages.

## Strategy processes

A strategy is `improve.strategies.<name>` (config) or a built-in under `src/assets/improve-strategies/*.json`. Its `processes` block configures eight processes (`IMPROVE_PROCESS_NAMES`, `src/core/config/engine-semantics.ts`; schemas in `src/core/config/schema/improve-processes.ts`). Every process takes `enabled`, `engine`, `model`, `llm`, and `timeoutMs`; the table lists the fields that are particular to each.

| Process | Does | Particular fields |
|---|---|---|
| `reflect` | Revises an asset's `description`, `when_to_use`, and title from negative feedback | `allowedTypes`, `excludeRefPrefixes`, `limit`, `qualityGate`, `lowValueFilter`, `defectFilter` |
| `distill` | Turns a memory and its feedback into a lesson or knowledge proposal | `allowedTypes`, `limit`, `qualityGate`, `requirePlannedRefs`, `cls`, `fidelityCheck` |
| `consolidate` | Promote pass and pair pass over memories | `allowedTypes`, `limit`, `minPoolSize`, `maxChunkSize`, `p90ChunkSecondsDefault`, `antiCollapse` |
| `memoryInference` | Writes derived memories and marks parents (`inferenceProcessed`); gated by `experimental.improveAutonomy` | `minPendingCount`, `cls` |
| `extract` | Queues proposals from coding-agent session transcripts (the same pass as `akm proposal extract`) | `defaultSince`, `maxTotalChars`, `minContentChars`, `triage` (`enabled`, `minScore`), `minNewSessions`, `maxSessionsPerRun`, `indexSessions`, `minSessionDuration` |
| `validation` | Checks that planned refs exist and lessons have a `description`; with an engine, attempts schema repair (proposals with `source: "schema-repair"`) | none beyond the common fields |
| `triage` | Drains the pending-proposal backlog before the loop | `applyMode` (`queue` or `promote`), `maxAcceptsPerRun`, `judgment` (boolean or `{ enabled, engine, model, timeoutMs, llm }`) |
| `proactiveMaintenance` | Fallback lane that scores assets due for review; plans no rewrite | `dueDays`, `maxPerRun`, `limit` |

Each strategy also has a `sync` block (`enabled`, `push`, `message`) and a profile-level `limit`. `default` enables reflect, distill, consolidate, memoryInference, and validation, with triage, extract, and proactive maintenance off; `thorough` adds a judged triage drain with `applyMode: promote`. The other built-ins turn processes off as their names suggest; read the JSON for exact settings.

Process selection is resolved once by `resolveImprovePlan`. The plan holds every process's enablement, config, and resolved runner. A process runs on any engine that confines the model-work tool policy; one that cannot is refused when the plan is built, and a process whose engine or credential is missing is skipped and reported in `skippedProcesses`.

## Output shape

The result is `AkmImproveResult` (`src/core/improve-types.ts`), `schemaVersion: 2`. Besides `strategy`, `scope`, `dryRun`, and `ok` it carries: `plannedRefs`, `plan` (the resolved process routing and gates), `actions`, `distillSkipped` (the folded `distill-skipped` actions), `validationFailures`, `schemaRepairs`, `consolidation`, `extract`, `memoryCleanup`, `memoryInference`, `skippedProcesses`, `engineProbe`, `deadUrls`, `writtenPaths`, and `sync`. A run that found the lock held returns `skipped: { reason: "lock-held" }`.

`actions` entries are `{ ref, mode, result }` where `mode` is one of `reflect`, `reflect-skipped`, `reflect-guard-rejected`, `reflect-failed`, `distill`, `memory-prune`, `memory-inference`, or `error` (`ImproveActionMode`). `distill-skipped` is emitted per ref but folded into `distillSkipped` before the result is built. `reflect-cooldown` stays in the type for older rows; nothing emits it.
