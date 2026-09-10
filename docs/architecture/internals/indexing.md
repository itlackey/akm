# Indexing

`akm index` builds and refreshes the local SQLite search index. The design is
the index redesign (`docs/plans/index-redesign.md`,
`docs/plans/index-redesign-contract.md`): everything derived from a file is
keyed by the hash of what it was derived from, so an unchanged file never
re-derives anything and a vector is never re-computed for text the provider
has already embedded. `akm index` itself is just **reconcile, then drain**:
diff the filesystem against `index.db`, then work through whatever the
embedding queue still owes. There is no phase pipeline, no directory
fingerprint cache, and no index rebuild lock.

By default, reconcile also runs an LLM metadata-enrichment pass over newly
added or changed entries when an engine is configured (`defaults.llmEngine`,
or `index.enrichment.engine` overriding it) and `index.enrichment.enabled` is
not `false`. There is no top-level `llm` config key in 0.9 — it is retired
and hard-rejected at load; per-call tuning lives on each named engine under
`engines.<name>.*`.

## Content-addressing

Everything the index derives is keyed by the hash of its own input, not by a
row id or a config string:

- A file's bytes hash to `blob_hash` (`files.blob_hash`, `entries.content_hash`).
  An unchanged file (same `size`/`mtime_ms` on the next stat) is never
  re-parsed; a changed one is re-hashed and, only if the hash actually moved,
  re-parsed.
- A parsed document's units (the card unit; one unit per Markdown fragment)
  hash to `unit_hash` (`unit_texts.unit_hash`, `INSERT OR IGNORE`) — the same
  text produced by two different files, or the same file before and after an
  unrelated edit elsewhere, is stored once.
- A vector hashes to `(unit_hash, identity)`, where `identity` is what the
  embedding provider's response actually reported (model id and vector
  width), not the operator's config string. A rename of `embedding.model`
  that still resolves to the same server-reported model needs no re-embed; a
  genuine model or dimension change is a different identity, so its units are
  simply "missing" for that identity and the drain queue picks them up —
  there is no separate rename-compatibility check.

A generation bump (a schema change to `entries`) re-derives only what its
schema actually touched; it never forces a re-embed, because vectors are
never keyed by anything the generation bump changes.

## `files` and reconcile (`src/indexer/reconcile.ts`)

`files` (`storage/repositories/files-repository.ts`) is the stat cache:
`(path, bundle_id, size, mtime_ms, blob_hash, adapter_id)`, one row per file
that currently has an `entries` row. `reconcileRoots(db, roots, opts)` stat-
walks every configured root and, per file:

- **Unchanged** (`size`/`mtime_ms`/adapter id all still match the stored
  row): skipped entirely — no hash, no parse.
- **New or changed**: hashed; if the hash is new, parsed with the same
  per-file document parser the walker uses (`scan/parse-file.ts`'s
  `parseFileDocument`, extracted so there is exactly one parser, not a
  drifting pair); `entries` is upserted (`content_hash` = the blob hash);
  units are derived (`deriveUnits`, `src/indexer/units/unit.ts`) bounded by
  the embedding provider's real window (`unitMaxChars(probeProviderLimits(...))`,
  probed once and cached for the run — never truncated, split into ordinal
  sub-units instead when a unit would exceed it); new hashes are inserted
  into `unit_texts`/`units_fts`; `entry_units` is replaced for that entry.
- **Gone**: the `entries` row is deleted (cascading `entry_units`); `files`
  loses the row.
- **Same-bundle rename**: a gone path whose last known `blob_hash` matches a
  changed/new path's freshly-parsed hash is re-pointed with one `UPDATE` of
  the existing `entries` row rather than delete-then-insert, so the row keeps
  its id (and anything keyed off it, e.g. usage history) across the move.
  Note: the canonical name — and therefore every unit's header line — is
  derived from the file's path, so a rename still changes every unit's hash;
  "no re-derive" here means the `entries` row is updated in place, not that
  its units are reused.

