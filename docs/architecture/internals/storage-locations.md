# Storage Locations

Where akm reads and writes data on disk. Path resolution lives in
`src/core/paths.ts` (`getConfigDir`, `getCacheDir`, `getDataDir`,
`getStateDir`, `getDefaultStashDir`, `getStashStateKey`, and the helpers they
feed); `src/storage/locations.ts` (`resolveStorageLocations`) gathers the main
ones.

## Path variables

| Variable | Linux / macOS default | Windows default | Override |
|---|---|---|---|
| `$CONFIG` | `~/.config/akm` | `%APPDATA%\akm` | `AKM_CONFIG_DIR`, then `XDG_CONFIG_HOME` |
| `$CACHE` | `~/.cache/akm` | `%LOCALAPPDATA%\akm` | `AKM_CACHE_DIR`, then `XDG_CACHE_HOME` |
| `$DATA` | `~/.local/share/akm` | `%LOCALAPPDATA%\akm\data` | `AKM_DATA_DIR`, then `XDG_DATA_HOME` |
| `$STATE` | `~/.local/state/akm` | `%LOCALAPPDATA%\akm\state` | `AKM_STATE_DIR`, then `XDG_STATE_HOME` |
| `$STASH` | `~/akm` | `%USERPROFILE%\Documents\akm` | `AKM_BUNDLE_DIR` |

When `AKM_BUNDLE_DIR` points under `/tmp`, `/var/tmp`, or a macOS temp
directory and no explicit config or cache override is set, `$CONFIG` resolves
to `$STASH/.akm` and `$CACHE` to `$STASH/.akm/cache`
(`isTransientStashPath`).

Several locations are namespaced per bundle by `getStashStateKey(stashDir)`,
shown below as `<stash>`.

## What lives in `$STASH/.akm`

`$STASH/.akm` holds state that has to travel with the bundle content. Anything
a machine can rebuild, or that only matters on the machine that wrote it,
lives in `$STATE`, `$CACHE`, or `$DATA`.

| Path | Contents |
|---|---|
| `memory-cleanup/belief-transitions.jsonl` | One line per memory belief-state transition: `appliedAt`, `ref`, `parentRef`, `fromState`, `toState`, `reason`, and `relatedRef` when present. Written by the memory cleanup pass (`appendBeliefStateTransitionLog`). |
| `memory-cleanup/archive/<stamp>-<ref>/` | A pruned or retired memory moved aside, plus a `cleanup.md` tombstone. Ref resolution reads the tombstones so an edge to a pruned memory reports "archived" instead of "missing" (`src/core/asset/memory-archive.ts`). `akm improve` deletes the archived files of a retirement 30 days after `retiredAt` when the bundle is a git repository and the files are tracked and clean; `cleanup.md` stays. |

`<cwd>/.akm/config.json` is not read as configuration. Its presence marks a
project root for the workflow scope key (`src/workflows/authoring/scope-key.ts`).

Older layouts under `.akm/` (`proposals/`, `runs.archived-*`, `archive/`,
`graph.json`, `consolidate-journal.json`, `proposals.db`, `mv-transactions/`)
are not read by akm. `akm migrate status` lists them and `akm migrate apply`
removes them (`scripts/akm-migrate/migrate/dead-residue.ts`).

## SQLite databases

Every database opens with a 30,000 ms `busy_timeout`. `AKM_SQLITE_JOURNAL_MODE`
(`WAL`, `DELETE`, `TRUNCATE`) selects the journal mode; the default is WAL, and
WAL falls back to DELETE when the data directory is on a detected network
filesystem. The rollback-journal modes also set `synchronous = FULL`
(`src/storage/sqlite-pragmas.ts`). Foreign keys are on for `index.db` and
`state.db` and off for `logs.db`.

### `$DATA/index.db` (search index)

A derived cache. `src/storage/repositories/index-schema.ts` (`ensureSchema`)
creates ten tables: `index_meta`, `entries`, `entries_fts`, `entry_fragments`,
`asset_links`, `embeddings`, `utility_scores`, `index_dir_state`,
`llm_enrichment_cache`, and `registry_index_cache`.

The layout number is `index_meta.version`, currently 26
(`CANONICAL_INDEX_DB_VERSION`, `src/storage/repositories/index-entry-schema.ts`).

