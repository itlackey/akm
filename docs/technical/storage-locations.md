# AKM Storage Locations

This document is the authoritative reference for every location on disk where akm reads or writes persistent data: databases, event streams, config files, asset files, caches, locks, and OS-native task scheduler entries.

## Path Variables

All paths below use these resolved base directories:

| Variable | Default (Linux/macOS) | Override |
|---|---|---|
| `$CACHE` | `~/.cache/akm` | `$AKM_CACHE_DIR` env var |
| `$CONFIG` | `~/.config/akm` | `$AKM_CONFIG_DIR` env var |
| `$STASH` | `~/akm` | `$AKM_STASH_DIR` env var |

On Windows: `$CACHE` → `%LOCALAPPDATA%\akm`, `$CONFIG` → `%APPDATA%\akm`.

---

## SQLite Databases

### `$CACHE/index.db` — Main Search Index

Schema version `DB_VERSION = 11`. WAL mode, `busy_timeout = 5000 ms`, foreign keys ON. Optionally loads the `sqlite-vec` extension for fast ANN (approximate nearest-neighbour) vector search.

Opened by:
- `openDatabase()` — full schema init, called by `akm index`
- `openExistingDatabase()` — read/write without schema mutation, called by search/show/curate

**Retention:** Rebuilt (drop + recreate all tables) on `DB_VERSION` mismatch. `usage_events` rows are backed up before the drop and restored after. `clearStaleCacheEntries()` removes orphaned LLM cache rows. `purgeOldUsageEvents()` removes rows older than 90 days.

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
| `entry_key` | TEXT NOT NULL UNIQUE | `<stash_dir>:<type>:<name>` |
| `dir_path` | TEXT NOT NULL | Parent directory of the asset file |
| `file_path` | TEXT NOT NULL | Absolute path to the asset file |
| `stash_dir` | TEXT NOT NULL | Root stash directory |
| `entry_json` | TEXT NOT NULL | Full `StashEntry` as JSON |
| `search_text` | TEXT NOT NULL | Pre-built BM25 search string |
| `entry_type` | TEXT NOT NULL | Asset type: `memory`, `skill`, `lesson`, etc. |

Indexes: `idx_entries_dir` on `dir_path`, `idx_entries_type` on `entry_type`.

#### Virtual Table: `entries_fts` (FTS5)

BM25-weighted full-text search. Tokenizer: `porter unicode61`.

| Column | BM25 weight |
|---|---|
| `name` | 10.0 |
| `description` | 5.0 |
| `tags` | 3.0 |
| `hints` | 2.0 |
| `content` | 1.0 |

#### Table: `entries_fts_dirty`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | Entry needing FTS rebuild |

Dirty queue drained during incremental `akm index`. Avoids full FTS wipe on every run.

#### Table: `embeddings`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Matches `entries.id` |
| `embedding` | BLOB NOT NULL | Float32 vector, little-endian IEEE-754 |

Used by JS cosine-similarity fallback when `sqlite-vec` is absent.

#### Virtual Table: `entries_vec` (conditional)

Created only when `sqlite-vec` is loadable. Columns: `id INTEGER PRIMARY KEY`, `embedding FLOAT[<dim>]`. Dropped and recreated if embedding dimension changes.

#### Table: `workflow_documents`

| Column | Type | Notes |
|---|---|---|
| `entry_id` | INTEGER PRIMARY KEY | FK → `entries(id)` ON DELETE CASCADE |
| `schema_version` | INTEGER NOT NULL | Workflow schema version |
| `document_json` | TEXT NOT NULL | Parsed `WorkflowDocument` AST |
| `source_path` | TEXT NOT NULL | Stash directory path |
| `source_hash` | TEXT NOT NULL | FNV-1a hash of raw file bytes (incremental skip key) |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

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
| `asset_ref` | TEXT PRIMARY KEY | Absolute file path or `entryKey:passId` |
| `body_hash` | TEXT NOT NULL | SHA-256 hex digest of file body |
| `result_json` | TEXT NOT NULL | Serialized LLM enrichment result |
| `updated_at` | INTEGER NOT NULL | Unix ms timestamp |

Cache miss on body change. Stale rows removed by `clearStaleCacheEntries()`. Bypassed with `--re-enrich` flag.

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

