# R5 — Longitudinal Collapse/Churn Detector for `akm improve`

> **Status:** Design, ready to implement (2026-07-02). Implements R5 / closes G7 from
> [improve-self-learning-analysis.md](improve-self-learning-analysis.md) §4-G7/§5-R5/§6.3.
> Deliberately deferred off `feat/improve-self-learning-wiring`; this document is the
> implementation spec for a follow-up branch.
>
> **Scope discipline.** The field has *measured* the two failure modes this detects
> (repeated LLM merge passes collapsing a store to one entry in ~10 passes; unbounded
> accumulation dropping task accuracy from 39%→13%) [research-08 §10]. AKM has strong
> *preventive* scaffolding (generation guard, lexical-diversity check, dedup, cooldowns,
> multi-run recombine confirmation) but **no longitudinal signal to detect collapse or
> wasted churn if prevention fails**. This is the one place the analysis judged adding a
> small mechanism justified. Everything below reuses existing machinery where it exists
> (curate-golden rank metrics, `computeBigramDiversity`, the anti-collapse generation
> guard, `improve_runs` metrics, the events log, the health advisory channel) and states
> the rejected alternative wherever a judgment call was made.
>
> **Hard constraints honored throughout:** deterministic only — the detector NEVER calls
> an LLM and never loads an embedding model; bounded storage (state.db already suffered a
> 3.95 GB `result_json` bloat — every row this design writes is < 2 KB and retention is
> explicit); cheap enough to run on every consolidation/recombine cycle (~a few runs/day;
> improve itself fires every ~20–30 min but the detector only runs on cycles where
> consolidate/recombine actually did work); fail-open (a detector error warns and skips,
> never breaks an improve run).

---

## 1. Problem statement & detection targets

Two distinct pathologies, distinguishable only longitudinally:

| Pathology | What it is | Primary signal | Secondary signals |
|---|---|---|---|
| **Collapse** | Repeated merges/generalizations destroy information: the store converges toward fewer, blander, more generic entries. Canonical content stops being retrievable by the queries that used to find it. | Fixed-canary **Recall@K / NDCG@K downtrend** across cycles | `distinct_content_ratio` downtrend; memory count shrinking while mean `generation` rises; `mean_bigram_diversity` downtrend |
| **Churn** | The pipeline burns LLM budget rewriting/merging content with **no retrieval-visible effect**: accepted changes accumulate but canary answers and store shape don't move. | High accepted-change volume **AND flat canary AND flat entropy** over a window | consolidate/recombine `plannedCount` > 0 with unchanged cycle metrics |

### Operational definitions (exact, threshold-bearing)

Let a *cycle* be one improve run in which the consolidate pass processed ≥ 1 op **or**
the recombine pass evaluated ≥ 1 cluster. The detector snapshots one metrics row per
cycle (§5). Let `W` = `windowCycles` (default 5) and `hist` = the last `W` rows.

**COLLAPSE alert** fires when ANY of:

1. `meanCanaryRecall(current) ≤ median(meanCanaryRecall over hist) − recallDropThreshold`
   (default `recallDropThreshold = 0.15` absolute). Median-of-window, not
   previous-cycle, so a single noisy cycle can't fire or mask the alert.
2. `distinct_content_ratio` is monotonically non-increasing across all `W` rows AND
   `hist[0].distinct_content_ratio − current.distinct_content_ratio ≥ entropyDropThreshold`
   (default `0.05`).
3. `store_memory_count(current) < 0.8 × max(store_memory_count over hist)` AND
   `over_generation_count(current) > over_generation_count(hist[0])` — the store is
   shrinking *because of* re-merging, not deletion hygiene (over_generation_count =
   assets with frontmatter `generation > maxGeneration`).

**CHURN alert** fires when ALL of:

1. `Σ acceptedCount over hist ≥ churnMinAcceptedActions` (default 25 — from live data:
   ~471 accepts/3 days on the default profile means a genuinely idle store won't trip this,
   but a busy one accumulates it in ~1–2 days of cycles),
2. `|meanCanaryScore(current) − meanCanaryScore(hist[0])| < 0.02`, and
3. `|distinct_content_ratio(current) − distinct_content_ratio(hist[0])| < 0.02`.

i.e. real write volume, zero retrieval-visible or shape-visible movement. Churn is a
budget-waste advisory, never a candidate for blocking.

**MERGE-FLOOR violation** (per-merge, not windowed): a consolidate merge whose output
fails the information floor (§4). Counted per cycle; an advisory fires when
`merge_floor_violations > 0` in the current cycle.

