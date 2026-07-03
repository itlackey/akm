# Indexer Vertical Slice Refactor Plan

Date: 2026-07-03

## Goal

Refactor indexing and related maintenance flows into clean vertical slices that:
- have one clear responsibility each
- can be reused from multiple higher-level processes
- are composable into larger workflows without hidden coupling
- are easy to unit test and integration test
- preserve current AKM contracts unless explicitly called out

## Non-negotiable constraints

These constraints come from the current code and architecture docs and should not
change during this refactor:

- The indexer remains the reader of source directories.
- Providers do not gain `search` or `show` behavior.
- `index.db` remains rebuildable/ephemeral.
- `ensureIndex(...)` keeps its current read-bootstrap semantics.
- `indexWrittenAssets(...)` remains a fast, fail-open write path.
- Graph extraction remains separate from the main `akmIndex()` pipeline unless
  explicitly promoted as a product-level behavior change.

## Current problems

- `src/indexer/indexer.ts` still mixes planning, orchestration, persistence,
  progress, policy, and adjacent-domain side effects.
- `ensureIndex(...)`, `akmIndex(...)`, `indexWrittenAssets(...)`, improve
  maintenance, and manual graph refresh all coordinate related behavior through
  separate paths.
- Several concerns that are not truly “index building” are piggybacking on the
  index run:
  - wiki index regeneration
  - usage-event relinking
  - utility-score recomputation
  - stale cache cleanup
- LLM-driven processes exist in two mental models today:
  - index-time metadata enrichment
  - improve-time maintenance passes
- Test seams are still too coarse. Many behaviors can only be validated through
  broad integration tests instead of focused unit-level tests.

## Target architecture

Use plain function-based vertical slices with thin ports, not a framework.

Each slice should have:
- one public entry point
- one small context object
- explicit input/output types
- no hidden singleton state beyond existing config/runtime boundaries
- its own tests

Recommended shape:

```text
src/indexer/
  processes/
    run-index.ts
    ensure-read-index.ts
    upsert-written-assets.ts
    run-index-maintenance.ts
  slices/
    source-sync/
    walk/
    metadata/
    entries/
    enrichment/
    embeddings/
    fts/
    verification/
    semantic-status/
    index-state/
  coordination/
    index-run-plan.ts
    index-run-lock.ts
    process-types.ts

src/commands/improve/processes/
  run-memory-inference.ts
  run-graph-extraction.ts
  run-staleness-detection.ts
  run-metadata-enrichment-catchup.ts   # optional later

src/search-maintenance/
  relink-usage-events.ts
  recompute-utility-scores.ts

src/wiki/processes/
  regenerate-wiki-indexes.ts
```

This keeps the index domain focused while moving side effects to their owning
domains.

Note: read-side source resolution and read bootstrap already live in
`src/indexer/read-preflight.ts` (`resolveReadSources`, `ensurePrimaryIndexForRead`,
`ensurePrimaryIndexFromConfig`), added alongside this plan. The proposed
`ensure-read-index.ts` process is a consolidation/rename of that existing code,
not a greenfield module — see Process B below.

## Vertical slices

### 1. Source Sync Slice

Purpose:
- materialize provider caches before indexing starts
- resolve ordered source entries

Owns:
- source cache refresh policy
- source list resolution for the current run

Does not own:
- file walking
- indexing policy

Primary callers:
- `run-index`
- `run-index-maintenance`

Initial extraction targets:
- source cache hydration: `ensureSourceCaches(...)` (implemented in
  `src/indexer/search/search-source.ts`) is called from `akmIndex` in
  `src/indexer/indexer.ts`; removed-source purging lives in `runSourceCachePhase`
  there
- the shared `resolveSourceEntries(...)` resolver (also in `search-source.ts`),
  currently called from scattered read/index entry points (`akmIndex`, `lookup`,
  and `resolveReadSources` in `read-preflight.ts`)

### 2. Walk Slice

Purpose:
- enumerate relevant files from source roots
- group by directory where needed
- expose stable walk outputs to downstream slices

Owns:
- git/manual walk selection
- skip-directory policy
- iterative walking behavior

Does not own:
- metadata generation
- DB staleness decisions

Primary callers:
- `run-index`
- graph extraction
- memory inference where file enumeration is needed

### 3. Metadata Slice

Purpose:
- derive asset metadata from files
- merge compatibility overrides
- produce canonical `StashEntry` values

Owns:
- metadata derivation rules
- `.stash.json` compatibility merge behavior
- warning generation for malformed assets

Does not own:
- persistence
- run planning

Primary callers:
- `run-index`
- `upsert-written-assets`
- any future improve enrichment catch-up pass

### 4. Index State Slice

Purpose:
- determine whether directories/files are stale enough to reprocess
- maintain `index_dir_state`
- expose pure planning decisions for incremental runs

Owns:
- fingerprinting
- incremental skip eligibility
- zero-row cache semantics