- `openIndexDatabase` (used by `akm index` and other writers) runs `ensureSchema`, which upgrades an older layout in place and sets `index_meta.vacuumPending`. It refuses a layout newer than the running akm (`INDEX_SCHEMA_INCOMPATIBLE`, "Upgrade akm to use this index.").
- `openExistingDatabase` and `openReadonlyExistingDatabase` do not change the schema. They read an older layout as it is and refuse a newer one.
- On `SQLITE_CORRUPT`, `openIndexDatabase` deletes the file and rebuilds it. This does not touch `state.db`.
- `akm index` runs `VACUUM` at the end of a run when `vacuumPending` is set or more than half the pages are free, and records an `index_db_vacuumed` event.

Vector search is an exact scan of `embeddings` (`src/storage/repositories/index-vec-repository.ts`).

#### `index_meta`

`key` TEXT PRIMARY KEY, `value` TEXT NOT NULL. Keys: `version`, `builtAt`,
`stashDir`, `stashDirs`, `sourceOwners`, `last_utility_computed_at`, `embeddingFingerprint` (the model the
vectors were made under), `hasEmbeddings` (`"0"` or `"1"`), `vacuumPending`,
and `ftsTotalsStale` (set when a delete removed a row from `entries_fts`;
cleared when `akm index` rebuilds the FTS table).

#### `entries`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `item_ref` | TEXT NOT NULL UNIQUE | `<bundle>//<concept-id>`; the durable identity and upsert key |
| `bundle_id`, `component_id`, `concept_id`, `adapter_id` | TEXT NOT NULL | Owning installation, component, adapter-owned concept id, and the adapter that recognized it |
| `type` | TEXT NOT NULL | Adapter-emitted item type |
| `file_path` | TEXT NOT NULL | Absolute path of the asset file |
| `content_hash` | TEXT | Change detection |
| `document_json` | TEXT NOT NULL | The stored `IndexDocument` |
| `derived_from` | TEXT | Set on entries derived from another asset (for example `.derived` memories) |
| `embed_hash` | TEXT | SHA-256 of the text the entry is embedded from; a change deletes the vector |

Indexes: `idx_entries_bundle`, `idx_entries_type`, `idx_entries_file_path`,
`idx_entries_derived_from`.

#### `entries_fts` (FTS5 virtual table)

Columns `entry_id` (UNINDEXED), `name`, `description`, `tags`, `hints`,
`content`. Tokenizer `porter unicode61`. The table is contentless
(`content=''`, `contentless_delete=1`) and rows are addressed by
`rowid = entries.id`; a SQLite older than 3.43 gets a content-bearing table
instead, and readers handle both. All BM25 column weights are 1.0
(`BM25_COLUMN_WEIGHTS`, `src/storage/repositories/index-fts-repository.ts`).

A contentless FTS5 table cannot take a deleted row out of its BM25 totals.
A delete that removes a row sets `index_meta.ftsTotalsStale`, and the next
`akm index` rebuilds the table from `entries`.

#### `entry_fragments`

`entry_id` INTEGER PRIMARY KEY (FK to `entries(id)`, ON DELETE CASCADE),
`safe_markdown` TEXT NOT NULL. One Markdown projection per entry. `akm show
<ref>#<fragment>` splits it at read time to select a section; nothing searches
it.

#### `asset_links`

`WITHOUT ROWID`, primary key `(entry_id, ord)`.

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER NOT NULL | FK to `entries(id)`, ON DELETE CASCADE; the entry that declares the link |
| `ord` | INTEGER NOT NULL | Position in that entry's link list |
| `kind` | TEXT NOT NULL | Link kind (`xref`, `superseded_by`, `contradicted_by`, `belief_peer`, `derived_from`, `cites`, `links_to`, `uses`; see `src/indexer/links/declared-links.ts`) |
| `raw` | TEXT NOT NULL | The token as authored |
| `dst_bundle` | TEXT | Target bundle; NULL means the declaring entry's own bundle |
| `dst_concept` | TEXT NOT NULL | Target concept id (`idx_asset_links_dst`) |

Derived from `document_json` and replaced in the same transaction as the
entry's upsert.

#### `embeddings`

`id` INTEGER PRIMARY KEY (matches `entries.id`), `embedding` BLOB NOT NULL
(little-endian float32), `model` TEXT (the embedding fingerprint the vector was
made under; NULL is treated as the current model). An entry is embedded when it
has no row for the configured model; readers serve only the configured model's
rows.