Both alert evaluations are pure functions of the stored history rows — trivially unit
testable with hand-built rows (§8).

---

## 2. Canary query mechanism

### 2.1 Where the canary set lives

**Derived from the live stash, frozen in `state.db`** (table `canary_queries`, §5) —
NOT a checked-in file. Rejected alternative: a checked-in fixture like
`tests/fixtures/stashes/curate-golden` — a fixed corpus cannot measure the *live* stash,
and the live stash content differs per install, so the canary set must be minted from
what the store actually contains and then held fixed.

- **How many:** `canaryCount = 40` (config; owner-approved 30–50 range so per-type
  trend lines are computable). Stable mean at K=10; 40 FTS
  queries cost single-digit milliseconds total.
- **How chosen (deterministic, at first detector run):** rank all `memory`, `lesson`,
  and `knowledge` entries by `asset_salience.rank_score` (fallback: `utility_scores`
  EMA, fallback: entry_key order), take a type-stratified top slice (⅓ memory, ⅓
  lesson, ⅓ knowledge, backfilling from the global list when a type is short), and for
  each anchor asset build a query string from its **name tokens + top 3 tags + first
  heading line of the body** (all read from `entries.entry_json` / `search_text`). The
  expected relevant ref is the anchor asset itself.
- **How refreshed:** never automatically. `akm improve canary --refresh` (CLI, §6.3)
  deactivates the current set (`active = 0`, rows retained for history interpretation)
  and mints a new one; the detector records `canary_set_id` per cycle row so trend
  queries never compare across sets. Rejected alternative: auto-refresh when a canary's
  anchor is deleted — silent re-baselining is exactly how a slow collapse hides.

### 2.2 Merge-following (the false-positive killer)

A canary anchor being **legitimately merged** must not read as collapse. When scoring,
a canary counts as a hit if the top-K contains (a) the anchor ref itself, OR (b) any
entry whose frontmatter `source_refs` array contains the anchor ref (consolidate's
`injectGenerationFrontmatter` at `src/commands/improve/consolidate.ts:764-781` already
writes `source_refs` = all merge participants; recombine writes `source_refs` at
`recombine.ts:878`). One level of indirection only — if a merged asset is merged
*again* and provenance is dropped, the canary misses, and that is precisely the
information loss we want to detect. This makes the recall metric a *provenance-aware*
survival probe: "can the store still answer what this asset answered, and can it say
where the answer came from."

### 2.3 Retrieval path: FTS-only BM25 (decision + justification)

The canary runs **`runFtsQuery`-path BM25 search** against the live `index.db`
(`searchFts`, `src/indexer/db/db.ts:1309`; bm25 weights name 10 / description 5 /
tags 3 / hints 2 / content 1), via a thin exported wrapper (§6.1). No embeddings, no
LLM, no model download, byte-deterministic given the same index.

Rejected alternatives, in one sentence each:

