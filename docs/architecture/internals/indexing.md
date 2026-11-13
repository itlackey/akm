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
3. **Persist.** `persistDirRecords` writes every drained directory in one transaction: the `entries` row, its `entries_fts` row, its `entry_fragments` row, and its `asset_links` rows. A changed embedding input deletes the entry's vector. Rows for files that left a directory are deleted in the same transaction. The same transaction records which library the rows are for (`index_meta.stashDir` and `stashDirs`): that is what makes the index usable (see [Usable index](#usable-index)). It takes the write lock up front (`BEGIN IMMEDIATE`), so a writer that overlaps it waits out the busy timeout instead of failing at once.
4. **Reconcile.** When every source was scanned completely, rows belonging to removed sources are dropped. With `--clean`, rows whose file is gone are deleted (`--dry-run` previews them; unreadable files keep their rows).
5. **Embed.** `runEmbeddingPass` generates vectors for entries without one under the configured model, then verifies semantic search state.
6. **Finalize.** Rebuild `entries_fts` if its totals are stale, re-link `state.db` usage events to the new entry ids, recompute `utility_scores` in one `index.db` transaction (improve and `akm doctor metrics` read utility; search ranking does not), clear orphaned `llm_enrichment_cache` rows, and (after a complete scan) record `builtAt` and `sourceOwners` in `index_meta`. Then `VACUUM` if due, and append an `index_completed` event with the phase timings.

The command returns the entry count, per-phase timings, warnings, the `--clean` result, and a `verification` block with `semanticStatus` (`disabled`, `pending`, `ready-js`, or `blocked`). The run computes it (`verifyIndexState`) and records it in `index_meta` under `semanticSearch` (`unavailable` when the local runtime could not be downloaded or loaded), which `akm doctor`'s `semantic-search` check reads.

## Modes

- **Incremental** (default). A run is incremental when the index was built before for the same bundle directory. A directory is skipped when its file-set fingerprint, mtimes, and adapter variant (`<adapter id>@<version>`) match the stored `index_dir_state` row. In a drained directory a file whose content hash, path, and adapter are unchanged keeps its stored row, vector, and enrichment.
- **Full** (`--full`, or the first run for a bundle directory). Drains every directory and upserts every entry. Upserts preserve `entries.id`, so vectors, utility scores, and usage links stay attached to unchanged entries.
- `--reembed` discards every stored vector and re-embeds all entries.
- `--skip-if-locked` exits 0 without indexing when another build holds the rebuild lock; without it `akm index` waits for that build, then builds.

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

## Who builds the index

One function builds the live index: `buildIndex` (`src/indexer/index-build.ts`). It takes the rebuild lock, `$DATA/index.rebuild.lock` (`src/indexer/index-rebuild-lock.ts`, PID liveness only, a dead holder is reclaimed at once), runs `akmIndex`, and releases the lock. At most one build runs at a time on a host. It has two modes:

| Mode | Callers | When a live process holds the lock |
| --- | --- | --- |
| `wait` | `akm index`, `akm setup`, `bundle add`, `bundle update`, `bundle remove`, `source add` | Prints a notice, polls every 100 ms, repeats the notice every 15 seconds, and builds when the lock frees. After 10 minutes (the asset mutation lease's bound) it fails with `INDEX_DB_CONTENDED` (exit 75). |
| `try` | `akm index --skip-if-locked` (the shipped `index-refresh` task), `improve`'s pre-run index and its reindex after memory cleanup | Does not build. `akm index` exits 0 with `skipped`; `improve` plans on the entries the index has and adds a warning. |

`akm upgrade` spawns a plain `akm index`, which waits. Reads never build: see below.

## Usable index

An index is usable for a library when the keyword data for it is persisted: the `entries` table exists and `index_meta.stashDir` or `stashDirs` names the library. The persist transaction writes both with the entries and their FTS rows, so a build that is still embedding, was interrupted after the scan, or had one source fail is usable, and so is an empty library that was indexed (akm#1469). An index an older akm finished has the same two keys, so it is usable with no migration. `openUsableIndex` (`src/indexer/index-readiness.ts`) is the one check; `search`, `curate`, `feedback` and write-through all use it.

`builtAt` is not part of usable. It is the incremental watermark, written when a build completes with a complete scan. A persist for a different library clears it.

## How reads degrade

Reads (`search`, `curate`, `show`, the in-process API, Desktop) never build and never wait. They exit 0 in every case below:

- **Usable, `builtAt` set.** Served as it is.
- **Usable, no `builtAt`** (the first build is still embedding, was interrupted, or a source failed). Keyword results are served with one warning: results may be incomplete, and semantic results arrive when a build completes.
- **No usable index** (no file, no schema, nothing persisted for the library, built for another library, a corrupt file). An empty result with one warning: there is no search index for this library yet, run `akm index`. When a live process holds the rebuild lock the warning says a build is running instead.
- **`show`.** The asset is resolved from the bundle's files first: the index-free owner lookup (`resolveConceptOwner`) and the owning adapter's `recognize`. The index adds only what it alone has (links, indexed fragment context, usage ids) when a row exists. `--context lead` without a row shows the exact section and warns. Not found means no file resolves.

Two refusals are not "no index" and still raise: an index file akm may not read (`DATA_DIR_UNREADABLE`) and an index laid out by a newer akm (`INDEX_SCHEMA_INCOMPATIBLE`, exit 78).

## Locks

- `$DATA/index.rebuild.lock`: see [Who builds the index](#who-builds-the-index).
- `$DATA/index.db.write.lock` (`src/indexer/index-writer-lock.ts`) serializes writes to authored content (`remember`, `import`, source updates, proposal apply). Indexing does not take it.
- `indexWrittenAssets` (the immediate upsert after `remember`, `import`, `proposal accept`, and similar) upserts whenever a usable index exists. It does not look for a build: it waits up to 5 seconds for the write lock and, if a build holds it longer, skips and fails open. A write that overlaps a build can be missed by it, and the next build indexes it from the directory fingerprints it takes.
- Only a build, which holds the rebuild lock, deletes and rebuilds a corrupt `index.db`. Any other opener raises the corruption error; readers treat it as "no usable index".

## Embedding phase

`generateEmbeddingsForDb` (`src/indexer/materialize-embeddings.ts`) embeds each entry's own search text. Fragments are not embedded. Knobs are under `embedding.*` in [Configuration](../../reference/configuration.md).

- **Model per row.** Each `embeddings` row records the fingerprint it was made under (`remote:<model>|<dimension>` for an endpoint, `local:<localModel>` otherwise; the endpoint URL is not part of it). `index_meta.embeddingFingerprint` holds the configured one. An entry is embedded when it has no row for that fingerprint, so a model change re-embeds entry by entry and an interrupted run resumes. Readers serve only the configured model's rows.
- **Per-document cap.** Text is cut to `embedding.maxInputTokens` (default 512, estimated at 4 characters per token) before batching; the run reports how many entries were cut. Text past the cut never reaches the embedder, so a change there rewrites the entry's keyword rows and keeps its vector. The run opens with `Embedding N changed entries (M unchanged)`.
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
- On `SQLITE_CORRUPT` a build deletes the file and rebuilds it. `state.db` is not touched.
