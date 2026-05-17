# Index Consistency Architecture Decision Record (M-4 / #395)

**Date:** 2026-05-16
**Status:** Accepted
**Issue:** [#395 M-4: Audit index count for reduction opportunities](https://github.com/itlackey/akm/issues/395)

## Context

AKM maintains four indexes per stash, all stored in a single SQLite database file:

| # | Index | Table(s) | Purpose |
|---|-------|----------|---------|
| 1 | Frontmatter | `entries` | Asset metadata, tags, descriptions |
| 2 | FTS5 full-text | `entries_fts` | Keyword search (BM25) |
| 3 | Vector / embedding | `embedding`, `vec_entries` | Semantic similarity search |
| 4 | Graph | `graph_nodes`, `graph_edges` | Entity–relation extraction |

There is no transactional boundary spanning all four indexes. A crash mid-improve
leaves observable inconsistency that the next index run heals opportunistically.

## Audit Findings

**Can any index be eliminated or merged?**

- **FTS5** is redundant with `entries` when semantic search is configured, but is
  the primary search path for keyword-only stashes (`semanticSearchMode: "off"`).
  Eliminating it would break keyword search for stashes without embeddings configured.
  **Cannot eliminate without breaking keyword search.**

- **Vector index** depends on `entries` for entry IDs. `clearStaleCacheEntries`
  handles most orphan drift. It could theoretically be merged into `entries` as a
  BLOB column, but the `sqlite-vec` extension requires a separate virtual table.
  **Cannot eliminate given the sqlite-vec architecture.**

- **Graph index** is rebuilt from scratch on each extraction pass (not incremental).
  Cross-step drift resolves on the next extraction automatically.
  **Could defer to reduce coordination cost, but graph search is a first-class feature.**

- **Frontmatter index** is the source of truth for all other indexes. Cannot eliminate.

**Conclusion:** None of the four indexes can be eliminated without removing a
first-class search capability. Merge is not currently feasible given the sqlite-vec
extension's architecture requirements.

## Decision

Accept **opportunistic recovery** as the consistency strategy:

- Each index operation is individually crash-tolerant.
- Cross-index drift is healed by the next `akm index` (full or incremental) run.
- No distributed transaction protocol is implemented.

CRDT-based convergence (Shapiro et al. 2011) would require per-operation CRDTs
for all four stores — deferred pending a dedicated storage refactor.
Salem-Beeri-Ramakrishnan (2000) materialized-view maintenance would require a
change-log mechanism — also deferred.

## Consequences

- **Positive:** Simple, easy to reason about, no distributed-transaction overhead.
- **Negative:** A crash mid-improve leaves temporary inconsistency. Users may see
  stale search results until the next index run.
- **Mitigating:** `akm index --full` fully rebuilds all four indexes from frontmatter;
  it is the escape hatch for any observed inconsistency.

## References

- Shapiro et al. (2011) — "Conflict-free Replicated Data Types"
- Salem, Beeri, Ramakrishnan (2000) — "Towards a Theory of Incremental View Maintenance"
- `src/indexer/indexer.ts` — ADR comment at the top of the file
