# Indexing

`akm index` builds and refreshes the local SQLite search index.

## High-Level Flow

```text
Resolve all stash sources
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

## Search Field Mapping

`src/search-fields.ts` builds five FTS columns:

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

Workflow runtime state lives separately in `workflow.db`, not this index.

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
