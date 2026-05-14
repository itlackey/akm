# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] — Storage Reorganization & CLI Hardening

### Breaking Changes

- **`vault set` no longer accepts values via argv**: The positional `<VALUE>` argument and the `KEY=VALUE` combined form have been removed. Values must be supplied via stdin (default) or `--from-env <VAR>`. This eliminates `/proc/cmdline` secret exposure. Migrate existing scripts:
  ```sh
  # Before
  akm vault set vault:prod DB_URL postgres://...
  akm vault set vault:prod DB_URL=postgres://...

  # After
  printf '%s' "postgres://..." | akm vault set vault:prod DB_URL
  AKM_VALUE="postgres://..." akm vault set vault:prod DB_URL --from-env AKM_VALUE
  ```

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

- **`akm index --enrich` and `--re-enrich` removed**: Plain `akm index` now owns fast metadata enhancement when LLM metadata enrichment is enabled. Slow LLM maintenance work no longer runs from `index`.

- **Memory inference and graph extraction moved out of `index`**: The slow memory-maintenance passes now run from `akm improve` after consolidation, not from `akm index`. Automation that previously treated `index` as the owner of all LLM enrichment work must switch to the improve-owned maintenance flow.

### New Features

- **`vault set` reads from stdin by default**: Values are never passed via argv. `printf '%s' "$SECRET" | akm vault set vault:prod KEY` is the default pattern. Use `--from-env <VAR>` to read from a named environment variable instead.

- **`vault set --from-env <VAR>`**: New flag reads the value from the named environment variable, avoiding both argv and stdin. Errors with exit 2 if the variable is not set.

- **`state.db`**: New migration-safe SQLite database using Flyway-pattern schema migrations (never drops durable rows). Tables: `events`, `proposals`, `task_history`. Located at `$DATA/state.db`.

- **`select` event**: Emitted when `akm show` follows an `akm search` within 60 seconds. Closes the MemRL selection signal loop so the improve pipeline can observe which search results actually get used.

- **`improve_skipped` event**: Emitted at every cooldown-guard skip in `akm improve`, making skip distribution and budget exhaustion observable in the event stream.

- **`reflect_completed` event**: Emitted after `akm reflect` creates a proposal, linking the reflect invocation to its proposal ID for closed-loop outcome tracking.

- **Search mode metadata**: `search` events now include `mode: "semantic" | "keyword"` for long-term quality analysis of retrieval strategies.

- **Per-task `timeoutMs` override**: Individual task definitions can set `timeoutMs` to override the global task timeout. Set to `null` to disable the timeout for a specific task.

- **`akm health`**: New runtime health command that validates `state.db`, checks task-history/log integrity, probes the default agent profile, and summarizes recent improve-loop telemetry from `improve_*` events.

- **`--target` on `remember`, `import`, and `wiki stash`**: All three write commands now accept a uniform `--target <stash-name>` flag to route the write to a specific named writable source, bypassing `defaultWriteTarget` and working-stash resolution.

- **Proposal resolution by ref or UUID prefix**: `akm accept`, `akm reject`, and `akm diff` now accept a short UUID prefix (e.g. `akm accept abc123`) or an asset ref (e.g. `akm accept memory:my-note`) in addition to full UUIDs.

- **`bun scripts/migrate-storage.ts`**: One-shot migration script to move existing data to the new XDG layout. Supports `--dry-run` to preview changes without applying them and `--yes` to apply.

### Performance

- **`akm improve` cooldown pre-filter**: Assets under cooldown are now filtered out before the main improvement loop rather than inside it. Reduces LLM API calls and speeds up runs on large stashes with many recently-processed assets.

- **Improve-owned maintenance refreshes the final corpus state**: `akm improve` now runs memory inference after distill/consolidation, reindexes when inference writes new derived memories, and refreshes graph extraction against the settled post-improve state.

### Bug Fixes

- **EISDIR on `akm improve`**: Fixed a crash when the improve pipeline encountered a directory entry where it expected a file. Directory paths are now validated and skipped with a warning rather than throwing an uncaught EISDIR error.

- **Lint `missing-ref` false positives**: The lint pass no longer flags refs that resolve through stash aliases or secondary sources. Cross-stash refs that are genuinely reachable no longer produce spurious `missing-ref` warnings.

- **`task_history` upsert overwrite bug**: Fixed migration 002 where a `task_history` upsert could silently overwrite an existing row for the same `(task_id, started_at)` pair instead of inserting a new row. Per-run rows are now correctly keyed on the auto-increment `id`.

- **Index isolation in XDG test harness**: Expanded XDG env isolation in tests so that `index.db`, `workflow.db`, and `state.db` always resolve inside the test's temporary directory tree, preventing cross-test state leakage.

- **Empty-query `search` regression**: `akm search` now rejects a missing query with a structured `MISSING_REQUIRED_ARGUMENT` usage error instead of returning filler results.

- **`remember --enrich` fail-soft write path**: When no LLM is configured or enrichment yields nothing, `akm remember --enrich` now still writes the memory instead of failing a later tag-required validation check.

- **`wiki stash <wiki> <url>` URL ingestion**: URL-based wiki stashing now uses the website snapshot fetch path directly, restoring deterministic markdown capture for raw wiki sources.

- **`help migrate --format json` positional parsing**: Global output flags no longer get consumed as the migration version positional, so missing-version invocations fail with the correct structured usage envelope.

- **Docker Bun install matrix**: Fixed the Bun-based Docker build path by declaring `@opencode-ai/sdk` as a package dependency and copying `scripts/` into the Bun image build context, bringing the release-check Docker matrix back to green.

### Migration

See [docs/migration/v0.7-to-v0.8.md](docs/migration/v0.7-to-v0.8.md) for the complete step-by-step guide.

Quick reference:

```sh
# Preview what the migration will do
bun scripts/migrate-storage.ts --dry-run

# Apply the migration
bun scripts/migrate-storage.ts --yes
```
