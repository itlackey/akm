# Search Architecture

Search uses a hybrid approach combining lexical and semantic ranking to find
the most relevant assets for a query.

## Indexed Search (primary)

When an index exists (`~/.cache/agentikit/index.db`), two strategies run in
parallel:

1. **FTS5 (lexical)** -- SQLite full-text search with Porter stemming.
   Matches against a combined search text built from name, description, tags,
   intents, examples, and aliases.

2. **Semantic (vector)** -- Cosine similarity between query embedding and
   stored entry embeddings via sqlite-vec (384 dimensions). Requires an
   embedding provider to be configured.

Scores are blended: **70% semantic + 30% FTS5** when both are available.

### Quality Boosts

After blending, quality boosts are applied:

| Boost | Value |
| --- | --- |
| Tag exact match | +0.15 |
| Intent token match | +0.12 |
| Name token match | +0.10 |
| Curated metadata | +0.05 |
| Confidence score | up to +0.05 |

## Substring Fallback

When no index is available, search falls back to scanning stash directories
and filtering by substring match. This ensures search always works, even
before `akm index` has been run.

## Registry Search

Search can also query npm and GitHub (`--source registry` or `--source both`).
Registry results are merged with local results in alternating order.

Registry results are filtered to only include packages and repos tagged with
`akm` or `agentikit`. See [registry.md](registry.md) for details.

## Explainability

Each search hit includes a `whyMatched` field explaining which signals
contributed to its ranking (e.g., "fts bm25 relevance", "matched name
tokens", "semantic similarity").
