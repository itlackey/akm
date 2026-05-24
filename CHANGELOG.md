# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Breaking Changes

- **Config validation is now strict and loud**: The config layer no longer silently drops, clamps, or coerces invalid values at load time. Configs that previously parsed with quiet repairs may now hard-error on the next `akm` invocation. Run `akm config migrate` (or simply load — auto-migration covers the legacy-input transforms) to bring a config back into spec, then fix any remaining loud failures.
  - `search.graphBoost.maxHops > 3` now throws (was silently clamped to 3).
  - `search.graphBoost.confidenceWeight > 1` now throws (was silently clamped to 1).
  - Unknown keys at the top level, in `search`, in `search.graphBoost`, and in nested strict sub-objects now throw (were silently dropped).
  - Invalid embedding entries (missing required sub-fields, wrong types, non-objects) throw instead of silently dropping the entire `embedding` block.
  - Partial LLM profiles persisted by stale `akm config set llm.endpoint <url>` no longer get auto-completed with `model: ""` at load. Provide a complete profile (endpoint + model) or remove the entry.
  - `profiles.agent.<name>` entries with invalid platforms hard-error instead of silently disappearing.
  - Invalid registry entries (empty/missing URL, wrong type) hard-error instead of being filtered out.
  - `output.format` / `output.detail` enum violations hard-error instead of falling back to defaults.

- **Embedding config: `endpoint` and `model` are now optional fields, not sentinels**: Local-only embedding configs (set only `localModel`) leave `endpoint` and `model` undefined; `hasRemoteEndpoint()` returns false naturally. Code that compared `config.embedding.endpoint === ""` or `config.embedding.model === ""` to detect the local-only path must switch to a presence check.

### Internal

- **Config layer rewrite (cleanup pass)**: `src/core/config.ts` reduced from 1454 LOC to 501. Type declarations split into `config-types.ts`; source-runtime construction into `config-sources.ts`; backup/prune I/O routines consolidated in `config-io.ts`. The previously-duplicated JSON-IO machinery was deduped. Load-time preprocessing closures (silent clamps, sentinel synthesis, warn-and-drop tolerances, legacy partial-profile fixups) are gone; the schema is now plain `.strict()` validation. Legacy-input transforms (semanticSearchMode boolean → string, `stashes[]` → `sources[]`, openviking source removal) live in the migration module where one-time fixups belong.

## [0.8.0] — Storage Reorganization & CLI Hardening

### Breaking Changes

- **Unified 0.8.0 config shape**: The legacy top-level `llm`, `agent`, and `features` blocks are **removed**. LLM and agent connections now live exclusively under `profiles.llm.<name>` and `profiles.agent.<name>` (with `defaults.llm` / `defaults.agent` selecting the active entry). Per-process LLM/agent gates moved into `profiles.improve.<name>.processes.*`, and feature sections that are not improve-process-bound moved to first-class `index.metadataEnhance`, `index.stalenessDetection`, and `search.curateRerank` blocks. Configs without `configVersion: "0.8.0"` are auto-migrated at first run with a one-time notice; a timestamped backup is written before any in-place rewrite. Set `AKM_NO_AUTO_MIGRATE=1` to suppress.

- **`akm wiki ingest <name>` now dispatches an agent instead of just printing the workflow**: The print-only mode and the `--execute` flag are gone — calling ingest resolves an agent profile (from `--profile` or `config.defaults.agent`) and dispatches that agent with the workflow as its prompt. Without an accessible agent profile the command fails with a clear error pointing at `profiles.agent`. New flags: `--profile <name>`, `--model <model>`, `--timeout-ms <ms>`.

- **`config.improve.reflectCooldownByType` removed**: Moved to `profiles.improve.default.processes.reflect.cooldownByType`. Migrated automatically.

- **`config.agent.processes["task"]` removed**: Tasks now declare `mode` and `profile` in their stash YAML file directly.

- **`improve.schedule` removed from config**: Scheduling is owned by stash task YAMLs that wrap `akm improve` calls. This key is stripped during auto-migration.

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

- **Task files migrated from `.md`+YAML frontmatter to pure `.yml` format**: Tasks are now stored as plain YAML at `<stash>/tasks/<id>.yml`. Multi-line inline prompts use YAML block scalars (`prompt: |`), replacing the prior `prompt: inline` + markdown-body convention. Existing `.md` task files are no longer discovered by `akm tasks list` — they must be renamed and rewritten as YAML. The lint pass for `tasks/` now parses YAML directly (it was silently a no-op for pure YAML files when routed through the frontmatter parser). The lint issue code `invalid-task-frontmatter` has been renamed to `invalid-task-yaml`. See [docs/migration/v0.7-to-v0.8.md](docs/migration/v0.7-to-v0.8.md) for migration steps.

### New Features