Does not own:
- walking
- persistence of entries themselves

Primary callers:
- `run-index`
- `ensure-read-index` in blocking mode

### 5. Entries Slice

Purpose:
- persist canonical entry rows and workflow side-table rows
- delete/rewrite affected rows for a directory or targeted file set

Owns:
- `entries` writes
- workflow document writes
- cross-source dedupe policy at write time

Does not own:
- search field composition rules beyond consuming them
- FTS rebuilds
- embeddings

Primary callers:
- `run-index`
- `upsert-written-assets`

### 6. Enrichment Slice

Purpose:
- enrich generated metadata via LLM
- use enrichment cache
- merge successful enriched values back into entry persistence

Owns:
- enrichment budget policy
- cache lookup/store policy
- “already enriched” skip logic

Does not own:
- whether enrichment is triggered by index or improve

Primary callers:
- `run-index` as the current default behavior
- optional future `run-metadata-enrichment-catchup`

Important decision:
- Keep this slice reusable.
- Keep index-time enrichment in `run-index` for now.
- Later add improve-side catch-up composition if needed, but do not make improve
  the sole owner of enrichment.

### 7. Embeddings Slice

Purpose:
- compute/store embeddings
- manage vec availability and embedding verification inputs

Owns:
- embeddable-entry collection
- embedding upsert policy
- embedding store cleanup for stale entries

Does not own:
- search ranking behavior
- semantic status file writes

Primary callers:
- `run-index`
- optional future maintenance catch-up process

### 8. FTS Slice

Purpose:
- rebuild FTS from dirty/all rows
- own the contract for incremental vs full FTS maintenance

Owns:
- FTS refresh behavior

Does not own:
- entry persistence
- search query logic

Primary callers:
- `run-index`
- `upsert-written-assets`

### 9. Verification Slice

Purpose:
- verify post-run search/semantic readiness
- assemble verification result for callers

Owns:
- verification result construction
- operator-facing status guidance

Does not own:
- embeddings themselves
- search execution

Primary callers:
- `run-index`

### 10. Semantic Status Slice

Purpose:
- own `semantic-status.json` updates/clears

Owns:
- semantic provider fingerprint status writes
- semantic status clear/write rules

Does not own:
- embedding generation

Primary callers:
- `run-index`
- possibly explicit semantic-maintenance tools later

### 11. Search Maintenance Slice

Purpose:
- maintain search-adjacent derived state that is not core entry indexing

Owns:
- usage event relinking
- utility-score recomputation

Does not own:
- entry indexing

Primary callers:
- `run-index`
- maybe future explicit maintenance tasks

Reason to move out of `indexer.ts`:
- these are search-maintenance concerns, not file-to-entry indexing concerns

### 12. Wiki Maintenance Slice

Purpose:
- regenerate wiki root indexes from indexed pages

Owns:
- wiki-specific maintenance behavior

Does not own:
- indexing process lifecycle

Primary callers:
- wiki domain processes
- optionally `run-index` via an explicit post-index hook during migration

Reason to move out of `indexer.ts`:
- this is clearly a wiki-domain concern

## Process composition

These are the larger processes built by composing slices.

### A. `run-index`

Current responsibility:
- explicit full/incremental indexing

Composed slices:
1. Source Sync Slice
2. Walk Slice
3. Metadata Slice
4. Index State Slice
5. Entries Slice
6. Enrichment Slice
7. Embeddings Slice
8. FTS Slice
9. Search Maintenance Slice
10. Semantic Status Slice
11. Verification Slice

Migration note:
- wiki maintenance can remain an explicit temporary post-hook until moved fully
  into its own domain process

### B. `ensure-read-index`

Current responsibility:
- bootstrap the index only when it cannot serve the stash

Already partially implemented today in `src/indexer/read-preflight.ts`
(`ensurePrimaryIndexForRead` → `ensureIndex(...)` in default `background` mode)
and `src/indexer/ensure-index.ts` (`ensureIndex`, whose default path calls
`indexCanServeStash(...)` and only rebuilds inline when the index cannot serve
the stash; `mode: "blocking"` instead gates on `isIndexStale(...)`). This process
should absorb that existing code rather than reimplement it.

Composed slices:
1. Readability/serveability check (`indexCanServeStash` / `isIndexStale`)
2. optional `run-index` invocation in bootstrap case (`runInlineReindex` → `akmIndex`)

Important rule:
- this remains an orchestration/policy process, not a place where indexing logic
  reappears

### C. `upsert-written-assets`

Current responsibility:
- fast write-path index visibility for newly written assets

Composed slices:
1. Metadata Slice
2. Entries Slice
3. FTS Slice

Important rule:
- keep fail-open behavior
- do not silently absorb unrelated maintenance responsibilities

### D. `run-index-maintenance`

Purpose:
- central reusable maintenance composition for scheduled or operator-invoked work

Composed slices:
- Search Maintenance Slice
- optional Embeddings catch-up
- optional Enrichment catch-up
- optional verification-only health pass

