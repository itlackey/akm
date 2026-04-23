# Search

Search in `akm` is built to degrade gracefully.

That matters because there are a few moving parts involved:

- stash sources
- the local SQLite index
- FTS search
- embeddings
- the vector search backend
- optional remote or local embedding providers

If one of those pieces is unavailable, `akm` usually keeps going instead of falling over. The quality of the results may drop, and performance may drop, but search is intentionally layered so the user still gets something useful back.

This doc explains the current implementation in plain English.

## The Big Idea

There are really three search tiers in the local stash path:

1. **Indexed hybrid search** — best case
2. **Indexed keyword search** — semantic/vector layer degraded
3. **Filesystem substring search** — index degraded or unavailable

And above that, there is one more routing layer:

- search the local stash
- search the registry
- search both and merge the results

So when people ask whether search is "down," the answer is usually "which layer?"

## Top-Level Search Flow

When you run `akm search`, the implementation first decides where to search:

- `stash`
- `registry`
- `both`

From there:

- `stash` searches the local stash and configured stash providers
- `registry` skips local stash search entirely
- `both` runs both paths and merges the results

If there are no configured stashes, `akm` does not hard fail. It returns an empty response and tells the user to run `akm init`.

## Local Search Path

The local stash search path prefers the SQLite index when it can trust it.

That indexed path is used only if the implementation can confirm all of the following:

- the database file exists
- the database opens successfully
- it contains indexed entries
- the stored stash metadata matches the active stash path

If any of that fails, `akm` falls back to filesystem substring search.

That is the broad fallback. It is not a semantic-search fallback. It is the fallback for when the index itself is unavailable or untrusted.

## Search Tiers

| Tier | Path | What you get | What you lose |
|---|---|---|---|
| 1 | Indexed hybrid search | FTS + semantic/vector scoring + reranking | Nothing important |
| 2 | Indexed keyword search | FTS + reranking | Semantic relevance |
| 3 | Filesystem substring search | Basic search that still returns useful matches | FTS ranking, semantic ranking, and most of the smarter ordering |
| 4 | No stash configured | Empty result with guidance | All local search |

This is the most important thing to understand about the current implementation: missing semantic search is not the same thing as missing search.

## Indexed Search

Inside the indexed path, `akm` does a couple of things:

- runs FTS keyword search
- tries semantic/vector scoring
- combines scores when both are available
- applies reranking boosts afterward

The current implementation uses a weighted blend when both FTS and vector scores are present:

- `0.7` FTS
- `0.3` vector

After that, additional boosts can influence the final order. That includes things like exact-ish matches, aliases, hints, and utility metadata.

So even in the best case, the final ranking is not just raw BM25 and not just raw cosine similarity.

## Ranking Modes

| Mode | When it happens | Inputs used |
|---|---|---|
| `hybrid` | The item has both FTS and vector scores | FTS + vector |
| `fts` | The item has FTS but no vector score | FTS only |
| `semantic` | The item has a vector score but was not surfaced by FTS | Vector only |

That last one matters. It means semantic search can rescue results that keyword search missed.

## Semantic Search

Here is the part that tends to confuse people:

**semantic search is not the same thing as `sqlite-vec`.**

`sqlite-vec` is only one vector backend.

If `sqlite-vec` is installed and loads correctly, `akm` uses the `entries_vec` virtual table for vector lookup.

If `sqlite-vec` is missing or fails to load, `akm` falls back to JavaScript cosine similarity over embeddings stored as blobs in SQLite.

That means:

- missing `sqlite-vec` does **not** disable semantic search
- it does **not** force a fallback to keyword search
- it does **not** break correctness
- it **does** reduce performance, especially as the embedding count grows

For small and moderate indexes, that tradeoff is usually acceptable. For larger indexes, it becomes more painful.

## When `sqlite-vec` Is Missing

| Condition | Result |
|---|---|
| `sqlite-vec` loads successfully | Native vector search is used |
| `sqlite-vec` is unavailable | JS vector fallback is used |
| `sqlite-vec` is unavailable and embedding count is large | JS fallback still works, but `akm` warns that performance may suffer |

The current implementation starts warning around 10,000 indexed embeddings.

So the right mental model is:

- **No vector extension** = semantic search still works, slower
- **No embeddings / semantic unavailable** = semantic scoring is skipped
- **No index** = fall back to substring search

Those are different failure modes.

## Semantic Status

`akm` tracks semantic readiness with a semantic status file.

That status controls whether semantic search is attempted.

| Status | Meaning | Effective behavior |
|---|---|---|
| `disabled` | Semantic mode is turned off | Semantic search is not attempted |
| `pending` | Semantic is expected but not verified yet | Search continues with keyword/indexed search |
| `blocked` | Semantic setup or indexing failed recently | Search continues with keyword/indexed search |
| `ready-vec` | Semantic is ready with native vector support | Full hybrid search available |
| `ready-js` | Semantic is ready using JS fallback | Full hybrid search available, slower vector backend |