- **Unified profiles tree**: Named LLM and agent profiles under `profiles.llm.<name>` and `profiles.agent.<name>`. Per-process LLM/agent bindings live on `profiles.improve.<name>.processes.{reflect,distill,consolidate,memoryInference,graphExtraction,feedbackDistillation,validation}` with a `{mode, profile, timeoutMs}` shape plus optional `qualityGate` / `contradictionDetection` sub-objects. Non-improve feature gates moved to first-class top-level sections (`index.metadataEnhance`, `index.stalenessDetection`, `search.curateRerank`). See [docs/configuration.md](docs/configuration.md) for the full 0.8.0 reference.

- **reflect LLM mode**: The reflect pass inside `akm improve` can now run as a direct LLM call — significantly faster than the agent subprocess path. Configure via `profiles.improve.<name>.processes.reflect.mode: "llm"`. Supports multi-turn self-refine (sends the prior draft back as an assistant turn) and structured JSON output for providers that set `supportsJsonSchema: true`.

- **`akm config migrate`**: New command to explicitly migrate pre-0.8.0 config shapes into the 0.8.0 unified shape. Includes `--dry-run` and `--no-wait` flags. Acquires a file lock before write for safety. All config layers (user + project) are visited and rewritten in place; read-only layers print the migrated content for manual apply.

- **`--profile` flag on improve/propose**: `akm improve` and `akm propose` now accept `--profile <name>` to override the configured dispatch profile for a single run.

- **`vault set` reads from stdin by default**: Values are never passed via argv. `printf '%s' "$SECRET" | akm vault set vault:prod KEY` is the default pattern. Use `--from-env <VAR>` to read from a named environment variable instead.

- **`vault set --from-env <VAR>`**: New flag reads the value from the named environment variable, avoiding both argv and stdin. Errors with exit 2 if the variable is not set.

- **`state.db`**: New migration-safe SQLite database using Flyway-pattern schema migrations (never drops durable rows). Tables: `events`, `proposals`, `task_history`. Located at `$DATA/state.db`.

- **`select` event**: Emitted when `akm show` follows an `akm search` within 60 seconds. Closes the MemRL selection signal loop so the improve pipeline can observe which search results actually get used.

- **`improve_skipped` event**: Emitted at every cooldown-guard skip in `akm improve`, making skip distribution and budget exhaustion observable in the event stream.

- **`reflect_completed` event**: Emitted after the reflect pass in `akm improve` creates a proposal, linking the reflect invocation to its proposal ID for closed-loop outcome tracking.

- **Search mode metadata**: `search` events now include `mode: "semantic" | "keyword"` for long-term quality analysis of retrieval strategies.

- **Per-task `timeoutMs` override**: Individual task definitions can set `timeoutMs` to override the global task timeout. Set to `null` to disable the timeout for a specific task.

- **`akm health`**: New runtime health command that validates `state.db`, checks task-history/log integrity, probes the default agent profile, and summarizes recent improve-loop telemetry from `improve_*` events.

- **`--target` on `remember`, `import`, and `wiki stash`**: All three write commands now accept a uniform `--target <stash-name>` flag to route the write to a specific named writable source, bypassing `defaultWriteTarget` and working-stash resolution.

- **Proposal resolution by ref or UUID prefix**: `akm accept`, `akm reject`, and `akm diff` now accept a short UUID prefix (e.g. `akm accept abc123`) or an asset ref (e.g. `akm accept memory:my-note`) in addition to full UUIDs.

- **`bun scripts/migrate-storage.ts`**: One-shot migration script to move existing data to the new XDG layout. Supports `--dry-run` to preview changes without applying them and `--yes` to apply.

- **Task YAML adds `name` and `when_to_use` fields**: Task definitions can now set an optional `name` (display name shown by `akm tasks list`) and `when_to_use` (manual-trigger guidance describing when an operator should invoke the task). Both fields are optional and surface in `akm tasks show`/`list` output.

- **`command:` is now a recognised task target**: `akm lint` recognises `command:` alongside `workflow:` and `prompt:` as valid task targets, so command-driven tasks no longer trip a `missing-target` finding.

- **Proposal creation validates at write time**: `createProposal()` now rejects four classes of malformed input deterministically before writing, with a typed `INVALID_PROPOSAL` usage error and a typed `ProposalRejectionReason`:
  - `invalid_ref` — `parseAssetRef` threw
  - `unknown_type` — type is not in `TYPE_DIRS`
  - `empty_content` — payload body is empty after trim
  - `missing_description` — consolidate-style frontmatter present but `description` is absent or empty

  Each rejection emits a `proposal_creation_rejected` event with the typed reason so upstream pipelines (especially `consolidate`) can be tuned based on which check fires most.