- **Deterministic embedder (`AKM_EMBED_DETERMINISTIC=1`) against the live index** —
  wrong vector space: the live index's stored embeddings were produced by the real
  model, so a hash-embedded query would score garbage; the deterministic embedder is
  only valid when it embedded the *corpus* too (which is exactly how curate-golden uses
  it, and why the detector's CI test can still use it, §8.2).
- **Real embedder / full `akmCurate` hybrid path** — the local embedding model is
  deterministic in principle but heavyweight to load per cron cycle, version-drifts,
  and its failure modes (model missing, download blocked) would make the detector
  flaky; collapse is about whether canonical *content* survives and ranks, which BM25
  over name/tags/body measures directly.

What we give up: the canary won't see a *vector-only* ranking regression. That is the
curate-golden CI gate's job (frozen corpus, deterministic embedder, per-commit); the
detector's job is longitudinal *store* health, not ranker health. The two are
complementary and share their metric code (§2.4).

### 2.4 Metrics — reuse curate-golden's rank metrics (with a small move)

`scripts/akm-eval/src/curate-metrics.ts` already implements pure, IO-free
`ndcgAtK`, `recallAtK`, `mrr`, `scoreCurateCase`, `summarizeCurateMetrics`. The
detector must not duplicate them, and `src/` should not import from `scripts/`
(bundling + layering). **Move the module to `src/core/eval/rank-metrics.ts`** and make
`scripts/akm-eval/src/curate-metrics.ts` a one-line re-export so the bench, the CI
test, and the detector share one implementation. The module has no imports, so the move
is mechanical. Rejected alternative: copy the three functions into the detector —
that's the parallel-mechanism accretion this repo bans.

Per-canary the detector computes `recall@K`, `ndcg@K`, `rank of first hit` (K =
`collapseDetector.k`, default 10, binary relevance with the single anchor + its
merge-followers as the relevant set); per-cycle it stores the means and a compact
per-canary array (`[canaryId, rankOfHit|-1]` pairs — ints only, ≤ ~400 bytes for 40
canaries).

### 2.5 When it runs

Once per qualifying improve cycle, in the **post-loop stage after the recombine pass**
(`runImprovePostLoopStage`, `src/commands/improve/loop-stages.ts` — insert immediately
after the procedural block ends at ~line 833, before the return at ~line 835), gated
on: detector enabled AND (`consolidationRan === true` OR
`recombination.processed > 0`) AND not `options.dryRun`. Rationale for one hook rather
than one inside `akmConsolidate` and one inside `akmRecombine`: the post-loop point is
after `reindexWithIndexDbReleased`, so FTS sees the post-merge index, and one call site
covers both passes with the pass attribution recorded in the row (`pass` column takes
`"consolidate"`, `"recombine"`, or `"both"`). On non-qualifying runs (the ~93% of
default-profile runs that touch no merges) the detector does nothing — zero cost on the
20–30-min hot path.

---

## 3. Entropy / store-shape metrics

All computed from a single pass over `index.db` `entries` for
`entry_type IN ('memory','lesson','knowledge')` (columns: `entry_key`, `entry_type`,
`search_text`, `entry_json` — see `src/indexer/db/db.ts:247-257`). No filesystem reads.

| Metric | Definition | Source |
|---|---|---|
| `store_total`, `store_by_type_json` | Row counts, total and per type (also per-type for the remaining asset types, one `GROUP BY entry_type`) | `entries` |
| `distinct_content_ratio` | `COUNT(DISTINCT normHash(search_text)) / COUNT(*)` over the three learning types. `normHash` = FNV-1a-64 of lowercased, whitespace-collapsed `search_text`. 1.0 = all distinct; downtrend = convergence. | `entries.search_text` (no JSON parse) |
| `mean_bigram_diversity` | Mean of `computeBigramDiversity(search_text)` (**reuse** `src/commands/improve/homeostatic.ts:305`) over a deterministic sample: sort by `entry_key`, take every ⌈N/2000⌉-th row, cap 2,000. | `entries.search_text` |
| `over_generation_count` | Count of entries whose `entry_json` frontmatter carries `generation > maxGeneration` (parse `generation` from `entry_json` with a cheap `LIKE '%"generation"%'` SQL pre-filter so only the few merged assets get JSON.parsed). | `entries.entry_json` |
| `accepted_actions` | This run's `acceptedCount` from the already-computed `computeImproveRunMetrics` result (threaded in, not re-derived). | improve run in flight |
| `merge_floor_violations` | Count from §4, threaded from the consolidate pass result. | consolidate result |

**Cost analysis at 5–10k assets** (the stated ceiling): one indexed `SELECT` of
~10k rows ≈ 10–30 ms in bun:sqlite; FNV-64 over ~1–2 KB × 10k ≈ 20–40 ms; bigram
diversity over the 2,000-row sample ≈ 30–60 ms; 40 FTS queries ≈ 10–40 ms. **Total
< 250 ms and zero LLM/model cost**, on a pass (consolidate/recombine) that already
spends minutes in LLM calls. Memory: `search_text` strings are streamed row-by-row
(prepare/iterate), never all materialized — peak overhead is the 2,000-row sample.

---

## 4. Merge-information floor

The analysis asks for two things: (a) a hard floor on re-generalization count, (b) a
requirement that merges strictly increase information, not just shorten.

### 4.1 (a) The hard re-merge floor already exists — turn it on

`checkGenerationGuard` (`src/commands/improve/homeostatic.ts:282`) already refuses a
merge when ≥ 2 participants exceed `maxGeneration` (default 2), and
`computeMergedGeneration`/`readAssetGeneration` maintain the frontmatter `generation`
counter through `injectGenerationFrontmatter` (`consolidate.ts:777`, wired at
`consolidate.ts:1941-1998`). It is gated on
`processes.consolidate.antiCollapse.enabled`, **default OFF**.

**Change: flip the anti-collapse guard suite to default-ON (opt out via
`antiCollapse: { enabled: false }`).** Concretely, the three call-site gates change
from `config.enabled` truthy-checks to `config.enabled !== false`:
`checkGenerationGuard` (`homeostatic.ts:286`), `checkLexicalDiversity`
(`homeostatic.ts:334`), and the random-cluster injection gate
(`consolidate.ts:1271`). This matches this branch's precedent (distill quality judge
and extract schema-similarity gate both flipped to default-ON, fail-open) and is
narrow: the generation guard only refuses the pathological case of merging two
*already-twice-merged* assets. Rejected alternative: a new separate re-merge counter —
`generation` IS that counter; adding another would be the parallel-mechanism
malfunction.

