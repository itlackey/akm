# Search Architecture

Search uses a hybrid approach combining lexical and semantic ranking to find
the most relevant assets for a query.

## Indexed Search (primary)

When an index exists (`~/.cache/akm/index.db`), local search uses two ranking
signals:

1. **FTS5 (lexical)** -- SQLite full-text search with Porter stemming.
   Matches against a combined search text built from name, description, tags,
   searchHints, examples, and aliases.

2. **Semantic (vector)** -- Cosine similarity between query embedding and
   stored entry embeddings via sqlite-vec (384 dimensions). Requires an
   embedding provider to be configured.

FTS and vector results are merged with reciprocal rank fusion (RRF). Entries
that appear in both lists rank higher than entries that appear in only one.

### Quality Boosts

After fusion, additional boosts are applied:

| Boost | Value |
| --- | --- |
| Tag exact match | +0.15 |
| Search hint token match | +0.12 |
| Name token match | +0.10 |
| Curated metadata | +0.05 |
| Confidence score | up to +0.05 |

## Substring Fallback

When no index is available, search falls back to scanning stash directories
and filtering by substring match. This ensures search always works, even
before `akm index` has been run.

## Registry Search

Search can also query npm and GitHub (`--source registry` or `--source both`).
When both local and registry sources are enabled, the CLI combines the two hit
lists and sorts the final results by score.

Registry results are filtered to only include packages and repos tagged with
`akm` or `agentikit`. Registry search includes pluggable providers
(static-index, skills-sh). Stash search includes pluggable stash providers
(filesystem, openviking). See [../registry.md](../registry.md) for provider
details.

## External Output Shape

Search keeps separate internal hit types for local assets and registry entries,
but normalizes what the CLI emits through the existing output shapers. That
lets ranking and source-specific metadata stay internal while the public output
contract stays small and consistent.

By default (`--format json`, `--detail brief`):

- local hits emit `type`, `name`, `ref`, `description`, `size`, and `action`
- registry hits emit `type`, `name`, `id`, `description`, `action`, and `curated`

`--detail normal` adds fields like `origin` and `tags`. `--detail full` exposes
debug-oriented fields such as scores, `whyMatched`, timings, stash paths, and
other internal metadata.

## Explainability

`whyMatched` explains which signals contributed to a hit's ranking (for
example "fts bm25 relevance", "matched name tokens", or "semantic
similarity"), but it is only surfaced in full-detail output.