- **`akm improve` orphan-purge maintenance pass**: After graph extraction (and after any reindex following consolidation or memory inference), `akm improve` now rejects pending `reflect` proposals whose target asset no longer exists on disk. This prevents stale proposals from polluting the queue when assets are removed or consolidated mid-run. Lesson proposals (which target new assets by definition) and non-reflect proposals (which legitimately target not-yet-created assets) are always kept. Emits a `proposal_orphan_purge` event with `checked`, `rejected`, `durationMs`, `byType`, and `orphans` for observability.

- **`improve_runs` table in `state.db`** (migration 003): Every `akm improve` invocation is now recorded as a single row with first-class indexed `dry_run`, `started_at`, `stash_dir`, and `scope_mode` columns. `improve-result.json` files under `<stash>/.akm/runs/<id>/` are no longer written — existing files from older runs become historical artifacts and can be safely deleted by users (zero current code paths read them). The dedicated `dry_run` index closes the productivity-audit artifact-trap where dry-run probes shared the same on-disk path as real runs. Query recent runs with:
  ```sh
  sqlite3 "$AKM_DATA_DIR/state.db" \
    "SELECT id, started_at, ok, dry_run FROM improve_runs ORDER BY started_at DESC LIMIT 10"
  ```
  Retention defaults to 90 days, governed by the same `improve.eventRetentionDays` config knob used for the `events` table. `purgeOldImproveRuns()` runs in the post-loop maintenance pass alongside `purgeOldEvents()`.

- **Per-reflect outcome event `improve_reflect_outcome`**: Emitted once per reflect call during `akm improve` with `{ok, durationMs, agentProfile, reason}`, enabling per-asset latency tracking and per-run failure-shape analysis.

- **Enriched `improve_completed` event**: Now includes `durationMs` (total wall-clock), `warningCount`, `orphansPurged`, `reflectCooldownActions`, `graphCoverage`, `graphDensity`, and `graphEntities` for richer self-tuning telemetry without requiring a separate stats query.

### Performance

- **reflect LLM mode**: The direct-LLM reflect path is order-of-magnitude faster per call than the agent subprocess path, with corresponding improvements on full improve runs. Enable with `profiles.improve.<name>.processes.reflect.mode: "llm"` in your config. (Specific numbers are preliminary; in-tree benchmarks live under `tests/bench/` once landed.)

- **`akm improve` cooldown pre-filter**: Assets under cooldown are now filtered out before the main improvement loop rather than inside it. Reduces LLM API calls and speeds up runs on large stashes with many recently-processed assets.

- **Improve-owned maintenance refreshes the final corpus state**: `akm improve` now runs memory inference after distill/consolidation, reindexes when inference writes new derived memories, and refreshes graph extraction against the settled post-improve state.

### Security