#### `index_dir_state`

Incremental-indexing cursor: a directory is skipped when its file set and
mtimes are unchanged.

| Column | Type | Notes |
|---|---|---|
| `dir_path` | TEXT PRIMARY KEY | Absolute directory path |
| `file_set_hash` | TEXT NOT NULL | Hash of the file names in the directory |
| `file_mtime_max_ms` | REAL NOT NULL | Newest file mtime, in ms |
| `reason` | TEXT NOT NULL | Why the directory was last drained |
| `updated_at` | TEXT NOT NULL | ISO-8601 |
| `row_count` | INTEGER | Rows the directory produced |
| `index_variant` | TEXT | Adapter variant the rows were built under |

#### `llm_enrichment_cache`

`asset_ref`, `cache_variant`, `body_hash`, `result_json`, `updated_at`
(INTEGER, Unix ms); primary key `(asset_ref, cache_variant)`. Holds memory
inference results (`cache_variant = 'memory-inference-v2'`). A row is a miss
when the body hash or variant changes; `clearStaleCacheEntries` removes
orphans.

#### `utility_scores`

`entry_id` INTEGER PRIMARY KEY (FK to `entries(id)`, ON DELETE CASCADE),
`utility`, `show_count`, `search_count`, `select_rate`, `last_used_at`,
`updated_at`. Recomputed by `akm index` from `state.db` `usage_events` and
adjusted by `akm feedback`. The improve eligibility code reads it
(`src/commands/improve/eligibility.ts`); search ranking does not.

#### `registry_index_cache`

`registry_url` TEXT PRIMARY KEY, `fetched_at`, `etag`, `last_modified`,
`index_json` (the raw registry index). This is the cache for registry indexes,
including skills.sh results.

### `$DATA/state.db` (durable state)

Opening `state.db` creates it and applies every pending migration in one
`BEGIN IMMEDIATE` transaction (`src/core/state-db.ts`, `src/core/state/migrations.ts`).
Before a pending migration that drops schema (`018-drop-dead-lane-schema`,
`028-improve-ledger`) runs against an existing database, the file is copied to
`state.db.pre-<migration id>.bak` with `VACUUM INTO`. A ledger that diverges from the
migrations this akm knows is refused; a ledger written by a newer akm opens with a
warning.

Tables: `schema_migrations`, `events`, `proposals`, `task_history`, `usage_events`,
`improve_runs`, `improve_ledger`, `extract_sessions_seen`, `asset_salience`,
`asset_outcome`, `body_embeddings`, `workflow_runs`, `workflow_run_steps`,
`workflow_run_units`, `workflow_run_unit_attempts`, and `legacy_state` (created
by migration 020; no current code reads or writes it).

#### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Monotonic cursor |
| `event_type` | TEXT NOT NULL | Open string (`EventType`, `src/core/events.ts`) |
| `ts` | TEXT NOT NULL | ISO-8601 |
| `ref` | TEXT | Asset ref, or a synthetic ref such as `proposals/_expiration` |
| `metadata_json` | TEXT NOT NULL DEFAULT '{}' | |

Indexes on `event_type`, `ref`, `ts`. The event types and their metadata are
listed in [Data & Telemetry](../../reference/data-and-telemetry.md). `akm
improve` purges events older than `improve.eventRetentionDays` (default 90; 0
disables).

#### `proposals`

The proposal queue. A decided proposal stays as a row; archiving changes `status`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID |
| `stash_dir` | TEXT NOT NULL | Absolute bundle root; partitions the queue per bundle |
| `ref` | TEXT NOT NULL | `bundle//conceptId`, no fragment |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `accepted`, `rejected`, `reverted` |
| `source` | TEXT NOT NULL | The generator (`PROPOSAL_SOURCES`, `src/commands/proposal/proposal-types.ts`) |
| `created_at`, `updated_at` | TEXT NOT NULL | ISO-8601 |
| `content` | TEXT NOT NULL DEFAULT '' | The content accept writes; empty for a retire proposal |
| `frontmatter_json` | TEXT | Frontmatter of the payload, NULL when none |
| `metadata_json` | TEXT NOT NULL DEFAULT '{}' | Every field without a column |

