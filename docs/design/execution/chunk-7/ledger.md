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