### 4.2 (b) Information floor — new deterministic check beside the generation guard

New pure function in `homeostatic.ts` (colocated with the other anti-collapse guards):

```ts
export interface MergeInformationFloorResult {
  passed: boolean;
  /** Provenance: |union(source_refs ∪ participants)| after vs. before. */
  provenanceBefore: number;
  provenanceAfter: number;
  /** Specificity proxy: distinct-token retention of merged body vs. union of sources. */
  specificityRetention: number; // 0..1
  reason?: string;
}

/**
 * A merge must strictly increase information:
 *  1. Provenance: the merged asset's source_refs must be a superset of the union of
 *     all participants' source_refs plus the participant refs themselves
 *     (provenance never shrinks through a merge).
 *  2. Specificity: distinctTokens(mergedBody) >= minSpecificityRetention *
 *     distinctTokens(concat(participant bodies)) — a merge that only shortens/
 *     genericizes fails. Tokenization = the same lowercase whitespace split
 *     computeBigramDiversity uses. Default minSpecificityRetention = 0.6.
 */
export function checkMergeInformationFloor(
  mergedBody: string,
  mergedSourceRefs: string[],
  participants: Array<{ ref: string; body: string; sourceRefs: string[] }>,
  config: AntiCollapseConfig,
): MergeInformationFloorResult;
```

Enforcement point: `consolidate.ts` merge branch, immediately after the generation
guard block (~line 1998, after `injectGenerationFrontmatter`) where `mergedContent`
and all participant bodies are in hand. Provenance is *made* to pass mechanically:
`injectGenerationFrontmatter` is extended to write `source_refs` as the **union** of
participants + their existing `source_refs` (today it only sets it when absent —
`consolidate.ts:779-781` — which drops second-generation provenance; that is a bug
this fixes). Specificity is measured, and in v1 a failure **does not block the merge**:
it increments `merge_floor_violations`, pushes a warning, and emits the per-cycle
advisory (§7). The documented promotion path (§9) turns it into a refusal
(`skipReason: "merge_information_floor"`, mirroring `merge_generation_guard` at
`consolidate.ts:1966`) once live data confirms the 0.6 threshold's false-positive rate.
Rejected alternative: blocking from day one — a wrong threshold silently freezing
consolidation is worse than a wrong threshold generating advisories.

Config: two keys added to the existing `antiCollapse` object (§6.2). No new config
surface.

---

## 5. Storage schema

### 5.1 Why not events alone

The events log is capped at **90-day retention** (`purgeOldEvents`,
`src/core/state-db.ts:396-411`) and stores metadata as JSON blobs. Collapse is a
*slow* failure — the field's measured case took ~10 merge passes, and AKM's
consolidate/recombine cycles are days-to-weeks apart in practice (`consolidate` 4 runs
and `recombine-only` 1 run in a recent 7-day window) — so a meaningful trend window
exceeds 90 days, and trend queries need indexed numeric columns, not
`json_extract` over a 100k-row event table. **Decision: cycle history in its own
table (365-day retention); alerts (rare, actionable) additionally go to the events
log** so they surface through the existing `readEvents`-based health plumbing exactly
like `outcome_proxy_inverted` does. Rejected alternative: rows in
`improve_runs.metrics_json` — that JSON is per-run not per-cycle, is the exact blob
that already bloated to 3.95 GB, and is slated for retention-nulling (R9).

### 5.2 Migration 016 (append-only; 015 verified current tail of `MIGRATIONS` in `src/core/state/migrations.ts`)

