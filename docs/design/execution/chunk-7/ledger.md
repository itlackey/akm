# Chunk 7 — deletion ledger

Started by WI-7.1. Appended to by later chunk-7 work items (WI-7.2, WI-7.3, ...).
Each entry records what was deleted/retained/orphaned and why, per plan §15.4
(deletion is gated by inventory + zero-count greps, never by a LOC number;
net-LOC is reported here, not gated).

## WI-7.1 — Delete the recombine/synthesis subsystem + the orphaned index-DB export `getEntitiesByEntryIds`

### Files deleted

| File | LOC | Notes |
|---|---:|---|
| `src/commands/improve/recombine.ts` | 1009 | Whole-corpus cross-episodic synthesis pass (#609/#625/#632/#633). |
| `src/storage/repositories/recombine-repository.ts` | 290 | `recombine_hypotheses` table accessors (migration 014's repository layer). |
| `src/assets/improve-strategies/synthesize.json` | 17 | Built-in strategy — recombine-only, all generative/extract passes off. |
| `src/assets/improve-strategies/recombine-only.json` | 23 | Built-in strategy — recombine over graph entities only. |
| `src/assets/prompts/recombine-system.md` | 40 | System prompt for the recombine LLM call. |
| `tests/commands/improve-recombine.test.ts` | 816 | Subject suite — `akmRecombine` API surface. |
| `tests/commands/improve-recombine-promote.test.ts` | 741 | Subject suite — second-pass hypothesis→lesson promotion. |
| `tests/recombine-tuning.test.ts` | 641 | Subject suite — #632/#633 clustering tuning + Jaccard confirmation fix. |
| `tests/recombine-drain-accept.test.ts` | 293 | Subject suite — recombine drain-accept `requireType` path. |
| `tests/state-db/recombine-hypotheses.test.ts` | 252 | Subject suite — migration 014 table + accessor contract. |

### Symbols deleted

- `akmRecombine`, `AkmRecombineOptions`, `RecombineLlmFn` (recombine.ts, deleted with the file)
- `buildRelatednessClusters`, `capClusters`, `selectClustersForRun`, `buildClusterPrompt`, `deriveRecombineLessonRef`, `recombineMemberKey`, `isJunkTag`, `isJunkEntity` (recombine.ts, deleted with the file)
- `RecombineResult` interface (`src/core/improve-types.ts`)
- `'recombine'` `EligibilitySource` literal (`src/core/improve-types.ts`)
- `AkmImproveResult.recombination` / `ImprovePostLoopResult.recombination` fields, `"recombination"` from the `improve-result.ts` field lists
- `AkmImproveOptions.recombineFn` seam (`src/commands/improve/improve.ts`)
- `'recombine_invoked'` event-type literal (`src/core/events.ts`)
- `getEntitiesByEntryIds` (`src/indexer/db/db.ts:1109` at HEAD) — recombine-only consumer (`recombine.ts:61,:644`); see retained-with-reason note below for its sibling `getNeighborsByEntryId`.
- `recordRecombineInduction`, `findMatchingRecombineHypothesis`, `getRecombineHypothesis`, `markRecombineHypothesisPromoted`, `decayUnseenRecombineHypotheses`, `RecombineHypothesisRow`, `PresentCluster` (recombine-repository.ts, deleted with the file)
- `'recombine'` entries in `PROPOSAL_SOURCES` / `AUTOMATED_PROPOSAL_SOURCES` (`src/commands/proposal/repository.ts`) — see D11 note below
- The recombine drain rule (`{ generator: "recombine", requireType: "lesson", maxDiffLines: 200 }`) in `PERSONAL_STASH` (`src/commands/proposal/drain-policies.ts`)
- The 7-field recombine config subtree in `ImproveProcessConfigSchema` (`minClusterSize`, `maxClustersPerRun`, `maxClusterSize`, `excludeTags`, `excludeEntities`, `relatednessSource`, `confirmThreshold`) + the `recombine: ImproveProcessConfigSchema.optional()` registration in `ImproveProfileProcessesSchema` (`src/core/config/config-schema.ts`)
- `"synthesize"` and `"recombine-only"` from `BUILTIN_IMPROVE_STRATEGY_NAMES`; `recombine: "llm"` from `IMPROVE_PROCESS_ENGINE_CAPABILITIES` (`src/core/config/engine-semantics.ts`) — both strategy JSON assets they named are deleted (above), so their imports/registrations in `src/commands/improve/improve-strategies.ts` are deleted alongside (mechanical consequence of the asset deletion, not separately Rxx-tagged)
- `"recombine": { "enabled": false }` block from the `default` built-in strategy (`src/assets/improve-strategies/default.json`)
- `synthesize`, `recombine-only` from the `--strategy` built-ins list in `src/assets/help/help-improve.md`

### Rewired (surviving machinery, NOT deleted)

- **Collapse/churn detector (R5)** — narrowed to consolidate-only. `runImproveMaintenancePasses`'s post-loop call site (`loop-stages.ts`) no longer computes a `recombineWorked` flag or a `"both"` pass value; the qualifying-cycle gate is now `!options.dryRun && consolidationRan`, `pass` is always the literal `"consolidate"`, and `acceptedActions` no longer adds `lessonsPromoted` (recombine's promotion count). Mint/score math (`computeCycleMetrics`, `evaluateCollapseAlerts`, canary scoring) is untouched.
  - WRITE-side `pass` union narrowed from `"consolidate" | "recombine" | "both"` to the literal `"consolidate"` at `collapse-detector.ts` (`computeCycleMetrics` args, `runCollapseDetector` args) and at `canaries-repository.ts`'s `CycleMetricsRow.pass` (the same interface serves both insert-row writes and `queryRecentCycleMetrics`/`getLatestCycleMetrics` reads — those reads cast raw SQL rows with `as CycleMetricsRow[]`, so historical rows carrying `"recombine"`/`"both"` still round-trip at runtime even though the TS type only covers writes going forward). A doc comment on the field records this explicitly.
  - Health advisory wording (`src/commands/health/advisories.ts`) updated: "...runs only on improve cycles where consolidate did work" (dropped "/recombine" and the "(synthesis lanes may be idle)" aside). `tests/health-checks-characterization.test.ts`'s pinned message updated to match.
  - `ENRICHMENT_LANES` doc comment (`src/commands/health/types.ts`) updated: minting lanes are "extract/distill/memory-inference" (dropped "/recombine"). The `ENRICHMENT_LANES` array itself never included `"recombine"`.
  - Migration 016's descriptive comment (`src/core/state/migrations.ts`, NOT the migration-014 recombine_hypotheses block, NOT the DDL) updated to say a qualifying cycle is "a run where consolidate processed ≥1 op" (was "...op or recombine evaluated ≥1 cluster"). Migration 014 itself is untouched, verbatim, append-only.
- **`getNeighborsByEntryId`** (`src/indexer/db/db.ts:896`, k-NN embedding lookup) — **RETAINED, NOT deleted** (D1). Its sole production consumer is `consolidate.ts`'s `narrowToIncrementalCandidates` (the `incrementalSince`/`--since` incremental-consolidation path), pinned by `tests/commands/consolidate/consolidate-incremental.test.ts`, which stays green unmodified through this item. Plan §14.3's premise that both `db.ts` graph-lookup exports are recombine-orphaned is half wrong; only `getEntitiesByEntryIds` (the entity-cluster lookup) was recombine-only.
- `src/commands/improve/shared.ts`'s `resolveImproveLlmFn` — `processKey` union narrowed from `"recombine" | "procedural"` to `"procedural"` only (procedural survives until WI-7.3). Doc comments updated to describe the seam generically rather than naming the deleted pass.
- `tests/standards-prompt-injection.test.ts` — dropped the `buildClusterPrompt` import, its `BUILDERS` entry, its `clusterMember` fixture helper, and its line in the module doc comment's builder list. The `buildProceduralPrompt` half (procedural prompt injection) is untouched, per WI-7.3's scope.

### D11 — orphaned legacy proposal sources (plan §15.4 / R28/R17)

Removing `'recombine'` (this item) and `'procedural'` (WI-7.3, not yet done) from
`PROPOSAL_SOURCES`/`AUTOMATED_PROPOSAL_SOURCES` means any PRE-EXISTING pending
proposal with `source: "recombine"` becomes unmatched by the schema's closed
enum going forward. No compatibility shim is added (per D11, binding). Such
proposals are swept by the existing 90-day TTL like any other stale pending
proposal — this is a deliberate no-shim decision, not an oversight. The
recombine drain rule in `PERSONAL_STASH` (`drain-policies.ts`) is deleted
outright rather than left dead, since `resolveDrainPolicy`'s `GeneratorSchema`
validates `generator` values against the (now-narrower) `PROPOSAL_SOURCES`
closed set at policy-load time — leaving the rule in would either fail that
validation or silently never match once the source vanishes.

### Migration 014

Left **verbatim, untouched, append-only** (`src/core/state/migrations.ts`,
`id: "014-recombine-hypotheses"`). The `recombine_hypotheses` table + its
`idx_recombine_hypotheses_last_seen` index still exist in the schema; the table
DROP is WI-7.3's migration 018, not this item's. `tests/storage/sqlite-migrations.characterization.test.ts`
stays green, unmodified, with its migration-014 DDL snapshot untouched.

### Grep-gate (R28/R29/R30) — verified zero hits

Scope: `src/`, `scripts/`, `src/assets/` (case-insensitive `recombin`; allowlist
= the migration-014 entry in `src/core/state/migrations.ts` only — WI-7.3's
migration 018 is the second allowlisted entry, not yet landed).

```
akmRecombine            0 hits
RecombineResult         0 hits
recombineFn             0 hits
recombine_hypotheses    0 hits (except migration 014 DDL)
recombine_invoked       0 hits
recombine-repository    0 hits
getEntitiesByEntryIds   0 hits
recombin (case-insens.) 0 hits (except migration 014 entry)
```

Two hits outside `src/` proper were found and fixed during the sweep:
`scripts/akm-eval/src/runners/judge-calibration.ts` and
`scripts/akm-eval/src/runners/memory-safety.ts` each carried an inert
`recombine: { enabled: false }` block in a sandbox-profile config literal
(harmless — `ImproveProfileProcessesSchema` is `.passthrough()` — but still a
grep-gate hit); both lines were deleted. Bare `synthesize` was deliberately
NOT gated (legitimate uses survive in `consolidate.ts` mergeStrategy naming,
reflect prompts, health HTML — confirmed via the frozen
`tests/fixtures/goldens/consolidate/merge-plans.json` golden, which pins
`"mergeStrategy": "synthesize"` and was correctly left untouched).

### Net LOC (reported, not gated — plan §15.4)

- `src/` + `scripts/`: **+39 / −1608** (net **−1569**), vs. the brief's ~−1300
  estimate for this item's residual row (§12.1) — the gap is mostly the
  `schemas/akm-config.json` regeneration (mechanical, generated file, not
  hand-written) and the two-strategy-name shrink cascading through the
  generated JSON schema's duplicated per-strategy process blocks.
- `tests/`: **+10 / −3044** (net **−3034**), vs. the brief's ~−2750 estimate —
  the gap is the regenerated `default-improve-strategies.test.ts.snap` (12
  resolved-strategy-tree blocks → 10, each shrinking by the recombine
  subtree) plus the five subject-suite deletions.
- Both deltas are ledgered under plan §12.1's residual row, outside the
  chunk's headline ~−3,900 improve/memory/salience target.

### Verification

- `bunx tsc --noEmit`: clean, zero errors.
- `bunx biome check` (touched files): clean, zero findings.
- `bun scripts/lint-license-headers.ts`, `lint-runtime-boundary.ts`,
  `lint-repository-sql.ts`, `lint-tests-isolation.ts`: all green (fixed points
  — `tests/_helpers/sandbox.ts`, `tests/_preload.ts`, the mock.module-ban rule
  and its ratchet baseline, the hand-rolled sharding scripts — untouched).
- `bun scripts/gen-config-schema.ts --check`: green after regeneration
  (`schemas/akm-config.json` committed alongside the schema edit).
- Targeted `bun test` runs, all green (per SPEED DISCIPLINE — no full-suite
  run in this item; the Finalize gate owns that): the seven directly-touched
  suites (118 tests), `collapse-detector.test.ts` +
  `health-checks-characterization.test.ts` (22 tests), the retained-with-reason
  oracle (`consolidate-incremental.test.ts`) + all four 0a consolidate/improve
  golden suites with zero fixture diffs (76 tests), the five migration-ID
  suites (80 tests, unmodified), the five proposal-source/drain suites (115
  tests, unmodified), `improve-cycle-metrics.test.ts` (8 tests), and eleven
  spot-checked "inert `recombine: {enabled:false}` leftover" suites that were
  deliberately left unedited (69 tests) — confirming the schema's
  `.passthrough()` leniency keeps them green without touching them.

### Deviations from the brief

None. All steps executed as specced; the two `scripts/akm-eval` hits and the
migration-016 comment fix were within the letter of step 6 (the grep-gate) and
step 3 (rewire the surviving detector) respectively, not scope additions.

## WI-7.2 — Delete the improve-loop lanes: self-consistency, P0-A, multi-cycle, exploration + self-confidence inputs, ValenceScore.lane, review_pressure (code/type)

### Files retired (RETIRE-with-designations, D15)

| File | LOC | Notes |
|---|---:|---|
| `tests/commands/improve/goldens-self-consistency.test.ts` | 360 | Subject suite — SC reflect call-count baseline. |
| `tests/fixtures/goldens/improve/self-consistency.json` | 61 | Its fixture. |
| `tests/commands/improve/goldens-p0a-selection.test.ts` | 374 | Subject suite — P0-A high-retrieval fallback selection-set baseline. |
| `tests/fixtures/goldens/improve/p0a-selection.json` | 45 | Its fixture. |

Both DESIGNATIONS.json entries removed in the same commit as the fixture
deletions (`goldens-designations.test.ts` stays green — verified). The
`SC_*`/`P0A_*` fixture-ref exports in `tests/fixtures/goldens/improve/fixture-refs.ts`
(their sole consumers) were removed alongside; the `SDG_*` exports consumed by
the frozen `goldens-signal-delta-gate.test.ts` are untouched, and that
suite's fixture (`signal-delta-gate.json`) stays byte-identical (verified via
`git status --porcelain` on the fixture path before/after — zero diff).

