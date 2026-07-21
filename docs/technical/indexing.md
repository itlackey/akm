# Indexing

`akm index` builds and refreshes the local SQLite search index.

By default it builds the local index and keeps metadata in the index. When
`akm.llm` is configured and `index.enrichment.llm` is not `false`, metadata
enhancement runs during indexing.

## High-Level Flow

```text
Resolve all sources (filesystem, git, website, npm) and materialise caches
        ↓
Walk files and classify assets
        ↓
Generate metadata from the asset, then merge explicit-file legacy overrides
        ↓
Build weighted search fields
        ↓
Upsert entries
        ↓
Rebuild FTS
        ↓
Re-link preserved usage events
        ↓
Recompute utility scores
        ↓
Refresh semantic status / embeddings when enabled
```

Cache materialisation runs through each source's `sync()` method
(`src/sources/providers/`) before the indexer walks `path()`.

## Search Field Mapping

`src/indexer/search-fields.ts` builds five FTS columns:

| Column | Contents |
| --- | --- |
| `name` | normalized asset name |
| `description` | description text |
| `tags` | tags + aliases |
| `hints` | `searchHints`, `examples`, `usage`, intent text, wiki xrefs, wiki page kind |
| `content` | TOC headings plus parameter names/descriptions |

The `content` column is intentionally sparse. Longer freeform guidance such as
`usage` and `intent` primarily feed `hints`, not `content`.

## Modes

- incremental (default): reprocesses changed directories/files
- full rebuild (`akm index --full`): rebuilds the search index from scratch

Full rebuilds preserve usage history and then re-link it to rebuilt entries by
ref.

## LLM Enrichment Pass

When metadata enhancement is enabled, the enrichment pass runs after all
entries are upserted and FTS is rebuilt. Key properties:

**Concurrency** — directories are enriched in parallel using a bounded
concurrency pool (`concurrentMap` from `src/core/concurrent.ts`). The pool
width defaults to 2 for remote LLM endpoints and 1 for local model servers
(localhost endpoints — one loaded model at a time); `llm.concurrency` in
config.json overrides the default. Individual entry failures within a
directory are isolated; the pool continues with remaining work.

**`quality: "enriched"` caching** — after a successful LLM enrichment call,
the entry's `quality` field is set to `"enriched"` and written back to the
index. On subsequent `akm index` runs, entries already marked `"enriched"`
are skipped unless the caller explicitly requests re-enrichment.

**5-minute wall-clock budget** — the enrichment pass operates under a 5-minute
total deadline enforced by `AbortSignal.timeout(5 * 60 * 1000)`. Once the
deadline fires, no new enrichment calls are started; entries that were not
reached are left at `quality: "generated"` and will be picked up on the next
eligible run.

**Eligibility** — only entries with `quality: "generated"` are enriched by
default. Entries with `quality: "curated"` or `quality: "enriched"` are
skipped unless the caller explicitly requests re-enrichment.

## Progress Reporting

- text mode: shows a spinner with processed-versus-total source counts
- `--verbose`: prints phase progress to stderr
- structured output (`json`, `yaml`, `jsonl`): emits clean machine-readable output without spinner noise

## Database Tables

| Table | Purpose |
| --- | --- |
| `entries` | normalized asset records |
| `entries_fts` | multi-column FTS5 index |
| `embeddings` | stored embeddings |
| `entries_vec` | optional sqlite-vec index |
| `usage_events` | search/show/feedback telemetry |
| `utility_scores` | recomputed utility boost state |
| `index_meta` | schema/version/runtime metadata |
| `workflow_documents` | validated `WorkflowDocument` JSON for indexed workflows |

Workflow runtime state lives separately in `state.db` (the former `workflow.db`
was folded into `state.db` in the 0.9.0 cutover), not this index.

## Schema Versioning

`index.db` is ephemeral — fully rebuildable from sources by `akm index`.
The schema is gated by a single `DB_VERSION` constant (currently 9). When
the stored version differs, `ensureSchema()` (in `src/indexer/db.ts`)
drops + recreates every table in `index.db` (preserving `usage_events`
via a typed backup); the next `akm index` repopulates. Durable workflow run
state in `state.db` is never touched by this path.

The `workflow_documents` table (introduced in v0.6.0 with `DB_VERSION = 9`)
caches the validated `WorkflowDocument` JSON output of `parseWorkflow()` for
each indexed workflow asset, keyed by `entry_id` with `ON DELETE CASCADE`:

```sql
CREATE TABLE workflow_documents (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## Metadata Sources

AKM now treats file-derived metadata as the primary runtime source. It derives
metadata from signals such as:

- frontmatter
- comments / headers
- filenames
- `package.json`
- renderer-specific extraction (workflow params, TOC, vault key hints, wiki metadata)

Legacy `.stash.json` support remains only as a compatibility layer for entries
that name an explicit `filename`, and that compatibility layer is deprecated and
scheduled for removal in v0.8.0. Filename-less `.stash.json` entries are no
longer treated as first-class metadata during indexing, search fallback,
manifest generation, or registry build.

## Parameters

Structured parameters can come from:

- command placeholders (`$ARGUMENTS`, `$1`-`$9`, `{{named}}`)
- frontmatter `params`
- script comment extraction
- workflow markdown parameters

Parameter names and descriptions are stored structurally and also fed into the
lowest-weight `content` field.

## Quality Values

The `quality` field on an index entry tracks how its metadata was produced.
Well-known values (defined in `src/indexer/metadata.ts`):

| Value | Meaning |
| --- | --- |
| `"generated"` | metadata derived automatically from file content |
| `"enriched"` | metadata produced by or updated via an LLM enrichment pass |
| `"curated"` | metadata written or explicitly approved by a human |
| `"proposed"` | metadata from a proposal awaiting review |

The `"enriched"` marker is set by the indexer after a successful metadata
enrichment pass during plain `akm index` and prevents unnecessary re-enrichment
on the next run (see LLM Enrichment Pass above).

## Utility Recomputation

Utility scores are rebuilt from `usage_events`.

- old events are purged on a rolling window
- event history is preserved through schema resets/full rebuilds
- decay is based on elapsed time, not on how often indexing runs
- utility is a secondary boost, not the primary ranking signal

## Semantic Search Integration

When semantic search is enabled:

- semantic readiness is tracked in `semantic-status.json`
- provider fingerprints include endpoint/model/dimension for remote configs
- fingerprint changes force semantic status back to pending until a rebuild
- `sqlite-vec` is optional; JS vector fallback still supports embeddings
