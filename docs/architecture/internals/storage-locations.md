# AKM Storage Locations

This document is the authoritative reference for every location on disk where akm reads or writes persistent data: databases, event streams, config files, asset files, caches, locks, and OS-native task scheduler entries.

## Path Variables

All paths below use these resolved base directories:

| Variable | Default (Linux/macOS) | Default (Windows) | Override |
|---|---|---|---|
| `$CONFIG` | `~/.config/akm` | `%APPDATA%\akm` | `AKM_CONFIG_DIR` |
| `$CACHE` | `~/.cache/akm` | `%LOCALAPPDATA%\akm` | `AKM_CACHE_DIR` |
| `$DATA` | `~/.local/share/akm` | `%LOCALAPPDATA%\akm\data` | `AKM_DATA_DIR` |
| `$STATE` | `~/.local/state/akm` | `%LOCALAPPDATA%\akm\state` | `AKM_STATE_DIR` |
| `$STASH` | `~/akm` | `%USERPROFILE%\Documents\akm` | `AKM_BUNDLE_DIR` |

akm uses four XDG-compliant directories. Durable data (`index.db`, `state.db`, `akm.lock`) lives in `$DATA`; the event log is stored in the `events` table in `state.db`.

---

## What May Live in `$STASH/.akm`

`$STASH/.akm` had no stated rule for what belongs there (itlackey/akm#889), and
accumulated 165 MB / 1,523 files of it — 82% (135 MB) was the pre-0.9.0
`.akm/proposals/` filesystem layout alone, superseded by the `proposals`
table in `state.db` back in 0.9.0. Migrations moved the writers; nothing ever
cleaned up the paths they left behind.

**The rule:** `$STASH/.akm` is for state that MUST travel with the content.
Everything else belongs in `$STATE`, `$CACHE`, or `$DATA`.

"Must travel with the content" means: a fresh clone of the bundle on another
machine, or a bundle synced via its own git remote, would lint or resolve
*differently* without this file present. A cache, a log, or a queue that
`akm` can rebuild or that only matters on the machine that wrote it does not
qualify — even if `akm` happens to write it while operating on that bundle.

**Confirmed exceptions (Tier 3 — correctly `$STASH`-local; do not move):**

- **`$STASH/.akm/memory-cleanup/`** (`belief-transitions.jsonl` + `archive/`)
  — the hard case. As of itlackey/akm#884, `memory-cleanup/archive/` is a
  **ref-resolution surface**: when a `contradictedBy` edge points at a memory
  that was later pruned, resolution falls through to that memory's tombstone
  in `memory-cleanup/archive/`. If the archive is not present, that edge
  resolves differently (or not at all) — so the same bundle would lint
  differently depending on which machine ran the check. It must travel with
  the bundle content itself, not live in a per-machine `$STATE`/`$CACHE` dir.
  It is also directly recoverable user data (pruned memory bodies). This
  correctness reason was previously undocumented; it only became load-bearing
  with #884.
- **`<cwd>/.akm/config.json`** — project-scoped config overrides, walked up
  from `cwd` to the filesystem root and merged. Deliberately local to the
  project tree, the same idea as `.editorconfig`.
- **`$STASH/.akm/cache`** — used only when `AKM_BUNDLE_DIR` points at a
  transient path, as an isolation safety net (`src/core/paths.ts`) so a test
  harness pointed at a scratch bundle root cannot silently clobber the
  developer's real `~/.cache/akm`. Not used in the normal (non-transient)
  case.

**Known-dead residue (Tier 1 — cleaned up by #889):** `.akm/proposals/`,
`.akm/runs.archived-<ts>/`, `.akm/archive/`, `.akm/graph.json`,
`.akm/consolidate-journal.json`, `.akm/proposals.db`, and `.akm/mv-transactions/`
are all superseded pre-0.9.0 layouts with no live reader or writer in `src/`.
`akm health` reports any that still exist (with size) via the
`akm migrate status` report; `akm migrate apply` deletes them
on request. Nothing deletes this user data without that explicit opt-in.

**Formerly-misplaced live writers (Tier 2 — relocated by itlackey/akm#890):**
`distill-rejected/`, `eval-cases/`, `measurement/verdicts/`,
`unresolved-sources/`, and the improve-pipeline `.lock` files used to be
written under `$STASH/.akm` but never met the "must travel with the content"
rule above — none of them are read to resolve anything about the bundle
content itself. They now live under `$STATE`/`$CACHE`, namespaced per stash
by `getStashStateKey()` (`src/core/paths.ts`) so two stashes on one machine
never collide:

| Old path | New path |
|---|---|
| `$STASH/.akm/distill-rejected/` | `$STATE/improve/distill-rejected/<stash>/` |
| `$STASH/.akm/eval-cases/` | `$STATE/improve/eval-cases/<stash>/` |
| `$STASH/.akm/measurement/verdicts/` | `$STATE/improve/measurement/verdicts/<stash>/` |
| `$STASH/.akm/unresolved-sources/` | `$CACHE/index/unresolved-sources/<stash>/` |
| `$STASH/.akm/improve.lock` (+ `.improve.lock.operations.sensitive` mutex) | `$STATE/locks/<stash>/improve.lock` (+ `.improve.lock.operations.sensitive`) |

`akm migrate status`/`apply` covers every configured LOCAL bundle (the
default stash first, then every other filesystem-backed bundle — a
`git`/`website`/`npm` bundle is cache-backed, never touched) and reports and
relocates any pre-0.9.11 files still sitting at the old paths (see
`docs/migration/`); a lock file only moves out of the way (is deleted) once
`probeLock` — the same staleness check `akm improve` itself uses — says its
holder is dead, so a lock a live run holds is left alone and reported
instead. The pilot treatment file at `$STASH/.akm/measurement/` (sibling to
`verdicts/`) is manually-authored measurement input, not a writer output,
and did not move.

---

## SQLite Databases

Managed SQLite openers apply a `busy_timeout` of 30,000 ms. Journal mode is
selected by `AKM_SQLITE_JOURNAL_MODE` (`WAL`, `DELETE`, or `TRUNCATE`) and
defaults to WAL. When that default is used on a detected network filesystem,
AKM falls back to DELETE; rollback-journal modes also set `synchronous = FULL`.
Read-only existing-index handles apply the same busy timeout without mutating
journal mode. Foreign-key policy is called out per database below.

### `$DATA/index.db` — Main Search Index

Schema managed by `ensureSchema()` (`src/storage/repositories/index-schema.ts`).
The current derived generation is exactly v23: `index_meta.version`, the
complete canonical `entries` fingerprint, and the exact logical
`entries_fts`/`entry_fragments`/`entry_fragments_fts` surfaces must all match.
It uses the shared opening pragma policy above with foreign keys ON and
optionally loads the `sqlite-vec` extension for fast ANN (approximate
nearest-neighbour) vector search.

Opened by:
- `openIndexDatabase()` — managed schema initialization and generation rebuild,
  called by `akm index` and other index writers
- `openExistingDatabase()` — no schema mutation; validates the exact current
  generation before returning a handle to search/show/curate and other readers

**Retention:** `index.db` is a fully regenerable derived cache. A missing or
noncanonical v23 `entries` fingerprint or required logical search surface
causes the managed opener to discard the entry-dependent derived generation and
create the exact current schema; the indexer then repopulates it from current
sources and durable usage state. Existing/read-only openers reject a
noncanonical generation. This path never modifies `state.db`.
`clearStaleCacheEntries()` removes orphaned LLM cache rows within a current
generation.

#### Table: `index_meta`

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PRIMARY KEY | Metadata key |
| `value` | TEXT NOT NULL | String-encoded value |

Known keys: `version` (stored DB_VERSION), `embeddingDim` (e.g. `"384"`), `hasEmbeddings` (`"0"` or `"1"`).

#### Table: `entries`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Internal row ID |
| `item_ref` | TEXT NOT NULL UNIQUE | Sole durable identity and upsert conflict key: `<bundle>//<concept-id>` |
| `bundle_id` | TEXT NOT NULL | Owning installation identity |
| `component_id` | TEXT NOT NULL | Owning component identity within the installation |
| `concept_id` | TEXT NOT NULL | Adapter-owned concept identity |
| `adapter_id` | TEXT NOT NULL | Adapter that recognized and renders the document |
| `type` | TEXT NOT NULL | Adapter-emitted item type |
| `file_path` | TEXT NOT NULL | Absolute path to the asset file |
| `content_hash` | TEXT | Content hash for change detection |
| `document_json` | TEXT NOT NULL | Sole stored `IndexDocument` projection |
| `search_text` | TEXT NOT NULL | Pre-built BM25 search string |
| `derived_from` | TEXT | Set on entries derived from another asset (e.g. `.derived` memories) |

Indexes: the UNIQUE `item_ref` constraint plus `idx_entries_bundle` on
`bundle_id`, `idx_entries_type` on `type`, `idx_entries_file_path` on
`file_path`, and `idx_entries_derived_from` on `derived_from`.

#### Virtual Table: `entries_fts` (FTS5)

BM25-weighted full-text search. Tokenizer: `porter unicode61`.

| Column | BM25 weight |
|---|---|
| `name` | 10.0 |
| `description` | 5.0 |
| `tags` | 3.0 |
| `hints` | 2.0 |
| `content` | 1.0 |

The canonical entry repository replaces this projection in the same SQLite
transaction as its `entries` upsert. Deletes remove the FTS row before the
parent entry. There is no caller-managed FTS dirty queue; a full FTS rebuild is
reserved for explicit recovery of regenerable index state.

#### Table: `entry_fragments`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | FK → `entries(id)` ON DELETE CASCADE; one safe source projection per parent entry |
| `safe_markdown` | TEXT NOT NULL | Line-preserving, retrieval-safe Markdown projection used to resolve a returned fragment selector |

This table keeps the parent-owned source for lexical fragment retrieval. It is
derived state and is replaced or removed in the same transaction as the
parent's FTS projections.

#### Virtual Table: `entry_fragments_fts` (FTS5)

Separate lexical body-fragment population. Tokenizer: `porter unicode61`.
Its rows carry `entry_id UNINDEXED`, `fragment_id UNINDEXED`,
`fragment_ordinal UNINDEXED`, and searchable `content`. Parent metadata is not
copied onto fragment rows, preserving the parent FTS conjunction semantics and
keeping the two BM25 populations independently calibrated. Search selects one
fragment per matching parent and merges it with parent results; `fragment_id`
is the selector returned in the hit ref.

#### Table: `embeddings`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Matches `entries.id` |
| `embedding` | BLOB NOT NULL | Float32 vector, little-endian IEEE-754 |

Used by JS cosine-similarity fallback when `sqlite-vec` is absent.

#### Virtual Table: `entries_vec` (conditional)

Created only when `sqlite-vec` is loadable. Columns: `id INTEGER PRIMARY KEY`, `embedding FLOAT[<dim>]`. Dropped and recreated if embedding dimension changes.

#### Table: `embedding_salvage` (#955)

| Column | Type | Notes |
|---|---|---|
| `content_hash` | TEXT PRIMARY KEY | `sha256(entries.search_text)` |
| `fingerprint` | TEXT NOT NULL | The `embeddingFingerprint` the salvaged vector was generated under |
| `embedding` | BLOB NOT NULL | Float32 vector, little-endian IEEE-754 — copied verbatim from `embeddings.embedding` |
| `salvaged_at` | TEXT NOT NULL | ISO-8601 timestamp of the discard that salvaged this row |

Transient and self-emptying, not a second embedding cache: rows are written
only at the two points that discard `embeddings` wholesale (a full-index
rebuild, a generation bump) and are consumed — or the whole table purged —
by the very next embedding pass. See "Embedding reuse across rebuilds" in
[Indexing](indexing.md#embedding-phase).

#### Workflow source indexing

Peer `.md` and `.yml` workflow sources compile directly to source IR version 1.
The index stores the ordinary normalized `entries` row and metadata derived from
that IR; there is no workflow-specific AST cache or parallel persisted source
representation. Executable durable plans belong only to `state.db`.

#### Table: `index_dir_state`

| Column | Type | Notes |
|---|---|---|
| `dir_path` | TEXT PRIMARY KEY | Absolute path to the directory |
| `file_set_hash` | TEXT NOT NULL | Hash of file names in directory |
| `file_mtime_max_ms` | REAL NOT NULL | Max file mtime across directory (ms since epoch) |
| `reason` | TEXT NOT NULL | Human-readable description |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

Incremental indexing cache. Directory skipped if hash + mtime unchanged.

#### Table: `llm_enrichment_cache`

| Column | Type | Notes |
|---|---|---|
| `asset_ref` | TEXT NOT NULL | Absolute file path or `entryKey:passId` |
| `cache_variant` | TEXT NOT NULL | Extractor/cache fingerprint. Graph extraction uses an extractor-specific variant; other passes currently use the empty-string default. |
| `body_hash` | TEXT NOT NULL | SHA-256 hex digest of file body |
| `result_json` | TEXT NOT NULL | Serialized LLM enrichment result |
| `updated_at` | INTEGER NOT NULL | Unix ms timestamp |

Primary key: `(asset_ref, cache_variant)`.

Cache miss on body change or cache-variant change. Stale rows removed by
`clearStaleCacheEntries()`. The cache can also be bypassed by internal forced
re-enrichment callers.

**What is cached:** metadata enhancement results, graph extraction (entities + relations), memory inference results.

#### Table: `utility_scores`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | FK → `entries(id)` ON DELETE CASCADE |
| `utility` | REAL NOT NULL DEFAULT 0 | Aggregated MemRL utility in [0, 1] |
| `show_count` | INTEGER NOT NULL DEFAULT 0 | Times shown in search results |
| `search_count` | INTEGER NOT NULL DEFAULT 0 | Searches that returned this entry |
| `select_rate` | REAL NOT NULL DEFAULT 0 | Fraction of shows that led to a selection |
| `last_used_at` | TEXT | ISO-8601; NULL if never selected |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

A companion `utility_scores_scoped` table (`entry_id, scope_key` PK) tracks the
same EMA per `(entry, project-anchor)` pair so an asset useful in one project
doesn't pollute rankings in another; `utility_scores` is preserved as the
global fallback / cold-start signal.

See [Utility Score Pipeline](#utility-score-pipeline) below.

`usage_events` (search/show/feedback telemetry) is **not** an `index.db` table;
it lives in `state.db` so an index-generation rebuild cannot discard durable
usage history. See the `state.db` section below.

#### Table: `registry_index_cache`

Registry index cache. TTL is enforced by `getRegistryIndexCache()`.

| Column | Type | Notes |
|---|---|---|
| `registry_url` | TEXT PRIMARY KEY | Canonical registry URL and cache key |
| `fetched_at` | TEXT NOT NULL | ISO-8601 |
| `etag` | TEXT | HTTP ETag for conditional requests |
| `last_modified` | TEXT | HTTP Last-Modified value for conditional requests |
| `index_json` | TEXT NOT NULL DEFAULT `'{}'` | Raw registry index document |

---

### Workflow Run State — tables in `$DATA/state.db`

`workflow_runs`, `workflow_run_steps`, `workflow_run_units`, and
`workflow_run_unit_attempts` live in `state.db`. They use `state.db`'s shared
journal-mode/busy-timeout policy with foreign keys enabled. There is no separate
workflow database or workflow-storage migration path. Runs persist until an
explicit retention policy removes them.

#### Table: `workflow_runs`

New starts persist durable-v4-family plan `irVersion: 5`, the sole executable
plan format. Pre-`irVersion`-5 stored
plans are rejected rather than upgraded or replayed through another runtime.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `workflow_ref` | TEXT NOT NULL | e.g. `workflows/review-todos` |
| `scope_key` | TEXT | Directory hash; isolates runs per project. Gates `list`'s default filter, `akm show`'s active-run nudge, and `startWorkflowRun`'s own-scope uniqueness guard (unchanged, still per-scope) — so two DIFFERENT scopes can each hold their own active run of the same ref; starting one warns about the other rather than blocking it (#942). `akm workflow list --all-scopes` sees across scopes, and `status`/`resume`/`abandon <run-id>` already act on a run regardless of which scope started it |
| `workflow_entry_id` | INTEGER | Optional FK into `index.db entries.id` |
| `workflow_title` | TEXT NOT NULL | Human-readable title |
| `status` | TEXT NOT NULL | `active`, `completed`, `blocked`, `failed` |
| `params_json` | TEXT NOT NULL DEFAULT '{}' | Run parameters |
| `current_step_id` | TEXT | NULL when completed |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at` | TEXT | ISO-8601; NULL while active |
| `agent_harness`, `agent_session_id` | TEXT | Invoking harness/session identity, recorded at start (see the check-in mechanism in `docs/reference/workflows.md`) |
| `checkin_armed_at` | TEXT | ISO-8601 timestamp; a stall past the check-in window surfaces a `continue` directive on the next poll |
| `plan_json`, `plan_hash` | TEXT | Frozen executable plan and its integrity hash; current v4 plans include guarded source reads, immutable targets, and symbolic environment bindings |
| `engine_lease_until`, `engine_lease_holder` | TEXT | Engine concurrency lease bookkeeping for the run |
| `plan_ir_version` | INTEGER | Schema version of `plan_json`'s IR |

Indexes: `idx_workflow_runs_ref`, `idx_workflow_runs_status`, `idx_workflow_runs_scope_ref_status`, `idx_workflow_runs_agent_session`.

#### Table: `workflow_run_steps`

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK → `workflow_runs(id)` ON DELETE CASCADE |
| `step_id` | TEXT NOT NULL | Step identifier from workflow definition |
| `step_title` | TEXT NOT NULL | |
| `instructions` | TEXT NOT NULL | Full step instruction text |
| `completion_json` | TEXT | JSON array of completion criteria; NULL if none |
| `sequence_index` | INTEGER NOT NULL | 0-based ordinal |
| `status` | TEXT NOT NULL | `pending`, `completed`, `blocked`, `failed`, `skipped` |
| `notes` | TEXT | Agent-provided completion notes |
| `evidence_json` | TEXT | Structured evidence key-value pairs |
| `completed_at` | TEXT | ISO-8601; NULL while pending |
| `summary` | TEXT | Required completion summary, validated against `completion_json` by an LLM gate when both are present |

Primary key: `(run_id, step_id)`.

#### Table: `workflow_run_units`

The current status projection for execution units (one row per node in a
run's execution graph), keyed `(run_id, unit_id)` with a FK to `workflow_runs`.
The `workflow_run_unit_attempts` table is append-only; it receives every
external reservation and terminal result, while this table remains the
public status projection. Columns include
`node_id`, `parent_unit_id`, `phase`,
`runner`, `model`, `status`
(`pending`/`running`/`completed`/`failed`/`skipped`), `result_json`, `tokens`,
`failure_reason`, `worktree_path`, `session_id`, timing columns, and per-unit
check-in/claim fields (`last_checkin_at`, `attempts`, `claim_holder`,
`claim_expires_at`, `engine`). See `docs/reference/workflows.md`.

#### Table: `workflow_run_unit_attempts`

Append-only durable-v4 external-dispatch attempt ledger. Primary key: `(run_id, unit_id, attempt)`.
`dispatch_id` also has a unique index. A crash
reclaim keeps the stable dispatch identity for the same attempt; an explicit
retry appends a new numbered attempt instead of overwriting history.

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK to `workflow_runs(id)` with cascade delete |
| `unit_id` | TEXT NOT NULL | Stable v4 unit identity across explicit retries |
| `attempt` | INTEGER NOT NULL | One-based append-only attempt ordinal |
| `dispatch_id` | TEXT NOT NULL UNIQUE | Stable identity reused by crash reclaim |
| `step_id`, `node_id` | TEXT NOT NULL | Owning workflow step and node |
| `phase` | TEXT NOT NULL | `unit` or `gate` |
| `runner`, `engine`, `model` | TEXT | Frozen dispatch classification; values may be absent where inapplicable |
| `input_hash` | TEXT NOT NULL | Integrity/replay identity for the dispatch input |
| `status` | TEXT NOT NULL | `running`, `completed`, `failed`, or `skipped` |
| `result_json`, `tokens`, `failure_reason` | mixed | Terminal result, known usage, and safe failure reason |
| `session_id`, `worktree_path` | TEXT | External session and isolation-worktree evidence |
| `started_at`, `finished_at` | TEXT | Attempt timing |
| `claim_holder`, `claim_expires_at` | TEXT NOT NULL | Lease fencing for reclaim and stale-terminal refusal |

---

### `$DATA/state.db` — Migration-safe Durable State Database

Uses the shared journal-mode/busy-timeout policy with foreign keys ON. The
immutable Flyway-pattern ledger has an explicit safety classification for every
migration ID. Additive migrations and released
migration 002's verified data-preserving `task_history` rebuild run
automatically. Released migration 018's dead-lane table/column drops do not:
an ordinary managed open stops at that boundary and directs the operator to
`akm upgrade` or `akm migrate apply`. Before any install, those commands create a
consistent sibling snapshot with `VACUUM INTO`, fsync it, require
`PRAGMA quick_check` to report `ok`, and only then admits migration 018. The
snapshot is named
`state.db.pre-018-drop-dead-lane-schema.<UTC-digits>.<UUID>.bak`. Its randomized
pathname is atomically reserved and held by descriptor; symlink, inode, and
ownership replacement fail closed. It remains owner-only while SQLite writes
and verifies it, then receives permissions no broader than `state.db`. One
`BEGIN IMMEDIATE` window spans the locked ledger recheck, WAL-inclusive
snapshot, migration 018 DDL, and ledger insert. Fresh-database privilege comes
only from an atomically created file whose inode remains owned by that open;
an existing or replaced path cannot inherit it. An existing file with no
applied migration IDs—whether the ledger table is absent or empty—is rejected
without writes by ordinary commands. Explicit upgrade binds the exact source
inode, writes and verifies a
`state.db.pre-001-initial-schema.<UTC-digits>.<UUID>.bak` copy before ledger
creation or migration 001. One `BEGIN IMMEDIATE` transaction holds writer
exclusion across that snapshot, ledger initialization, migration 001, and
migration 002's table rebuild. The migration lock verifies that `BEGIN`
actually opened a transaction before any body runs and that the transaction
still exists before `COMMIT`. Snapshot source and target SQLite connections use
descriptor-bound paths where the platform permits pathname replacement and
fail closed if that binding is not available. Failed reserved backup paths are
reported and retained, never removed by check-then-unlink cleanup. Unknown or
divergent ledgers fail closed.

This is one narrow released-ledger gate, not a general database backup,
restore, or cutover framework. Created on first durable state write.

#### Table: `schema_migrations`

Tracks applied migration IDs.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Migration identifier |
| `applied_at` | TEXT NOT NULL | ISO-8601 |

#### Table: `events`

Replaces `events.jsonl`. Indexed on `event_type`, `ref`, `ts`. Monotonic rowid replaces byte-offset cursor. Defined by migration `001-initial-schema` in `src/core/state/migrations.ts` (`CREATE TABLE IF NOT EXISTS events`); no later migration alters it.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Monotonic cursor (replaces JSONL byte offset) |
| `event_type` | TEXT NOT NULL | See event type catalog below |
| `ts` | TEXT NOT NULL | ISO-8601 |
| `ref` | TEXT | Asset ref or NULL |
| `metadata_json` | TEXT NOT NULL DEFAULT '{}' | JSON object; maps to `EventEnvelope.metadata` |

Indexes: `idx_events_type` on `event_type`, `idx_events_ref` on `ref`, `idx_events_ts` on `ts`.

#### Table: `proposals`

Replaces per-uuid JSON directories under `$STASH/.akm/proposals/`. Indexed on `stash_dir+status`, `ref+status`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `ref` | TEXT NOT NULL | Asset ref |
| `stash_dir` | TEXT NOT NULL | Bundle root directory |
| `status` | TEXT NOT NULL | `pending`, `accepted`, `rejected` |
| `source` | TEXT | Origin (e.g. `reflect`) |
| `payload_json` | TEXT NOT NULL | Full proposal payload JSON |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

Indexes: `idx_proposals_stash_status` on `(stash_dir, status)`, `idx_proposals_ref_status` on `(ref, status)`.

#### Table: `task_history`

Replaces per-task JSONL files. Indexed on `task_id`, `started_at`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `task_id` | TEXT NOT NULL | Task identifier |
| `status` | TEXT NOT NULL | |
| `started_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at` | TEXT | ISO-8601; NULL while incomplete |
| `failed_at` | TEXT | ISO-8601; NULL unless failed |
| `log_path` | TEXT | Transitional flat log path |
| `target_kind` / `target_ref` | TEXT | Task target identity |
| `metadata_json` | TEXT | Versioned metadata: v2 records `durationMs`, `detail`, and prompt `engine`; unversioned historical metadata keeps `profile` as `legacyProfile` |

Indexes: `idx_task_history_task` on `task_id`, `idx_task_history_started` on `started_at`.

#### Table: `usage_events`

Durable, non-regenerable telemetry lives in `state.db`, not the rebuildable
derived index.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `event_type` | TEXT NOT NULL | `search`, `show`, `curate`, `feedback` |
| `query` | TEXT | Search query (NULL for non-search events) |
| `entry_id` | INTEGER | `index.db` entry id; NULL until re-linked after a rebuild |
| `entry_ref` | TEXT | Stable ref string (survives entry ID changes across index rebuilds) |
| `signal` | TEXT | Feedback signal: `positive` or `negative` |
| `metadata` | TEXT | JSON free-form metadata |
| `source` | TEXT NOT NULL DEFAULT 'user' | Provenance: `user`, `improve`, `task`, `audit`, or `unknown`. Runtime writers always pass an explicit value. |
| `created_at` | TEXT NOT NULL | ISO-8601 |

Indexes: `idx_usage_events_entry`, `idx_usage_events_type`, `idx_usage_events_ref`, `idx_usage_events_source`.

Preserved across `index.db` schema changes and full rebuilds. `relinkUsageEvents()`
re-associates rows to new entry IDs via `entry_ref` after a full rebuild.

#### Table: `legacy_state`

Historical table installed by released state migration 020. The migration SQL
and ledger id remain immutable for existing databases; current runtime code has
no reader, writer, or cutover path for this table.

---

### `$DATA/logs.db` — Task/Run Log Lines

Separate SQLite database from `state.db` (`src/core/logs-db.ts`,
`getLogsDbPath()`). Uses the shared journal-mode/busy-timeout policy with
foreign keys OFF. Structured replacement for grepping the per-run flat log
files under `$CACHE/tasks/logs/<task-id>/<ISO-ts>.log` (that per-run text file
is still written as a transitional human-readable tail). Can grow large in
practice — live installs have been observed at roughly 1 GB — because every
scheduled task run appends its stdout/stderr lines here with no default cap on
total size (only an age-based purge, see below).

#### Table: `task_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `ts` | TEXT NOT NULL | ISO-8601 |
| `task_id` | TEXT NOT NULL | Task identifier |
| `run_id` | TEXT NOT NULL | `buildTaskRunId(task_id, started_at)` — joins to `state.db`'s `task_history` row |
| `stream` | TEXT NOT NULL DEFAULT 'stdout' | `stdout` or `stderr` |
| `level` | TEXT NOT NULL DEFAULT 'info' | `info`, `warn`, or `error` |
| `line` | TEXT NOT NULL | One captured log line (no trailing newline) |

Indexes: `idx_task_logs_ts` on `ts`, `idx_task_logs_task_id` on `task_id`, `idx_task_logs_run_id` on `run_id`.

**Retention:** `purgeOldTaskLogs()` deletes rows older than 90 days by default; it runs as part of the improve maintenance stage (`loop-stages.ts`) alongside the `state.db` purges. Age-based only — there is no size cap, which is why the file can reach ~1 GB.

---

## JSONL Event Streams

### `$CACHE/events.jsonl` — **Replaced by `events` table in `$DATA/state.db`**

The JSONL file at `$CACHE/events.jsonl` is no longer read or written by akm.

**Wire format (one object per line, historical reference):**
```json
{"schemaVersion":1,"ts":"2026-05-11T01:37:00.000Z","eventType":"<verb>","ref":"<type:name>","metadata":{}}
```

> `id` was the byte offset of the line — assigned at read time via `readEvents()`, not stored on disk. In the new `events` table, the monotonic `INTEGER PRIMARY KEY` replaces the byte-offset cursor.

**Full event type catalog:**

| `eventType` | Emitted by | Key `metadata` fields |
|---|---|---|
| `add` | `akm bundle add` | `target`, `provider`, `name`, `writable` |
| `remove` | `akm bundle remove` | `target`, `ref` |
| `update` | `akm bundle update` | `target`, `all`, `processed` |
| `remember` | `akm remember` | `path`, `force`, `tagCount`, `enriched`, `auto`, `scope` |
| `import` | `akm import` | `source`, `path`, `force` |
| `save` | `akm sync` | `name`, `message`, `ok` |
| `feedback` | `akm feedback` | `signal` (positive\|negative), `reason`, `tags` |
| `promoted` | `akm proposal accept` | `proposalId`, `source`, `assetPath` |
| `rejected` | `akm proposal reject` | `proposalId`, `source`, `reason` |
| `reflect_invoked` | reflect pass inside `akm improve` | `task`, `engine`, `eligibilitySource` |
| `propose_invoked` | `akm proposal new` | `type`, `name`, `task`, `engine` |
| `distill_invoked` | distill pass inside `akm improve` | `outcome` (queued\|skipped\|validation_failed\|quality_rejected), `lessonRef`, `score`, `reason` |
| `search` | `akm search` | `query`, `hitCount`, `resultRefs[]`, `mode` (semantic\|keyword) |
| `show` | `akm show` | `type`, `name` |
| `select` | `akm show` (when preceded by search within 60s) | `query`, `searchTs`, `rankPosition` |
| `improve_invoked` | `akm improve` | `strategy`, `scope`, `dryRun`, `eligibleCount` |
| `improve_skipped` | `akm improve` (cooldown guards) | `reason` (reflect_cooldown\|distill_cooldown\|consolidation_cooldown\|budget_exhausted), `cooldownDays`, `lastEventTs` |
| `consolidate_completed` | `akm improve` (post-consolidation) | `processed`, `merged` |
| `schema_repair_invoked` | `akm improve` (repair pass) | `outcome` (queued\|error), `reason`, `proposalId?`, `error?` |
| `reflect_completed` | reflect pass inside `akm improve` (after proposal created) | `proposalId`, `source` |
| `workflow_started` | workflow engine | `runId` |
| `workflow_step_completed` | workflow engine (genuine `completed` transition only) | `runId`, `stepId`, `status` |
| `workflow_step_updated` | workflow engine (every non-`completed` transition: `failed`/`skipped`/`blocked`) | `runId`, `stepId`, `status` |
| `workflow_finished` | workflow engine | `runId` |

**Read API:** `readEvents(options)` — filter by `since`, `sinceOffset` (row id cursor), `type`, `ref`, `includeTags`, `excludeTags`. Returns `{ events, nextOffset }`. `tailEvents()` provides a polling loop.

**Consumers and purpose:**

| Consumer | Filter used | Purpose |
|---|---|---|
| `akm improve` | `feedback` within 30d | Signal-filter candidate selection |
| `akm improve` | `reflect_invoked` per ref | Reflect cooldown guard (7d / 14d / 3d tier) |
| `akm improve` | `distill_invoked` per ref | Distill cooldown guard (30d) |
| `akm improve` | `consolidate_completed` | Consolidation cooldown guard (14d) |
| `akm improve` | `schema_repair_invoked` per ref | Schema repair cooldown guard (7d) |
| `akm improve` (distill pass) | `feedback` per ref | Builds LLM prompt context (last 20 events) |
| `akm improve` (reflect pass) | `feedback` per ref | Builds agent prompt context (last 10 per-ref / 20 global) |
| `akm show` | `show` per ref | Loop detection: warns at 3+ repeated shows |
| `akm log --type promoted\|rejected` | `promoted`, `rejected` | Proposal lifecycle trail (0.9.0: `akm history --include-proposals` was removed; this is the surviving read path) |
| `akm log` | user-supplied | Direct inspection |

---

### `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` — Belief State Log

One line per memory belief-state transition: `{ appliedAt, ref, parentRef, fromState, toState, reason, relatedRef? }`. Observability only; no programmatic consumer reads this file.

---

## JSON / Config Files

| Path | Contents | Retention |
|---|---|---|
| `$CONFIG/config.json` | User config (bundle dirs, sources, LLM endpoints, feature flags, registries). JSONC — `//` and `/* */` comments stripped at parse time. | Manual |
| `<cwd>/.akm/config.json` | Project-scoped config overrides. Walked up to filesystem root; all ancestors merged. | Manual |
| `$CACHE/config-backups/config-<ISO-ts>.json` | Pre-save snapshot of `config.json`, written by `backupExistingConfig()` in `src/core/config/config-io.ts` before each config write. `config.latest.json` is a second copy (not a symlink) always overwritten with the newest snapshot. Dir created/chmod'd `0700`; both the timestamped file and `config.latest.json` are chmod'd `0600` (08-F4, mirroring the env-cli write-mode convention). This is the only live backup location — legacy `$DATA/config-backups/` and `$CONFIG/config-backups/` write paths have been removed. | Capped at `MAX_CONFIG_BACKUPS = 5` most-recent timestamped snapshots; `pruneOldBackups()` deletes the rest on every write |
| `$CONFIG/akm.lock` | Legacy location. Removed in v0.8.0 — akm reads ONLY from `$DATA/akm.lock`. Run the migration script to copy this file to `$DATA/akm.lock` before upgrading. | Legacy |
| `$DATA/akm.lock` | Installed bundle lockfile (moved from `$CONFIG`). Application-managed install state. Same format as `$CONFIG/akm.lock`. | Managed by `akm bundle add`/`akm bundle remove` |
| `$CACHE/semantic-status.json` | Embedding provider health: `status` (pending/ready-js/ready-vec/blocked), `reason`, `providerFingerprint`, `lastCheckedAt`, `entryCount`, `embeddingCount`. Blocked status auto-expires after 24h. | Reset on `akm index --full` |
| `$CACHE/registry-index/<slug>.json` | Removed in v0.8.0 — data now stored in `registry_index_cache` table in `$DATA/index.db`. Delete these files after running the migration script. | — |
| `$CACHE/registry-index/skills-sh-search-<md5>.json` | Skills.sh search result cache. Fresh 15min; stale 1d. Key = MD5 of `url + query + limit`. | TTL |
| `$STASH/.akm/consolidate-journal.json` | Legacy consolidation journal; current advisory consolidation does not read or write it. | Dead residue (itlackey/akm#889); reported by `akm migrate status`, removed by `akm migrate apply` |
| `$DATA/index.db` (`graph_*` tables) | Knowledge graph index data: per-bundle graph metadata plus per-file entities and relations extracted from assets via LLM. `graph_files` is keyed by `(stash_root, file_path, body_hash)` with `(stash_root, file_path)` unique; it has no `entries.id` foreign key. Every considered file persists `status` and `reason`. `graph_file_entities` and `graph_file_relations` carry the same three-column owner key and cascade from `graph_files`; they store normalized and display-form entity values. `extraction_run_id` (on `graph_files` and `graph_meta`) and `extractor_id` (on `graph_meta`) record extraction provenance. `graph_meta` also stores the latest graph telemetry: model, prompt version, batch size, cache hits/misses, truncation count, and failure count. A companion `graph_extraction_queue` table holds a lazy, priority-ordered backlog of files awaiting extraction. Indexes include `idx_graph_files_path`, `idx_graph_files_stash_order`, `idx_graph_file_entities_entity_norm(stash_root, entity_norm)`, and `idx_entries_file_path` on `entries(file_path)`. | Refreshed by graph extraction; regenerated on the next `akm index`/`akm improve` since `index.db` is a fully rebuildable cache |

---

## Markdown / Asset Files

### Primary Bundle Content

All asset files live under `$STASH/` in type-specific subdirectories defined by the `PLACEMENT_SPECS` map in `src/core/asset/asset-placement.ts`:

The `workflows/` directory holds peer `.md` and `.yml` workflow sources. The
`tasks/` directory holds task source v4 `.yml` sources.

| Subdirectory | Asset Type | Format |
|---|---|---|
| `skills/<name>/SKILL.md` | skill | YAML-FM + Markdown |
| `commands/<name>.md` | command | YAML-FM + Markdown |
| `agents/<name>.md` | agent | YAML-FM + Markdown |
| `knowledge/<name>.md` | knowledge | YAML-FM + Markdown |
| `instructions/<name>.md` | instruction | YAML-FM + Markdown |
| `workflows/<name>.md` / `workflows/<name>.yml` | workflow | Peer `.md` Markdown and `.yml` GitHub-shaped sources; both compile through source IR v1 |
| `scripts/<name>.<ext>` | script | sh / ts / js / ps1 etc. |
| `memories/<name>.md` | memory | YAML-FM + Markdown |
| `env/<name>.env` | env | `KEY=VALUE` pairs |
| `secrets/<name>` | secret | raw secret bytes |
| `facts/<name>.md` | fact | YAML-FM + Markdown |
| `lessons/<name>.md` | lesson | YAML-FM + Markdown (required: `description`, `when_to_use`) |
| `tasks/<name>.yml` | task | Task source v4 YAML source with root `version: 4`; `.yaml` is not recognized |
| `sessions/<harness>/<session-id>.md` | session | YAML-FM + Markdown; generated by the `extract` pass, not user-authored |

`wikis/<name>/` is a separate convention: a bundle root recognized by the
`llm-wiki` adapter, not a `PLACEMENT_SPECS` type directory. `wiki` is not an
item type (see [Classification](classification.md)).

### Wiki File Structure

Each `$STASH/wikis/<wikiName>/` (or any other bundle root the `llm-wiki`
adapter recognizes — `schema.md` + `pages/` is the probe) contains:

| File | Purpose |
|---|---|
| `schema.md` | Content structure definition (reserved, never indexed as a concept) |
| `index.md` | Table of contents (reserved, never indexed as a concept) |
| `log.md` | Recent activity log (reserved, never indexed as a concept) |
| `raw/.gitkeep` | Ensures `raw/` survives clean clones |
| `raw/<slug>.md` | Immutable ingested raw sources (adapter type `wiki-source`) |
| `pages/<page>.md` | Agent-authored, synthesized wiki pages (open type from frontmatter `pageKind`, default `note`) |
| `pages/<subdir>/<page>.md` | Pages may nest under subdirectories (e.g. `pages/entities/`) |

### Improvement Pipeline Files

| Path | Contents | Retention |
|---|---|---|
| `$DATA/state.db` (`proposals` table) | Proposal queue: `id`, `stash_dir`, `ref`, `status` (`pending`\|`accepted`\|`rejected`\|`reverted`), `source`, `created_at`, `updated_at`, `content`, `frontmatter_json`, `metadata_json`. Replaces the pre-0.9.0 per-uuid `$STASH/.akm/proposals/<uuid>/proposal.json` filesystem layout — archival is a status flip, not a directory move (`src/commands/proposal/repository.ts`). | Durable; `archiveRetentionDays` (default 90d) governs when pending proposals age out |
| `$STASH/.akm/archive/<ts>-<i>-<name>.md` | Legacy consolidation archive. Current advisory consolidation does not create or manage these files. | Dead residue (itlackey/akm#889); reported by `akm migrate status`, removed by `akm migrate apply` |
| `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Legacy pre-0.9 consolidation backups; current advisory consolidation does not create them. | Safe to remove after review |
| `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Belief-state archived memory files + `cleanup.md` audit record | No cleanup |
| `$STATE/improve/distill-rejected/<stash>/<ts>-<lessonRef>.md` | Lessons that failed the LLM-as-judge quality gate. Frontmatter: `{ score, reason }`. Moved out of `$STASH/.akm/distill-rejected/` (itlackey/akm#890). | No cleanup |
| `$STATE/improve/eval-cases/<stash>/<slug>.md` | Regression eval cases captured from rejected distill/proposal output. Moved out of `$STASH/.akm/eval-cases/` (itlackey/akm#890). | No cleanup |
| `$STATE/improve/measurement/verdicts/<stash>/verdict-<ts>.{json,md}` | `akm-eval-proactive-verdict` reports. Moved out of `$STASH/.akm/measurement/verdicts/` (itlackey/akm#890); the pilot treatment file stays at `$STASH/.akm/measurement/` (manually-authored input, not a writer output). | No cleanup |
| `$STASH/memories/MEMORY.md` | Human-maintained memory index. Budget: warn at 180 lines, hard cap at 200. Read-only for akm (not written by current code). | Manual |
| `<dir>/.stash.json` | Legacy per-directory metadata manifest (pre-0.9.0). The live indexer no longer reads it; only the storage migrator reads and folds it into inline asset metadata before deleting it. | Manual |

---

## Lock / Sentinel Files

| Path | Format | Purpose |
|---|---|---|
| `$DATA/akm.lock.lck` | Plain text (PID) | Advisory write-lock for `akm.lock` mutations. Created with `O_EXCL`; stale locks (dead PIDs) auto-reclaimed. Best-effort: 3 retries × 100ms. |
| `$STATE/locks/<stash>/improve.lock` | JSON `{ pid, startedAt, lockId }` | Serializes the complete live `akm improve` mutation window from triage through final sync. Exact ownership protects successor locks during release. Stale locks are reclaimed when the PID is dead or after the larger of four hours and the configured run budget plus ten minutes. Moved out of `$STASH/.akm/improve.lock` (itlackey/akm#890); its `.improve.lock.operations.sensitive` mutex sibling (see `operationMutexPath()` in `src/core/file-lock.ts`) moved with it. |

---

## Cache Directories

| Path | Contents | TTL / Retention |
|---|---|---|
| `$CACHE/registry/<src>/<id>/<ver>/` | Downloaded bundle packages (npm tarballs + extracted trees) | No TTL |
| `$CACHE/registry/<src>/<id>/repo/` | Git mirror working trees for git-sourced bundles | 12h fresh; 7d stale |
| `$CACHE/registry-index/website-<sha256-16>/` | Scraped website content as knowledge markdown files + `manifest.json` freshness marker | 12h fresh; 7d stale |
| `$CACHE/registry-build/build-<random>/` | Temp archive extraction for registry index building | Deleted in `finally` after each run |
| `$CACHE/tasks/logs/<task-id>/` | Per-run stdout/stderr log files (`<ISO-ts>.log`) | No cleanup |
| `$CACHE/bin/rg` | Auto-downloaded ripgrep binary | Permanent |
| `$CACHE/index/unresolved-sources/<stash>/<name>` | Synthetic placeholder path for a configured source whose content root did not resolve this run; never written to disk, only reported as a `SearchSource.path`. Moved out of `$STASH/.akm/unresolved-sources/` (itlackey/akm#890). | N/A (not a real directory) |

Cache-backed bundles (`git`, `website`, `npm`) are materialised into `$CACHE`
before indexing — each provider's `sync()` method (`src/sources/providers/`)
is invoked through `ensureSourceCaches()`, and the materialised tree is then
indexed like a local filesystem bundle.

---

## OS-Native Task Scheduler Files

### macOS (launchd)

**Plist:** `~/Library/LaunchAgents/com.akm.task.<id>.plist` — XML plist. Contains label, `ProgramArguments` (`akm task run <id>`), `StandardOutPath`, `StandardErrorPath`, trigger (`StartInterval` or `StartCalendarInterval`), and `EnvironmentVariables` (PATH captured at install time).

Registered via `launchctl bootstrap gui/<uid> <plist>`.

### Linux (cron)

No files written. User crontab edited in-place via `crontab -l` / `crontab -`. Each task is bracketed with sentinels:

```
# akm:task <id> BEGIN
<cronexpr> /abs/akm task run <id> >> ~/.cache/akm/tasks/logs/<id>.log 2>&1
# akm:task <id> END
```

Disabled tasks get `# akm:disabled ` prepended to the cron line.

### Windows (Task Scheduler)

Task definition XML written to `%TEMP%\akm-task-<id>-<ts>.xml`, used to register via `schtasks /Create`, then deleted in the `finally` block. Persistent state is in the Windows Task Scheduler (OS-managed).

---

## Companion Plugin State (Claude Code / OpenCode Harnesses)

These directories are written by the akm-plugins hook scripts (`akm-plugins` repo — the Claude Code and OpenCode integration layer that shells out to this `akm` CLI), not by the `akm` binary itself. They are part of the overall akm-ecosystem storage footprint and have been observed to grow large in practice (hundreds of MB) with **no retention/prune policy in code today** — no purge, TTL, or size cap was found in the hook sources.

### `$XDG_STATE_HOME/akm-claude/` (Linux/macOS default `~/.local/state/akm-claude/`) — Claude Code Hook State

Path resolved by `getHarnessStateDir("claude-code")` / `STATE_DIR` in `akm-plugins/claude/hooks/akm-hook.ts` and `akm-plugins/claude/shared/memory-events.ts`.

| Path | Contents | Retention |
|---|---|---|
| `events.jsonl` | Append-only memory-event log (`AkmMemoryEvent`: session/tool/workflow/feedback observations), written via `appendMemoryEvent()` | No cleanup |
| `memory-candidates.jsonl` | Candidate memories extracted from session activity, written via `getCandidateLogPath()` in `akm-plugins/claude/shared/memory-candidates.ts` | No cleanup |
| `curated/prompt-<sessionId>.md`, `curated/session-<sessionId>.md` | Curated bundle context written per prompt/session for the model to read (`CURATED_DIR`) | No cleanup |
| `sessions/` | Per-session hook working state (`SESSIONS_DIR`) | No cleanup |
| `session.log`, `feedback.log`, `memory.log` | Human-readable hook activity logs | No cleanup |
| `quality-cache.tsv` | Cached asset-quality lookups | No cleanup |
| `setup.stamp` | One-time setup marker | Manual |

### `$XDG_STATE_HOME/akm-opencode/` (Linux/macOS default `~/.local/state/akm-opencode/`) — OpenCode Hook State

Same shared helpers as above with `harness: "opencode"` (`getHarnessStateDir()` / `getCandidateLogPath()` in `akm-plugins/claude/shared/`).

| Path | Contents | Retention |
|---|---|---|
| `events.jsonl` | Append-only memory-event log, same schema as the Claude Code tier | No cleanup |
| `memory-candidates.jsonl` | Candidate memories extracted from OpenCode session activity | No cleanup |

Note: the OpenCode plugin's curated-prompt files (`CURATED_DIR` in `akm-plugins/opencode/index.ts`) are written under the OS temp directory, not this state tier.

---

## External / Read-Only Inputs

These paths are read by `akm improve` to scan for repeated failure patterns in agent session logs. akm never writes to them.

| Path | Agent |
|---|---|
| `~/.claude/projects/**/*.jsonl` | Claude Code |
| `~/.local/share/opencode/` (Linux) | OpenCode |
| `~/Library/Application Support/opencode/` (macOS) | OpenCode |

---

## Utility Score Pipeline

How utility scores flow through the system:

```
akm search / akm show
  → insertUsageEvent()       → usage_events table (SQL aggregation)
  → bumpUtilityScoresBatch() → utility_scores (between-index EMA bump)
       formula: next = clamp(current + 0.1 × (1.0 − current), 0, 1)

akm feedback
  → insertUsageEvent()       → usage_events (signal column)
  → appendEvent()            → events table in state.db (for improve/distill/reflect pipeline)

akm index  (recomputeUtilityScores)
  → reads source='user' usage_events aggregates per entry
       selectRate   = min(1, show_count / search_count)
       feedbackRate = (positive_count − negative_count) / total_feedback
       effectiveRate = max(selectRate, feedbackRate)
       decay        = 0.7 ^ elapsedDays
       utility      = prevUtility × decay + effectiveRate × (1 − decay)
  → overwrites/decays the union of aggregated entries and existing utility rows

akm search  (ranking phase)
  → recencyFactor = exp(−daysSinceLastUse / 30)
  → score        *= min(1 + utility × recencyFactor × 0.5, 1.5)
```

`usage_events` and the general `events` log are both durable tables in
`$DATA/state.db`. Utility recomputation reads usage telemetry there and joins
entry ids against the regenerable `index.db` catalog in application code.
Only `source='user'` contributes demand or utility. `improve`, `task`, `audit`,
`unknown`, and unrecognized extension values remain inspectable telemetry but do
not affect ranking, salience, real-query labels, or GRR.

---

## Summary Index

| # | Path | Format | Purpose |
|---|---|---|---|
| 1 | `$DATA/index.db` | SQLite 3 (WAL) | Main search index, embeddings, utility scores, LLM cache, registry index cache |
| 2 | `$DATA/state.db` | SQLite 3 (WAL) | Durable event and usage logs, proposals, task history, and workflow run state |
| 3 | `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` | JSONL | Belief state transition audit log |
| 4 | `$CONFIG/config.json` | JSONC | User configuration |
| 5 | `<cwd>/.akm/config.json` | JSONC | Project-scoped config overrides |
| 6 | `$CACHE/config-backups/config-<ts>.json` | JSON | Config pre-save backups (0600 files / 0700 dir; capped at 5) |
| 7 | `$DATA/akm.lock` | JSON | Installed bundle lockfile |
| 8 | `$DATA/akm.lock.lck` | Text (PID) | Write-lock sentinel for lockfile |
| 9 | `$CACHE/semantic-status.json` | JSON | Embedding provider health cache |
| 10 | `$CACHE/registry-index/skills-sh-search-<md5>.json` | JSON | Skills.sh query result cache |
| 11 | `$DATA/index.db` (`graph_*` tables) | SQLite | Knowledge graph data — there is no `graph.json` file; see the `graph_*` table row above |
| 12 | `$DATA/state.db` (`proposals` table) | SQLite | Proposal queue; archival is a `status` change, not a separate directory |
| 19 | `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Markdown | Legacy consolidation backups; no longer created |
| 20 | `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Markdown | Belief-state archived memories |
| 21 | `$STATE/improve/distill-rejected/<stash>/<ts>-<ref>.md` | FM+Markdown | Quality-gate rejected lessons |
| 22 | `$STATE/locks/<stash>/improve.lock` | JSON | Improve run mutex |
| 23 | `$STASH/{skills,commands,agents,...}/` | FM+Markdown | Asset files (working bundle) |
| 24 | `$STASH/wikis/<name>/` | Markdown | `llm-wiki`-adapter bundle content (schema/index/log + `raw/` + `pages/`) |
| 25 | `<dir>/.stash.json` | JSON | Legacy metadata (read-only) |
| 26 | `$STASH/memories/MEMORY.md` | Markdown | Memory index (user-maintained, read-only for akm) |
| 27 | `$CACHE/registry/<src>/<id>/<ver>/` | Binary+FS | Downloaded bundle package cache |
| 28 | `$CACHE/registry/<src>/<id>/repo/` | Git tree | Git source mirror cache |
| 29 | `$CACHE/registry-index/website-<hash>/` | JSON+MD | Website mirror cache |
| 30 | `$CACHE/registry-build/` | JSON+FS | Registry build workspace |
| 31 | `$CACHE/tasks/logs/<id>/` | Plain text | Task run stdout/stderr |
| 32 | `$CACHE/bin/rg` | Binary | Auto-downloaded ripgrep |
| 33 | `~/Library/LaunchAgents/com.akm.task.<id>.plist` | XML | macOS scheduled task (launchd) |
| 34 | User crontab | Cron text | Linux scheduled tasks |
| 35 | Windows Task Scheduler `\akm\<id>` | XML | Windows scheduled tasks |
| 36 | `~/.claude/projects/**/*.jsonl` | JSONL | Claude Code session logs (read-only input) |
| 37 | `~/.local/share/opencode/` | JSONL | OpenCode session logs (read-only input) |
| 38 | `$DATA/logs.db` | SQLite 3 (WAL) | Task/run log lines (`task_logs`); observed ~1 GB on live installs; 90d age-based purge only, not size-capped |
| 39 | `$XDG_STATE_HOME/akm-claude/` | JSONL+Markdown+text | Claude Code plugin hook state (events, memory candidates, curated prompts, logs); written by akm-plugins, not core akm; no retention policy today |
| 40 | `$XDG_STATE_HOME/akm-opencode/` | JSONL | OpenCode plugin hook state (events, memory candidates); written by akm-plugins, not core akm; no retention policy today |
| 41 | `$STATE/improve/eval-cases/<stash>/<slug>.md` | FM+Markdown | Improve regression eval cases |
| 42 | `$STATE/improve/measurement/verdicts/<stash>/verdict-<ts>.{json,md}` | JSON+Markdown | `akm-eval-proactive-verdict` reports |
| 43 | `$CACHE/index/unresolved-sources/<stash>/<name>` | N/A | Synthetic unresolved-source placeholder path (never written to disk) |

---

Check `src/core/paths.ts` for the canonical path resolution functions (`getCacheDir`, `getConfigDir`, `getDataDir`, `getDbPath`, `getStateDbPathInDataDir`, `getSemanticStatusPath`, `getStateDir`, `getStashStateKey`, and the per-stash `$STATE`/`$CACHE` writer helpers `getDistillRejectedDir`, `getEvalCasesDir`, `getMeasurementVerdictsDir`, `getUnresolvedSourcesDir`, `getStashLocksDir`).
