# Changelog

All notable changes to this project will be documented in this file.

## [0.9.0] — Storage Reorganization

### Breaking Changes

- **Storage directories**: akm now uses four XDG directories. Existing data must be migrated using `bun scripts/migrate-storage.ts`.
  - `$DATA` (`~/.local/share/akm`): `index.db`, `workflow.db`, `state.db`, `akm.lock`, `config-backups/`
  - `$STATE` (`~/.local/state/akm`): task run logs
  - `$CACHE` (`~/.cache/akm`): regenerable data only (registry downloads, binary cache)

- **Event log**: `events.jsonl` is replaced by the `events` table in `state.db`. The JSONL file is no longer written or read. Run the migration script to import existing events.

- **Task history**: Per-task JSONL files are replaced by the `task_history` table in `state.db`.

- **Registry index cache**: Per-URL JSON files in `$CACHE/registry-index/` are replaced by the `registry_index_cache` table in `index.db`. These files can be safely deleted.

- **akm.lock location**: Moved from `~/.config/akm/akm.lock` to `~/.local/share/akm/akm.lock`.

### New Features

- **`state.db`**: Migration-safe SQLite database using Flyway-pattern schema migrations (never drops durable rows). Tables: `events`, `proposals`, `task_history`.
- **`select` event**: Emitted when `akm show` follows an `akm search` within 60 seconds. Closes the MemRL selection signal loop.
- **`improve_skipped` event**: Emitted at every cooldown-guard skip in `akm improve`, making skip distribution observable.
- **`reflect_completed` event**: Emitted after `akm reflect` creates a proposal, linking the invocation to its proposal ID for closed-loop outcome tracking.
- **Search mode signal**: `search` events now include `mode: "semantic" | "keyword"` for long-term quality analysis.
- **`bun scripts/migrate-storage.ts`**: One-shot migration script to move existing data to new locations.

### Migration

Run: `bun scripts/migrate-storage.ts --dry-run` to preview, then `bun scripts/migrate-storage.ts --yes` to apply.