See [Utility Score Pipeline](#utility-score-pipeline) below.

#### Table: `usage_events`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `event_type` | TEXT NOT NULL | `search`, `show`, `select`, `feedback` |
| `query` | TEXT | Search query (NULL for non-search events) |
| `entry_id` | INTEGER | FK → `entries(id)`; NULL until re-linked after rebuild |
| `entry_ref` | TEXT | Stable `type:name` string (survives entry ID changes) |
| `signal` | TEXT | Feedback signal: `positive` or `negative` |
| `metadata` | TEXT | JSON free-form metadata |
| `created_at` | TEXT NOT NULL | ISO-8601 |

Indexes: `idx_usage_events_entry`, `idx_usage_events_type`, `idx_usage_events_ref`.

Preserved across schema version upgrades. `relinkUsageEvents()` re-associates rows to new entry IDs via `entry_ref` after a full rebuild.

#### Table: `search_events` (legacy)

Queried defensively by `getZeroResultSearches()` but not created by current schema. May exist in databases created by older akm versions.

| Column | Type |
|---|---|
| `query` | TEXT |
| `result_count` | INTEGER |
| `ts` | INTEGER (Unix ms) |

---

### `$CACHE/workflow.db` — Workflow Run State

WAL mode, foreign keys ON. No automatic cleanup — runs persist indefinitely.

#### Table: `workflow_runs`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `workflow_ref` | TEXT NOT NULL | e.g. `workflow:review-todos` |
| `scope_key` | TEXT | Directory hash; isolates runs per project |
| `workflow_entry_id` | INTEGER | Optional FK into `index.db entries.id` |
| `workflow_title` | TEXT NOT NULL | Human-readable title |
| `status` | TEXT NOT NULL | `active`, `completed`, `blocked`, `failed` |
| `params_json` | TEXT NOT NULL DEFAULT '{}' | Run parameters |
| `current_step_id` | TEXT | NULL when completed |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |
| `completed_at` | TEXT | ISO-8601; NULL while active |

Indexes: `idx_workflow_runs_ref`, `idx_workflow_runs_status`, `idx_workflow_runs_scope_ref_status`.

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

Primary key: `(run_id, step_id)`.

---

## JSONL Event Streams

### `$CACHE/events.jsonl` — Append-only Audit Log

Written with `fs.appendFileSync` + `O_APPEND`. Atomic for payloads under PIPE_BUF (~4 KiB on Linux). Safe for concurrent writers. Grows indefinitely — **no automatic cleanup**.

**Wire format (one object per line):**
```json
{"schemaVersion":1,"ts":"2026-05-11T01:37:00.000Z","eventType":"<verb>","ref":"<type:name>","metadata":{}}
```

> `id` is the byte offset of the line — assigned at read time via `readEvents()`, not stored on disk.

**Full event type catalog:**

| `eventType` | Emitted by | Key `metadata` fields |
|---|---|---|
| `add` | `akm add` | `target`, `provider`, `name`, `writable` |
| `remove` | `akm remove` | `target`, `ref` |
| `update` | `akm update` | `target`, `all`, `processed` |
| `remember` | `akm remember` | `path`, `force`, `tagCount`, `enriched`, `auto`, `scope` |
| `import` | `akm import` | `source`, `path`, `force` |
| `save` | `akm save` | `name`, `message`, `ok` |
| `feedback` | `akm feedback` | `signal` (positive\|negative), `reason`, `tags` |
| `promoted` | `akm proposal accept` | `proposalId`, `source`, `assetPath` |
| `rejected` | `akm proposal reject` | `proposalId`, `source`, `reason` |
| `reflect_invoked` | `akm reflect` | `task`, `profile` |
| `propose_invoked` | `akm propose` | `type`, `name`, `task`, `profile` |
| `distill_invoked` | `akm distill` | `outcome` (queued\|skipped\|validation_failed\|quality_rejected), `lessonRef`, `score`, `reason` |
| `search` | `akm search` | `query`, `hitCount`, `resultRefs[]` |
| `show` | `akm show` | `type`, `name` |
| `improve_invoked` | `akm improve` | `scope`, `dryRun`, `assetCount` |
| `consolidate_completed` | `akm improve` (post-consolidation) | `processed`, `merged` |
| `schema_repair_invoked` | `akm improve` (repair pass) | `outcome` (written\|error), `reason`, `error?` |
| `workflow_started` | workflow engine | `runId` |
| `workflow_step_completed` | workflow engine | `runId`, `stepId` |
| `workflow_finished` | workflow engine | `runId` |

**Read API:** `readEvents(options)` — filter by `since`, `sinceOffset` (byte cursor), `type`, `ref`, `includeTags`, `excludeTags`. Returns `{ events, nextOffset }`. `tailEvents()` provides a polling loop.

**Consumers and purpose:**

| Consumer | Filter used | Purpose |
|---|---|---|
| `akm improve` | `feedback` within 30d | Signal-filter candidate selection |
| `akm improve` | `reflect_invoked` per ref | Reflect cooldown guard (7d / 14d / 3d tier) |
| `akm improve` | `distill_invoked` per ref | Distill cooldown guard (30d) |
| `akm improve` | `consolidate_completed` | Consolidation cooldown guard (14d) |
| `akm improve` | `schema_repair_invoked` per ref | Schema repair cooldown guard (7d) |
| `akm distill` | `feedback` per ref | Builds LLM prompt context (last 20 events) |
| `akm reflect` | `feedback` per ref | Builds agent prompt context (last 10 per-ref / 20 global) |
| `akm show` | `show` per ref | Loop detection: warns at 3+ repeated shows |
| `akm history` | `promoted`, `rejected` | Unified lifecycle trail |
| `akm events` | user-supplied | Direct inspection / tail |

---

### `$CACHE/tasks/history/<task-id>.jsonl` — Task Run History

One line per execution: `{ id, status, startedAt, finishedAt, durationMs, log, target, detail? }`. No cleanup.

### `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` — Belief State Log

One line per memory belief-state transition: `{ appliedAt, ref, parentRef, fromState, toState, reason, relatedRef? }`. Observability only; no programmatic consumer reads this file.

---

## JSON / Config Files

| Path | Contents | Retention |
|---|---|---|
| `$CONFIG/config.json` | User config (stash dirs, sources, LLM endpoints, feature flags, registries). JSONC — `//` and `/* */` comments stripped at parse time. | Manual |
| `<cwd>/.akm/config.json` | Project-scoped config overrides. Walked up to filesystem root; all ancestors merged. | Manual |
| `$CACHE/config-backups/config-<ISO-ts>.json` | Pre-save snapshot of `config.json` before each write. `config.latest.json` symlink always points to the newest backup. | Accumulate forever |
| `$CONFIG/akm.lock` | Installed stash entries: `{ id, source, ref, resolvedVersion, resolvedRevision, integrity }`. Written atomically. | Managed by `akm add/remove` |
| `$CACHE/semantic-status.json` | Embedding provider health: `status` (pending/ready-js/ready-vec/blocked), `reason`, `providerFingerprint`, `lastCheckedAt`, `entryCount`, `embeddingCount`. Blocked status auto-expires after 24h. | Reset on `akm index --full` |
| `$CACHE/registry-index/<slug>.json` | Cached remote registry index (v2/v3 schema). Fresh 1h; stale fallback 7d. Slug = registry URL with non-alphanumeric → `-`, max 120 chars. | TTL |
| `$CACHE/registry-index/skills-sh-search-<md5>.json` | Skills.sh search result cache. Fresh 15min; stale 1d. Key = MD5 of `url + query + limit`. | TTL |
| `$STASH/.akm/consolidate-journal.json` | Write-ahead journal for consolidation operations. Used to detect incomplete runs on restart. | Deleted on success |
| `$STASH/.akm/graph.json` | Knowledge graph artifact: `{ schemaVersion, generatedAt, nodes, edges }` extracted from memory + knowledge assets via LLM. Written atomically. | Rebuilt each index run |

---

## Markdown / Asset Files

### Primary Stash Content

All asset files live under `$STASH/` in type-specific subdirectories defined by `TYPE_DIRS` in `src/core/asset-spec.ts`:

| Subdirectory | Asset Type | Format |
|---|---|---|
| `skills/<name>/SKILL.md` | skill | YAML-FM + Markdown |
| `commands/<name>.md` | command | YAML-FM + Markdown |
| `agents/<name>.md` | agent | YAML-FM + Markdown |
| `knowledge/<name>.md` | knowledge | YAML-FM + Markdown |
| `workflows/<name>.md` | workflow | YAML-FM + Markdown |
| `scripts/<name>.<ext>` | script | sh / ts / js / ps1 etc. |
| `memories/<name>.md` | memory | YAML-FM + Markdown |
| `vaults/<name>.env` | vault | `KEY=VALUE` pairs |
| `wikis/<name>/` | wiki | See wiki structure below |
| `lessons/<name>.md` | lesson | YAML-FM + Markdown (required: `description`, `when_to_use`) |
| `tasks/<name>.md` | task | YAML-FM + Markdown |

### Wiki File Structure

Each `$STASH/wikis/<wikiName>/` contains:

| File | Purpose |
|---|---|
| `schema.md` | Content structure definition |
| `index.md` | Table of contents |
| `log.md` | Recent activity log |
| `raw/.gitkeep` | Ensures `raw/` survives clean clones |
| `raw/<slug>.md` | Immutable ingested raw sources |
| `<page>.md` | Synthesized wiki pages |

### Improvement Pipeline Files

| Path | Contents | Retention |
|---|---|---|
| `$STASH/.akm/proposals/<uuid>/proposal.json` | Pending proposal: `{ id, ref, status, source, createdAt, updatedAt, payload.content, payload.frontmatter? }` | Until accepted/rejected |
| `$STASH/.akm/proposals/archive/<uuid>/proposal.json` | Archived proposal with `status: accepted\|rejected` and `review` populated | Permanent |
| `$STASH/.akm/archive/<ts>-<i>-<name>.md` | Soft-invalidated memory (P1-B). Adds `status: superseded`, `superseded_at`, `superseded_by`, `superseded_reason` to frontmatter. | TTL: `archiveRetentionDays` (default 90d) |
| `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Pre-merge file copies (consolidation backups) | Deleted on consolidation success |
| `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Belief-state archived memory files + `cleanup.md` audit record | No cleanup |
| `$STASH/.akm/distill-rejected/<ts>-<lessonRef>.md` | Lessons that failed the LLM-as-judge quality gate. Frontmatter: `{ score, reason }`. | No cleanup |
| `$STASH/memories/MEMORY.md` | Human-maintained memory index. Budget: warn at 180 lines, hard cap at 200. Read-only for akm (not written by current code). | Manual |
| `<dir>/.stash.json` | Legacy per-directory metadata manifest. Still parsed as an override layer by the indexer but no longer written. | Manual |

---

## Lock / Sentinel Files

| Path | Format | Purpose |
|---|---|---|
| `$CONFIG/akm.lock.lck` | Plain text (PID) | Advisory write-lock for `akm.lock` mutations. Created with `O_EXCL`; stale locks (dead PIDs) auto-reclaimed. Best-effort: 3 retries × 100ms. |
| `$STASH/.akm/improve.lock` | JSON `{ pid, startedAt }` | Prevents concurrent `akm improve` runs on the same stash. Stale locks auto-reclaimed by PID liveness check. |

---

## Cache Directories

| Path | Contents | TTL / Retention |
|---|---|---|
| `$CACHE/registry/<src>/<id>/<ver>/` | Downloaded stash packages (npm tarballs + extracted trees) | No TTL |
| `$CACHE/registry/<src>/<id>/repo/` | Git mirror working trees for git-sourced stashes | 12h fresh; 7d stale |
| `$CACHE/registry-index/website-<sha256-16>/` | Scraped website content as knowledge markdown files + `manifest.json` freshness marker | 12h fresh; 7d stale |
| `$CACHE/registry-build/build-<random>/` | Temp archive extraction for registry index building | Deleted in `finally` after each run |
| `$CACHE/tasks/logs/<task-id>/` | Per-run stdout/stderr log files (`<ISO-ts>.log`) | No cleanup |
| `$CACHE/bin/rg` | Auto-downloaded ripgrep binary | Permanent |

---

## OS-Native Task Scheduler Files

### macOS (launchd)

**Plist:** `~/Library/LaunchAgents/com.akm.task.<id>.plist` — XML plist. Contains label, `ProgramArguments` (`akm tasks run <id>`), `StandardOutPath`, `StandardErrorPath`, trigger (`StartInterval` or `StartCalendarInterval`), and `EnvironmentVariables` (PATH captured at install time).

Registered via `launchctl bootstrap gui/<uid> <plist>`.

### Linux (cron)

No files written. User crontab edited in-place via `crontab -l` / `crontab -`. Each task is bracketed with sentinels:

```
# akm:task <id> BEGIN
<cronexpr> /abs/akm tasks run <id> >> ~/.cache/akm/tasks/logs/<id>.log 2>&1
# akm:task <id> END
```

Disabled tasks get `# akm:disabled ` prepended to the cron line.

### Windows (Task Scheduler)

Task definition XML written to `%TEMP%\akm-task-<id>-<ts>.xml`, used to register via `schtasks /Create`, then deleted in the `finally` block. Persistent state is in the Windows Task Scheduler (OS-managed).

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
  → appendEvent()            → events.jsonl (for improve/distill/reflect pipeline)

akm index  (recomputeUtilityScores)
  → reads usage_events aggregates per entry
       selectRate   = min(1, show_count / search_count)
       feedbackRate = (positive_count − negative_count) / total_feedback
       effectiveRate = max(selectRate, feedbackRate)
       decay        = 0.7 ^ elapsedDays
       utility      = prevUtility × decay + effectiveRate × (1 − decay)
  → overwrites utility_scores rows

akm search  (ranking phase)
  → recencyFactor = exp(−daysSinceLastUse / 30)
  → score        *= min(1 + utility × recencyFactor × 0.5, 1.5)
```

**Dual-write rationale:** `usage_events` (SQLite) powers fast SQL aggregation for the EMA recompute during indexing. `events.jsonl` powers text-filtered reads (by ref, type, tags, since-cutoff) used by the improve/distill/reflect pipeline without requiring the index DB to be open.

---

## Summary Index

| # | Path | Format | Purpose |
|---|---|---|---|
| 1 | `$CACHE/index.db` | SQLite 3 (WAL) | Main search index, embeddings, utility scores, usage events, LLM cache |
| 2 | `$CACHE/workflow.db` | SQLite 3 (WAL) | Workflow run state and per-step status |
| 3 | `$CACHE/events.jsonl` | JSONL (append-only) | Audit event log for all mutating CLI operations |
| 4 | `$CACHE/tasks/history/<id>.jsonl` | JSONL | Per-task execution history |
| 5 | `$STASH/.akm/memory-cleanup/belief-transitions.jsonl` | JSONL | Belief state transition audit log |
| 6 | `$CONFIG/config.json` | JSONC | User configuration |
| 7 | `<cwd>/.akm/config.json` | JSONC | Project-scoped config overrides |
| 8 | `$CACHE/config-backups/config-<ts>.json` | JSON | Config pre-save backups |
| 9 | `$CONFIG/akm.lock` | JSON | Installed stash lockfile |
| 10 | `$CONFIG/akm.lock.lck` | Text (PID) | Write-lock sentinel for lockfile |
| 11 | `$CACHE/semantic-status.json` | JSON | Embedding provider health cache |
| 12 | `$CACHE/registry-index/<slug>.json` | JSON | Remote registry index cache |
| 13 | `$CACHE/registry-index/skills-sh-search-<md5>.json` | JSON | Skills.sh query result cache |
| 14 | `$STASH/.akm/consolidate-journal.json` | JSON | Consolidation write-ahead journal |
| 15 | `$STASH/.akm/graph.json` | JSON | Knowledge graph artifact |
| 16 | `$STASH/.akm/proposals/<uuid>/proposal.json` | JSON | Pending proposals |
| 17 | `$STASH/.akm/proposals/archive/<uuid>/proposal.json` | JSON | Archived proposals |
| 18 | `$STASH/.akm/archive/<ts>-<i>-<name>.md` | FM+Markdown | Soft-invalidated memories (90d TTL) |
| 19 | `$STASH/.akm/consolidate-backup/<ts>/<name>.md` | Markdown | Pre-merge file backups |
| 20 | `$STASH/.akm/memory-cleanup/archive/<ts>-<ref>/` | Markdown | Belief-state archived memories |
| 21 | `$STASH/.akm/distill-rejected/<ts>-<ref>.md` | FM+Markdown | Quality-gate rejected lessons |
| 22 | `$STASH/.akm/improve.lock` | JSON | Improve run mutex |
| 23 | `$STASH/{skills,commands,agents,...}/` | FM+Markdown | Asset files (working stash) |
| 24 | `$STASH/wikis/<name>/` | Markdown | Wiki content |
| 25 | `<dir>/.stash.json` | JSON | Legacy metadata (read-only) |
| 26 | `$STASH/memories/MEMORY.md` | Markdown | Memory index (user-maintained, read-only for akm) |
| 27 | `$CACHE/registry/<src>/<id>/<ver>/` | Binary+FS | Downloaded stash package cache |
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

---

Check `src/core/paths.ts` for the canonical path resolution functions (`getCacheDir`, `getConfigDir`, `getDbPath`, `getWorkflowDbPath`, `getEventsPath`, `getSemanticStatusPath`).