`metadata_json` keys, each present only when the proposal has it: `changes`,
`proposedTarget`, `beforeHash`, `beforeHashNormalized`, `sourceRun`, `review`,
`reviewHistory`, `confidence`, `gateDecision`, `feedback`, `backupContent`,
`acceptedTarget`, `eligibilitySource`, `promotionSource`, `promotionSourceHash`,
`retirement`, `retiredArchive`, `retireAcceptIntent`. The shapes are validated
in `validatePresentMetadata`, `src/storage/repositories/proposals-repository.ts`.

Indexes: `idx_proposals_stash_status`, `idx_proposals_ref_status`,
`idx_proposals_stash_status_ref_source`.

#### `task_history`

One row per task run.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `task_id` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | |
| `started_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at`, `failed_at` | TEXT | ISO-8601 |
| `log_path` | TEXT | The per-run flat log file |
| `target_kind`, `target_ref` | TEXT | Task target |
| `metadata_json` | TEXT NOT NULL DEFAULT '{}' | |

Unique index `idx_task_history_run` on `(task_id, started_at)`; indexes on
`task_id`, `started_at`, `(target_kind, target_ref)`, `status`.

#### `usage_events`

Search, show, curate, and feedback telemetry. It lives in `state.db` so
rebuilding `index.db` does not discard it.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `event_type` | TEXT NOT NULL | `search`, `show`, `curate`, `feedback` |
| `query` | TEXT | Search query; NULL otherwise |
| `entry_id` | INTEGER | `index.db` entry id; re-linked after a rebuild |
| `entry_ref` | TEXT | Stable ref string |
| `signal` | TEXT | `positive` or `negative` for feedback |
| `metadata` | TEXT | JSON |
| `source` | TEXT NOT NULL DEFAULT 'user' | `user`, `improve`, `task`, `audit`, `unknown` (`AKM_EVENT_SOURCE` sets it for child processes) |
| `created_at` | TEXT NOT NULL | |

Only `source = 'user'` rows count as demand or utility. `akm index` deletes rows
older than 90 days. Indexes on `entry_id`, `event_type`, `entry_ref`, `source`.

#### `improve_ledger`

One row per `(stash_dir, ref, source)`: what an improve stage last did with the
asset and when it may try again.

| Column | Notes |
|---|---|
| `stash_dir`, `ref`, `source` | Primary key |
| `last_attempt_at` | ISO-8601 |
| `outcome` | `proposed`, `accepted`, `rejected`, `quality_rejected`, `review_needed`, `expired`, `unchanged`, `failed`, `judged_no_action` |
| `next_eligible_at` | When the stage may try again; NULL for content-driven decisions |
| `proposal_id`, `detail` | The proposal and the reason, when any |
| `content_hash` | For content-driven decisions (the consolidate pair pass and decided consolidate promotions): the asset is eligible again only when its body hash differs |

Candidate selection in each improve stage reads it before any model call
(`src/storage/repositories/improve-ledger-repository.ts`).

#### Other tables

| Table | Holds |
|---|---|
| `improve_runs` | One row per `akm improve` run: `id`, `started_at`, `completed_at`, `stash_dir`, `dry_run`, `strategy`, `scope_mode`, `scope_value`, `ok`, `result_json`, `metrics_json`. Purged by the retention pass. |
| `extract_sessions_seen` | Primary key `(harness, session_id)`; the extractor's record of which sessions it processed and with what outcome. |
| `asset_salience`, `asset_outcome` | Per-asset improve scoring state, keyed by `asset_ref`. |
| `body_embeddings` | Cache of memory-body embedding vectors keyed by `content_hash`, with `model_id` (`src/storage/repositories/embeddings-repository.ts`). |

#### Workflow run tables

Run state lives in four tables; runs persist until a retention policy removes
them. Column definitions are in migrations `020-three-db-cutover`,
`022-workflow-unit-attempts`, `023-child-workflow-runs`, and
`024-workflow-run-outputs` (`src/core/state/migrations.ts`); run semantics are
in [Workflow Engine](../workflow-engine.md).

