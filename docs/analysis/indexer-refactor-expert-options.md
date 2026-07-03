# Indexer Refactor Review (Expert Options)

Date: 2026-07-03

Scope reviewed (callers + indexer paths):
- `src/indexer/indexer.ts`
- `src/indexer/ensure-index.ts`
- `src/indexer/index-written-assets.ts`
- `src/indexer/index-writer-lock.ts`
- `src/indexer/walk/walker.ts`
- `src/indexer/passes/*`, `src/indexer/db/*`, `src/indexer/graph/*`
- `src/indexer/search/db-search.ts`
- callers in `src/commands/read/show.ts`, `src/commands/read/search.ts`,
  `src/commands/improve/improve.ts`, `src/commands/sources/*.ts`, `src/commands/wiki-cli.ts`,
  `src/commands/workflow-cli.ts`

## Why this review was needed

The current pipeline is already better than earlier versions (bounded lock wait,
cleaner write-path behavior, reduced recursion risk), but it remains tightly coupled:
- orchestration and persistence responsibilities are concentrated in `indexer.ts`
- read bootstrap, explicit full/indexed writes, and improve maintenance are
  coordinated in separate call sites
- write/read/maintenance paths share many mutable concerns (lock ownership,
  run policy, staleness semantics, DB transaction scope)

The team reviewed this for clean architecture, testability, and data/process
separation opportunities.

## Validity review summary

These options are valid only if they preserve the existing AKM architectural
constraints:
- the indexer remains the reader of source directories (`v1-architecture-spec.md`)
- sources/providers do not gain search/show responsibilities
- the search-facing index remains rebuildable/ephemeral
- read bootstrap semantics in `ensureIndex(...)` remain unchanged unless
  intentionally and explicitly revised

One correction from validation:
- graph extraction is **not** currently part of the main `akmIndex()` phase
  sequence. It runs from improve-maintenance/manual graph paths today. Any plan
  that folds graph into the main indexing lifecycle is a deliberate behavior
  change, not just an internal refactor.

## Top 3 solutions

### 1) **Index Runner Domain Service with explicit plans** *(Recommended)*

#### Design
- Introduce `src/indexer/service/index-runner.ts` (or `.../index-service.ts`) as a thin
  orchestration façade.
- Keep existing `ensureIndex(...)` and `akmIndex(...)` APIs, but route all
  pathways through a shared `IndexPlan` abstraction:
  - `ReadBootstrapPlan`: no stale rebuild on read, only bootstraps when unreadable
  - `IndexedFullRebuildPlan`: explicit full passes with deterministic phase ordering
  - `IncrementalRebuildPlan`: stale-skip policy + dir-state reconciliation
  - `WriteUpsertPlan`: single-asset upserts delegated from `indexWrittenAssets`
- Extract pass interfaces with narrow inputs/outputs:
  - `WalkPlanner`, `LlmEnrichmentPass`, `EmbeddingPass`, `FtsPass`, `VerifyPass`
  - each writes through typed repository contracts instead of calling DB helpers
    directly.
- Add `IndexRunContext` factory + immutable event collector for phase timings/results
  (`IndexProgressEvent` becomes test fixture friendly).

#### Why this is strongest
- The heaviest code is still in the same place initially; no major behavior shift.
- Greatly improves testability: each phase can be unit-tested with in-memory repositories.
- Preserves legacy read contract and command output contract while making future
  migrations tractable.

#### TL;DR pros
- Lowest blast radius for a real architecture improvement.
- Aligns with clean architecture (ports/adapters) without changing runtime semantics.
- Makes correctness regressions much easier to test in isolation.
- Enables future phase-level opt-in/out by caller.

#### TL;DR cons
- Requires moving and renaming several helper modules first.
- Initial churn in typing/tests due to larger seams.
- Not a pure “delete-only” pass; behavior must be carefully parity-checked against
  legacy logs/timings.

---

### 2) **Separate write-path indexing from maintenance indexing via run ledger and deferred heavy passes** *(Pragmatic performance path)*

#### Design
- Keep `indexWrittenAssets(...)` as the immediate write path, but add an explicit
  `index_runs`/`index_run_steps` ledger (in the same DB initially).
- `runMaintainIndexPlan` becomes explicit and resumable:
  - `walk -> llm -> embeddings -> fts -> verify`
  - graph remains a separate maintenance/manual plan unless AKM intentionally
    changes that contract
  - heavy phases (LLM/embedding/graph) can be re-queued with bounded retries
    instead of being implicitly coupled to every command path.
- Introduce event-driven scheduling hook in `improve` maintenance path and a light
  CLI/API trigger to start deferred maintenance.
- Keep DB path unchanged for now; move to sibling DB files only if lock contention
  or write amplification remains high after baseline measurements.

#### Why this is strong
- Preserves fast writes while making eventual consistency explicit instead of implicit.
- Lets `search/show` continue to serve stale-but-indexable data, while background
  maintenance catches up with richer passes.
- Good stepping stone before heavier process split; easy rollback by disabling queue
  drain only for heavy stages.

#### TL;DR pros
- Highest immediate ROI for operational resilience (fewer long write-side surprises).
- Introduces observability and resumability (`run ledger`) with moderate code churn.
- Compatible with current command calls and contracts.

#### TL;DR cons
- Behavioral model shifts from “monolithic one-shot run” to “queued maintenance plan.”
- Requires careful docs/UX for users if they expect embedding/graph updates
  immediately after mutation.