```sql
-- ── Migration 016 — collapse/churn detector (R5) ─────────────────────────────
CREATE TABLE IF NOT EXISTS canary_queries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  canary_set_id TEXT    NOT NULL,          -- mint token; all rows of one set share it
  anchor_ref    TEXT    NOT NULL,          -- e.g. 'memory:alpha'
  query         TEXT    NOT NULL,          -- deterministic FTS query string
  source        TEXT    NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canary_queries_active
  ON canary_queries(active, canary_set_id);

CREATE TABLE IF NOT EXISTS improve_cycle_metrics (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                  TEXT    NOT NULL,  -- improve_runs.id of the cycle
  ts                      TEXT    NOT NULL,  -- ISO-8601 UTC
  pass                    TEXT    NOT NULL,  -- 'consolidate' | 'recombine' | 'both'
  canary_set_id           TEXT    NOT NULL,
  mean_recall             REAL    NOT NULL,
  mean_ndcg               REAL    NOT NULL,
  mean_mrr                REAL    NOT NULL,
  canary_ranks_json       TEXT    NOT NULL,  -- [[canaryId, rankOfHit|-1], ...] ≤ ~200B
  store_total             INTEGER NOT NULL,
  store_by_type_json      TEXT    NOT NULL,  -- {"memory":n,"lesson":n,...} ≤ ~200B
  distinct_content_ratio  REAL    NOT NULL,
  mean_bigram_diversity   REAL    NOT NULL,
  over_generation_count   INTEGER NOT NULL,
  accepted_actions        INTEGER NOT NULL,
  merge_floor_violations  INTEGER NOT NULL DEFAULT 0,
  alerts_json             TEXT    NOT NULL DEFAULT '[]'  -- fired alert kinds, ≤ ~100B
);
CREATE INDEX IF NOT EXISTS idx_improve_cycle_metrics_ts
  ON improve_cycle_metrics(ts);
```

### 5.3 Footprint & retention

Every column is a scalar or a size-capped JSON array; a row is **< 2 KB by
construction** (the only variable-size fields are the three small JSON columns, each
bounded by `canaryCount`/type-count). At the realistic maximum of ~10 qualifying
cycles/day, one year of history is < 7 MB. Retention: `purgeOldCycleMetrics(db,
retentionDays = 365)` — same shape as `purgeOldEvents` — called from the same
maintenance point that already runs `purgeOldEvents` in
`runImproveMaintenancePasses`, emitting the purge count into the existing
`events_purged`-style observability (new metadata key, no new event type needed).
`canary_queries` rows are never purged (tens of rows, needed to interpret history).

---

## 6. Wiring points

### 6.1 New module: `src/commands/improve/collapse-detector.ts` (~250 LOC)

```ts
export interface CollapseDetectorConfig {
  enabled?: boolean;            // default true
  canaryCount?: number;         // default 40 (owner-approved 30–50 range)
  k?: number;                   // default 10
  windowCycles?: number;        // default 5
  recallDropThreshold?: number; // default 0.15
  entropyDropThreshold?: number;// default 0.05
  churnMinAcceptedActions?: number; // default 25
  retentionDays?: number;       // default 365
}

export interface CycleMetrics { /* mirrors improve_cycle_metrics columns */ }
export type CollapseAlertKind = "collapse-recall" | "collapse-entropy"
  | "collapse-shrink" | "churn" | "merge-floor";
export interface CollapseAlert { kind: CollapseAlertKind; detail: string;
  metrics: Record<string, number>; }

/** Mint (or return) the active canary set. Deterministic given the index +
 *  salience tables. Called lazily by runCollapseDetector on first use. */
export function ensureCanarySet(stateDb: Database, indexDb: IndexDatabase,
  cfg: CollapseDetectorConfig): { canarySetId: string;
  canaries: Array<{ id: number; anchorRef: string; query: string }> };

/** Compute one cycle's metrics. FTS + entries scan only; no LLM, no model. */
export function computeCycleMetrics(stateDb: Database, indexDb: IndexDatabase,
  args: { runId: string; pass: "consolidate" | "recombine" | "both";
    acceptedActions: number; mergeFloorViolations: number;
    cfg: CollapseDetectorConfig }): CycleMetrics;

/** PURE. Evaluate §1's alert definitions over stored history. */
export function evaluateCollapseAlerts(history: CycleMetrics[],
  current: CycleMetrics, cfg: CollapseDetectorConfig): CollapseAlert[];

/** Orchestrator: ensure canaries → compute → evaluate → persist row →
 *  appendEvent per alert. Fail-open: catches, warns, returns undefined. */
export function runCollapseDetector(args: { stateDbPath?: string;
  indexDbPath?: string; runId: string; pass: "consolidate"|"recombine"|"both";
  acceptedActions: number; mergeFloorViolations: number;
  config: AkmConfig; eventsCtx?: EventsContext }): CycleMetrics | undefined;
```

Canary retrieval goes through `searchFts` (`src/indexer/db/db.ts:1309`); rank metrics
import from the relocated `src/core/eval/rank-metrics.ts` (§2.4); bigram diversity
imports `computeBigramDiversity` from `./homeostatic`.

