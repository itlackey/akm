# Indexing

The indexer (`akm index`) builds a SQLite database that powers search.

## How It Works

```
Walk stash directories
        |
        v
Load or generate .stash.json
        |
        v
Build search text for FTS5
        |
        v
Generate embeddings (if provider configured)
        |
        v
Upsert into SQLite index
```

## Modes

- **Incremental (default)** -- Tracks file modification times and
  `.stash.json` changes. Only re-processes directories that have changed.
- **Full rebuild** -- `akm index --full` wipes and rebuilds the entire index.

## Database Schema

The SQLite database contains three tables:

| Table | Purpose |
| --- | --- |
| `entries` | Main data (name, type, description, tags, metadata) |
| `entries_fts` | FTS5 virtual table for lexical search |
| `entries_vec` | Vector table for semantic similarity |

## Metadata Generation

When no `.stash.json` exists for a directory, the indexer generates metadata
from available signals in priority order:

1. **`package.json`** -- `description` and `keywords` fields (confidence 0.8)
2. **Frontmatter** -- YAML `description` in `.md` files (confidence 0.9)
3. **Code comments** -- JSDoc blocks and hash comments extracted by
   type-specific handlers (confidence 0.7)
4. **Filename heuristics** -- Converts `docker-build.ts` to `"docker build"`
   (confidence 0.55)

Generated metadata is written to `.stash.json` automatically. Set `quality`
to `"curated"` to prevent regeneration.

## LLM Enhancement

When an LLM provider is configured, the indexer can enhance auto-generated
metadata by:

- Improving descriptions with file content context
- Generating 3-6 natural language intent phrases
- Suggesting relevant tags

This runs against an OpenAI-compatible chat endpoint with low temperature
(0.3) for consistency. Enhancement is optional and degrades gracefully.

See [configuration.md](configuration.md) for setting up an LLM provider.