Important rule:
- this is not the same as `run-index`
- it should operate on already indexed content, not replace file-to-entry indexing

### E. Improve processes

Keep these as separate improve-owned processes:
- memory inference
- graph extraction
- staleness detection

Possible future addition:
- metadata enrichment catch-up

Do not move into improve:
- walk/classify
- entry persistence as the primary source of truth
- FTS rebuild as the main index contract
- index verification as the only semantic readiness path

## Shared process contract

Use a small plain-object convention instead of a class framework.

Suggested shape:

```ts
type ProcessResult<T> = {
  ok: true;
  value: T;
  warnings?: string[];
} | {
  ok: false;
  error: string;
  warnings?: string[];
};

type ProcessStep<TContext> = {
  name: string;
  run: (context: TContext) => Promise<void>;
};
```

Keep it simple:
- one context object per top-level process
- slice functions return explicit results, not mutate unrelated globals
- mutations on context should be narrow and documented

## Testing strategy

### Unit tests per slice

Each slice should have direct tests against small fixtures or mocked ports.

Examples:
- Walk Slice: skip rules, symlink behavior, git/manual parity
- Index State Slice: unchanged vs stale vs zero-row cache decisions
- Metadata Slice: override merge precedence, warning generation
- Enrichment Slice: cache hit/miss, timeout budget, merge behavior
- Entries Slice: dedupe, workflow side-table writes
- FTS Slice: full vs incremental rebuild mode selection

### Contract tests per process

Keep or add process-level tests for:
- `ensure-read-index` availability-first semantics
- `run-index` full vs incremental behavior
- `upsert-written-assets` fail-open and visibility semantics
- improve maintenance ordering around reindex-after-memory-inference

### Integration tests

Retain end-to-end tests for:
- source add -> index -> search/show
- remember/write path -> targeted upsert -> search visibility
- improve maintenance -> memory inference -> reindex -> graph extraction

## Migration phases

### Phase 1: Extract orchestration seams without behavior change

Deliverables:
- `run-index.ts`
- `ensure-read-index.ts`
- `upsert-written-assets.ts`
- shared process/context types

Moves:
- take orchestration out of `src/indexer/indexer.ts`
- keep existing DB helpers intact behind the new process files

Success criteria:
- existing tests pass unchanged or with minimal import updates

### Phase 2: Extract core slices

Deliverables:
- Walk Slice
- Metadata Slice
- Index State Slice
- Entries Slice
- FTS Slice

Moves:
- shift concrete logic from `indexer.ts` into slice modules
- leave current SQL helpers in place initially

Success criteria:
- new unit tests exist for each extracted slice
- `run-index` becomes mostly composition code

### Phase 3: Extract LLM and semantic slices

Deliverables:
- Enrichment Slice
- Embeddings Slice
- Verification Slice
- Semantic Status Slice

Moves:
- isolate LLM-specific policy from the main index flow

Success criteria:
- can invoke enrichment as a reusable slice from both index and future improve maintenance

### Phase 4: Move adjacent-domain side effects out of indexer

Deliverables:
- Search Maintenance Slice
- Wiki Maintenance Slice

Moves:
- remove wiki regeneration and usage/utility maintenance logic from `indexer.ts`

Success criteria:
- index domain no longer owns wiki-side behavior
- maintenance steps can be invoked independently

### Phase 5: Add optional reusable maintenance processes

Deliverables:
- `run-index-maintenance.ts`
- optional `run-metadata-enrichment-catchup.ts`

Moves:
- create shared reusable maintenance composition for scheduled tasks

Success criteria:
- improve can call shared slices instead of embedding custom maintenance logic
- no behavior regression in normal `akm index` output/quality

## Recommended first moves

Start here:
1. Extract `run-index` orchestration from `src/indexer/indexer.ts`
2. Consolidate `ensure-read-index` from the existing `src/indexer/read-preflight.ts`
   + `src/indexer/ensure-index.ts` (`ensureIndex`) rather than building it new
3. Extract `upsert-written-assets` process wrapper around `indexWrittenAssets(...)`
   (already implemented in `src/indexer/index-written-assets.ts`)
4. Extract Walk + Index State + Entries slices

This gives the best architecture gain with the least behavioral risk.

## Explicit recommendations

- Keep index-time metadata enrichment in the main index process.
- Make enrichment reusable so improve can optionally run a catch-up enrichment
  process later.
- Keep graph extraction in improve/manual maintenance for now.
- Move wiki and search-maintenance side effects out of the indexer domain.
- Avoid a class-heavy pipeline framework; use small typed functions and context
  objects instead.

## Definition of done

The refactor is successful when:
- top-level processes are short composition files
- slices are independently unit testable
- current read/write/index contracts are preserved
- adjacent-domain side effects are no longer hidden inside `indexer.ts`
- improve and index can reuse the same slices without copy-paste orchestration
