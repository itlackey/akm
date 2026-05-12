# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] — Storage Reorganization & CLI Hardening

### Breaking Changes

- **Storage directories**: akm now uses four XDG directories instead of two. Existing data must be migrated using `bun scripts/migrate-storage.ts`. See [docs/migration/v0.7-to-v0.8.md](docs/migration/v0.7-to-v0.8.md) for the full guide.
  - `$DATA` (`~/.local/share/akm`): `index.db`, `workflow.db`, `state.db`, `akm.lock`, `config-backups/`
  - `$STATE` (`~/.local/state/akm`): task run logs
  - `$CACHE` (`~/.cache/akm`): regenerable data only (registry downloads, binary cache)
  - `$CONFIG` (`~/.config/akm`): `config.json` — unchanged location, but `akm.lock` moves out

- **Event log removed**: `events.jsonl` is no longer written or read. The JSONL event stream is replaced by the `events` table in `state.db`. Run the migration script to import existing events. Any external tooling that reads `$CACHE/events.jsonl` must switch to `akm events` or the `state.db` `events` table directly.

- **Registry file cache removed**: Per-URL JSON files in `$CACHE/registry-index/` are replaced by the `registry_index_cache` table in `index.db`. These files can be safely deleted after migration. No manual action needed for the registry cache itself — it rebuilds automatically on next use.

- **Task history moved**: Per-task JSONL files under `$STATE/tasks/history/` are replaced by the `task_history` table in `state.db`. Existing files can be imported via the migration script.

- **`akm.lock` location changed**: Moved from `$CONFIG/akm.lock` (`~/.config/akm/akm.lock`) to `$DATA/akm.lock` (`~/.local/share/akm/akm.lock`). The migration script copies the file; the old location is no longer read after migration.

- **JSONL fallbacks removed**: `remember`, `import`, and `wiki stash` no longer have JSONL-based fallback write paths. The deprecated `filePath` alias on task entries is removed. All event and task writes go exclusively through `state.db`.

- **`--target` flag standardised**: `akm remember`, `akm import`, and `akm wiki stash` now uniformly use `--target` to specify the destination stash. Previous inconsistent flag names are removed with no compatibility aliases.

- **Deprecated config-dir fallback removed**: The `AKM_CONFIG_DIR`-as-data-directory fallback is removed. Set `AKM_DATA_DIR` explicitly if you override data paths in scripts or CI environments.

### New Features

- **`state.db`**: New migration-safe SQLite database using Flyway-pattern schema migrations (never drops durable rows). Tables: `events`, `proposals`, `task_history`. Located at `$DATA/state.db`.

- **`select` event**: Emitted when `akm show` follows an `akm search` within 60 seconds. Closes the MemRL selection signal loop so the improve pipeline can observe which search results actually get used.

- **`improve_skipped` event**: Emitted at every cooldown-guard skip in `akm improve`, making skip distribution and budget exhaustion observable in the event stream.

- **`reflect_completed` event**: Emitted after `akm reflect` creates a proposal, linking the reflect invocation to its proposal ID for closed-loop outcome tracking.

- **Search mode metadata**: `search` events now include `mode: "semantic" | "keyword"` for long-term quality analysis of retrieval strategies.

- **Per-task `timeoutMs` override**: Individual task definitions can set `timeoutMs` to override the global task timeout. Set to `null` to disable the timeout for a specific task.

- **`--target` on `remember`, `import`, and `wiki stash`**: All three write commands now accept a uniform `--target <stash-name>` flag to route the write to a specific named writable source, bypassing `defaultWriteTarget` and working-stash resolution.

- **Proposal resolution by ref or UUID prefix**: `akm accept`, `akm reject`, and `akm diff` now accept a short UUID prefix (e.g. `akm accept abc123`) or an asset ref (e.g. `akm accept memory:my-note`) in addition to full UUIDs.

- **`bun scripts/migrate-storage.ts`**: One-shot migration script to move existing data to the new XDG layout. Supports `--dry-run` to preview changes without applying them and `--yes` to apply.

### Performance

- **`akm improve` cooldown pre-filter**: Assets under cooldown are now filtered out before the main improvement loop rather than inside it. Reduces LLM API calls and speeds up runs on large stashes with many recently-processed assets.

### Bug Fixes

- **EISDIR on `akm improve`**: Fixed a crash when the improve pipeline encountered a directory entry where it expected a file. Directory paths are now validated and skipped with a warning rather than throwing an uncaught EISDIR error.

- **Lint `missing-ref` false positives**: The lint pass no longer flags refs that resolve through stash aliases or secondary sources. Cross-stash refs that are genuinely reachable no longer produce spurious `missing-ref` warnings.

- **`task_history` upsert overwrite bug**: Fixed migration 002 where a `task_history` upsert could silently overwrite an existing row for the same `(task_id, started_at)` pair instead of inserting a new row. Per-run rows are now correctly keyed on the auto-increment `id`.

- **Index isolation in XDG test harness**: Expanded XDG env isolation in tests so that `index.db`, `workflow.db`, and `state.db` always resolve inside the test's temporary directory tree, preventing cross-test state leakage.

### Migration

See [docs/migration/v0.7-to-v0.8.md](docs/migration/v0.7-to-v0.8.md) for the complete step-by-step guide.

Quick reference:

```sh
# Preview what the migration will do
bun scripts/migrate-storage.ts --dry-run

# Apply the migration
bun scripts/migrate-storage.ts --yes
```