### 6.2 Hook + config + existing-file edits

| File | Change |
|---|---|
| `src/commands/improve/loop-stages.ts` (~line 833, end of `runImprovePostLoopStage` after the procedural block) | Call `runCollapseDetector(...)` when enabled AND (`consolidationRan` OR `recombination?.processed > 0`) AND `!options.dryRun`. Thread `consolidationRan` (already a param of `runImproveMaintenancePasses`) and the run's accepted/merge-floor counts. Attach the returned `CycleMetrics` to the post-loop result so it lands in `result_json` for free. |
| `src/core/config/config-schema.ts` (`ImproveConfigSchema`, ~line 673-681) | Add `collapseDetector: z.object({ enabled, canaryCount, k, windowCycles, recallDropThreshold, entropyDropThreshold, churnMinAcceptedActions, retentionDays }).passthrough().optional()` with the bounds above (all `.optional()`, numeric mins/maxes mirroring §6.1 defaults). Add `mergeInformationFloor: z.boolean().optional()` and `minSpecificityRetention: z.number().min(0).max(1).optional()` to the existing `antiCollapse` object (~line 312). |
| `src/core/config/config-types.ts` (`ImproveConfig`, ~line 387 region) | Mirror the two shapes with doc comments (keep the schema↔type pair in sync — this repo's config audit flagged two-source-of-truth drift as the root rot; add both sides in one commit). |
| `src/core/state/migrations.ts` (append after 015) | Migration `016-collapse-churn-detector` (§5.2 DDL, verbatim). |
| `src/core/state-db.ts` | `insertCycleMetrics`, `queryRecentCycleMetrics(db, canarySetId, limit)`, `purgeOldCycleMetrics(db, retentionDays)` + canary CRUD (`insertCanaries`, `getActiveCanaries`, `deactivateCanarySet`) — same style as the recombine-hypotheses helpers at :1415-1675. |
| `src/commands/improve/homeostatic.ts` | `checkMergeInformationFloor` (§4.2); flip the three `!config.enabled` gates to `config.enabled === false` (default-on). |
| `src/commands/improve/consolidate.ts` (~line 1998) | Call the floor check after `injectGenerationFrontmatter`; extend `injectGenerationFrontmatter` (:764) to union `source_refs` instead of set-if-absent; count violations into the pass result. |
| `src/core/events.ts` (`EventType` union, ~line 140 region) | Add `"collapse_detector_alert"` with a doc comment (metadata: `{kind, detail, metrics, canarySetId, runId}`). |
| `src/commands/health.ts` (~line 2222, beside the `outcome_proxy_inverted` advisory) | Advisory `"collapse-churn-detector"`: read `collapse_detector_alert` events in the health window plus the latest `improve_cycle_metrics` row; `warn` on any alert, `pass` with the latest mean recall / entropy in the message otherwise, `unknown` when no cycle row exists yet. |
| `src/core/eval/rank-metrics.ts` (new, moved) + `scripts/akm-eval/src/curate-metrics.ts` (becomes re-export) | §2.4. |
| `src/commands/improve/improve-cli.ts` | `akm improve canary` subcommand: default = print active set + last `windowCycles` rows (table); `--refresh` mints a new set; `--json` for scripting. Rejected alternative: a new top-level `akm collapse` command — this is improve-internal observability and the health advisory is the primary surface. |

### 6.3 Default-on vs opt-in: **default-ON**, justified

The branch precedent is explicit: quality gates that are deterministic, cheap, and
fail-open ship default-ON with a config opt-out (distill `qualityGate`, extract
`schemaSimilarity`, outcome weights). The detector is strictly *observational* in v1
(never blocks anything), costs < 250 ms only on merge-active cycles, uses no
LLM/model, and fails open. An opt-in longitudinal detector is a contradiction — the
operator who remembered to enable it is the one who didn't need it. Opt-out:
`improve.collapseDetector.enabled: false`.

---

## 7. Alert semantics

- **Per qualifying cycle, always:** one `improve_cycle_metrics` row. No event (avoid
  event-volume creep; history lives in the table).
- **On any alert (rare):** one `collapse_detector_alert` event per fired kind
  (`appendEvent`, best-effort, same pattern as `outcome_proxy_inverted` at
  `preparation.ts:1575-1594`), and the kinds recorded in the row's `alerts_json`.
- **Health surface:** the `akm health` advisory (§6.2) — `warn` status, `kind:
  "deterministic"`, `confidence: "high"` for collapse kinds (they're measured, not
  inferred), `confidence: "medium"` for churn (volume thresholds are tunable). The
  message includes the concrete numbers (current vs. window-median recall, entropy
  delta, accepted-action count) so the operator can act without opening the DB.
- **Blocking: NO in v1.** The detector observes; it never vetoes a consolidation pass.
  Recommendation is observe-first with this documented promotion path: (1) v1 ships
  observe-only; (2) after ≥ 30 days of live rows and threshold tuning (§9), an opt-in
  `improve.collapseDetector.blockOnCollapse: true` makes `runConsolidationPass` skip
  the merge phase (not the whole pass — dedup/archival still run) for a run whose
  *previous* cycle fired a collapse-kind alert, fail-open on any detector error, and
  emits a `consolidation_blocked` note into warnings; (3) the merge-information floor
  independently promotes from advisory to per-merge refusal (§4.2). Blocking on the
  previous cycle (not live re-evaluation) keeps the merge path free of detector
  latency and makes the block deterministic from persisted state.

---

## 8. Test plan

All tests use `tests/_helpers/sandbox` `withIsolatedAkmStorage` (per
`tests/curate-golden-eval.test.ts:54-76`); no raw `process.env` mutation
(`scripts/lint-tests-isolation.ts` enforces this). No test touches a live DB. All new
tests are CI-fast unit tests under `tests/` (no `Bun.spawn`/`Bun.serve`/60s timeouts —
the unit-vs-integration boundary rule).

1. **`tests/commands/improve/collapse-detector.test.ts` — deterministic collapse
   simulation (the headline test).** Seed an isolated stash with 30 distinct
   memories (distinct topics, distinct vocabularies), `akmIndex` it (FTS only — the
   detector path needs no embeddings; set `semanticSearchMode: "off"` in the sandbox
   config), mint the canary set, snapshot cycle 0. Then simulate merge passes
   directly on the stash files: each pass replaces groups of 3 memories with one
   generic merged body (progressively blander shared phrasing, `source_refs` written
   for pass 1 then deliberately dropped for pass 2+ to model provenance loss),
   reindex, run `computeCycleMetrics` + `evaluateCollapseAlerts`. Assert:
   `distinct_content_ratio` and `mean_bigram_diversity` decrease monotonically; mean
   recall survives pass 1 (merge-following via `source_refs`) and drops afterward; a
   `collapse-recall` or `collapse-entropy` alert fires by pass ≤ 4; the
   `collapse_detector_alert` event is written.
2. **Churn simulation** (same file): paraphrase bodies without merging (store shape
   and canary hits stable), feed `acceptedActions` ≥ threshold per cycle for `W`
   cycles, assert exactly a `churn` alert and no collapse alert.
3. **`evaluateCollapseAlerts` pure-function table tests:** hand-built history rows for
   each §1 clause boundary (just-below/just-above each threshold; median-window
   robustness against a single-cycle recall spike; window shorter than `W` never
   alerts).
4. **Merge-information floor unit tests** (extend `tests/commands/improve/homeostatic.test.ts`):
   provenance-union enforcement, specificity retention at the 0.6 boundary, shortening
   merge fails, genuinely-additive merge passes; plus the default-on flip
   (`enabled` absent ⇒ guards active; `enabled: false` ⇒ inert — byte-identical to the
   old default for opted-out configs).
5. **`tests/state-db/improve-cycle-metrics.test.ts`:** migration 016 applies on a
   fresh and an existing DB; insert/query round-trip; `purgeOldCycleMetrics` deletes
   only rows past retention and returns the count; canary set mint / deactivate /
   re-mint preserves history rows with the old `canary_set_id`.
6. **Curate-golden reuse guard:** the metrics move in §2.4 keeps
   `tests/curate-golden-eval.test.ts` green unchanged (it imports through the
   re-export) — that existing test IS the regression guard for the shared module; add
   one assertion in the detector test importing `ndcgAtK` from
   `src/core/eval/rank-metrics.ts` to pin the canonical path. Additionally, one
   detector test seeds the *curate-golden fixture corpus* with
   `AKM_EMBED_DETERMINISTIC: "1"` (exactly as `withSeededGolden` does), mints canaries
   against it, and asserts cycle-0 mean recall ≥ 0.9 — proving the canary mechanism
   itself finds well-formed content on a known-good corpus.
7. **Wiring test** (extend `tests/commands/improve/improve-multi-cycle.test.ts`
   pattern): an improve run with a stubbed consolidate that reports work writes
   exactly one cycle row; a run with no consolidate/recombine work writes none;
   `dryRun` writes none; a detector that throws (inject a bad `indexDbPath`) leaves
   the improve run green with a warning (fail-open).

---

## 9. Rollout plan

- **Phase 0 — land observe-only (this design, one PR).** Default-on detector +
  default-on generation guard + advisory-only information floor. Gate: full
  `bun run check` green (custom lints included), zero new warnings.
- **Phase 1 — accumulate & tune (2–4 weeks of live cron).** Watch, read-only:
  ```sql
  SELECT ts, pass, mean_recall, distinct_content_ratio, mean_bigram_diversity,
         over_generation_count, accepted_actions, merge_floor_violations, alerts_json
  FROM improve_cycle_metrics ORDER BY ts DESC LIMIT 30;
  SELECT ts, json_extract(metadata,'$.kind') FROM events
  WHERE event_type='collapse_detector_alert' ORDER BY ts DESC LIMIT 20;
  ```
  Tune `recallDropThreshold` / `entropyDropThreshold` / `churnMinAcceptedActions`
  against observed variance (the live synthesis lanes are currently near-idle, so
  early rows will be sparse — that sparsity is itself the §6.3 "synthesis lanes idle"
  signal made durable). Success criterion for the thresholds: zero false alerts on a
  healthy store over the window, and the simulated-collapse test values sitting well
  inside the alert region.
- **Phase 2 — optional enforcement (separate PR, owner sign-off).**
  `blockOnCollapse` opt-in (§7) and information-floor refusal (§4.2), each promoted
  independently and only if Phase 1 shows clean precision.

**Non-goals (explicit):** no LLM-judged merge quality (deterministic-only is a design
invariant here); no embedding-drift tracking of the live vector space (curate-golden
owns ranker quality); no automatic canary refresh; no changes to user-facing
search/curate ranking; no retention change to `improve_runs.result_json` (that is R9,
separately owned and sign-off-gated); no resurrection of the deleted homeostatic
demotion pass.

---

## 10. Estimated diff size & file-by-file change list

| File | Change | Est. LOC |
|---|---|---|
| `src/commands/improve/collapse-detector.ts` | new module (§6.1) | +250 |
| `src/core/eval/rank-metrics.ts` | moved from `scripts/akm-eval/src/curate-metrics.ts` (net zero; new home) | +200 / −0 |
| `scripts/akm-eval/src/curate-metrics.ts` | body replaced by re-export | −195 |
| `src/core/state/migrations.ts` | migration 016 | +60 |
| `src/core/state-db.ts` | cycle-metrics + canary CRUD, purge | +90 |
| `src/commands/improve/homeostatic.ts` | `checkMergeInformationFloor`; default-on flips | +70 |
| `src/commands/improve/consolidate.ts` | floor call site; `source_refs` union fix | +30 |
| `src/commands/improve/loop-stages.ts` | post-loop hook | +25 |
| `src/core/config/config-schema.ts` | `collapseDetector` + 2 `antiCollapse` keys | +30 |
| `src/core/config/config-types.ts` | mirrored types | +30 |
| `src/core/events.ts` | 1 event type + comment | +8 |
| `src/commands/health.ts` | advisory | +30 |
| `src/commands/improve/improve-cli.ts` | `canary` subcommand | +40 |
| `tests/commands/improve/collapse-detector.test.ts` | simulations + pure tests (§8.1-3, 6-7) | +350 |
| `tests/commands/improve/homeostatic.test.ts` | floor + default-flip tests | +80 |
| `tests/state-db/improve-cycle-metrics.test.ts` | schema/CRUD/purge | +90 |

**Total: ~+1,290 / −195 (net ~+1,100 incl. ~520 test LOC; production code ~+660).**
For calibration: the moved metrics module and the simulation tests are the two biggest
blocks; the runtime footprint added to the improve hot path is one gated function call.

## Owner decisions (resolved 2026-07-02)

All three open questions were put to the owner and approved:

1. **Anti-collapse guard suite flips to default-ON (§4.1)** — approved. The
   generation guard may newly refuse the narrow two-participants-both-gen>2 merge
   case; acceptable as a live-pipeline behavior change.
2. **365-day retention for `improve_cycle_metrics` (§5.3)** — confirmed (< 7 MB/yr
   worst case; the slow-failure detection window outweighs the bloat concern).
3. **Canary count: 30–50 with per-type trend lines** — approved. Size the canary set
   toward the top of the range (type-stratified across memory/lesson/knowledge so
   per-type collapse divergence is visible); cost stays negligible.
