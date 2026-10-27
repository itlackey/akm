# Indexing

`akm index` builds and refreshes the local SQLite search index (`$DATA/index.db`).
Metadata is derived from the files themselves (`src/indexer/passes/metadata.ts`);
no LLM runs during indexing. The entry point is `akmIndex` in
`src/indexer/indexer.ts`.

There is no top-level `llm` config key: it is an unknown key, named once and
ignored. Per-call tuning lives on a named connection under
`connections.<name>.*` (see
[Configuration](../../reference/configuration.md#connections)).

## Pipeline

1. **Preflight.** Open `state.db` (this applies pending migrations), materialize sources not yet on this host (`ensureSourceCaches`: a `git` or `website` source is fetched into `$CACHE` only if it has never been materialized here; an `npm` bundle with no lock entry is skipped with a warning naming `akm bundle update`; nothing refreshes on a timer), resolve the source list, and detect each bundle's adapter. Detected adapter ids are persisted to the config (reported as `configUpdated.detectedAdapters`).
2. **Walk.** `scanSourceDirs` walks each source (`walkStashFlat`, `src/indexer/walk/walker.ts`), groups files by directory, and decides per directory whether it can be skipped. A directory that is drained has each file recognized by its bundle's adapter (`adapter.recognize`, see [Classification](classification.md)).
3. **Persist.** `persistDirRecords` writes every drained directory in one transaction: the `entries` row, its `entries_fts` row, its `entry_fragments` row, and its `asset_links` rows. A changed embedding input deletes the entry's vector. Rows for files that left a directory are deleted in the same transaction.
4. **Reconcile.** When every source was scanned completely, rows belonging to removed sources are dropped. With `--clean`, rows whose file is gone are deleted (`--dry-run` previews them; unreadable files keep their rows).
5. **Embed.** `runEmbeddingPass` generates vectors for entries without one under the configured model, then verifies semantic search state.
6. **Finalize.** Rebuild `entries_fts` if its totals are stale, re-link `state.db` usage events to the new entry ids, recompute `utility_scores` (improve and `akm metrics` read utility; search ranking does not), clear orphaned `llm_enrichment_cache` rows, and (after a complete scan) record `builtAt`, `stashDir`, `stashDirs`, and `sourceOwners` in `index_meta`. Then `VACUUM` if due, and append an `index_completed` event with the phase timings.

The command returns the entry count, per-phase timings, warnings, the `--clean` result, and a `verification` block with `semanticStatus` (`disabled`, `pending`, `ready-js`, or `blocked`). The run computes it (`verifyIndexState`) and records it in `index_meta` under `semanticSearch` (`unavailable` when the local runtime could not be downloaded or loaded), which `akm health`'s `semantic-search` check reads.

## Modes

- **Incremental** (default). A run is incremental when the index was built before for the same bundle directory. A directory is skipped when its file-set fingerprint, mtimes, and adapter variant (`<adapter id>@<version>`) match the stored `index_dir_state` row. In a drained directory a file whose content hash, path, and adapter are unchanged keeps its stored row, vector, and enrichment.
- **Full** (`--full`, or the first run for a bundle directory). Drains every directory and upserts every entry. Upserts preserve `entries.id`, so vectors, utility scores, and usage links stay attached to unchanged entries.
- `--reembed` discards every stored vector and re-embeds all entries.
- `--skip-if-locked` exits 0 without indexing when another `akm index` holds the rebuild lock.

## Walking

`walkStashFlat` lists files with `git ls-files --cached --others --exclude-standard` when the source sits inside a git repository (so `.gitignore` applies), plus a second `git ls-files --others --ignored` listing for `env/` and `secrets/` so git-ignored env and secret assets are still indexed, and with a directory walk otherwise. Both skip `.git`, `node_modules`, `bin`, `.cache`, and dot-directories, unless the adapter asks to see every directory (OKF does). A symlink to a file is indexed like any other file; a symlinked directory is never descended.

## Search fields

`buildSearchFields` (`src/indexer/search/search-fields.ts`) builds the five `entries_fts` columns:

| Column | Contents |
| --- | --- |
| `name` | asset name, with `-` and `_` replaced by spaces |
| `description` | description |
| `tags` | tags and aliases |
| `hints` | hints, `searchHints`, `examples`, `usage`, intent text, `xrefs`, `pageKind`, `whenToUse` |
| `content` | table-of-contents headings, parameter names and descriptions, and the body projection |

The body projection is the body text the adapter provides; for native Markdown it is bounded by `MARKDOWN_CONTENT_MAX_CHARS` (1,000,000 characters) and truncation is reported as a warning. Fenced code contributes only its identifiers, never its literal values (`fencedCodeIdentifiers`, akm#1260). The projection's version, `CONTENT_PROJECTION_VERSION`, is part of every directory's index fingerprint, so changing what the projection returns re-projects every directory once on the next `akm index`. `env`, `session`, and `secret` entries get no native body projection. `buildSearchText` joins the same fields into the text each entry's vector is made from.

Lexical retrieval is one `OR` query over the query's tokens (Unicode letters and numbers, NFKC-normalized, lowercased, English stopwords removed; a query of only stopwords keeps them), ranked by BM25 with equal column weights. A query that is a ref prefix (`skills/`, `bundle//`) enumerates a subtree and skips FTS. Ranking fuses the lexical and vector lists with reciprocal rank fusion; see the Search Pipeline in [Architecture](../architecture.md).

## Metadata sources

Per file, in priority order: `package.json` description and keywords from the file's directory; Markdown frontmatter (including `params`, and `$ARGUMENTS`, `$1`-`$9`, `{{named}}` placeholders in commands); script `@param` and header-comment metadata; renderer-specific metadata (workflow parameters, table of contents, wiki fields); then filename-derived description, tags, and aliases as fallbacks. `.stash.json` files are skipped.

Workflow `.md` sources compile to source IR version 1. The index stores the ordinary `entries` row and metadata derived from that IR, not a workflow AST or a plan; starting a run recompiles the source and freezes the plan in `state.db`.

## Two files, one ref

Two files in one source can claim one ref (a skill's `references/a.md` and
`knowledge/skills/x/references/a.md` are both `knowledge/skills/x/references/a`).
The index holds one row: the file with the smaller path (code-point order) wins, regardless of walk order.
`akm index` lists each pair in `warnings`. `akm show` refuses the ref with `RESOURCE_ALREADY_EXISTS`;
search returns the indexed file.

## Locks

- `akm index` takes `$DATA/index.rebuild.lock` (`src/indexer/index-rebuild-lock.ts`). It is advisory: a plain `akm index` that finds it held warns and proceeds; `akm index --skip-if-locked` (the shipped `index-refresh` task uses it) exits 0. The holder is reclaimed only when its PID is dead.
- `$DATA/index.db.write.lock` (`src/indexer/index-writer-lock.ts`) serializes writes to authored content (`remember`, `import`, source updates, proposal apply). Indexing does not take it.
- `indexWrittenAssets` (the immediate upsert after `remember`, `import`, `proposal accept`, and similar) returns without indexing when the rebuild lock is held; the running rebuild picks the change up.
- `ensureIndex` (`src/indexer/ensure-index.ts`) builds the index inline on first use when it is missing, empty, or built for a different bundle. Otherwise reads serve the existing index without a freshness walk; `improve` checks freshness and rebuilds inline.

## Embedding phase

`generateEmbeddingsForDb` (`src/indexer/materialize-embeddings.ts`) embeds each entry's own search text. Fragments are not embedded. Knobs are under `embedding.*` in [Configuration](../../reference/configuration.md).

- **Model per row.** Each `embeddings` row records the fingerprint it was made under (`remote:<model>|<dimension>` for an endpoint, `local:<localModel>` otherwise; the endpoint URL is not part of it). `index_meta.embeddingFingerprint` holds the configured one. An entry is embedded when it has no row for that fingerprint, so a model change re-embeds entry by entry and an interrupted run resumes. Readers serve only the configured model's rows.
- **Per-document cap.** Text is cut to `embedding.maxInputTokens` (default 512, estimated at 4 characters per token) before batching; the run reports how many entries were cut.
- **Batching** (`RemoteEmbedder.embedBatch`, `src/llm/embedders/remote.ts`). Requests are bounded by `embedding.maxTokens` (default 6000 estimated tokens) and `embedding.batchSize` (default 100 documents).
- **Concurrency.** `embedding.concurrency` (1 to 16); unset, it is 1 for a loopback endpoint and 2 for a remote one.
- **Timeout.** `embedding.timeoutMs` (default 120000) is the budget for a full-size request; smaller requests get a proportionally smaller timeout, never below 30 seconds.
- **Rejected batches.** A batch rejected for exceeding the endpoint's context window (HTTP 413 or a recognized context-size error) is split in half and retried down to single documents; the first such rejection in a run also cuts the remaining request budget to three quarters. A timed-out request backs off (5 seconds, doubling to 60) and is retried once at the same size, then split.
- **Circuit breaker.** The pass stops after 3 consecutive failures at single-document size, or 3 consecutive network errors at any size, keeping every batch already committed.
- **Per-batch commit.** Each batch is written in its own transaction as it completes.

## Progress output

Text mode shows a spinner. `--verbose` prints every phase message to stderr. In `json`, `yaml`, and `jsonl` modes, phase messages and the embedding heartbeat (every 15 seconds) still reach stderr; the per-batch `Embedded N/M entries.` line is verbose-only. Source hydration reports `Hydrating source i/n: <name>` with a 15-second heartbeat. Each run also writes a log file under `$CACHE/logs/index/`.

## Tables and layout

`ensureSchema` creates ten tables (`index_meta`, `entries`, `entries_fts`, `entry_fragments`, `asset_links`, `embeddings`, `utility_scores`, `index_dir_state`, `llm_enrichment_cache`, `registry_index_cache`); columns are in [Storage Locations](storage-locations.md). `usage_events` and workflow run state live in `state.db`.

`index_meta.version` is the layout number, currently 26. It is a marker, not a gate:

- The writable opener (`ensureSchema`, `src/storage/repositories/index-schema.ts`) upgrades an older layout in place: it adds and drops columns, rebuilds `entries_fts` once if it is not contentless, drops the retired `entries_vec`, `entry_fragments_fts`, and `graph_*` tables, and derives `asset_links` from stored documents. It does not drop `embeddings`, `utility_scores`, or `llm_enrichment_cache`.
- An `entries` table older than layout 21 (no `item_ref`) has its entry-keyed tables recreated and re-walked; the LLM enrichment cache is kept.
- Read-only openers (`openExistingDatabase`, `openReadonlyExistingDatabase`) do not change the schema. They read an older layout as it is and refuse a newer one with `INDEX_SCHEMA_INCOMPATIBLE`.
- On `SQLITE_CORRUPT` the file is deleted and rebuilt. `state.db` is not touched.