There is also a TTL behavior on `blocked`. After about 24 hours, it is treated more like `pending` so the system can retry semantic setup on a later rebuild.

## When Semantic Search Is Skipped or Unavailable

Semantic search is skipped, unavailable, or effectively empty under these conditions:

| Condition | What happens |
|---|---|
| `semanticSearchMode` is `off` | Semantic search is disabled |
| No semantic status file exists yet | Semantic is treated as pending |
| Embedding provider fingerprint changed | Semantic is treated as pending until rebuilt |
| Semantic status is `blocked` | Semantic scoring is skipped for now |
| Query embedding generation fails | Vector scoring is skipped for that query |
| Stored embeddings were cleared due to dimension change | Semantic search has nothing useful to search until reindexing |
| No embeddings were generated yet | Semantic results come back empty |
| Vector lookup fails at runtime | Vector scores are skipped and keyword search continues |

This is where the implementation is doing the right thing: semantic failures usually do **not** break search as a whole.

They just knock the search path down one tier.

## What Happens When Semantic Search Is Degraded

When semantic search is pending or blocked, `akm` continues with indexed keyword search if the SQLite index is otherwise healthy.

That means the user still gets:

- FTS matching
- reranking boosts
- a sensible result list

What they lose is the semantic contribution.

So the real downgrade is usually:

- from **hybrid search**
- to **keyword/indexed search**

Not:

- from **search**
- to **nothing**

## What Happens When the Index Is Degraded

If the SQLite index cannot be opened, trusted, or matched to the active stash, `akm` falls all the way back to filesystem substring search.

That is the bigger downgrade.

At that point you lose:

- FTS relevance
- semantic/vector scoring
- most of the better ranking behavior
- some of the nicer metadata-driven ordering

But you still usually get useful results.

That is exactly what you want from a CLI tool like this. Keep working. Get worse gracefully.

## Empty Query Behavior

If the query string is empty, `akm` does not behave like a normal search.

Instead, it returns indexed entries directly, deduped by file path and limited to the requested slice.

This is more of a browse/list operation than a relevance-ranked search.

## Error Handling

The current implementation avoids turning partial failures into total failures.

### Provider failures

If an additional stash provider fails, `akm` records a warning and keeps the local results.

### Vector failures

If vector search fails during a query, `akm` logs a warning and skips vector scores for that search.

### Index failures

If the index is unavailable or untrusted, `akm` falls back to filesystem substring search.

### No stash configured

If no stash exists, `akm` returns an empty result and guidance instead of blowing up.

## Operator Matrix

| Condition | Effective path | Does search still return results? | What degrades | Likely fix |
|---|---|---|---|---|
| No stash configured | No local search | No | Everything local | `akm init` |
| Search source is `registry` | Registry only | Yes | No local results | Use `stash` or `both` if needed |
| Additional stash provider fails | Local results continue | Yes | That provider only | Fix provider config/runtime |
| Semantic mode is off | Indexed keyword search | Yes | Semantic scoring | Re-enable semantic mode |
| Semantic pending | Indexed keyword search | Yes | Semantic scoring | `akm setup` or `akm index --full` |
| Semantic blocked | Indexed keyword search | Yes | Semantic scoring | Fix backend issue and rebuild |
| Embedding config changed | Indexed keyword search | Yes | Semantic scoring until rebuild | `akm index --full` |
| Query embedding generation fails | Indexed keyword search | Yes | Semantic scoring for that query | Fix embedder/backend/auth/model |
| `sqlite-vec` missing | Indexed hybrid search with JS vector backend | Yes | Performance | Install `sqlite-vec` if needed |
| `sqlite-vec` missing with large index | Indexed hybrid search with warning | Yes | Performance, more noticeably | Install `sqlite-vec` |
| Index unavailable or untrusted | Filesystem substring search | Yes | Relevance quality and semantic ranking | `akm index` |
| Embeddings missing or cleared | Indexed keyword search | Yes | Semantic results | Reindex to regenerate embeddings |

## Practical Reading of the Current Implementation

If you want the short version, it is this:

- missing `sqlite-vec` is a **performance problem**, not a semantic-search outage
- missing embeddings or blocked semantic status is a **semantic-quality problem**, not a search outage
- missing or invalid index is the point where `akm` drops to **substring search**
- no stash configured is the when local search is actually unavailable

That is a solid design.

It means `akm search` is not fragile. It just gets less smart as more pieces go missing.

## Commands That Usually Fix Things

Rebuild the index:

```bash
akm index
```

Force a full rebuild when semantic state, embeddings, or provider configuration changed:

```bash
akm index --full
```

Initialize the stash if none exists yet:

```bash
akm init
```

Run setup if semantic search is pending or not fully configured:

```bash
akm setup
```

## Final Note

The current implementation gets the important part right.

It does not confuse "semantic search degraded" with "search broken." It does not confuse "vector extension missing" with "semantic unavailable." And it does not force a hard failure when a softer fallback will still get the user where they need to go.

That is exactly the kind of behavior you want in a tool that is supposed to help you find things instead of becoming one more thing you have to troubleshoot.