- **Directory traversal prevention**: `vault set`, `vault create`, `vault path`, and `vault run` now validate that the resolved vault path stays within the stash's `vaults/` directory. Names like `../../evil` are rejected with a `UsageError` (exit 2).
- **Atomic temp file hardening**: `writeFileAtomic` now opens the temp file with mode `0o600` from the start (no world-readable window before chmod), and uses `crypto.randomBytes` instead of `Math.random` for the temp filename.
- **Stdin cap on `vault set`**: stdin reads are capped at 1 MB; values larger than that are rejected with a `UsageError`.
- **Vault path stripped from JSON output**: `vault list --format json` and `show vault:<name> --format json` no longer include the absolute `path` field. Use `akm vault path vault:<name>` when you need the path.
- **Write lock on `vault set` / `vault unset`**: both commands now acquire an exclusive lock file (`<vault>.lock`) around the read-modify-write cycle. Concurrent writers in CI no longer silently drop each other's keys. Lock times out after 5 s.
- **Orphaned comment cleanup in `vault unset`**: `vault unset KEY` now also removes the `# comment` line immediately above the removed key.
- **Lint ref extension fix**: `akm lint` now correctly resolves `vault:<name>` refs to `vaults/<name>.env` (was incorrectly using `.md`).
- **Dangerous vault key detection**: `akm lint` and `akm add` now scan vault files against the dangerous vault key list — environment variable names that can be used for process-execution hijacking (`LD_PRELOAD`, `PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, etc.). `akm lint` reports these as `dangerous-vault-key` findings (non-blocking). `akm add` pauses and prompts for confirmation (default: No) when dangerous keys are found; in non-interactive mode the install fails unless `--allow-insecure` is passed. `--allow-insecure` on `akm add` now covers both plain-HTTP sources and dangerous vault key bypass.

### Graph Extraction Improvements

- **`candidatePaths` filter**: Graph extraction now refreshes only touched assets per improve cycle. Massive perf win on cold cache and large stashes — extraction sweeps no longer revisit every asset on every run.
- **Default `graphExtractionBatchSize` raised from 1 to 4**: Auto-tuned against `llm.contextLength`, so larger context windows produce wider batches without manual tuning.
- **Incremental `replaceStoredGraph`**: Unchanged entries skip; only changed entries delete child rows and re-insert; removed entries get cleaned up. Order-of-magnitude reduction in row writes on small re-extractions vs. the previous wipe-and-rewrite path.
- **SQL-backed `listRelatedPathsForFile`**: Rewritten as a SQL self-join on `graph_file_entities` plus a relation-count subquery, scoped by `stash_root`. Significantly faster cold-call latency on typical stashes.
- **Graph schema redesign (DB_VERSION 10 → 17)**: `graph_files` now keys on `entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE`. Child tables (`graph_file_entities`, `graph_file_relations`) re-keyed on `entry_id` and cascade through. `body_hash` is now `NOT NULL`. New columns `extraction_run_id` (graph_files + graph_meta) and `extractor_id` (graph_meta) record extraction provenance. New indexes `idx_graph_file_entities_entity_norm` and `idx_entries_file_path`; two redundant indexes dropped. Migration uses the existing DROP+rebuild path — graph data re-extracts on the first `akm improve` after upgrade; a warning is logged during the upgrade.
- **Stash removal cleans up graph rows**: Removing a stash now correctly cascades through the graph tables. Earlier versions left orphaned graph rows behind.
- **New: `akm graph entity <name>`**: Inverts the entities view — list every asset that mentions a given entity, ordered by per-asset extraction confidence.
- **New: `akm graph orphans`**: List assets that produced zero entities during the extraction pass — useful for quality triage and re-extraction targeting.
- **Confidence in graph output**: `akm graph relations` and `akm graph entities` now surface per-row confidence values.
- **Graph-boost magnitude in `whyMatched`**: Search results now annotate the graph-boost contribution so agents can see why a hit ranked where it did.
- **`Next: akm show '<ref>'` hint**: Related-results output appends a Next hint pointing at the top hit so agents know which ref to load next.

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

- **`FOREIGN KEY constraint failed` crash in embedding batch**: When an entry was deleted between when its id was queued for embedding and when the INSERT ran (e.g. a concurrent improve cycle consolidating away the entry), the INSERT would throw inside the batch transaction, rolling back every embedding for that run — not just the stale one. `upsertEmbedding` now does a cheap pre-flight `SELECT 1 FROM entries WHERE id = ?` and returns `false` (skipped) instead of throwing. The indexer tracks `storedCount`/`skippedCount` separately and surfaces a single concise warning when entries were skipped.

- **`vault set` stdin prompt no longer hangs**: When `stdin` is attached to a TTY, `akm vault set` now prints `Enter value for "<KEY>" (Ctrl-D when done):` to stderr before reading. Previously an interactive invocation hung silently with no indication that input was awaited. Piped-stdin invocations are unchanged.

- **Reflect cooldown signals classified correctly**: When a reflect call returns `{ok: false, reason: "cooldown"}`, the improve loop now classifies the action as `reflect-cooldown` rather than `reflect-failed`, and skips the `pushRecentError` call. This prevents cooldown skips from contaminating the `recentErrors`/`avoidPatterns` context injected into the next reflect call, and they are now counted separately in `improve_completed.reflectCooldownActions`.

- **`propose` static import**: `node:fs` in `src/commands/propose.ts` is now a static top-level import instead of a dynamic `await import` inside the function body. Consistent with the rest of the file and removes an unnecessary microtask boundary on every propose invocation.

- **`akm agent <profile> [<agent-ref>]`**: Agent command now accepts an optional agent asset ref as a second positional. The agent asset's content becomes the system prompt, its `model:` frontmatter sets the model, and its `tools:` frontmatter sets the tool policy — all translated to platform-specific CLI flags automatically. Use `--model <alias-or-id>` to override the asset's model for this invocation.

- **Platform-specific command builders for `akm agent`**: A new builder strategy translates platform-agnostic dispatch parameters to the exact argv each agent CLI expects. OpenCode receives `opencode run [--system-prompt "..."] [--model opencode/<model>] "<prompt>"`; Claude Code receives `claude [--system-prompt "..."] [--model <model>] [--allowedTools ...] --print "<prompt>"`. Built-in model aliases (`opus`, `sonnet`, `haiku`) resolve to the correct platform model ID automatically. Custom aliases configurable per profile in `agent.profiles.<name>.modelAliases`.

### Migration

See [docs/migration/v0.7-to-v0.8.md](docs/migration/v0.7-to-v0.8.md) for the complete step-by-step guide.

Quick reference:

```sh
# Preview what the storage migration will do
bun scripts/migrate-storage.ts --dry-run

# Apply the storage migration
bun scripts/migrate-storage.ts --yes

# Preview the config v2 migration
akm config migrate --dry-run

# Apply the config v2 migration
akm config migrate
```
