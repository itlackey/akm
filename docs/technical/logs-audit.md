# Logs audit — every log producer, and where it should live (#579)

Strategic direction (0.9.0): **stop scattering observability data across flat
files and folders**. Anything a machine consumes (health checks, advisories,
audits, cross-run queries) belongs in SQLite where it can be indexed, joined,
and purged. Flat files remain only where (a) a human tail is genuinely the
interface, (b) the writer is outside an akm process, or (c) the data is
stash-portable content rather than machine-local observability.

This document inventories every log location akm writes or reads, with a
keep / move / drop decision per source.

## The databases

| Database | Owner module | Contents |
|---|---|---|
| `<dataDir>/state.db` | `src/core/state-db.ts` | Durable records: events, proposals, task_history, improve_runs, extract_sessions_seen, and workflow run state (`workflow_runs` / `workflow_run_steps` / `workflow_run_units`, folded in from the former `workflow.db` in 0.9.0) |
| `<dataDir>/logs.db` | `src/core/logs-db.ts` (new in #579) | High-volume task/run log lines: `task_logs {ts, task_id, run_id, stream, level, line}` |
| `<dataDir>/index.db` | `src/indexer/db/db.ts` | Regenerable search index + usage events |

logs.db is deliberately separate from state.db: log lines are high-volume,
append-only, and freely purgeable, whereas state.db rows are durable records.
Cross-db joins use `ATTACH` — `openLogsDatabaseWithState()` opens logs.db with
state.db attached as `state`, and `queryFailedRunLogLines()` is the canonical
join (failed `task_history` row → its log lines via
`task_logs.run_id = task_history.task_id || '@' || task_history.started_at`,
see `buildTaskRunId()`).

Retention: `purgeOldTaskLogs()` mirrors `purgeOldEvents()` /
`purgeOldImproveRuns()` and runs in the same improve maintenance pass,
governed by the single `improve.eventRetentionDays` knob (default 90 days).

## Producer inventory

### 1. Task run logs — MOVED to logs.db (transitional dual-write)

- **Writer:** `src/tasks/runner.ts` (`persistRunLog`)
- **Old location:** `<cacheDir>/tasks/logs/<task-id>/<ts>.log`, one flat text
  file per run, path recorded in `task_history.log_path`.
- **Decision: MOVE.** Every run now writes structured rows to
  `logs.db::task_logs`, keyed by `run_id = buildTaskRunId(task_id, started_at)`
  with per-line `stream` (`stdout`/`stderr`) and `level` (`info`/`error`).
- **Transitional:** the flat file is still written (dual-write) so
  `task_history.log_path` keeps resolving for humans (`cat`/`tail`) and for
  history rows that predate logs.db. The file write is slated for removal once
  a `tasks logs` read surface exists over the DB (target: 1.0). The health
  log-backing check already prefers the DB and uses the file only as a
  fallback for pre-#579 rows.

### 2. OS-scheduler redirect logs — KEEP (files)

- **Writers:** the OS schedulers themselves, configured by
  `src/tasks/backends/cron.ts` (`>> <logDir>/<id>.log 2>&1`),
  `launchd.ts` (plist stdout/stderr path), `schtasks.ts` (cmd redirect) —
  all under `<cacheDir>/tasks/logs/<id>.log`.
- **Decision: KEEP.** These lines are written by cron/launchd/schtasks shell
  redirection, *outside* any akm process — they exist precisely to capture
  failures that happen before the akm runner starts (missing binary, bad PATH).
  A process that cannot start cannot write to SQLite. Once the runner is up,
  everything it captures goes to logs.db (source 1), so these files stay tiny.

### 3. Improve run tee logs — KEEP for now (candidate for a future move)

- **Writer:** `src/commands/improve/improve-cli.ts` via `setLogFile()`
  (`src/core/warn.ts`) → `<cacheDir>/logs/improve/<ts>.log`.
- **Decision: KEEP.** This is a free-form tee of stderr diagnostics
  (`info`/`warn`/`error`) for post-mortem reading; the *structured* record of
  every improve run already lives in `state.db::improve_runs`
  (`result_json`, `metrics_json`) and in `events`. No machine consumer greps
  this file. If one ever appears, the move is a `cli_logs` table in logs.db
  reusing the `task_logs` shape — do not add a new grep.
- Note: scheduled improve runs (`akm-improve-*` tasks) additionally get their
  agent stdout/stderr captured into logs.db via source 1.

### 4. Index run tee logs — KEEP for now

- **Writer:** `src/commands/sources/stash-cli.ts` via `setLogFile()` →
  `<cacheDir>/logs/index/<ts>.log`.
- **Decision: KEEP.** Same rationale and same future path as source 3.

### 5. Consolidation / reflect / distill logging — already DB-backed, KEEP

- **Writers:** the improve phases log prose through `core/warn` (lands in the
  source-3 tee + stderr) and record structured outcomes in
  `state.db::improve_runs.result_json` plus events
  (`improve_reflect_outcome`, `improve_completed`, …).
- **Decision: KEEP / no action.** Everything a machine reads is already in
  state.db; the prose lines are human-only. `akm health` reads these phases
  exclusively through `queryImproveRuns()` / `readEvents()` — no file greps.

### 6. Memory belief-transition audit log — KEEP (stash content)

- **Writer:** `src/commands/improve/memory/memory-improve.ts` →
  `<stash>/.akm/memory-cleanup/belief-transitions.jsonl` (+ archived asset
  copies under `.akm/memory-cleanup/archive/`).
- **Decision: KEEP.** This is a stash-portable audit trail that travels (and
  syncs) with the stash itself. Machine-local databases are the wrong home for
  data whose whole point is to follow the stash across machines.

### 7. Extract session scans — external sources, KEEP (read-only)

- **Readers:** `src/integrations/session-logs/` +
  `src/integrations/harnesses/*/session-log.ts` scan harness-owned session
  files (`~/.claude/projects/**`, opencode storage).
- **Decision: KEEP.** akm does not own these files and must not move them.
  The extract pipeline's *processed-state* is already in
  `state.db::extract_sessions_seen`; raw session content stays where the
  harness puts it.

### 8. Health-report log consumers

- **task-log-backing check + `logBackingRate` metric** (`src/commands/health.ts`,
  `partitionLogBackedRows`): previously `fs.existsSync` over every
  `task_history.log_path` file. **MOVED (#579):** now answered by
  `getLoggedRunIds()` against logs.db, with the file check retained only as a
  fallback for history rows that predate logs.db.
- **session-log-failures advisory** (`getExecutionLogCandidates`): regex scan
  over *external* harness session logs (source 7). **KEEP** — external files,
  and the scan is already capped and informational-only.

### 9. Legacy flat stores — already DROPPED (0.8)

For completeness: `events.jsonl`, per-uuid proposal directories, and per-task
history JSONL under `<cacheDir>/tasks/history/` were migrated into state.db in
0.8 (`scripts/migrate-storage.ts`, `importEventsJsonl`). No new writers exist.

### 10. Wiki `log.md` — KEEP (asset content, not observability)

`src/wiki/wiki.ts::readRecentLog` reads a wiki's agent-maintained `log.md`.
That is stash *content* (an asset with markdown conventions), not a runtime
log. Out of scope for logs.db.

## Rules going forward

1. New machine-readable log data goes in logs.db (or state.db when durable),
   never a new flat file/folder.
2. New consumers query the DB; adding a regex/grep over a log file is a
   review-blocker.
3. Cross-db questions use ATTACH helpers in `src/core/logs-db.ts`, not ad-hoc
   path stitching.
4. Every new table gets a purge helper wired into the improve maintenance
   pass, following `purgeOldTaskLogs()`.