- Needs policy around stale warning thresholds and stale-file cleanup cadence.
- The run ledger must stay ephemeral/rebuildable or be clearly separated from
  durable state; otherwise it fights the existing `index.db` contract.

---

### 3) **Split process and data planes for heavy domains (Graph + LLM + Embedding workers)** *(Longer-term architecture path)*

#### Design
- Keep read-facing search/index DB for hot paths (`entries`, `entries_fts`).
- Move expensive asynchronous domains behind bounded worker executors:
  - Graph extraction worker + domain table store (`graph_nodes`, `graph_edges`,
    `graph_file_entities`) in a dedicated SQLite DB file or separate attached db.
  - Embedding generation worker can remain local-threaded but isolated through a
    stable queue contract.
- Add cross-domain synchronization contract in `index-run` metadata: pass result,
  version, completion state, last-success timestamp.
- `show/search/read` read graph/embedding-annotated payloads via optional joins,
  with fallback if worker domains are stale.

#### Why this is strong
- Best scale path if indexing dominates runtime or LLM calls are unstable.
- Reduces lock pressure on the central index DB and avoids interleaving long
  writer runs with search-read telemetry.
- Supports future migration to externalized services without changing CLI/API.

#### TL;DR pros
- Strong isolation of heavy compute.
- Better failure isolation: one worker can fail/restart without blocking all phases.
- Clear path to incremental processing and distributed scheduling later.

#### TL;DR cons
- Highest implementation complexity.
- Significant compatibility/rollback surface: multiple write locations and sync
  points.
- Risk of cross-domain drift unless each run has strict versioning and
  reconciliation logic.
- Not justified yet without measured evidence that Option 1/2 cannot solve the
  real bottlenecks.

## Recommendation from debate

All experts converged on **Option 1 first** because it is the best balance of
architectural clarity and low risk. Option 2 is a very good follow-up if lock time,
queue pressure, or maintenance latency is still painful after phase extraction.

Option 3 is suitable when AKM needs scale/availability improvements beyond what
in-process refactors can deliver.

## Suggested migration order
1. Add domain service + pass interfaces (Option 1), keep existing DB layout.
2. Add minimal run ledger + resumable maintenance path (Option 2).
3. Re-evaluate contention and correctness with measurements before splitting DBs/
   processes (Option 3).

## Refactor plan

The detailed implementation plan also lives in:
- `docs/analysis/indexer-vertical-slice-refactor-plan.md`

The recommended execution plan is to refactor into reusable vertical slices and
compose them into a small set of top-level processes.

### Target slices

- Source Sync Slice
  - materialize provider caches and resolve source entries
- Walk Slice
  - enumerate files and directory groups with shared skip policy
- Metadata Slice
  - derive canonical `StashEntry` values and merge compatibility overrides
- Index State Slice
  - own incremental staleness/fingerprint decisions and `index_dir_state`
- Entries Slice
  - persist entries and workflow side-table rows
- Enrichment Slice
  - own LLM metadata enrichment and its cache
- Embeddings Slice
  - own embedding generation/storage policy
- FTS Slice
  - own full vs incremental FTS refresh
- Verification Slice
  - own post-index verification/status result assembly
- Semantic Status Slice
  - own `semantic-status.json` updates
- Search Maintenance Slice
  - own usage-event relinking and utility-score recomputation
- Wiki Maintenance Slice
  - own wiki index regeneration

### Top-level composed processes

- `run-index`
  - explicit full/incremental index build
- `ensure-read-index`
  - read bootstrap only when the existing index cannot serve the stash
- `upsert-written-assets`
  - fast fail-open write-path index visibility
- `run-index-maintenance`
  - optional maintenance-only composition for scheduled/operator flows
- improve-owned maintenance processes
  - memory inference
  - graph extraction
  - staleness detection
  - optional future metadata-enrichment catch-up

### Ownership decisions

- Keep metadata enrichment in the main index process.
- Make enrichment reusable so improve can optionally run catch-up enrichment later.
- Keep graph extraction separate from the main `akmIndex()` contract for now.
- Move wiki and search-maintenance side effects out of `indexer.ts` into their
  owning domains.

### Recommended implementation order

1. Extract orchestration seams without behavior change:
   - `run-index`
   - `ensure-read-index`
   - `upsert-written-assets`
2. Extract core slices first:
   - Walk
   - Index State
   - Entries
   - Metadata
   - FTS
3. Extract LLM/semantic slices:
   - Enrichment
   - Embeddings
   - Verification
   - Semantic Status
4. Move adjacent side effects out of indexer:
   - Search Maintenance
   - Wiki Maintenance
5. Add optional shared maintenance compositions:
   - `run-index-maintenance`
   - optional improve-side enrichment catch-up

### Testing plan

- Unit tests per slice
  - walk, staleness, metadata merge, enrichment cache/budget, entry persistence,
    FTS mode selection
- Contract tests per process
  - read bootstrap semantics
  - full vs incremental index behavior
  - fail-open write-path indexing
  - improve maintenance ordering around post-write reindex needs
- Integration tests
  - source add -> index -> search/show
  - write path -> targeted upsert -> search visibility
  - improve maintenance -> memory inference -> reindex -> graph extraction

## Minimal acceptance criteria
- No semantic change to read bootstrap contract in `ensureIndex(...)` and search/show behavior.
- Existing lock semantics remain preserved (`index-writer-lock.ts` wait/try behavior + timeout).
- All existing index tests continue to pass, plus new unit tests for:
  - plan creation and phase ordering
  - stale/read contract in `ensure-index.ts`
  - write-path queue interactions and run-ledger transitions
