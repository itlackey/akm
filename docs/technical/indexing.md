# Indexing

The indexer (`akm index`) builds a SQLite database that powers search.

## How It Works

```
Walk stash directories (11 sources)
        │
        v
Load .stash.json or generate metadata in memory
        │
        v
Extract parameters ($ARGUMENTS, @param JSDoc, frontmatter params)
        │
        v
Build per-field search text (name, description, tags, hints, content)
        │
        v
Upsert into SQLite entries table
        │
        v
Rebuild multi-column FTS5 index
        │
        v
Recompute utility scores from usage events (M-2)
        │
        v
Generate embeddings (if semantic search enabled)
        │
        v
Enhance with LLM (if LLM provider configured)
```

## Modes

- **Incremental (default)** — Tracks file modification times and
  `.stash.json` changes. Only re-processes directories that have changed.
- **Full rebuild** — `akm index --full` wipes and rebuilds the entire index.

## Database Schema

The SQLite database contains these tables:

| Table | Purpose |
| --- | --- |
| `entries` | Main data (name, type, description, tags, JSON metadata) |
| `entries_fts` | Multi-column FTS5 virtual table for lexical search |
| `embeddings` | BLOB embeddings (Float32Array) for vector search |
| `entries_vec` | sqlite-vec virtual table for fast vector search (optional) |
| `usage_events` | Telemetry: search queries, show actions, feedback signals |
| `utility_scores` | Aggregated utility metrics per entry (M-2 re-ranking) |
| `index_meta` | Key-value metadata (version, timestamps, config) |

### FTS5 Multi-Column Schema

The FTS5 table uses separate columns with per-column BM25 weighting:

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
  entry_id UNINDEXED,
  name,           -- weight 10.0
  description,    -- weight 5.0
  tags,           -- weight 3.0
  hints,          -- weight 2.0
  content,        -- weight 1.0
  tokenize='porter unicode61'
);
```

A match in the `name` column is weighted 10× higher than a match in `content`.
See [search.md](search.md) for how these weights affect ranking.

### Schema Versioning

`DB_VERSION` is stored in `index_meta`. When the code version differs from the
stored version, all tables are dropped and recreated. This is a deliberate
design choice — no migration code, no version compatibility matrix. A full
reindex is always safe and produces a correct index.

## Metadata Generation

When no `.stash.json` exists for a directory, the indexer generates metadata
from available signals in priority order:

1. **`package.json`** — `description` and `keywords` fields (confidence 0.8)
2. **Frontmatter** — YAML `description` in `.md` files (confidence 0.9)
3. **Code comments** — JSDoc blocks and hash comments extracted by
   type-specific handlers (confidence 0.7)
4. **Filename heuristics** — Converts `docker-build.ts` to `"docker build"`
   (confidence 0.55)

Generated metadata is stored in the SQLite index. Add or edit `.stash.json`
when you want curated metadata to override generated values on future runs.

### Parameter Extraction

The indexer extracts structured parameters from assets:

- **Commands** — `$ARGUMENTS`, `$1`–`$9`, `{{named}}` placeholders
- **Scripts** — `@param {type} name - description` JSDoc comments (first 50 lines)
- **Frontmatter** — `params:` key with name/type/description fields

Extracted parameters are stored in `StashEntry.parameters` and their names
and descriptions are included in the FTS5 search text, enabling queries like
"tool that takes a Docker image".

## LLM Enhancement

When an LLM provider is configured, the indexer can enhance auto-generated
metadata by:

- Improving descriptions with file content context
- Generating 3–6 natural language intent phrases
- Suggesting relevant tags

This runs against an OpenAI-compatible chat endpoint with low temperature
(0.3) for consistency. Enhancement is optional and degrades gracefully.

**Performance note:** LLM enhancement calls the endpoint for every directory
with generated metadata. With many stash sources and hundreds of files, this
can take several minutes. Disable the LLM provider in config or run
`akm index --full` without it for fast rebuilds.

See [../configuration.md](../configuration.md) for setting up an LLM provider.

## Utility Score Recomputation (M-2)

During indexing, the system aggregates usage telemetry from the `usage_events`
table into per-entry utility scores:

1. Count search appearances and show events per entry (single aggregate SQL)
2. Compute select rate: `show_count / search_count` (clamped to 0–1)
3. Update utility via exponential moving average: `utility = 0.7 × previous + 0.3 × select_rate`
4. Purge events older than 90 days

These utility scores feed into the search scoring pipeline as a multiplicative
boost (see [search.md](search.md)), causing frequently-used assets to rank
higher over time.
