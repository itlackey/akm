# Indexing

`akm index` builds and refreshes the local SQLite search index.

## High-Level Flow

```text
Resolve all sources (filesystem, git, website, npm) and materialise caches
        ↓
Walk files and classify assets
        ↓
Load .stash.json or generate metadata
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

Workflow runtime state lives separately in `workflow.db`, not this index.

## Schema Versioning

`index.db` is ephemeral — fully rebuildable from sources by `akm index`.
The schema is gated by a single `DB_VERSION` constant (currently 9). When
the stored version differs, `ensureSchema()` (in `src/indexer/db.ts`)
drops + recreates every table in `index.db` (preserving `usage_events`
via a typed backup); the next `akm index` repopulates. `workflow.db`
(durable run state) is never touched by this path.

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

When `.stash.json` is absent, akm derives metadata from signals such as:

- frontmatter
- comments / headers
- filenames
- `package.json`
- renderer-specific extraction (workflow params, TOC, vault key hints, wiki metadata)

## Parameters

Structured parameters can come from:

- command placeholders (`$ARGUMENTS`, `$1`-`$9`, `{{named}}`)
- frontmatter `params`
- script comment extraction
- workflow markdown parameters

Parameter names and descriptions are stored structurally and also fed into the
lowest-weight `content` field.

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