### File deleted (repurposed, not RETIRE-designated — it was never a golden fixture)

| File | LOC | Notes |
|---|---:|---|
| `tests/commands/improve/improve-multi-cycle.test.ts` | 414 | Subject suite for the deleted #616 cycle loop (AC1-AC5). |

AC1 ("default maxCycles=1 ⇒ each stage seam called exactly once, no
`cyclesRun` field") was repurposed into new
`tests/commands/improve/improve-single-pass.test.ts` (232 LOC, 2 tests): the
four-stage-seam-called-once-per-run regression plus the budget-AbortSignal
threading test (also carried over, since the loop-stage AbortSignal contract
is unrelated to cycling and still needs a pin). AC2 (cycle-N-output-visible-
to-cycle-N+1), AC3 (fixed-point stop), AC4 (budget gate blocks a second
cycle), and AC5 (`cyclesRun` reporting) all pinned machinery that WI-7.2
deletes outright (D12) — no replacement needed, they test nothing that still
exists.

### Symbols deleted

- **Self-consistency (R15):** `SC_THRESHOLD`, `SC_N`, `jaccardSimilarity`,
  `pickMajorityVote` (`loop-stages.ts`, formerly `:110-167`); the
  `useConsistency`/samples/majority-vote branch + its winner-persist tail
  (`createProposal` with `reflect-sc-` sourceRun, formerly `:243-300`) —
  collapsed to the single plain `reflectFn` call that was already the
  `else` branch. `AkmImproveOptions.selfConsistencyThreshold`/`selfConsistencyN`
  (`improve.ts`). `AkmReflectOptions.draftMode` (`reflect.ts`) + its
  synthetic-draft-proposal branch (`sc-draft-` id) + the noise-gate comment's
  "runs before the draftMode branch" clause. No config-schema field existed
  for SC (options-only, confirmed — the plan's "AND config-schema" for R15
  is inapplicable; noted per brief step 1). `utilityMap`'s SC-only
  destructure in `runImproveLoopStage` removed (the field stays on both
  `ImprovePreparationResult` and `ImproveRunContext` — still populated by
  `preparation.ts`'s internal warm-start/attention scoring and read by
  `ImprovePreparationResult` consumers outside the loop stage; NOT
  grep-gated per brief step 9's token list, confirmed).
- **P0-A (R18):** `RETRIEVAL_COUNT_THRESHOLD` const, the `highRetrievalRefs`
  filter (`count > 0 && count >= threshold && !lastReflectProposalTs.has`),
  and every downstream merge/stamp/log site that referenced it
  (`preparation.ts`: the Layer-2 `alreadySelected` exclusion set, the Layer-3
  `proactiveAndRetrievalSet` → renamed `proactiveSelectedSet`, the
  `rescuedSet` union, the `signalAndRetrievalRefs` merge, both
  `eligibilitySourceByRef.set(r.ref, "high-retrieval")` stamps, the
  usage-signal summary log's high-retrieval clause). `AkmImproveOptions.minRetrievalCount`
  (`improve.ts`); `--min-retrieval-count` CLI flag + its parse call
  (`improve-cli.ts`; the generic `parseNonNegativeIntFlag` helper in
  `cli/parse-args.ts` is left in place — not P0-A-specific, no other scope
  item names it for deletion). `'high-retrieval'` `EligibilitySource` union
  member (`core/improve-types.ts`) + `ENRICHMENT_LANES` entry
  (`health/types.ts`) + doc mentions (`proposal/repository.ts`,
  `health/advisories.ts`'s live advisory-message string,
  `scripts/akm-eval/src/proactive-verdict.ts`'s `REACTIVE_SOURCES` set — the
  last two are grep-gate-scoped `scripts/` hits, fixed per D2/precedent).
  KEPT verbatim per brief: `retrievalCounts`/`getRetrievalCounts`
  (`indexer/db/db.ts`, shared with the Layer-2 proactive-maintenance
  selector) and the `noFeedbackCandidates` "zero-feedback candidate pool"
  construction (shared by Layer 2 and Layer 3, not P0-A-exclusive despite
  living in the same code region) — only their P0-A-specific comment framing
  was reworded.
- **Multi-cycle (R19/D12):** the `for (cycleIndex...)` loop (`improve.ts`,
  formerly `:857-1035`), `maxCycles` option (`AkmImproveOptions.maxCycles`)
  + its resolution (`Math.max(1, Math.trunc(options.maxCycles ?? improveProfile.maxCycles ?? 1))`)
  + config knob (`config-schema.ts`'s `ImproveProfileConfigSchema.maxCycles`),
  per-cycle accumulator framing (kept the accumulator *variables* — sums of
  one and last-wins-of-one collapse to plain assignments now, renamed
  comments accordingly), the fixed-point break (`gateAcceptedThisCycle === 0`),
  the inter-cycle git bank call site (`commitStashBatch` between cycles —
  `commitStashBatch` itself KEPT, called from end-of-run + the catch path
  only now), the re-collect guard (`if (cycleIndex > 0) { await runIndexAndCollect(); ...}`),
  `cyclesRun` counter + its `AkmImproveResult.cyclesRun` field
  (`core/improve-types.ts`) + its `...(cyclesRun > 1 ? {cyclesRun} : {})`
  serialization. KEPT verbatim per D12: the four stage seams
  (`collectEligibleRefsFn`/`runImprovePreparationStageFn`/`runImproveLoopStageFn`/`runImprovePostLoopStageFn`)
  and `runIndexAndCollect` itself (now called exactly once, comments
  reworded to drop the "cycle 1 / cycle N+1" framing). `improve-result.ts`'s
  `cyclesRun` entries in `COMMON_FIELDS`/the numeric-field validation list
  were deliberately LEFT IN PLACE — that module decodes/validates
  *persisted* (potentially historical, pre-Chunk-7) `improve_runs.result_json`
  envelopes; tightening its allow-list would reject old rows that still
  carry the field, which is a regression the brief's "no compatibility shim"
  principle (D11) does not ask for here (D11 is about not adding NEW
  shims for removed *sources*, not about narrowing an EXISTING historical-data
  reader). Not grep-gated (brief's grep-gate token list omits `cyclesRun`).
- **Exploration + self-confidence loop inputs (R14/R13 Chunk-7 half, D3):**
  `AutoAcceptGateConfig.explorationBudgetCount`, the `explorationBudget`/`explorationRemaining`
  counters, the `isExploration` branch (below-threshold-but-budget-remaining
  promotion), the `eligibilitySource:"exploration"` override, the
  `explorationBudget:true` event-metadata flag, the failed-promotion
  slot-restore (`explorationRemaining += 1`), and `makeGateConfig`'s
  `candidateCount` param + its `config.improve.exploration.budgetFraction × candidateCount`
  computation (`improve-auto-accept.ts`). The two `candidateCount: loopRefs.length`
  call sites (`loop-stages.ts`, reflect/distill gate configs). `'exploration'`
  `EligibilitySource` union member (`core/improve-types.ts`). LEFT FOR
  CHUNK 6 (D3, verified untouched): `runAutoAcceptGate`, `recordGateDecision`,
  `Proposal.gateDecision`, `getPhaseThreshold`, the `autoAccept` config field,
  `proposal/drain.ts` — confirmed via `git diff --stat` showing zero changes
  to `drain.ts` and `runAutoAcceptGate`/`recordGateDecision` still exported
  and called from their pre-existing call sites.
- **review_pressure code/type (R21 code/type half):** `REVIEW_PRESSURE_INCREMENT`,
  `REVIEW_PRESSURE_DECAY` consts; `AssetOutcomeRow.review_pressure`,
  `OutcomeUpdateResult.reviewPressure` fields; the compute/decay block inside
  `updateAssetOutcome`; `review_pressure` dropped from the upsert's INSERT
  column list AND the `ON CONFLICT...DO UPDATE SET` clause (an existing row's
  value is now left untouched on every future update — never zeroed, never
  re-written — until migration 018 drops the column); dropped from both
  `getAssetOutcome`/`getAllAssetOutcomes` SELECT column lists
  (`outcome-loop.ts`). The DB column + its index
  (`idx_asset_outcome_review_pressure`) and migration 016's `CREATE TABLE`
  are UNTOUCHED (`DEFAULT 0` tolerates the omission from INSERT/UPDATE;
  column drop is WI-7.3's migration 018, per D5).
- **ValenceScore.lane (R22):** `STRONG_VALENCE_THRESHOLD` const, `FeedbackLane`
  type, `ValenceScore.lane` field, the lane-assignment branch inside
  `computeValenceScore` (`feedback-valence.ts`). Verified zero consumers of
  `.lane` outside the module before deletion (`grep -rn "\.lane\b"` scoped to
  `computeValenceScore` call sites — `preparation.ts:1647,:1894` read only
  `.valence`/`.attention`).
- **Config (R20 exploration/maxCycles half, D16):** `ImproveExplorationSchema`
  (`config-schema.ts`, formerly `:805-820`) + its `exploration:` registration
  in `ImproveConfigSchema`; `maxCycles: positiveInt.optional()` in
  `ImproveProfileConfigSchema`. Both parent schemas keep `.passthrough()`, so
  orphaned `improve.exploration`/`improve.strategies.<n>.maxCycles` blocks in
  existing user configs still load without error (verified: rewrote
  `tests/config-process-roundtrip.test.ts`'s three affected tests to assert
  exactly this — passthrough survival, not schema validation; a fourth test
  that asserted `maxCycles:0` THROWS was inverted to assert it no longer
  throws, since positiveInt validation no longer exists for the orphaned
  field). `ImproveCalibrationSchema` (WI-7.3's) left untouched — confirmed
  present, unedited, in the diff.
- **`schemas/akm-config.json`** regenerated via `bun scripts/gen-config-schema.ts`
  (40 lines removed: the two `maxCycles`/`exploration` JSON-schema blocks,
  each appearing twice — once per improve-strategy-shape occurrence in the
  generated tree). `--check` green after regeneration.

### Retired-with-reason: `proposal-gate-decision.test.ts` — no change made

The brief's testsFirst list calls out
`tests/proposal-gate-decision.test.ts (exploration-budget reason strings
only — gate mechanics are Chunk 6's)` for an update. Grepped the file for
`exploration`, `explorationBudget`, `exploration-budget`, and `budgetFraction`:
zero hits. The file never referenced the exploration-budget reason string in
the first place — it exercises `recordGateDecision`/`archiveProposal`
mechanics with literal `reason: "below-threshold"`/`"max-diff-lines"`/etc.
strings unrelated to WI-7.2's deletions. No edit made; confirmed green
(18/18) both before and after the rest of this item's changes. Recorded as a
deviation (the brief overstated this file's scope) rather than silently
skipped.

### Behavior-change ledger

**(a) Self-consistency default-ON deletion (R23).** Before this item, any
reflect-eligible ref whose utility score was ≥ 0.7 (the default
`selfConsistencyThreshold`, itself default-ON — no config flag gated it)
triggered 3 draftMode reflect samples (majority-vote by Jaccard token
overlap) instead of 1, with only the winning sample persisted as a proposal.
This item deletes that lane entirely: every reflect-eligible ref now gets
exactly 1 reflect call regardless of utility. Net effect: 3×→1× reflect LLM
calls on utility≥0.7 refs. Intended — self-agreement across 3 samples of the
same model is not independent verification (no distinct evidence source),
so the majority-vote signal was cosmetic robustness, not correctness;
dropping it is a straightforward LLM-call-volume reduction with no
retrieval-quality claim being given up. (Pulled from
`goldens-self-consistency.test.ts`'s retired header, which pinned this exact
before-state as its designated re-baseline-at-7 note.)

**(b) P0-A high-retrieval fallback deletion — CORRECTED attribution (R23,
D13).** The plan's "P0-A is today the ONLY path for never-rated assets" is
FALSE at HEAD and was already flagged stale by the retired
`goldens-p0a-selection.test.ts`'s header. Two other lanes rescue never-rated
(zero-feedback) assets independent of P0-A: the default-ON
`proactiveMaintenance` selector (Layer 2, ships `enabled:true, maxPerRun:15`
in the default strategy) and the `#608` high-salience admission gate
(Layer 3, admits zero-feedback refs whose content-derived `encoding_salience`
clears the configured threshold). Post-deletion, never-rated assets remain
reachable via those two lanes; only assets that clear NEITHER the
signal-delta gate NOR proactive-maintenance's staleness/priority cut NOR the
high-salience content-score threshold become fully unreachable — a materially
smaller behavior delta than a naive reading of the plan would suggest. Diff
reviewers should attribute any post-deletion "never-rated asset stopped
being reflected" report to the SPECIFIC lane it fell out of (P0-A's raw
retrieval-count threshold had no equivalent in the surviving two lanes'
composite priority/staleness/content-score gates), not assume P0-A was the
asset's only path.

**(b2) `'high-retrieval'` removed from `ENRICHMENT_LANES` (R23).**
`health/types.ts`'s `ENRICHMENT_LANES` shrank from
`["proactive","high-salience","high-retrieval","signal-delta"]` to
`["proactive","high-salience","signal-delta"]`. Historical proposal rows
persisted with `eligibilitySource:"high-retrieval"` (from before this item)
still appear in `computeEnrichmentMintingRollup`'s per-lane `byLane`
breakdown (that construction is unconditional — every lane seen in the
data), but no longer contribute to the rollup's top-level
`minted`/`updated`/`share` aggregation (which sums ENRICHMENT_LANES only) —
a small, intended live health-reporting behavior change.
`tests/commands/health-minting-rollup.test.ts` updated: the ratified-lane-set
pin shrunk to the 3 surviving lanes; the "null backupContent → minted"
byLane semantics test was re-pointed at `"high-salience"` (a surviving lane)
and a new dedicated test added pinning the historical-`"high-retrieval"`-row
byLane-but-not-aggregated behavior described above.

### Grep-gate (R11/R14/R15/R18/R19/R22/R30) — verified zero hits

Scope: `src/`, `scripts/`, `src/assets/`.

```
selfConsistencyThreshold          0 hits
selfConsistencyN                  0 hits
pickMajorityVote                  0 hits
jaccardSimilarity (src/commands/improve scope) 0 hits
explorationBudgetCount            0 hits
high-retrieval                    0 hits
minRetrievalCount                 0 hits
maxCycles (src/commands/improve + config-schema.ts scope) 0 hits
reviewPressure                    0 hits
FeedbackLane                      0 hits
STRONG_VALENCE_THRESHOLD          0 hits
review_pressure (snake_case column string) — 0 hits outside migrations.ts
  (CREATE TABLE/index, migration 016, untouched) and one outcome-loop.ts
  doc-comment explaining the deliberate INSERT/UPDATE omission
```

`ImproveExplorationSchema` and bare `'exploration'`/`"exploration"` as an
`EligibilitySource`/config-key literal: 0 hits (checked separately — not on
the brief's explicit token list but implied by the deletions).

### Verification

- `bunx tsc --noEmit`: clean, zero errors (full repo, not just touched files
  — confirms no downstream type breakage e.g. in `improve-result.ts`'s
  historical-envelope validator, which was deliberately left permissive).
- `bunx biome check` (all touched + new files): clean after two fixups
  (`Object.prototype.hasOwnProperty` → `Object.hasOwn` in the new
  `improve-single-pass.test.ts`; an unused `AutoAcceptGateConfig` type import
  in `ws4-gate-coherence.test.ts` left dangling by the exploration-describe
  deletions) + 3 auto-formatted files (whitespace only).
- `bun scripts/gen-config-schema.ts --check`: green after regeneration
  (`schemas/akm-config.json` committed alongside the schema edit).
- `tests/goldens-designations.test.ts`: green (7/7) — both retired entries
  removed cleanly, no orphaned registry row or unregistered fixture file.
- `tests/commands/improve/goldens-signal-delta-gate.test.ts`: green (19/19);
  fixture bytes byte-identical (verified via `git status --porcelain` on the
  fixture path — no diff) despite the permitted carve-out edit dropping
  `minRetrievalCount: 0` from the suite's `akmImprove` call (the option no
  longer exists; the lane it neutralized is gone too, so removing the dead
  line changes nothing observable).
- `tests/commands/improve/outcome-invariance.test.ts`: green (4/4), file
  UNTOUCHED (zero diff — confirmed via `git status --porcelain`), per brief
  ("untouched here — its `:49` INSERT column list is updated in WI-7.3").
- `tests/commands/consolidate/consolidate-incremental.test.ts` (D1
  retained-with-reason oracle) + all four 0a consolidate/improve golden
  suites: not re-run this item (no code path touched by WI-7.2 intersects
  them); zero fixture diffs confirmed via `git status --porcelain` across
  `tests/fixtures/goldens/consolidate/**`.
- Directly-touched/new suites, all green: `ws4-gate-coherence.test.ts` (13),
  `outcome-loop.test.ts` (27), `monitor-liveness.test.ts` (8),
  `health-minting-rollup.test.ts` (7), `distill.test.ts` attribution tests
  (spot-checked within the 1750-line file), `feedback-valence.test.ts` (4),
  `engine-plan-boundaries.test.ts`, `config-process-roundtrip.test.ts` (22),
  `improve-sync-resilience.test.ts` (3), `improve-eligibility.test.ts` (25,
  118s — the heaviest file in the item, full real-`akmImprove` integration
  coverage), `improve-single-pass.test.ts` (2, new), plus the seven
  §15.3-adjacent "KEEP GREEN" suites named in the brief
  (`improve-no-hang`/`improve-budget-watchdog`/`improve-session-lifecycle`/
  `improve-sync`/`improve-dry-run-side-effects`/`improve-lock-invariants`/
  `improve-db-locking`, 28 tests) and `proactive-maintenance-flow.test.ts`
  (mechanical `minRetrievalCount` census edit only).
- Full `tests/commands/improve/` directory run (467 tests, 42 files): 466
  pass, 1 pre-existing failure
  (`improve-auto-accept.test.ts > runAutoAcceptGate — archives
  validation-failed proposals (M4) > real auto-accept composition emits
  exactly one promoted event`) — **verified NOT caused by this item**: the
  same directory run against the pre-WI-7.2 (post-WI-7.1) baseline, obtained
  by `git stash`-ing this item's full working tree and re-running, reproduces
  the IDENTICAL single failure (504 tests, 44 files incl. the two now-retired
  golden suites and the now-deleted multi-cycle suite; 503 pass / 1 fail, same
  test). The test passes in isolation and paired with
  `improve-eligibility.test.ts`; it fails only as part of the full ~40+-file
  directory run, and `improve-auto-accept.ts`'s diff for this item touches
  only the exploration branches (verified via `git diff` — the
  above-threshold/normal-promotion code path this test exercises is
  byte-unchanged). Cross-file test-order/state pollution, pre-existing,
  out of this item's scope — flagged for the chunk-level Finalize gate
  rather than fixed here (touching an untouched, unrelated file's ordering
  sensitivity is outside WI-7.2's brief).

### Deviations from the brief

- `tests/proposal-gate-decision.test.ts`: brief's testsFirst list calls for
  an "exploration-budget reason strings only" update; the file contains no
  exploration-budget references at all (verified by grep) and required no
  change. See the dedicated section above.
- `improve-multi-cycle.test.ts`'s AC1 was repurposed into a NEW file
  (`improve-single-pass.test.ts`) rather than edited in place, since every
  other test in the file (AC2-AC5) pins deleted multi-cycle machinery and
  the file's name/module-doc no longer describe anything that exists;
  renaming+gutting in place seemed less clear than a fresh, correctly-named
  file. Functionally equivalent to "delete + repurpose one AC" as specced.
- Pre-existing, unrelated test-order-dependent failure in
  `improve-auto-accept.test.ts` discovered and root-caused during
  verification (see above) — not fixed (out of scope), flagged for the
  chunk-level Finalize gate.

## WI-7.4 — Shared helpers: RunContext, proposal-envelope facade, single derived-ref, god-fn ratchet; DRY fixes + rename

This item MINTS shared machinery (no lane deletions). Net-LOC is reported, not
gated (plan §15.4). Adoption of RunContext / the envelope facade at the verb
call sites is WI-7.5–7.8 work; here they exist with one implementation each.

### Files added

| File | LOC | Purpose |
|---|---:|---|
| `src/commands/improve/run-context.ts` | 215 | `RunContext` carrier + the D6 read-once seam (memo scope, write-through invalidation). (R6) |
| `src/commands/improve/proposal-envelope.ts` | 54 | `emitProposal(ctx, input)` facade over `createProposal` — the single seam Chunk 6 extends. (R7/D10) |
| `src/commands/improve/memory/derived-ref.ts` | 83 | The single keyed-on-ref `isDerivedMemory`/`resolveParentRef`/`parseMemoryRef`. (R12) |
| `scripts/lint-improve-fn-size.ts` | 154 | TS-AST god-fn size ratchet: scanner + shrink-only baseline. (R31) |
| `tests/commands/improve/run-context.test.ts` | — | Pins the D6 memo contract (7 tests). |
| `tests/commands/improve/proposal-envelope.test.ts` | — | Pins direct-vs-facade equivalence (3 tests). |
| `tests/commands/improve/derived-ref.test.ts` | — | Pins producer/consumer agreement + the intended widening (10 tests). |
| `tests/architecture/improve-fn-size-ratchet.test.ts` | — | Asserts the live over-bar set equals the baseline (shrink-only). |

Net src/scripts diff for this item: **+529 / −74 ≈ +455** (within the plan §5
~+500 helper budget; reported). Already-landed earlier in the branch and folded
under WI-7.4: `serializeFrontmatterQuoted` (R27) and the single
`MAX_REJECTED_PROPOSALS` (plan §5 dedup).

### Duplicate implementations collapsed (R12 / R27 / plan §5)

- `isDerivedMemory` + `resolveParentRef`: two divergent copies (consumer
  `memory-improve.ts`, producer `memory-contradiction-detect.ts`) → one in
  `derived-ref.ts`. `parseMemoryRef` folded onto the same module (was a private
  copy in `memory-improve.ts`; the now-unused `parseAssetRef` import was
  dropped there). Local `DERIVED_SUFFIX` in `memory-improve.ts` removed in favour
  of the shared export.
- `serializeFrontmatterQuoted` (R27) and `MAX_REJECTED_PROPOSALS` (plan §5) —
  single implementations already landed earlier on the branch.

### Behavior change (intended, ledgered) — derived-ref producer widening

Sharing one keyed-on-ref impl WIDENS the producer
(`detectAndWriteContradictions`), which previously used a strictly narrower
copy that (a) ignored `derivedFrom` entirely and (b) matched `source:` only via
a raw `startsWith("memory:")`. Post-change the producer resolves a parent for
`derivedFrom`-keyed families (so they now participate in contradiction
detection) and normalises `source:` through `parseAssetRef` (trim + origin) —
aligning it with the consumer so the two can no longer disagree (plan §6). All
existing producer suites set `source:` and are unaffected (86 memory tests
green); the widening is pinned by `derived-ref.test.ts`.

### Rename (plan §5 RENAME row)

`relativeImproveResultPath → improveRunLocator`, `writeImproveResultFile →
recordImproveRunResult` (the names lied about writing a file; the 0.8.0 storage
swap moved the record into the `improve_runs` state.db table). Mechanical —
signatures/return types unchanged; `improve-cli.ts` call sites + the test file
updated. File name kept (rename optional per the brief).

### D8 — mutateFrontmatter row (plan §5 CONSOLIDATE row): MIS-GROUNDED, no code change

The plan §5 row "`memory-improve.ts:315-328,730-735` raw fs read/parse/write →
`mutateFrontmatter`" is not cleanly executable and is recorded here as
descoped:
- the `:728-735`-region block is a read-only collector — there is no write to
  convert; and
- the `:313-333`-region block mutates the memory BODY (`resolveRelativeDates`),
  which `mutateFrontmatter`'s frontmatter-only contract cannot express.

`core/asset/frontmatter.ts` is deliberately NOT extended (wide blast radius; the
frozen `improve/resolve-relative-dates.json` golden pins the block's bytes). The
~−20 LOC the row anticipated is therefore not realized. Carries no inventory id.

### God-fn ratchet baseline (R31) — the WI-7.5–7.8 worklist

Measured at chunk-7 HEAD (post 7.1/7.2/7.3 deletions), 13 function-like nodes in
`src/commands/improve/**` exceed the 220-line bar. Emptied by WI-7.8.

| Lines | Node |
|---:|---|
| 1493 | `preparation.ts :: runImprovePreparationStage` |
| 810 | `improve.ts :: akmImprove` |
| 643 | `reflect.ts :: akmReflect` |
| 632 | `distill.ts :: akmDistill` |
| 500 | `loop-stages.ts :: runImproveLoopStage` |
| 470 | `loop-stages.ts :: runImproveMaintenancePasses` |
| 452 | `extract.ts :: akmExtract` |
| 389 | `loop-stages.ts :: withIndexWriterLease#arg1` (the maintenance anon) |
| 373 | `consolidate.ts :: planConsolidation` |
| 308 | `extract.ts :: processSession` |
| 297 | `consolidate.ts :: handleMergeOp` |
| 265 | `preparation.ts :: runConsolidationPass` |
| 254 | `distill/promote-memory.ts :: promoteMemoryToKnowledge` |

### Scope discipline held

No change to `EventsContext` shape (D14/R25); no db handle threaded into
`ProposalsContext` (D14); no change to `core/asset/frontmatter.ts` (D8). The
RunContext memo is structurally never run-wide (top-risk #7): the base context is
non-memoizing and memoization is opt-in per `withFreshAssetMemo()` scope.

## WI-7.5–7.8 — god-function decomposition progress (R31 ratchet)

The WI-7.4 god-fn size ratchet (`scripts/lint-improve-fn-size.ts`, 220-line bar
over `src/commands/improve/**`) started at **13 offenders**. Each decomposition
below is a pure, byte-identical code-motion extraction verified against the
relevant characterization suites; the ratchet baseline shrinks by exactly the
functions brought under the bar (equality-asserted, shrink-only).

| Item | Function | Before | After | Extracted pass(es) | Oracle (green) |
|---|---|---:|---:|---|---|
| WI-7.5 | `promoteMemoryToKnowledge` | 254 | ~165 | `resolveKnowledgePromotionContent` | 145 distill tests |
| WI-7.6 | `runConsolidationPass` | 265 | ~175 | `evaluateConsolidationEligibility` | consolidate-min-pool-size + eligibility/salience (66) |
| WI-7.8 | `handleMergeOp` | 297 | ~165 | `finalizeMerge` | 138 consolidate-suite tests |
| WI-7.8 | `planConsolidation` | 373 | ~178 | `judgeConsolidationChunks`, `recordChunkJudgedNoAction` | 142 consolidate-suite tests |
| WI-7.7 | `processSession` | 308 | ~213 | `runPreLlmSessionGates` | 136 extract tests |

Ratchet: **13 → 8 offenders**. `consolidate.ts` is now fully under the bar
(R9 op-family decomposition core landed). Full `bun run check` green at this
point: unit **8568/0**, integration **4456/0**.

**Remaining ratchet baseline (WI-7.5–7.8 worklist, 8 offenders):**
`runImprovePreparationStage` (1493), `akmImprove` (810), `akmReflect` (643),
`akmDistill` (632), `runImproveLoopStage` (500), `runImproveMaintenancePasses`
(470), `akmExtract` (452), `loop-stages.ts withIndexWriterLease#arg1` (389).

**Still outstanding for full WI-7.5–7.8 DoD** (beyond emptying the ratchet):
the RunContext.readAsset / emitProposal facade *adoption* at the verb call
sites (the mints exist and are pinned but are not yet threaded in); the
promotion-policy literal trim (R24 — intricate `CANDIDATE_MODELS` /
`selectPromotionPolicy` / bench-recompute interplay); the structured-call
migration (R26, ~10 sites); the events-ctx threading (R25, 14+ sites) and the
appendEvent hot-path test (WI-7.7); processSession's full 18→2-arg RunContext
signature collapse; and the final grep-gate / net-LOC / audit finalize (WI-7.8).

### Divergences from the brief found this session (anchors drift)

- The brief's "Chunk 0a golden suites" and `tests/fixtures/goldens/` +
  `DESIGNATIONS.json` infrastructure **do not exist in this worktree**. The
  consolidate characterization oracle is `consolidate-op-handlers.test.ts` +
  the sibling `tests/integration/commands/consolidate/*` suites (which drive the
  four op handlers directly and end-to-end). "Byte-identical fixture" is moot
  here; behavior preservation is enforced by those suites staying green.
- Architecture AST tests live under `tests/integration/architecture/`
  (disk-reading precedent: `agent-runner-seam.test.ts`); the god-fn ratchet
  meta-test was placed at `tests/architecture/improve-fn-size-ratchet.test.ts`
  (unit shard, matching the disk-reading `lint-isolation-ratchet.test.ts`
  precedent) so it runs in `check:fast`.

## WI-7.5–7.8 — decomposition progress update (ratchet 13 → 5)

Continuing the byte-identical god-fn decomposition. Eight of the thirteen HEAD
offenders are now fully under the 220-line bar; **consolidate.ts, extract.ts,
distill.ts, reflect.ts, and distill/promote-memory.ts are entirely clear**.

| Item | Function | Before | Passes extracted (all byte-identical) |
|---|---|---:|---|
| 7.5 | `promoteMemoryToKnowledge` | 254 | `resolveKnowledgePromotionContent` |
| 7.6 | `runConsolidationPass` | 265 | `evaluateConsolidationEligibility` |
| 7.8 | `handleMergeOp` | 297 | `finalizeMerge` |
| 7.8 | `planConsolidation` | 373 | `judgeConsolidationChunks`, `recordChunkJudgedNoAction` |
| 7.7 | `processSession` | 308 | `runPreLlmSessionGates` |
| 7.7 | `akmExtract` | 452 | `resolveExtractRunConfig`, `discoverExtractCandidates`, `runExtractSessionLoop` |
| 7.5 | `akmDistill` | 632 | `loadAndScoreInputSalience`, `readDistillFeedback`, `buildDistillMessages`, `runDistillLlmCall`, `distillEmptyResponseResult`, `assembleAndValidateDistillContent`, `applyDistillQualityGate`, `emitDistillLessonProposal` |
| 7.5 | `akmReflect` | 643 | `resolveReflectRunner`, `resolveReflectSource`, `runReflectRefineIterations`, `resolveReflectPayload`, `finalizeReflectProposal`, `createReflectProposal` |

Each removal was verified against that function's characterization suite
(125–147 tests apiece) with the ratchet green throughout; full `bun run check`
green at this point — unit **8568/0**, integration **4456/0**.

**Remaining ratchet baseline (5 offenders):** `runImprovePreparationStage`
(1493), `akmImprove` (810), `runImproveLoopStage` (500),
`runImproveMaintenancePasses` (470), `loop-stages.ts withIndexWriterLease#arg1`
(389). These are the improve orchestration/loop core; their intricate control
flow (mutating closures over outer-scope `let`s, `for`-loops with
`continue`/`break` + running counters, the maintenance `withIndexWriterLease`
callback) makes byte-identical pass-extraction materially harder than the
verb-command bodies already cleared — the remaining WI-7.6/7.7 work. The ratchet
guards them: none can grow, and each decomposition must shrink its baseline
entry in the same change.

## WI-7.6/7.7 completion — the last 5 god-functions (ratchet 5 → 0)

Continuing from the "13 → 5" update: the five orchestration/loop-core
offenders are decomposed, byte-identically, each adversarially verified
against HEAD by an independent review pass (side-effect order, exception-path
state, shared-mutable identity, exit-path topology) before its commit:

| Item | Function | Before | Passes extracted |
|---|---|---:|---|
| 7.7 | `runImproveLoopStage` | 500 | `prepareImproveLoopEnv`, `processImproveLoopRef` (per-ref `LoopRefTally` — `continue`→`return`, counters folded by the orchestrator), `runLoopReflectPass`, `runLoopDistillPass`, `invokeDistillAndRecord`, `recordBudgetExhausted` |
| 7.7 | `runImproveMaintenancePasses` + `withIndexWriterLease#arg1` (470 + 389) | 859 | `runMaintenancePassesUnderLease` (the anon callback, named), `runMemoryInferenceMaintenancePass`, `runGraphExtractionMaintenancePass`, `runOrphanProposalPurgePass`, `runProposalExpirationPass`, `runRetentionPurgePass`; `IndexDbCell` replaces the closure-mutated `db` (the #584 reopen-in-finally is the one irreducible mutable seam), `MaintenanceCtx` carries run deps |
| 7.6 | `runImprovePreparationStage` | 1493 | `buildSnapshotManifest`, `gatherCandidates` (`partitionBySignalDelta` + `buildFeedbackSummaryMap` + `fetchRetrievalSignals` + `selectProactiveMaintenanceLane` + `selectHighSalienceLane`), `scoreSalience` (`updateOutcomeScores` + `computeSalienceVectors` + `persistSalienceAndReportRanks` + `applyForgettingSafety`), `filterEligibility` (`applyReplaySelection` + `dropRefsMissingOnDisk`), plus `assessMemoryIndexBudget` / `applyCleanupPass` / `seedRecentErrorWindows` |
| 7.7 | `akmImprove` | 810 | `resolveImproveRunSetup` (the `ImproveRunSetup` carrier), `indexAndCollect` (former closure, now pure), `buildLockSkippedResult` / `buildDryRunResult`, `runTriagePrePass`, `makeCommitStashBatch` (getter-based live-binding capture), `preloadRejectedProposals`, `refilterProactiveLoopRefs`, `runImproveStageSequence`, `recordImproveFailure`, `finalizeImproveResult` |

Every extraction biased toward testability per the session requirement:
per-item loop bodies return results instead of mutating outer `let`s
(`LoopRefTally`, pass result records), dependencies ride explicit args-object
carriers (`ImproveLoopEnv`, `MaintenanceCtx`, `ImproveRunSetup`,
`ExtractSessionRunCtx`), and each decomposition landed with a NEW focused unit
suite driving the passes directly through injected seams:
`improve-loop-ref-pass.test.ts` (20), `improve-maintenance-passes.test.ts`
(12), `preparation-passes.test.ts` (13), `improve-run-units.test.ts` (4).

### Brief-vs-HEAD divergences recorded for WI-7.6's six-pass prescription

- **valence-score**: no separate pass exists — `computeValenceScore` (pure) is
  called at exactly two embedded sites (`updateOutcomeScores` `.valence`,
  scenario-A rank reconstruction `.attention`); both moved VERBATIM inside the
  salience passes. Minting an empty pass wrapper was rejected as churn.
- **standards-context**: does not exist in preparation.ts at HEAD — the
  assembly lives in extract.ts (`resolveExtractStandards`, resolved once per
  run, threaded via `ExtractSessionRunCtx.standardsContext`). Recorded here
  instead of minting a vacuous pass.
- The three `!== false` outcome-weight reads and the #644 provenance gates
  moved verbatim (`computeSalienceVectors` now owns the
  `outcomeWeightEnabled` read site); the 2026-05-26 signal-delta partition
  semantics + comment moved verbatim into `partitionBySignalDelta`.

### RunContext (D6) adoption decision — recorded, not silently skipped

The WI-7.4 `RunContext.readAsset` memo has ZERO content-read consumers in the
decomposed pass regions at HEAD (the preparation map confirmed no content
`readFileSync` inside the six-pass region; metadata-only `statSync`/`existsSync`
cannot route through a bytes seam without behavior change). Threading the
literal `RunContext` object would also collide with type realities
(`eventsCtx` non-optional vs the stages' optional threading; extract's
`getLlmConfig` returns `LlmProfileConfig`, not `LlmConnectionConfig | null`).
Decision: the passes take explicit run-scoped carriers instead
(`ImproveLoopEnv` / `MaintenanceCtx` / `ImproveRunSetup` /
`ExtractSessionRunCtx` — same DI shape, honest types), and `RunContext`
adoption at the verb read sites stays on the WI-7.5–7.8 outstanding list
below. `emitProposal`'s `ProposalEmitContext` is structurally satisfied by
`RunContext`, so the facade path is compatible either way.

## WI-7.8 — finalize: absolute gate, grep-gate, audits, net-LOC

### Ratchet emptied + flipped (R31, DoD 5)

`IMPROVE_FN_SIZE_BASELINE` is deleted; `scripts/lint-improve-fn-size.ts` is
now the absolute gate and `tests/architecture/improve-fn-size-ratchet.test.ts`
asserts `measureImproveFnOffenders() === []` with no allowlist. Live scan at
finalize: **0 offenders** across every function-like node (incl. arrows/anons)
in `src/commands/improve/**`, bar 220.

### emitProposal facade adoption (R7) + processSession collapse (R5)

All five surviving emit sites route through `emitProposal` (reflect.ts,
distill.ts, distill/promote-memory.ts, extract.ts, consolidate.ts); zero
direct `createProposal` calls remain under `src/commands/improve/**`
(comments and the repository module itself excepted). `processSession` is
`(runCtx: ExtractSessionRunCtx, session: ExtractSessionInput)` — 2 params,
run-scoped inputs resolved once per run in `runExtractSessionLoop`.

### Final grep-gate re-run (R30) — zero-counts recorded at finalize

The full WI-7.1 + 7.2 + 7.3 token lists re-run over `src/`, `scripts/`,
`src/assets/`: **every token 0 hits** (7.1: akmRecombine, RecombineResult,
recombineFn, recombine_hypotheses, recombine_invoked, recombine-repository,
getEntitiesByEntryIds, deriveRecombineLessonRef, RecombineHypothesisRow,
case-insensitive `recombin`; 7.2: selfConsistencyThreshold, selfConsistencyN,
pickMajorityVote, jaccardSimilarity, explorationBudgetCount, high-retrieval,
minRetrievalCount, maxCycles, reviewPressure, FeedbackLane,
STRONG_VALENCE_THRESHOLD; 7.3: maybeAutoTuneThreshold, computeThresholdAutoTune,
summarizeCalibration, gateDecisionsToSamples, CalibrationSummary,
calibration_autotune, akmProcedural, ProceduralCompilationResult,
procedural_compiled, buildProceduralPrompt, orderedActions,
runDeterministicDedup, computeMemoryContentHash, hotProbation, isHotProbation,
schemaSimilarity, proceduralAwareFloor, consolidation_judged), with exactly the
standing allowlist surviving: migration DDL in `src/core/state/migrations.ts`
(007/010/014 historical + 018 drops) and the `outcome-loop.ts` doc comment
explaining the deliberate `review_pressure` INSERT/UPDATE omission. One stale
doc-comment `maxCycles` mention in `config-types.ts` (outside the 7.2 gate's
scope) was cleaned in this pass.

### R33/R11 audit — clean

Scoped grep for lifecycle machinery (states/water-marks/pressure computation/
intake blocking/CAS archive/sandbox gate/purge-quarantine commands): zero
hits. The 8 `purgeOld*` retention call sites under improve are the
pre-existing retention passes, moved verbatim into
`runRetentionPurgePass`/`runProposalExpirationPass` (allowlisted vocabulary).
`review_pressure` code references: zero (doc-comment allowlist above). No new
labeling/clamps/prompts/digests/trust records were introduced by the
decomposition (structural moves only, adversarially verified per function).

### Bookkeeping note — WI-7.3

WI-7.3's deletions are fully landed on this branch (calibration.ts,
procedural.ts, dedup.ts, hot-probation.ts, schema-similarity-gate.ts,
consolidation-repository.ts all gone; `content-hash.ts` minted; migration
`018-drop-dead-lane-schema` appended; all 7.3 grep-gate tokens 0), but the
item never received its own ledger section — the finalize grep-gate above
serves as its zero-count record.

### Net LOC (reported, not gated — plan §15.4)

The WI-7.6/7.7 decomposition + testability pass is a net ADD, as expected for
byte-identical extraction (interface carriers, pass shells, docs, and four new
focused unit suites):

- `runImproveLoopStage` commit: src +583/−403 (+180); test +359
- maintenance commit: src +563/−401 (+162); test +290
- preparation commit: src +924/−383 (+541); test +294
- `akmImprove` commit: src +860/−619 (+241); test +130
- facade adoption + processSession collapse: src +118/−78 (+40)
- finalize (gate flip + ledger): src/scripts ≈ −25

Decomposition subtotal ≈ **src +1,164 / tests +1,073**. The chunk's headline
deletion economics live in WI-7.1–7.3 (e.g. 7.1 alone: src −1,569 /
tests −3,034) and are unchanged by this pass; net-LOC remains REPORTED, never
gated.

### Still outstanding for the full WI-7.5–7.8 DoD (carried forward)

The ratchet DoD (no fn >220, baseline emptied, gate absolute) is COMPLETE.
Carried forward from the prior outstanding list, unchanged in scope:
`RunContext.readAsset` adoption at the verb read sites (D6 memo has no
consumers yet — see the decision note above), the promotion-policy literal
trim (R24), the structured-call migration (R26, ~10 raw callers), events-ctx
threading through the reflect/distill subtree + `locks.ts` + extract's three
sites (R25) and the appendEvent hot-path test, and the R32/R36 consolidate
golden replay (this worktree has no goldens infrastructure — the
consolidate-op-handlers + integration suites remain the behavior oracle, all
green through every decomposition commit).

### Final verification (R34)

Full `bun run check` run EXACTLY ONCE at finalize, exit 0: biome + the five
lint gates + `gen-config-schema --check` green, `bunx tsc --noEmit` clean,
unit shards green (the `&&` chain reached integration), integration
**4456 pass / 0 fail / 55 skip** (4511 tests, 333 files, 431 s). Fixed points
(`tests/_helpers/sandbox.ts`, `tests/_preload.ts`, the mock.module-ban lint +
baseline, the sharding scripts) untouched all session — `git diff` empty on
all four paths across every commit.

---

# Residuals session (2026-07-16+) — carried-forward WI-7.5/7.7 items

## R24 — promotion-policy literal trim (reshape → trim, two commits)

Reshape commit (tests green BEFORE the trim, per WI-7.5 step 3 ordering):
the bench deep-equal against the 842-line frozen payload became (a) a live
`selectPromotionPolicy` grid search over the corpus + (b) narrow equality on
the winner's `{name,threshold}`; the unit suite's trainingSize/heldOutSize/
heldOut-metrics/baselines assertions switched from
`getDefaultPromotionPolicySelection()` to the same live recompute; the
`.selectedModel.name` assertion survives against the frozen constant.

Trim commit: `DEFAULT_PROMOTION_POLICY_SELECTION` (:650–1491, 842 lines) +
the 3-model `CANDIDATE_MODELS` array (:444–493) are replaced by a narrow
`PromotionPolicySelection` type + one frozen literal carrying the FULL
13-weight `balanced-evidence` config + `threshold: 3.8` (the plan's
`{selectedModel}` shorthand is insufficient — `assessWithWeightedModel`
reads all 13 weight fields at runtime; brief trap #8). `SELECTED_MODEL`
became a direct read of the constant (the module-load `.find` is gone);
`getDefaultPromotionPolicySelection` (test-only callers) deleted;
`selectPromotionPolicy` gained a required `candidates` parameter and the
3-model grid moved VERBATIM to `tests/commands/distill/
promotion-policy-corpus.ts` next to the corpus — the bench recompute must
keep searching all three candidates or the "winner still wins" assertion
degenerates into a tautology. `PromotionModelConfig` is now exported
(type-only consumer: the test-side grid).

Behavior: NONE changed on the production path —
`assessMemoryKnowledgePromotionCandidate` (promote-memory.ts:216) still
assesses with the identical weights/threshold; adversarially verified
value-identity of all 13 weights + threshold against HEAD before commit.
Net: src −868 (distill-promotion-policy.ts 1510 → 642 lines); tests +61.
Suites: distill unit+bench+integration 111 pass / 0 fail; tsc clean;
biome clean; goldens untouched (no DESIGNATIONS entry references promotion
policy — verified).

## R26 — structured-call migration (seam extension + four migration commits)

D7's preferred branch, finished: every raw `chatCompletion` call expression
in the chunk-7 files now routes through `callStructured`. Landed as five
commits, each green on its scoped suites before push:

1. **Seam extension** (additive, contract-pinned): `CallStructuredOptions.
   enabled` forwards to `tryLlmFeature` — without it, resolver-less feature
   keys (`distill`, `memory_consolidation`, `memory_contradiction_detection`,
   the quality gates) migrate onto a permanently-closed gate;
   `CallStructuredRequest` gains `maxTokens` + `enableThinking`; option keys
   forward hasOwn-conditionally because the wrapper AND transport are
   tri-state on `timeoutMs` (absent = default, present-undefined = disabled).
   The three existing adopters pass the timeoutMs key explicitly → behavior
   unchanged (suites green). Contract pins (8)–(11) added.
2. **reflect + quality-gate**: `runReflectViaLlm` → ungated callStructured
   (new `reflect_proposal` LlmFeatureKey labels it; enablement is
   strategy-resolved before dispatch); errors still fold into the
   failure-shaped AgentRunResult. `runQualityJudge` (shared LLM-as-judge) →
   ungated callStructured with the injected chat as transport override;
   `chat` widens to `QualityJudgeChat | undefined` so reflect passes
   `options.chat` straight through; wrappers stamp lane-appropriate keys.
   Fail-closed reasons + 3.5/2.5 banding byte-preserved.
3. **distill**: `runDistillLlmCall` migrates with the `enabled` override; the
   in-gate missing-LLM ConfigError becomes a pre-seam guard producing the
   identical terminal state (fallbackReason "error" + same warnVerbose line;
   disabled still dominates); production responseSchema path and the
   schema-blind test-seam bifurcation preserved.
4. **extract**: both bounded calls (per-session + #561 summary generator)
   migrate; `getLlmConfig()` moves behind an explicit try/catch preserving
   the fail-open contract (materializeLlmConnection CAN throw ConfigError —
   verified — and used to be swallowed by the gate); the llmRaw side-channel
   stays; the chat ctx field widens to optional and both `?? chatCompletion`
   bindings die — extract.ts now has ZERO chatCompletion occurrences.
5. **consolidate + memory-contradiction-detect**: envelope semantics
   preserved exactly (throw → {ok:false, String(e)} via onError, never the
   gate fallback; retry-with-2s-backoff, AKM_DEBUG_LLM, accounting bumps
   untouched); contradiction pair-judge keeps its default-off strategy gate
   and null-skip semantics.

### Final grep record (the six files + quality-gate.ts)

`chatCompletion\(` call expressions: **0** in reflect.ts, distill.ts,
extract.ts, consolidate.ts, shared.ts (0 lines — deleted in WI-7.1/7.3;
complete-by-deletion), memory/memory-contradiction-detect.ts, and
distill/quality-gate.ts. Remaining value references are sanctioned
non-calls: type-position `typeof chatCompletion` seam declarations
(reflect ×2 type-only import, distill ×2), distill.ts:835's binding that
feeds promote-memory's required `ctx.chat` (subtree consumer, Chunk 9
RunContext work), and mcd's documented default parameter.
`_setChatCompletionForTests` verified working through the seam's late
binding by the frozen consolidate golden call-count pins and the reflect
response-schema capture suite.

Out-of-chunk raw callers left untouched for Chunk 9 (re-confirmed at HEAD):
graph-extract batch/retry (llm/graph-extract.ts:660,:683), tasks/runner.ts
chatCompletionImpl, workflows native-executor + frozen-judge lazy imports,
sources/schema-repair.ts, remember.ts, proposal/propose.ts + drain.ts,
run-context.ts:204 default binding, llm/client.ts in-module probes.

Net: seam +150 (incl. 4 contract pins); migrations ≈ −60 net across the
five files (scaffold dedup offset by preserved-semantics comments).
Suites: ~640 tests green across seam/reflect/distill/extract/consolidate/
contradiction buckets; tsc + biome clean per commit.