- `workflow_runs`: one row per run. `status` is `active`, `completed`, `blocked`, or `failed`. It holds the frozen plan (`plan_json`, `plan_hash`, `plan_ir_version`; the version is `WORKFLOW_PLAN_VERSION` in `src/workflows/plan.ts`), `params_json`, `scope_key` (a directory hash that scopes runs to a project), the invoking `agent_harness` and `agent_session_id`, engine lease columns, child-run links (`parent_run_id`, `parent_unit_id`, `invocation_key`), and `outputs_json`.
- `workflow_run_steps`: primary key `(run_id, step_id)`; step `status` is `pending`, `completed`, `blocked`, `failed`, or `skipped`.
- `workflow_run_units`: primary key `(run_id, unit_id)`; the current status of each node in a run's execution graph.
- `workflow_run_unit_attempts`: primary key `(run_id, unit_id, attempt)`; an append-only ledger of external dispatches with a unique `dispatch_id`. A crash reclaim keeps the dispatch id for the same attempt; an explicit retry appends a new attempt.

### `$DATA/logs.db` (task log lines)

`src/core/logs-db.ts` (`getLogsDbPath`). One table, `task_logs`: `id`, `ts`,
`task_id`, `run_id` (`buildTaskRunId`, joins to `task_history`), `stream`
(`stdout`/`stderr`), `level` (`info`/`warn`/`error`), `line`. Indexes on `ts`,
`task_id`, `run_id`. `akm improve`'s retention pass deletes rows older than
`improve.eventRetentionDays` (default 90; 0 disables); there is no size cap.

## Files in `$CONFIG`, `$DATA`, and `$STASH`

| Path | Contents |
|---|---|
| `$CONFIG/config.json` | User configuration (JSONC: comments are stripped at parse time). |
| `$CACHE/config-backups/config-<ISO-ts>.json` | Snapshot of `config.json` taken before each config write (`backupExistingConfig`, `src/core/config/config-io.ts`), plus `config.latest.json`, a copy of the newest. The five newest timestamped snapshots are kept. |
| `$DATA/akm.lock` | JSON array of installed bundle entries, maintained by `akm bundle add` and `akm bundle remove` (`src/integrations/lockfile.ts`). |
| `$STASH/memories/MEMORY.md` | Optional memory index. `akm improve` warns when it passes 180 of a 200-line budget; akm does not write it. |

### Asset directories in `$STASH`

Subdirectories and file shapes come from `BUILTIN_PLACEMENT_SPECS`,
`src/core/asset/asset-placement.ts`. See [Asset Types](../../reference/asset-types.md).

| Subdirectory | Type | File |
|---|---|---|
| `skills/<name>/` | skill | `SKILL.md` |
| `commands/`, `agents/`, `knowledge/`, `instructions/`, `memories/`, `lessons/`, `facts/` | command, agent, knowledge, instruction, memory, lesson, fact | `<name>.md` |
| `workflows/` | workflow | `<name>.md` or `<name>.yml` |
| `tasks/` | task | `<name>.yml` |
| `scripts/` | script | `<name>.<ext>` for `.sh`, `.ts`, `.js`, `.ps1`, `.cmd`, `.bat`, and other script extensions |
| `env/` | env | `<name>.env` (`.env` is `default`) |
| `secrets/` | secret | any file except `.lock` and `.sensitive` sidecars |
| `sessions/<harness>/` | session | `<session-id>.md`; written by the extract pass |

A bundle recognized by the `llm-wiki` adapter (a root with `schema.md` and
`pages/`) is a wiki; `wikis/<name>/` is the usual place. See
[Classification](classification.md).

## Locks and sentinels

| Path | Purpose |
|---|---|
| `$DATA/akm.lock.lck` | Sentinel that serializes writes to `akm.lock`. |
| `$DATA/index.db.write.lock` | Asset-mutation lease: serializes writes to authored content (`remember`, `import`, source updates, proposal apply). Reclaimed only when the holder PID is dead (`src/indexer/index-writer-lock.ts`). |
| `$DATA/index.rebuild.lock` | Taken by every `akm index` run. A plain `akm index` that finds it held warns and proceeds; `akm index --skip-if-locked` exits 0 instead (`src/indexer/index-rebuild-lock.ts`). |
| `$STATE/locks/<stash>/improve.lock` | One `akm improve` run per bundle. JSON `{ pid, startedAt, lockId }`. A lock is reclaimed only when its holder PID is dead; it does not expire by age (`src/commands/improve/locks.ts`, `src/core/run-lock.ts`). |
| `$STATE/locks/scheduler.lock` | Serializes scheduler mutations (`withSchedulerLock`, `src/tasks/scheduler-lock.ts`). |
| `$DATA/workflow-run-locks/<run-id>.lock` | One engine per workflow run; same PID-liveness reclaim (`workflowRunLockPath`, `src/workflows/exec/run-workflow.ts`). |
| `$DATA/secret-locks/<sha256>.lock` | Serializes writes to one secret file (`secretLockPath`, `src/commands/env/secret.ts`). |