Orphaned `unit_texts`/`units_fts` rows (no `entry_units` mapping references
the hash any more) are swept once at the end of the run with a single
`NOT EXISTS` delete; vectors (`units`/`units_vec`) are never touched by this
sweep — a hash that comes back later resumes serving search with no
re-embed.

Every write is its own short `BEGIN IMMEDIATE` transaction — one per file (or
small group), never one transaction for the whole run — so two processes
reconciling the same root serialize file-by-file and converge on the same end
state instead of one clobbering the other's snapshot. `reconcileRoots` is
idempotent: a second run against an unchanged tree touches no row. A stat
walk of tens of thousands of files takes well under a second, so reconcile
runs at the start of `akm index` and any other command that reads the index
when the tree may have moved.

`reconcilePaths(db, paths, bundleId, opts)` is the same per-file step scoped
to a known list of paths — the write paths (below) call it directly instead
of walking the whole tree.

## Units and stores

`unit_texts` holds every distinct piece of text the index ranks, keyed by
`unit_hash`: one **card** unit per entry (name, description, tags, hints,
parameters — `structuredFieldsText`, `src/indexer/units/unit.ts`) and one
**fragment** unit
per Markdown section (a header line — entry name, then `›` and the section
title — plus the section body). `units_fts` is FTS5 (`porter unicode61`)
over the same text, written alongside it. `entries` keeps only what other
commands need to read directly: ref, `blob_hash`, provenance, the parsed
`document_json`, and `search_text` (kept for the legacy per-entry
change-detection path below — it is no longer itself a search index).
`entry_fragments` (the safe-rendered Markdown source, not an FTS index)
survives unchanged: it is what a matched fragment hit's display metadata is
projected from and what `akm show <ref>#<fragmentId>` resolves through.

`units` and `units_vec` (the vec0 virtual table) are the **one** vector
store, keyed by `(unit_hash, identity)`. Only one identity is ever kept live:
adopting a new one drops every row under a different identity
(`dropOtherIdentities`). There is no BLOB-table fallback for a unit vector —
`units_vec` requires the `sqlite-vec` extension outright. `entry_units`
(`entry_id, ordinal, fragment_id, unit_hash`) is the cheap, derived mapping a
reconcile rebuilds for the entry; ordinal 0 is always the card unit, fragment
units follow in document order.

