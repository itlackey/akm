# index redesign — implementation contract, stage 2

Design: `docs/plans/index-redesign.md`. Base: `wt/index-units` after the stage-1 modules merged
(units `src/indexer/units/unit.ts`, the vector store `src/storage/repositories/units-repository.ts`,
provider limits `src/llm/embedders/provider-limits.ts`). Branches are `wt/index-units-B<n>` (a
slash after `wt/index-units` collides with the base ref). Rules as in the stage-1 contract:
AGENTS.md, tests first, no new config keys, named constants with a one-sentence reason, biome +
tsc + focused tests + `bun run lint` before each commit, conventional subjects ending
"(index-redesign)", trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01B66fKkS6fzLhAhxLQuhUxn`.

Where a module needs another module's table or function that is being written in parallel, code
against the signature here and add a minimal stub file marked "stage-2 stub, superseded at
merge"; the integrator takes the owner's file.

## Tables (final shape)

```sql
-- B1 owns
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,      -- absolute path
  bundle_id  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   REAL NOT NULL,
  blob_hash  TEXT NOT NULL          -- sha256 of the bytes
);
CREATE TABLE IF NOT EXISTS unit_texts (       -- content-addressed text, one row per distinct unit
  unit_hash TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('card','fragment')),
  text      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
  unit_hash UNINDEXED, text, tokenize='porter unicode61'
);
-- stage 1 (A2) owns: units(unit_id, unit_hash, identity), units_vec(vec0 + aux), entry_units(entry_id, ordinal, fragment_id, unit_hash)
-- entries keeps: id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash (= blob_hash), document_json, search_text, derived_from
```

## B1 — `src/indexer/reconcile.ts` (files and reconcile)

```ts
export interface ReconcileCounts { scanned: number; unchanged: number; added: number; changed: number; removed: number; unitsAdded: number }
/** Stat-walk every root, hash files whose (size, mtime) moved or are new, derive new blob hashes, delete gone paths. Idempotent. */
export async function reconcileRoots(db: Database, roots: readonly { path: string; bundleId: string }[], opts?: { signal?: AbortSignal; onProgress?: (line: string) => void }): Promise<ReconcileCounts>;
/** The same per-file step for a known list of paths (the write paths call this inline). */
export async function reconcilePaths(db: Database, paths: readonly string[], bundleId: string): Promise<ReconcileCounts>;
```
Per changed file: parse with the SAME document parser the walk uses today (find it in
`indexer.ts`'s drain step and extract it into a function rather than duplicating it); upsert
`entries` (`content_hash` = blob hash); `deriveUnits` (stage 1) with `maxChars` from
`unitMaxChars(probeProviderLimits(config))` cached per run; `INSERT OR IGNORE` into `unit_texts`
and `units_fts` for new hashes; `replaceEntryUnits`. A gone path deletes its `entries` row (cascade
removes `entry_units`); `unit_texts`/`units_fts` rows no entry references are removed at the end of
`reconcileRoots` (a single `NOT EXISTS` delete; vectors are never touched). Every write is a short
`BEGIN IMMEDIATE` transaction, one per file or per small group, never one transaction per run.
Tests: temp roots with fixtures; add, edit, rename (one row re-pointed, no re-derive), delete;
idempotence (second run: all unchanged); two concurrent reconciles of the same root converge.

## B2 — write-time indexing (`src/indexer/index-written-assets.ts` and its callers)

`indexWrittenAssets(stashDir, paths, {bundleId})` becomes a thin call to `reconcilePaths` followed
by `drainEmbeddingQueue(db, config, { onlyHashes: <the units just added>, ... })` (B4), inline, no
lock probe, no rebuild detection, no background spawn. The five callers
(`commands/improve/extract.ts`, `commands/read/knowledge.ts`, `commands/sources/source-clone.ts`,
`commands/proposal/repository.ts`) keep their call shape. Tests: each caller's existing integration
test still passes; a written asset is searchable lexically immediately after the call returns and
semantically after its drain.

## B3 — search over units (`src/indexer/search/db-search.ts`, `ranking.ts`, result shapes)

```ts
export function searchUnitsLexical(db, query: string, k: number): { unitHash: string; rank: number }[];     // units_fts bm25
// stage 1 provides searchUnits(db, vector, k, identity) → { unitId, hash, distance }[]
export function fuseByEntry(db, lexical: ..., semantic: ..., opts: { typeFilter?: string[]; excludeTypes?: string[] }): RankedEntryInput[];
```
Fusion is reciprocal rank: score = Σ 1 / (RRF_K + rank) over the two lists, `RRF_K = 60` (the
constant from Cormack et al. 2009; it damps the top ranks, and nothing else is tuned). Group to
entries via `entry_units` keeping the best unit; carry `matchedUnit: { unitHash, fragmentId | null,
kind }` on the hit. `k` for each list = requested × mean units per entry (min 1). The old path
(`entries_fts` + `searchVec` + `FTS_WEIGHT/VEC_WEIGHT` + `minScore`) is left in place for B5 to
delete; the new path is selected when `units_fts` has rows. Tests: seeded `unit_texts`/`units_fts`/
`entry_units`/`units_vec`; lexical-only, semantic-only, both; grouping; type filters; the envelope
field; a `curate-golden` fixture run recorded before/after in the PR body, not asserted yet.

## B4 — `src/indexer/drain.ts` (the embedding queue)

```ts
export interface DrainCounts { pending: number; embedded: number; failed: number; skipped: number; identity: string | null }
export async function drainEmbeddingQueue(db, config: AkmConfig, opts: { signal?: AbortSignal; onProgress?: (line: string) => void; limit?: number; onlyHashes?: readonly string[] }): Promise<DrainCounts>;
```
Pending = `unit_texts.unit_hash` with no `units` row for the active identity (`index_meta
embeddingIdentity`); when no identity is known yet, embed the first batch, take the identity from
the response (`deriveObservedEmbeddingIdentity`, stage 1's `dropOtherIdentities` if it changed),
then continue. Pack requests with `probeProviderLimits` (window, slots, exact counts where offered)
using the EXISTING `embedBatch` / `RemoteEmbedder` batching, retry, back-off and circuit breaker;
each provider batch commits through `upsertUnitVectors` in its own transaction. Progress: one
line per batch at default level, one final line with counts. Do not touch
`materialize-embeddings.ts`; B5 deletes it. Tests: mock embedder; resume after a kill mid-drain
embeds only what is missing; identity learned from the first response; `onlyHashes` bounds the
work; the circuit breaker still trips.

## B5 — removal, migration, status (after B1–B4 merge)

Delete: the phase pipeline and `passes/dir-staleness.ts`, `index_dir_state`; the rebuild lock,
the index writer lock, the index paths through the maintenance barrier and their exit-code
special cases (`--skip-if-locked` is accepted with a deprecation warning and does nothing);
`embedding_salvage` and its repository; `materialize-embeddings.ts` (canary, purge, `--reembed`
becomes "drop the active identity's vectors"), `capEmbeddingText`, the adaptive budget as a
primary mechanism; `entries_fts`, `entry_fragments`, `entry_fragments_fts`, `embeddings`,
`entries_vec` and `index-fts-repository.ts`'s duplicated paths; the fusion weights and
`search.minScore`; config keys `embedding.maxInputTokens`, `maxTokens`, `batchSize`,
`contextLength` (schema regenerated; Retired Configuration doc). `akm index` = reconcile + drain
with the flags that still mean something (`--full` = drop derived tables except vectors, then
reconcile). New `akm index status`: files, entries, units, vectors present/missing for the active
identity, last reconcile time, queue depth. Generation bump; migration note; CHANGELOG; docs
(`indexing.md` rewritten to this design). Gate: `bun run check`, then the release check.