## Cache and state directories

| Path | Contents | Retention |
|---|---|---|
| `$CACHE/registry/<source>-<id>/<version>/` | Installed npm and git/github packages: `artifact.tar.gz`, `clone/`, `extracted/` | No automatic cleanup |
| `$CACHE/registry-index/git-<hash>/` | Mirror of a `git` bundle: `repo/` and an `index.json` freshness marker | Fetched on add and on `akm bundle update`, never on a timer; if a forced refresh fails, `akm bundle update` reports the error and the old copy stays on disk |
| `$CACHE/registry-index/website-<hash>/` | A `website` bundle snapshot: `stash/` and `manifest.json` | Fetched on add and on `akm bundle update`, never on a timer; if a forced refresh fails, `akm bundle update` reports the error and the old copy stays on disk |
| `$CACHE/index/unresolved-sources/<stash>/<name>` | Placeholder path for a configured source whose content root did not resolve; not created on disk | n/a |
| `$CACHE/tasks/logs/<task-id>/<ISO-ts>.log` | Per-run task log file; the cron backend also writes `<id>.log` directly in `$CACHE/tasks/logs/` | `akm improve` deletes files older than `improve.eventRetentionDays` (default 90) |
| `$CACHE/logs/index/<ISO-ts>.log`, `$CACHE/logs/improve/<ISO-ts>.log` | Log of one `akm index` run or one non-dry-run `akm improve` run | No automatic cleanup |
| `$CACHE/models/` | Hugging Face model cache for the local embedder (`HF_HOME`, when not already set) | No automatic cleanup |
| `$CACHE/codex-output-schemas/<sha256>.json` | JSON output schemas passed to Codex | No automatic cleanup |
| `$STATE/opencode-model-work/` | `XDG_STATE_HOME` given to the OpenCode plugin when akm dispatches model work through OpenCode (`modelWorkPluginEnv`) | No automatic cleanup |

`git`, `website`, and `npm` bundles are materialized into `$CACHE` by each
provider's `sync()` (`src/sources/providers/`) before indexing, then indexed
like a local filesystem bundle.

## Native scheduler entries

`akm task sync` writes rows into the OS scheduler. Each row runs `akm task run
<id> --bundle <bundle> --scheduled` and sets `AKM_BUNDLE_DIR` to the syncing
process's working bundle, plus any `AKM_CONFIG_DIR`, `AKM_DATA_DIR`,
`AKM_CACHE_DIR`, `AKM_STATE_DIR` that process set explicitly
(`src/tasks/scheduler-invocation.ts`).

- **macOS (launchd):** `~/Library/LaunchAgents/com.akm.task.<id>.plist`, registered with `launchctl bootstrap gui/<uid> <plist>`. The plist's `EnvironmentVariables` carries `PATH` and the variables above.
- **Linux (cron):** no files. The user's crontab is edited through `crontab -l` and `crontab -`. Each task sits between `# akm:task <id> BEGIN` and `# akm:task <id> END` lines, under one `# akm:env BEGIN` / `# akm:env END` block that holds `PATH`. A disabled task's line is prefixed `# akm:disabled `. A command line over 1,000 bytes runs a wrapper script, `$CACHE/tasks/logs/.akm-cron-wrapper-<id>-<hash>.sh`.
- **Windows (Task Scheduler):** `schtasks /Create /TN \akm\<id> /XML <file>` with a temporary `akm-task-<id>-<ts>.xml` in the OS temp directory.

## Read-only inputs

Session extraction (`akm proposal extract` and improve's extract stage) reads
harness session logs. akm does not write to these paths.

| Path | Harness |
|---|---|
| `~/.claude/projects/` (`AKM_CLAUDE_PROJECTS_DIR` overrides) | Claude Code |
| `~/.local/share/opencode/` (Linux), `~/Library/Application Support/opencode/` (macOS) | OpenCode |
| `$CODEX_HOME/sessions/` (`~/.codex/sessions/` by default) | Codex |