The pre-redesign per-entry vector tables (`embeddings`, `entries_vec`) are
still declared in the schema and dimension-tracked, but nothing on the
reconcile/drain path writes to either any more; see [Database
Tables](#database-tables) below for what still reads them and why they have
not been dropped yet.

Full table shapes are in [Storage
Locations](storage-locations.md#dataindexdb--main-search-index).

## LLM Enrichment Pass (on reconcile)

Metadata enrichment (`src/indexer/enrich.ts`) is folded into reconcile, not a
separate phase: after `reconcileRoots` has upserted every added or changed
file for a run — every per-file transaction already committed, since a
provider call must never run inside one — it hands the batch of
"generated"-quality, not-yet-complete entries (`isEnrichmentComplete`) to
`enrichReconciledEntries`, gated on `index.metadataEnhance.enabled` (checked
per call, inside `enhanceMetadata`) and an engine resolving for the
`enrichment` pass (`resolveIndexPassExecution("enrichment", config)` —
`index.enrichment.engine` or `defaults.llmEngine`). A resulting
`quality: "enriched"` entry and its re-derived units are written back through
the same `upsertEntry` + `deriveUnits`/`replaceEntryUnits` machinery
`reconcileRoots` itself uses, in one more short transaction, before drain
embeds the enriched text.

**Content-addressed cache** — `llm_enrichment_cache` is consulted with
`asset_ref = body_hash = ` the file's `blob_hash` (`entries.content_hash`),
so a cache hit means "this exact byte content has already been enriched"
regardless of which entry (or how many identically-named-but-different
entries) currently carries it, and survives a rename untouched. `akm index
--full` re-parses every file, so an unchanged file becomes a candidate again
on every `--full` run — but its blob hash is unchanged, so this is a cache
hit with no new provider call, falling out of content-addressing with no
special-cased branch.

**Fail-soft** — a provider error or a closed `metadata_enhance` feature gate
writes no cache row and never sets `quality: "enriched"`, so a transient
outage can never poison an entry into a permanent enrichment skip; only a
genuine `ConfigError` (a required symbolic credential that resolved to
nothing) escapes fail-soft handling and aborts the run.

**Concurrency** — candidates are enriched through a bounded pool
(`concurrentMap`). The pool width defaults to 2 for remote LLM endpoints and
1 for local model servers (localhost endpoints — one loaded model at a
time), auto-derived by `getDefaultLlmConcurrency` (`src/indexer/indexer.ts`;
`enrich.ts` mirrors the same classifier directly to avoid an import cycle
back into `indexer.ts`). `engines.<name>.concurrency` is a valid schema
field, but it is **not honored** on this path — the engine resolver used
here never copies `concurrency` into the resolved connection. Individual
candidate failures are isolated; the pool continues with remaining work.

**Eligibility** — only entries with `quality: "generated"` and missing
`description`/`tags`/`searchHints` are enriched (`isEnrichmentComplete`).
Entries with `quality: "curated"`, `"manual"`, `"proposed"`, or already
`"enriched"` this run are never candidates.

## Drain: the embedding queue (`src/indexer/drain.ts`)

Embedding is a queue, not a phase: the pending set is `unit_texts.unit_hash`
minus `units` for the active identity (`index_meta.embeddingIdentity`) —
`listMissingHashes`, a set difference recomputed fresh on every call, never a
persisted dirty list. When no identity is known yet (a fresh index, or one
whose prior identity was just dropped), every candidate hash is pending; the
identity is learned from whichever provider response lands first
(`deriveObservedEmbeddingIdentity`) and adopted from then on, dropping any
stale identity's rows.

`drainEmbeddingQueue(db, config, opts)` reuses `embedBatch` / `RemoteEmbedder`
(`src/llm/embedder.ts`, `src/llm/embedders/remote.ts`) for the batching,
retry, back-off, and circuit-breaker machinery — this module's own job is the
pending set, the identity, and turning each provider batch into a durable
`upsertUnitVectors` write, one short transaction per batch (never buffered
and written all at once — a killed run loses at most one in-flight batch, and
the next call recomputes the same "still missing" query). Requests are
packed against the provider's own probed window and slot count
(`probeProviderLimits`, `src/llm/embedders/provider-limits.ts`) rather than a
generic config default — window, slots, exact token counts where the
provider offers a tokenizer endpoint. See [Configuration →
Semantic search](../../reference/configuration.md#semantic-search) for the
full packing, timeout, retry, split-and-retry, and circuit-breaker detail,
which is unchanged by this redesign: only what feeds it (units instead of
whole entries, probed limits instead of four retired config keys) moved.

`opts.onlyHashes` restricts the candidate set to exactly the given hashes,
still filtered down to what is genuinely missing — the write-time path
(below) uses this to embed only the units a just-written asset added.
`opts.limit` caps how many missing units one call embeds, leaving the rest
pending for a later call. `opts.onProgress` receives one line per provider
batch and a final `[drain] done: ...` summary line with counts.

**Credential diagnostic (#953)** — before the first provider request this
call makes (only when there is a remote endpoint configured and something is
actually pending), one default-level line names the endpoint, model, and the
credential's SOURCE — `secret://...`, `$VAR`, `literal apiKey`, or
`none configured` — never the resolved value: `[embed] endpoint <url>, model
<model>; credential: <source>`. Every `RemoteEmbedder` path already resolves
`secret://...` through one boundary, so a keyless request can only mean
`embedding.apiKey` was absent from the config this run actually loaded; this
line lets a field run self-diagnose that without ever surfacing the secret
itself. Under `--verbose` the same line also names the loaded config file.

`akm index` is `reconcileRoots` then `drainEmbeddingQueue`; the scheduler's
`index-refresh` task drains the same way; a write path (below) drains only
the few units it just created.

## Write-time indexing (`src/indexer/index-written-assets.ts`)

Every akm path that writes an asset indexes what it wrote, inline, in the
same call as the write — `remember`, `import`, extract's session-asset
capture, `source clone`, and proposal accept all call `indexWrittenAssets`
right after committing their file write. It is a thin wrapper: `reconcilePaths`
for exactly the written paths, then `drainEmbeddingQueue` scoped
(`onlyHashes`) to exactly the unit hashes that reconcile just produced or
touched (`entries.file_path IN (paths) → entry_units → unit_hash`). No lock
probe, no rebuild detection, no background spawn — the redesign has no
full-rebuild pipeline for a write path to defer to.

Fail-open at every step: an absent or empty index is skipped on purpose
(bootstrap belongs to the first read or an explicit `akm index`); any other
error (an unreadable index, an unparseable file, a locked database past a
5-second busy timeout) is reduced to a verbose-only warning and the write
command still succeeds — the asset appears after the next reconcile instead
of immediately. The one exception is an index directory/file that exists but
cannot be **read** at all (not merely absent): that failure will not heal on
its own on the next reconcile, so it warns audibly and the caller-visible
result reflects it. A failed embedding drain here is always best-effort: the
write is already lexically searchable via reconcile, and the embedding queue
is durable — any later drain, including the next write, picks up the same
"no vector yet" units.

## No index locks

Every index write — reconcile's per-file upsert, drain's per-batch vector
commit — is an idempotent, content-addressed insert or re-point inside a
short `BEGIN IMMEDIATE` transaction under WAL with SQLite's own busy timeout.
Two processes doing the same reconcile converge on the same rows instead of
fighting over a lock, so the rebuild lock, the index-path branch of the
maintenance barrier, and their exit-code special cases are gone entirely —
there is no full-rebuild concept left for a lock to protect. `core/
maintenance-barrier.ts` itself still exists, but no index-path caller
acquires it any more; it now only serializes `akm improve`'s own run lock,
the workflow-run-start barrier, and lockfile integration, all unrelated to
indexing.

The asset-mutation lease (`src/indexer/index-writer-lock.ts`,
`index.db.write.lock`) is a different, still-live mechanism: it serializes
writes to real, authored user content (source updates, `remember`, proposal
apply) so two concurrent writers cannot both pass a git exact-path preflight
before either commits. It has been unrelated to indexing since #872 removed
the index rebuild's own use of it, and it stays under AGENTS.md's
Defensive-Code rule — it guards against a lost or conflicting git commit, not
against contention on a fully regenerable cache.

Genuine `SQLITE_BUSY` — a second connection holding a write transaction long
enough to exhaust the driver's own busy timeout — stays a real, if now rare
(writes are tiny and short-lived), transient condition. `reclassifyIndexDbContention`
(`src/indexer/indexer.ts`) turns the raw SQLite driver error escaping
reconcile or drain into `TransientError` / `INDEX_DB_CONTENDED` (exit 75)
instead of an unclassified exit 70, mirroring `STATE_DB_CONTENDED`'s
precedent for `state.db` — a scheduler can branch on "retry shortly" instead
of alerting.

`--skip-if-locked` is accepted with a deprecation warning and does nothing:
index runs no longer take a rebuild lock, so there is nothing left to skip
around. It is kept only so an existing script or scheduled task does not
fail on an unknown flag.

## Search

Search runs one query over `units`: a lexical rank from `units_fts` (BM25)
and a semantic rank from `units_vec` for the active identity, fused by
reciprocal rank (`RRF_K = 60`, Cormack, Clarke & Buettcher 2009) so no weight
or threshold is hand-tuned, grouped to entries by each list's best-ranked
unit, with the matching unit carried on the hit. Type filters apply to
entries as before. See `src/indexer/search/db-search.ts` and `ranking.ts`
for the exact grouping/fusion/contributor mechanics — this module is
maintained separately from the index-redesign work described above.

## `akm index` flags and `index status`

`akm index` = reconcile + drain. `akm index --full` forces every walked file
to be treated as needing re-derivation (the stat-hint "unchanged" shortcut is
skipped, so every file is re-parsed), but each file's existing `entries` row
is updated in place, not deleted and reinserted — it keeps its id, its
vectors, and its learned utility scores. Content-addressed units are never at
risk from a reindex at all, `--full` included: there is nothing to re-embed
for unchanged content. `akm index --reembed` drops the active embedding
identity's vectors (`dropActiveIdentityVectors`), then the next drain
re-embeds every unit from scratch under that identity. `--enrich`/
`--re-enrich` were removed with the old phase pipeline (plain `akm index` now
always performs metadata enrichment; re-enrichment of index-time LLM passes
is not exposed in this slice) and are rejected with a `UsageError` naming the
replacement; `--clean`/`--dry-run` were removed the same way — every run
already removes stale entries as part of reconcile, the work `--clean` used
to opt into.

`akm index status` (`src/commands/sources/index-status.ts`) is a cheap,
read-only snapshot: files tracked, entries, distinct units referenced by the
current `entry_units` mapping, how many of those have a vector for the
active identity (and therefore how many are still pending), the active
identity string, and the last reconcile/build times. It mirrors `akm info`'s
absent/inaccessible handling: a missing index reads as the ordinary
first-run state (all zeros), and an index that exists but cannot be read is
reported as `unreadable`, never silently presented as empty.

## Schema Versioning

`index.db` is ephemeral — fully rebuildable from sources by `akm index`. The
current generation is exactly v24. `ensureSchema()`
(`src/storage/repositories/index-schema.ts`) accepts an existing generation
only when `index_meta.version`, the complete `entries` fingerprint, and the
`entry_fragments` logical surface match the canonical contract
(`src/storage/repositories/index-entry-schema.ts`); `files`/`unit_texts`/
`units_fts` are fingerprinted separately by their own schema ensure
(`files-repository.ts`), not by this generation check. An incompatible
generation is discarded: AKM drops the entry-dependent derived tables and
caches, creates the canonical v24 schema, and `akm index` repopulates it from
current sources and durable usage state. `entries_fts` and
`entry_fragments_fts` (both FTS5 virtual tables) were dropped going into v24
— lexical search runs entirely over `units_fts` now, so an entry-level
lexical query is a units query grouped by entry, and a fragment-level query
is the same table filtered to fragment-kind units; `entry_fragments` itself
(the safe-rendered Markdown source, not an index) stays, since a matched
fragment hit's display metadata and `akm show <ref>#<fragmentId>` both
consume it independently of what table search queries. Current read-only and
existing-database openers reject an incompatible generation instead of
serving it. Durable workflow, task, proposal, event, and usage state in
`state.db` is never touched by this path.

Workflow `.md` and `.yml` adapters compile directly to source IR version 1.
The index stores only the ordinary normalized `entries` row and searchable
metadata derived from that IR. It does not cache a second workflow AST or an
executable plan. Starting a run recompiles the authored source once and
freezes the sole durable plan format into `state.db`.

## Database Tables

Full column-level detail lives in [Storage
Locations](storage-locations.md#dataindexdb--main-search-index); this is a
purpose summary of what `ensureSchema()` creates:

| Table | Purpose |
| --- | --- |
| `files` | Stat cache reconcile diffs against: `(path, bundle_id, size, mtime_ms, blob_hash, adapter_id)` |
| `entries` | Normalized asset records (narrowed — no longer the search index itself) |
| `entry_fragments` | Safe Markdown projection retained per parent entry, for fragment display/resolution — not an FTS index |
| `unit_texts` | Content-addressed text for every card/fragment unit |
| `units_fts` (virtual, FTS5) | Lexical index over `unit_texts` |
| `units` / `units_vec` (virtual, vec0) | The one vector store, keyed by `(unit_hash, identity)` |
| `entry_units` | Derived entry → ordinal → unit_hash mapping |
| `embeddings` / `entries_vec` (virtual, conditional) | Legacy per-entry vector tables — still schema-declared, unpopulated by anything on the reconcile/drain path; see [Storage Locations](storage-locations.md#legacy-tables-embeddings-and-entries_vec-conditional) |
| `utility_scores` / `utility_scores_scoped` | Recomputed utility boost state (global, and per project-anchor) |
| `index_meta` | Schema/version/runtime metadata, including `embeddingIdentity` and reconcile/build timestamps |
| `llm_enrichment_cache` | Cached LLM enrichment/graph-extraction/memory-inference results |
| `registry_index_cache` | Cached registry index JSON |
| `graph_meta` / `graph_files` / `graph_file_entities` / `graph_file_relations` / `graph_extraction_queue` | Per-bundle knowledge-graph extraction state |

`usage_events` (search/show/feedback telemetry) and workflow runtime state
both live in `state.db`, not `index.db`, so rebuildable search state remains
separate from durable runtime state.

## Metadata Sources

AKM treats file-derived metadata as the primary runtime source. It derives
metadata from signals such as:

- frontmatter
- comments / headers
- filenames
- `package.json`
- renderer-specific extraction (workflow params, TOC, vault key hints, wiki metadata)

The live indexer no longer reads `.stash.json` at all — since the 0.9.0
cutover it is a migrator-only concern: the storage migrator folds each
sidecar's overrides into the asset's inline metadata (frontmatter or header
comments) and deletes the sidecar. See
[Storage Locations](storage-locations.md).

## Parameters

Structured parameters can come from:

- command placeholders (`$ARGUMENTS`, `$1`-`$9`, `{{named}}`)
- frontmatter `params`
- script comment extraction
- workflow markdown parameters

Parameter names and descriptions are stored structurally in `document_json`
(read by `akm show` and by execution) and folded into `entries.search_text`.
They are also part of the card unit (index-redesign B5g): `structuredFieldsText`
(`src/indexer/units/unit.ts`) appends one line per parameter after hints —
just the name, or `name: description` when the parameter has one — so a
parameter's structured name/description is retrievable via lexical (and
semantic) search through `units_fts`/`units_vec`, not only via `akm show`.
TOC headings stay out of the card unit on purpose: a fragment unit already
carries its own section's heading as the first line of its header whenever
the fragment begins at that heading, so folding every heading into the card
unit too would only inflate it without adding coverage.

## Quality Values

The `quality` field on an index entry tracks how its metadata was produced.
Well-known values (defined in `src/indexer/passes/metadata.ts`):

| Value | Meaning |
| --- | --- |
| `"generated"` | metadata derived automatically from file content |
| `"enriched"` | metadata produced by or updated via an LLM enrichment pass |
| `"curated"` | metadata written or explicitly approved by a human |
| `"proposed"` | metadata from a proposal awaiting review |

The `"enriched"` marker is set after a successful metadata enrichment pass
during reconcile and prevents unnecessary re-enrichment on the next run (see
LLM Enrichment Pass above).

## Utility Recomputation

Utility scores are rebuilt from `usage_events`.

- old events are purged on a rolling window
- event history is preserved through schema resets/full rebuilds
- decay is based on elapsed time, not on how often indexing runs
- utility is a secondary boost, not the primary ranking signal

## Semantic Search Integration

- semantic readiness is read live from `index.db` at call time
  (`index_meta.embeddingIdentity` and unit coverage for it), never a cached
  verdict file — `$CACHE/semantic-status.json` is no longer written or read
- provider identity is derived from what the provider's response actually
  reported (model id, vector width), not a config-derived fingerprint —
  moving the same model+dimension to a different host, or an
  endpoint/gateway rename that resolves to the same underlying model, needs
  no rebuild
- `sqlite-vec` is required for the unit vector store — there is no JS-cosine
  fallback for `units_vec` the way the legacy per-entry `embeddings` table
  once provided (`"ready-js"` is a retired runtime status; nothing produces
  it any more)
