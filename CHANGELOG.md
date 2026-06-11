# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.12] - 2026-06-11

### Fixed

- **`akm extract` calling the LLM for noise sessions that never yield candidates.**
  96% of processed sessions (72/75 measured) produced zero candidates, consuming
  ~330 s of LLM time per run. The pre-filter had no minimum content threshold —
  sessions as short as 50 chars were sent to the LLM regardless. A new
  `minContentChars` gate (default 500) skips the LLM call when post-filter
  content falls below threshold, cutting extract LLM calls by ~95% on typical
  stashes. Configurable via `profiles.improve.<name>.processes.extract.minContentChars`.
  Closes #595.

## [0.8.11] - 2026-06-11

### Fixed

- **`akm improve --profile <name>` ignored profile's `extract.enabled: false` setting.**
  The session-extraction gate in the preparation stage called
  `isLlmFeatureEnabled(config, "session_extraction")`, which hardcodes a lookup
  against `profiles.improve.default.processes.extract.enabled`. Any non-default
  profile that set `extract.enabled: false` (e.g. `quick-shredder`) was silently
  ignored, causing the extract pass to run regardless. The fix adds a
  `resolveProcessEnabled("extract", improveProfile)` check so the active
  resolved profile gates the pass correctly. Closes #593.

## [0.8.10] - 2026-06-11

### Fixed

- **`akm improve` taking 8–10 minutes per run due to O(n) DB writes for
  profile-filtered refs.** When a profile disables reflect and distill for
  certain asset types, `collectEligibleRefs` marks those refs as
  `profile_filtered_all_passes`. The caller then emitted one `improve_skipped`
  event per ref — a sequential DB write for each. On a ~9 000-ref stash this
  was ~500 s of SQLite writes before any consolidation or memory inference
  began. The fix collapses the per-ref loop into a single summary event
  carrying a `count` field, eliminating ~9 000 sequential writes per run.
  Closes #590.

## [0.8.9] - 2026-06-11

### Fixed

- **`akm improve` validation pass was O(n) in stash size, causing ~510 s overhead
  on large stashes.** For every indexed ref, the preparation phase called
  `findAssetFilePath()` — an async round-trip to the index DB followed by a
  filesystem probe — serially inside a `for…await` loop. With ~9 000 indexed
  refs at ~55 ms each, this loop consumed the entire 600–900 s run budget before
  any reflect, triage, or memory-inference work began. The fix threads
  `filePath` from the planning stage (`collectEligibleRefs`) through
  `ImproveEligibleRef` so the validation pass and the disk-existence guard can
  use the pre-resolved path directly. The async lookup is retained only as a
  fallback for refs that enter via a narrow scope (e.g. `--scope ref:foo`).
  Closes #587.

## [0.8.8] - 2026-06-11

### Fixed

- **SQLite `SQLITE_BUSY` errors under concurrent improve runs.** `busy_timeout`
  was set to 5 000 ms in all three database open paths (`openDatabase`,
  `openExistingDatabase`, `openStateDatabase`). Under a busy cron schedule — or
  when a reindex triggered by memory inference ran concurrently with an event
  write — the 5 s window was routinely exhausted, producing "database is locked"
  failures. Raised to 30 000 ms across all three paths so transient lock
  contention is retried for up to 30 s before surfacing as an error.

## [0.8.7] - 2026-06-09

### Fixed

- **`incrementalSince` duration strings were silently ignored.** Values like
  `"30m"`, `"24h"`, `"7d"` were passed raw to `narrowToIncrementalCandidates`,
  which compared them against ISO timestamps via string sort. All `2026-...`
  timestamps are lexicographically less than `"30m"` (`'2' < '3'`) and `"24h"`
  (`"20" < "24"`), so `isChanged()` always returned `false` and the candidate
  pool was silently emptied rather than filtered to the window. The fix adds
`parseSinceToIso()`, which resolves human duration strings to absolute ISO
  timestamps before comparison. Values that already look like ISO timestamps
  are passed through unchanged.

## [0.8.6] - 2026-06-09

### Added

- **`consolidate.incrementalSince` profile config field.** Setting
  `incrementalSince: "7d"` (or any duration string) in the `consolidate` block
  of an improve profile narrows the candidate pool to memories modified within
  that window plus their top-5 graph neighbours, keeping each pass focused on
  recent changes. This makes it practical to run consolidation more often than
  once per day (e.g. via `akm-improve-consolidate` every 4 h) without
  re-scanning the full pool every time. The nightly default profile leaves this
  unset (full-pool sweep, same as before). The `incrementalSince` option already
  existed in `akmConsolidate()` but was hardcoded off at the call site; the
  field is now surfaced in the config schema and read from the profile.

## [0.8.5] - 2026-06-09

### Fixed

- **Consolidation starved merge recall; the memory pool grew unbounded.** Commit
  `633ece41` made the `incrementalSince` narrowing unconditional, so every
  consolidation run only judged memories changed since the last run plus their
  immediate vector-neighbors. Stale-but-unmerged duplicate clusters were never
  re-examined, so the eligible pool grew monotonically and never shrank, and
  contradiction detection (which rides on the consolidation pass) went dark.
  Consolidation only runs on the nightly default-profile pass (`quick`/`frequent`
  disable it), so a full-pool sweep is correct and affordable; the override is
  removed. `lastConsolidateTs` still gates whether the pass runs.

## [0.8.4] - 2026-06-08

### Fixed

- **`akm tasks sync` ignored schedule changes.** Sync classified any task already
  present in the OS scheduler as "unchanged" without comparing its installed
  entry, so editing a task's `schedule:` in the `.yml` never reached the crontab —
  the only way to apply a new schedule was to `remove` and re-`add` the task. The
  same gap affected `tasks enable`/`disable`, which merely toggled the existing
  cron line's comment and so re-enabled a stale schedule. Sync now compares the
  backend's installed signature against the signature the current definition would
  produce and reinstalls on drift (reported in a new `updated[]` field);
  `enable`/`disable` reinstall from the current `.yml` instead of toggling in
  place. Backends that can't cheaply read their installed form fall back to an
  idempotent reinstall, so the fix is correct on launchd/schtasks too. The cron
  backend gains `expectedSignature()` and a signature on each `list()` entry.

### Added

- **`akm improve --skip-if-locked`.** When another improve run already holds the
  lock, the run logs and exits 0 with a no-op result (`skipped.reason:
  "lock-held"`) instead of failing with the "already running" config error
  (exit 78). Intended for high-frequency scheduled runs (e.g. an every-30-min
  `quick` pass) that would otherwise pile up exit-78 failures whenever a longer
  run overlaps them. Default off — the hard error is preserved for interactive
  use. The result is still recorded so the skip is auditable.

## [0.8.3] - 2026-06-08

### Fixed

- **`improve.lock` leaked on signal death (cron timeout).** The improve
  SIGTERM/SIGINT/SIGHUP handler calls `process.exit()`, which skips `finally`
  blocks — so the `finally` that releases `improve.lock` never ran, and every
  timed-out cron run leaked the lock sentinel. (It wasn't a permanent deadlock
  only because the next run reclaims a dead-PID lock, a path that PID reuse can
  defeat.) The lock is now released from a `process.on("exit", …)` handler
  registered at acquire time (exit handlers DO run on `process.exit()`), via a
  new ownership-checked `releaseLockIfOwned(path, pid)` so a backstop release can
  never delete a different run's lock. This generalizes to the budget watchdog
  and any future exit path.
- **`quick` profile was not quick.** It was documented "Reflect-only" but did
  not disable the session-`extract` process (which is default-ON), so a `quick`
  run processed the entire unindexed-session backlog (~40 min) — guaranteeing a
  5-minute cron timeout → SIGTERM → the lock leak above, every run. `quick` now
  explicitly sets `processes.extract.enabled: false`.

## [0.8.2] - 2026-06-05

### Added

- **LM Studio auto-detection in setup wizard** — `akm setup` now probes
  `localhost:1234/v1/models` at startup and, when the server is running, pre-fills
  the LLM backend with the active model list, mirroring the existing Ollama detection
  flow (#522).
- **Agent harness config import** — `akm setup` detects installed AI coding harnesses
  (currently Claude Code and OpenCode) and pre-populates LLM provider, model, and
  base-URL fields from the harness configuration. The importer registry
  (`HARNESS_CONFIG_IMPORTERS`) makes adding future harnesses a single append (#523).
  API key *values* are never read or stored — only the environment variable name is
  imported.
- **Registry-driven stash selection** — the "Add Sources" step now fetches available
  stashes from the official AKM registry at startup. `DEFAULT_SELECTED_STASH_IDS`
  in `src/setup/registry-stash-loader.ts` is the single edit point for changing
  which stashes are pre-checked. Falls back to a hardcoded list on network error (#520).
- **`improve.autoAccept.{promoted,validationFailed}` health metrics** — auto-accepted
  proposals that pass the confidence threshold but fail validation (truncated
  description, invalid frontmatter) are now counted as `gateAutoAcceptFailedCount`
  in the improve result envelope and surfaced as `improve.autoAccept.validationFailed`
  in `akm health` reports.
- **`auto-accept-validation` health advisory** — heuristic advisory that warns when
  `validationFailed > 0` so malformed proposals are visible before they pile up in
  the queue.

### Fixed

- **`akm-improve` tasks recorded as failed on budget exhaustion** — the budget
  exhaustion timer called `process.exit(1)`, causing every budget-limited run to be
  recorded as a task failure. Changed to `process.exit(0)`; budget exhaustion is a
  normal exit condition.
- **`improve_runs.started_at` always equal to `completed_at`** — `writeImproveResultFile`
  was called at end-of-run, so `new Date()` captured the completion time and both
  columns held the same value (649/661 real runs affected, regressed ~May 26).
  `started_at` now uses the timestamp captured at process launch, passed in from the
  CLI entry point. A regex-based fallback decodes the timestamp embedded in the run ID
  for any call site that does not supply an explicit value (#524).
- **`akm-health-report` task fails on transient DNS errors** — the Discord webhook
  script caught `HTTPError` but not the parent `URLError`, so DNS blips caused the
  task runner to record the health report as failed. `URLError` is now caught and
  logged as a warning with a clean exit.

### Added

- **Stash `.meta/` convention** — a stash may carry an optional, human-authored
  `.meta/` directory at its root for orientation: purpose, key assets, conventions,
  and maintainer info. Surface it on demand with `akm show meta` (the working
  stash's `.meta/index.md`), `akm show meta:<name>` (e.g. `.meta/about.md`), or
  scope it to a specific stash with `akm show <origin>//meta[:<name>]`. Because
  `.meta/` is a dot-directory, the indexer already skips it, so these docs never
  pollute search results — they are direct-read on demand. Owners extend the
  convention by dropping new files (`.meta/about.md`, `.meta/conventions.md`,
  `.meta/license`) with no code changes. `akm init` scaffolds a `.meta/index.md`
  template into newly created stashes.
- **Default stash skeleton** — `akm init` (and `akm setup`) now copies
  `src/assets/stash-skeleton/` into every newly created stash. Currently ships
  a `README.md` covering what the stash contains and how agents use `akm` to
  access assets. Existing files are never overwritten. Add files to
  `src/assets/stash-skeleton/` to extend what ships with a fresh install.

### Improved

- **Setup wizard pre-populates from existing config** — on re-run, `akm setup`
  initialises every prompt default from the current saved configuration so users
  only need to change what has actually changed (#519).
- **Config backup before every setup write** — `backupExistingConfig()` is now called
  before each `saveConfig` in the setup wizard, ensuring the previous config is always
  recoverable if a wizard run is interrupted (#521).

## [0.8.1] - 2026-06-05

### Added

- **`graph-refresh` improve profile** — new built-in profile that runs a full-corpus
  graph extraction pass across all stash files (all other improve processes disabled).
  Use `akm improve --profile graph-refresh` for a weekly relationship rebuild.
  Pairs with the new `graph-refresh-weekly` task template (`akm tasks add --template graph-refresh-weekly`).
- **`session-extraction` health advisory** — new heuristic advisory backed by real
  `akmExtract` outcomes: warns when the session-extraction process ran but produced
  zero proposals across ≥ 5 sessions, or recorded warnings. Replaces the vestigial
  `session-log-failures` warn signal.
- **`improve.sessionExtraction` health metrics** — `sessionsScanned`, `sessionsExtracted`,
  `sessionsSkipped`, `proposalsCreated`, `warnings`, `durationMs` now tracked and
  visible in `akm health` reports.

### Fixed

- **`akm info` indexStats** — `readIndexStats` errors are now surfaced and the resolved
  DB path is passed correctly; `entryCount`, `hasEmbeddings`, and related fields are
  no longer silently empty (#510).
- **Indexer timing fields** — `embedMs` and `ftsMs` in timing output had their
  operands swapped, producing negative durations. Fixed (#516).
- **Incremental consolidation gate** — the `volumeTriggered` path bypassed the
  incremental gate introduced in 0.8.0, causing consolidation to run on chunks it
  had already processed in the same run. Fixed.
- **Improve budget exhaustion** — `improve.lock` was not released after budget
  exhaustion, blocking subsequent runs until the lock TTL expired.
- **Consolidation chunk retry** — failed chunks are now retried once with a 2 s
  backoff before being recorded as lost, reducing transient LLM errors from
  propagating to `chunksFailed`.
- **`yieldRate` health metric** — `skippedAborted` refs were incorrectly counted in
  `freshAttempts`, inflating the denominator and underreporting yield rate.
- **`session-log-failures` advisory** — demoted from `warn` to always `pass`
  (informational only); the advisory was a raw regex counter with no LLM signal,
  producing false positives on normal session content.

### Refactored

- All runtime assets consolidated under `src/assets/` with `dist/assets/` mirroring
  the layout exactly. Built-in improve profiles moved from in-source object literals
  to embedded JSON files (`src/assets/profiles/*.json`). The `copy-assets.ts` build
  step now uses a precise `src/assets/**/*` glob instead of a broad catch-all.
- Vestigial Phase 0 (`getExecutionLogCandidates` / `ERROR_PATTERNS`) removed from
  the improve pipeline. This regex scan collected a metric count but never fed an
  LLM; `akmExtract` (Phase 0.4) is the real session extraction pipeline.

## [0.8.0] - 2026-05-28

### Performance

- **`akm consolidate`**: all-hot chunk early-exit. When every memory in a chunk
  is `captureMode: hot` (user-explicit), the only operations the LLM could ever
  propose are deletes — all refused unconditionally by the downstream guard.
  Such chunks now skip the model entirely and are counted as `judgedNoAction`
  up front, instead of relying on a prompt-level hint and spending a wasted
  request. Mixed chunks are unaffected.

### Breaking changes (deprecation aliases, removed 0.9.0)

The 0.8 line is the clean-break window for CLI ergonomics. Every rename below
keeps the **old spelling working** as a deprecated alias that prints a stderr
warning (never on stdout, so JSON consumers are unaffected) and delegates to the
canonical form. **All of these deprecated aliases are removed in 0.9.0.** See
[`docs/migration/v0.8-to-v0.9.md`](docs/migration/v0.8-to-v0.9.md) for the full
old → new table.

- **Proposal queue is now a noun group**: `akm proposal {list,show,diff,accept,reject,revert}`.
  The flat verbs `akm proposals`, `akm show proposal <id>`, `akm accept`,
  `akm reject`, `akm diff`, and `akm revert` are deprecated aliases.
  Bare `akm proposal` behaves as `akm proposal list`.
- **`--detail` is now verbosity only** (`brief|normal|full`). The output
  *projection* moved to a new **`--shape`** flag (`human|agent|summary`).
  `--detail summary` and `--detail agent` are deprecated aliases that map to
  `--shape summary` / `--shape agent`.
- **`--for-agent`** is a deprecated alias for `--shape agent`.
- **`--generator`** replaces `--source` on `accept` / `reject` / `history`
  (which generator produced the proposal/event). `--source` is a deprecated
  alias on **those three commands only** — it is unchanged on
  `search` / `curate` / `graph` / `remember`, where it means "read from here".
- **`akm save` → `akm sync`** (commit + optional push; `sync` connotes push
  better). `akm save` is a deprecated alias. `akm sync` adds `--no-push`.
- **`akm enable` / `akm disable` → `akm config enable` / `akm config disable`**.
  The top-level `enable` / `disable` are deprecated aliases.
- **`akm events` → `akm log`**: `log` is an additive alias for the same
  state.db stream in 0.8 and becomes primary in 0.9.0. (`akm history` remains the
  asset-scoped, cross-source analytical trail — a different surface.)
- **`akm wiki remove --force` → `-y` / `--yes`** for skipping the confirmation
  prompt. `wiki remove` now also *prompts* interactively when a TTY is present;
  `--force` is a deprecated alias for `-y`.
- **`akm feedback --note` → `--reason`**: `--note` is a deprecated alias and
  warns when used without `--reason`.
- **`akm workflow next --dry-run` removed**: the flag is no longer declared, so
  it no longer appears in `--help`. The explicit "next does not support
  --dry-run" guard remains (read from argv) so existing callers still get a clear
  message instead of silent acceptance.
- **Singular aliases added** (additive, non-breaking): `akm task` for
  `akm tasks`, `akm lesson` for `akm lessons`.

### Safety

Two destructive paths that previously acted with no confirmation now guard
behind an interactive prompt (or `-y` / `--yes` in non-interactive use).
**Scripts that ran these non-interactively must add `-y`.**

- **`akm registry remove`** now confirms before splicing the registry out of the
  config (`confirmDestructive`). Pass `-y` / `--yes` to skip the prompt;
  non-interactive use without `-y` aborts.
- **Bulk `akm proposal accept --generator <g>`** (the multi-proposal branch) now
  confirms before promoting every matching proposal, mirroring the existing
  guard on bulk `reject`. Single-id accept stays unguarded (it is revertable).

### Fixed

- **Consolidation `delete_failed` on stale index entries** — when consolidation
  successfully deleted a memory file, the index DB was not re-indexed between
  runs. Subsequent runs loaded the stale DB entry into their memory map, the LLM
  re-proposed the deletion, and `deleteAssetFromSource` threw "not found in
  source" — appearing as `delete_failed` in skipReasons. Fix: `loadMemoriesForSource`
  now filters entries whose file no longer exists on disk before building chunks,
  so phantom memories are never sent to the LLM. A secondary catch in the delete
  handler emits `delete_already_gone` instead of `delete_failed` when the file
  is confirmed absent.

> **CI / Docker users:** the 0.8.0 storage split moved `akm.lock`, the event
> database, and the registry cache out of `$XDG_CONFIG_HOME/akm/` into
> `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, and `$XDG_CACHE_HOME` respectively. If
> you override any of `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`,
> `AKM_CACHE_DIR` in CI to isolate per-job state, set **all four** (or none,
> and rely on XDG defaults). Overriding only `AKM_CONFIG_DIR` will leave the
> lock file / event DB pointing at the host's default `$XDG_DATA_HOME`,
> causing lock contention and bleed between jobs.

### Removed

- **Install-time security audit (`security.installAudit`) and the `--trust`
  flag**. The audit scanned incoming stash assets for risky patterns (e.g.
  `curl ... | bash`, "ignore previous instructions") and blocked installs on
  critical findings. In practice it produced too many false positives on
  benign documentation strings and forced first-time users to pass `--trust`
  or twiddle config just to install the official stash. The whole feature is
  gone:
  - `akm add` and `akm update` no longer scan synced content.
  - The `--trust` flag is removed from `akm add` and `akm wiki register`.
  - The `security.installAudit.*` config keys (`enabled`, `blockOnCritical`,
    `registryAllowlist`, `registryWhitelist`, `blockUnlistedRegistries`,
    `allowedFindings`) are no longer recognised; the entire `security` block
    is removed from the config schema.
  - The `akm config set security.installAudit.*` keys now error as unknown.
  - `audit` fields are removed from `AddResponse.installed` and
    `SourceInstallStatus`.

### Breaking Changes

- **Project-level `.akm/config.json` files are no longer merged**. The
  multi-layer config discovery introduced in the 0.7 line was deprecated
  in late-0.8.x with a warning; that warning is now backed by removal.
  `loadConfig` walks cwd-ancestors only to emit a one-time deprecation
  warning per discovered file. Move any needed settings to
  `~/.config/akm/config.json`. `stashInheritance` (a multi-layer-only
  field) is removed from the schema.

- **`${VAR}` env-var expansion only resolves at the apiKey consumption
  sites**. The recursive expansion walker that ran on the load path is
  gone. Other config string values now round-trip verbatim: a literal
  `${HOME}` in (say) `stashDir` is preserved as the literal `${HOME}`
  on read. The new exported `resolveSecret(value)` helper is applied
  only where authorization headers are built (`src/llm/client.ts`,
  `src/llm/embedders/remote.ts`, `src/integrations/agent/sdk-runner.ts`).
  Documented `${OPENAI_API_KEY}` recipes in `docs/configuration.md`
  continue to work because expansion still happens at request time for
  apiKey fields.

- **`AKM_FORCE_DOWNGRADE_CONFIG` env var removed**. The newer-than-binary
  read-only guard (`configReadOnlyReason`, `markConfigReadOnlyIfNewer`,
  `getConfigReadOnlyReason`) is gone. Configs declaring a `configVersion`
  newer than the running binary now save through silently — unknown
  fields are stripped on save by `sanitizeConfigForWrite` plus the
  strict-walled Zod schema. Users on 0.9.x configs should not open them
  with a 0.8.x binary in writable workflows.

### Changed

- **Rebrand**: the full name "Agent Kit Manager" is now **Agent Knowledge Management** — `akm` stands for Agent Knowledge Management going forward. The binary name, npm package (`akm-cli`), and all APIs remain unchanged.

- **Config layer rewrite** — single-source-of-truth Zod schema in
  `src/core/config-schema.ts` replaces the per-field parse switch AND
  the per-shape load-time parser. Adding a new config field is now one
  line of schema + zero lines of CLI code. `loadConfig` now consists of
  parse-text → migrate (pure JSON transforms) → Zod safeParse → overlay
  defaults — a ~30-line pipeline that absorbs ~900 LOC of legacy
  per-shape parsers (`parseLlmConfig`, `parseEmbeddingConfig`,
  `parseIndexConfig`, `parseSourceConfigEntry`, and ~20 more).
  - **#454**: `akm config set llm.apiKey` / `embedding.apiKey` /
    `profiles.llm.<name>.apiKey` now throws `UsageError` pointing at the
    corresponding env var (`AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`,
    `AKM_PROFILE_<NAME>_API_KEY`). Was previously a silent strip.
  - **#455**: every schema-leaf key is now reachable via `akm config set`.
    Includes previously hand-listed gaps: `defaults.agent`, `search.minScore`,
    `improve.eventRetentionDays`, `embedding.provider`, `llm.temperature`,
    `profiles.llm.<name>.*`, `profiles.agent.<name>.*`, etc.
  - **#456**: `akm config validate` and `akm config migrate` are now real
    registered subcommands. The orphan implementations in `config-validate.ts`
    have been removed; the new entry points live in `src/cli/`.
  - **#457**: project-level `.akm/config.json` files are now flagged with a
    deprecation warning ("will be ignored in 0.9.0+"). The merge still
    happens in 0.8.x — one release of grace.
  - **#458**: malformed JSON or non-object root in the config file now raises
    `ConfigError("INVALID_CONFIG_FILE")` with the underlying parse error.
    Was previously a silent fallback to `DEFAULT_CONFIG`, which masked
    corruption. File-not-existing remains the legitimate cold-start case.
  - **#459**: `~/.cache/akm/config-backups/` is now bounded to the 5 most
    recent timestamped backups. Pruning runs on each `saveConfig`.
    `config.latest.json` is preserved separately.
  - **#460**: `UNKNOWN_CONFIG_KEY_HINT` is now auto-generated from the
    schema via `listTopLevelConfigKeys()`. No more stale hand-maintained string.
  - **#461**: if the auto-migration disk-write fails, `loadConfig` now throws
    a hard error instead of returning the in-memory migrated shape. Eliminates
    the silent infinite re-migrate loop on every `akm` command.
  - **#462**: nested registries[], sources[], profiles.* objects are
    `.strict()` — unknown keys are rejected with a path-pointing error at
    both set time and saveConfig time.
  - **#463**: `schemas/akm-config.json` is now auto-generated from the Zod
    source via `bun scripts/gen-config-schema.ts`. A drift test fails CI if
    the committed file disagrees with the regeneration output.
  - **#464.a**: `defaultWriteTarget` is validated via Zod `.refine()` against
    `sources[].name`. With no sources configured, save-time validation
    rejects instead of silently accepting (no implicit "first writable" fallback).
  - **#464.b**: generic unset works on `semanticSearchMode` and every other
    key via the dotted-path walker.
  - **#464.c**: all write paths route through `writeFileAtomic`.
  - **#464.d**: duplicate `mergeSecurityConfig` / `mergeInstallAuditConfig`
    in `config-cli.ts` are deleted; merging happens via re-parse through the
    Zod schema.

See `docs/migration/v0.7-to-v0.8.md` for the user-facing migration guide.

## [0.7.5] - 2026-05-08

### Added

- **Feedback tag/filter filtering** — `akm feedback` and related event-reading paths now support richer filtering by tags and other event metadata, making it easier to inspect and reuse accumulated feedback signals.
- **Vault path/run UX improvements** — vault flows now better support path discovery and command-scoped secret injection without surfacing values, with expanded regression coverage for the path/run contract.
- **Reflect fallback improvements for external agents** — reflection/proposal flows now support a more robust fallback path for proposal content, including the file-write path used by the `opencode` agent integration.

### Changed

- **Workflow runs are now scoped to the current workspace** — ref-based workflow commands (`workflow next/status/list`) now resolve runs within the current project, worktree, or non-repo directory instead of sharing active-run state globally across the whole cache. Direct run-id commands still target the exact run.
- **Help, hints, and workflow docs now explain run scoping** — CLI descriptions, embedded hints, operator docs, and workflow guides now describe the current-scope semantics so users understand how ref-based run resolution behaves across repos and local sandboxes.
- **`akm show` auto-indexes stale state instead of falling back to raw filesystem reads** — show/search parity is tighter because stale index state now triggers refresh rather than silently drifting to a separate fallback path.
- **Release metadata lookup follows the published `CHANGELOG.md` layout** — migration-help, package publish metadata, and related docs now consistently reference the shipped changelog location at the package root.
- **Documentation refresh across README and posts** — README positioning, command-tour docs, workflow examples, and dev.to post organization were refreshed to better match the current CLI surface.

### Fixed

- **Cross-repo and cross-directory workflow leakage** — an active workflow run in one repo or sandbox no longer blocks or leaks into another when the same workflow ref is used from a different working directory.
- **`show` workflow hints now respect the current scope** — `show workflow:...` only surfaces the active workflow run for the current workspace instead of attaching the latest run from anywhere on the machine.
- **Agent-output and local-model JSON hardening** — reflect/propose and LLM-backed parsing paths are significantly more defensive against malformed JSON and partial local-model output.
- **Reflect draft-file isolation** — reflect no longer writes intermediate draft files into the stash itself; temporary draft output now lives in OS temp space instead of polluting user content.
- **Memory-inference token budgeting** — memory inference now respects the configured LLM token budget instead of overrunning long inputs.
- **Named git stash selectors in `akm save`** — save now resolves named git-backed stash selectors correctly.
- **Indexed script refs in search results** — script entries now surface the correct refs in indexed search results.
- **Feedback ref resolution and LLM indexing regressions** — feedback targeting and related LLM indexing paths were corrected.
- **Release workflow reruns and optional native dependency handling** — release automation is now rerunnable and avoids tripping over optional native dependency edges in CI/publish contexts.
- **Published static-file checks** — migration-help packaging/tests now verify the shipped changelog and bundled release-note files are present and loadable from the published layout.

### Documentation

- **Bundled migration notes now cover 0.7.5** — `akm help migrate 0.7.5` and `akm help migrate latest` now surface the full 0.7.5 operator summary alongside the changelog section.

## [0.7.4] - 2026-05-06

## [0.7.3] - 2026-05-05

### Added

- **`akm index --enrich` opt-in for LLM passes** — index-time enrichment work such as metadata enhancement, memory inference, and graph extraction now runs only when explicitly requested with `--enrich`. Default indexing is faster and no longer surprises operators with LLM-backed work during normal maintenance runs.
- **Config backup snapshots before writes** — config writes now create AKM cache backups so setup/config flows have a recovery path if a config is overwritten or corrupted during development or testing.

### Changed

- **Setup wizard UX refresh** — `akm setup` now better reflects the real configured state: source prompts are ordered more sensibly, configured and preserved stash information is surfaced, agent defaults can be selected explicitly (including disabled), and post-setup indexing does not implicitly enable enrichment.
- **CI workflows updated for current GitHub Actions runtimes** — CI, release, and publishing workflows now use current action majors (`checkout@v5`, `cache@v5`, `setup-node@v5`, `upload-artifact@v5`, `download-artifact@v6`) to stay off deprecated Node 20 action runtimes.
- **Technical investigation notes updated** — the index investigation note now reflects the latest `.stash.json` migration status, current green CI runs, and the narrowed remaining compatibility surface ahead of `v0.8.0`.

### Fixed

- **Embedding-dimension drift on read-only DB opens** — read/telemetry paths no longer mutate the live index schema with the default embedding dimension. `akm info`, search/show parity paths, and related readers now preserve the configured embedding shape instead of downgrading vector tables.
- **Incremental index churn across multiple source layouts** — incremental indexing is now significantly more stable for filename-less legacy metadata, wiki-root sources, repo-root git stash layouts, non-indexed companion files, and cross-source dedupe cases.
- **Git source indexing for repo-root stashes** — git-backed sources no longer assume a `<repo>/content` subtree; repo-root stash layouts are indexed correctly and cached mirrors are treated as fresh instead of being needlessly refreshed.
- **`show` metadata no longer depends on `.stash.json`** — command and skill summary/show metadata now comes from file-local frontmatter and renderer parsing rather than the deprecated disk fallback sidecar.
- **`.stash.json` no longer drives incremental stale detection** — editing `.stash.json` alone no longer forces directories to rescan during incremental indexing.

### Internal

- **Ranking and scoring fixtures migrated toward file-local metadata** — routine benchmark and regression fixtures now prefer markdown frontmatter or inline script metadata, with `.stash.json` retained only for intentional legacy-compatibility coverage that still exercises explicit-file override behavior.
- **Production-path ranking regression coverage** — ranking regression tests now build their fixture index through the production indexer rather than a custom `.stash.json` crawler, reducing fixture drift and improving confidence in the real indexing/search path.

### Added

- **One-shot URL ingest for `akm import` and `akm wiki stash`** — both commands now accept a single HTTP/HTTPS URL in addition to file paths and stdin. `akm import <url>` fetches the exact page, converts it to markdown, and writes it into `knowledge/` using a URL-path-derived default name. `akm wiki stash <wiki> <url>` fetches the exact page, converts it to markdown, and writes it into `wikis/<wiki>/raw/`. Neither command registers a persistent website source or crawls linked pages.

### Changed

- **Shared website ingest boundary** — website URL validation, single-page fetch/convert, and website mirror generation now live in a dedicated shared ingest module. The website source provider is a thin adapter, and `akm add`, `akm import`, and `akm wiki stash` all reuse the same core website-ingest path.
- **`.stash.json` docs deprecation timeline** — the docs now explicitly state that `.stash.json` is deprecated, remains only as a 0.7.x compatibility bridge, and will be removed in v0.8.0 to match the current aggressive pre-release phase-out posture.

## [0.7.0]

### Added

- **Proposal queue (`akm proposal *`)** (#225, #226, #233) — durable queue for proposal-producing commands. New verbs `akm proposal {list, show, diff, accept, reject, revert}`. Promotion runs full validation before routing through `writeAssetToSource()`. Multiple proposals for the same `ref` coexist without filesystem collisions. Auto-accept is gated per-source via `autoAcceptProposals: true` (default off; requires a writable source). See v1 spec §11.
- **`akm reflect`, `akm propose`, `akm distill`** (#225, #226, #227) — three new commands that write **only** to the proposal queue. `reflect` and `propose` shell out via the agent CLI (`agent.*` config); `distill` is the canonical bounded in-tree LLM call gated behind `llm.features.feedback_distillation`. Usage events `reflect_invoked`, `propose_invoked`, `distill_invoked`.
- **`lesson` asset type** (#227) — first-class well-known type with required frontmatter `description` and `when_to_use`, stored under `lessons/<name>.md`. Normally produced by `akm distill <ref>` as a `proposed`-quality proposal and promoted via `akm proposal accept`.
- **`llm.features.*` map with mixed defaults** (#227, #284) — every bounded in-tree LLM call site is gated behind exactly one feature flag. Four keys ship: `curate_rerank`, `feedback_distillation`, `memory_inference`, `graph_extraction`. `memory_inference` and `graph_extraction` default to `true`; the others default to `false`. Wrapper `tryLlmFeature(feature, config, fn, fallback)` in `src/llm/feature-gate.ts` guarantees disabled/throw/timeout fall back without crashing the call site. See v1 spec §14.
- **`quality: "proposed"` and `--include-proposed`** — `SearchHit.quality` open string set; `proposed` is excluded from default search and surfaces only via `akm search ... --include-proposed` or `akm proposal *`. Unknown values parse-warn-include. `SearchHit` gains optional `quality?` and `warnings?` fields.
- **`akm-bench` v1** (#234, PRs #266, #268, #269) — paired-utility benchmark framework. Track A runs each task with and without akm available and emits a comparable score pair; `akm-bench compare` aggregates paired runs into a delta report; `akm-bench attribute` maps utility deltas back to specific `[origin//]type:name` refs (Track B); `akm-bench evolve` is a stub for the closed-loop workflow that lands in 0.8.
- **Operator env-var documentation** (#284 Wave B, PR #285) — `docs/configuration.md` now documents `AKM_NPM_REGISTRY`, `AKM_REGISTRY_URL`, `AKM_CACHE_DIR`, `HF_HOME`, and `GH_TOKEN`.
- **Empty-state hints** (#284 Wave C, PR #286) — `akm proposal list`, `akm workflow list`, and `akm vault list` empty-state messages now include "how to create the first one" guidance.
- **Canned error hints** (#284 Wave C, PR #286) — four new typed error hints added: `INVALID_FLAG_VALUE`, `ASSET_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `FILE_NOT_FOUND`.
- **`--verbose` global flag in `--help`** (#284 Wave C, PR #286) — the flag was honoured at runtime but invisible in help output; now declared.
- **~90 new tests** (#284 Wave D, PR #285) — direct coverage for the proposal/reflect/propose/distill CLI integration paths, output-shape contracts, workflow-runs state machine, and lesson-init scaffolding.

### Security

- **Git message sanitization** (#270) — commit messages and remote URLs written by akm are sanitized to prevent shell-substitution and control-character injection through user-supplied content.
- **Bench env isolation** (#271) — `akm-bench` runs each agent invocation in a scrubbed environment so host secrets do not leak into bench transcripts or paired-run logs.
- **LLM body redact + npm tarball host validation** (#272) — outbound LLM request/response bodies are redacted in error reporting before surfacing to stderr or warnings; `akm add npm:…` validates the tarball download host against the configured npm registry rather than following arbitrary `dist.tarball` URLs.

### Changed

- **Workflow noise gate, sources deprecation warn, setup `--help`** (#273) — `akm workflow next/complete/status` no longer print spurious progress noise on quiet runs; the legacy `stashes[]` key emits a single deprecation warning per process (was: per call site); `akm setup --help` renders the same help block as `akm setup` with no args plus the agent-detection summary.
- **tsconfig + HF pin + shapes throw** (#274) — `tsconfig.json` now includes `tests/` so `bunx tsc --noEmit` covers test files; the HF embeddings model is pinned to a specific revision to avoid silent upstream changes; the output-shape registry throws on a missing shape rather than silently `JSON.stringify`-ing.
- **Bench tmp redirect** (#276) — `akm-bench` no longer writes scratch state under `/tmp`; everything lands under the AKM cache dir (`~/.cache/akm/bench/`) so cleanup is bounded and CI sandboxes that ban `/tmp` writes work out of the box.
- **Registry-build tmp redirect** (#284 Wave E, PR #285) — `inspectArchive` now mkdtemps under `${getCacheDir()}/registry-build/` instead of `os.tmpdir()`. Mirrors the bench-only redirect from #276 for non-bench code. `vault load` retains its `/tmp` mode-0600 sentinel by design.

### Fixed

- **Agent spawn timeout** (#284 Wave A, PR #285, BUG-H1) — stdin write could hang past `agent.timeoutMs`; the write now races against `proc.exited` so the timeout is always honoured.
- **Captured-stdio leak on spawn failure** (#284 Wave A, PR #285, BUG-H2) — stream readers no longer leak as floating promises on the spawn-failed path.
- **`defaultWriteTarget` writability check** (#284 Wave A, PR #285, BUG-H3) — resolving `defaultWriteTarget` was missing the writability gate that the `--target` path enforces; now mirrored.
- **Schema-upgrade row loss** (#284 Wave A, PR #285, BUG-H4) — `restoreUsageEventsBackup` silently dropped rows when the new schema added a NOT-NULL column without DEFAULT; now projects rows onto the column intersection and warns loudly.
- **Bench cleanup registry running flag** (#284 Wave A, PR #285, BUG-H5) — `runAllAndExit` now resets `registry.running` in a `try/finally` so a synchronous throw cannot deadlock subsequent SIGINT handlers.
- **`akm search` with no query** (#284 Wave C, PR #286) — error hint now references `--type`/`--limit` instead of show-style ref grammar.
- **`akm workflow next <bogus-id>`** (#284 Wave C, PR #286) — surfaces `WORKFLOW_NOT_FOUND` with `Run \`akm workflow list --active\`` instead of a cryptic ref-parse error.
- **`akm add /missing/path`** (#284 Wave C, PR #286) — throws typed `NotFoundError("FILE_NOT_FOUND")` with hint instead of a bare `Error`.
- **`akm update <bogus>`** (#284 Wave C, PR #286) — now uses `SOURCE_NOT_FOUND` (with the existing hint pointing at `akm list`) instead of the default `ASSET_NOT_FOUND`.
- **Setup wizard source count + embedding-dim prompt** (#284 Wave C, PR #286) — the wizard now reads `newConfig.sources ?? newConfig.stashes` to count configured sources (was reading the dropped legacy key); the embedding-dimension prompt now explains what the value is for.
- **`formatPlain` null fallback** (#284 Wave C, PR #286) — text renderers now exist for every command that calls `output()`; no more silent JSON when an operator passes `--format text`.
- **Arity guards** (#284 Wave C, PR #286) — `propose`, `feedback`, `curate`, and `help migrate` no longer exit 0 with citty's help screen when required positionals are missing; they now exit 2 with `MISSING_REQUIRED_ARGUMENT`.

### Removed

- **Legacy registry `curated` boolean** — legacy v2 index JSON parses and silently ignores it; renderers no longer surface a `curated` column. The per-asset `quality` field replaces it. Publishers do not need to migrate existing JSON.
- **Phantom config keys** (#284 Wave B, PR #285): `llm.features.{tag_dedup, memory_consolidation, embedding_fallback_score}`, `llm.capabilities.{longContext, toolUse}`, and `llm.contextWindow`. These were parsed and persisted by the loader but never read at any call site, and the docs that described their behaviour were misleading. Operators with these keys in `config.json` will see them silently ignored — `akm config get llm.features.tag_dedup` (etc.) will return undefined.
- **`disableGlobalStashes`** (#284 Wave B, PR #285) — legacy config key removed; the one-cycle deprecation window from the v1 spec has expired.
- **`stashes[]` config-key migration shim** (#284 Wave B, PR #285) — the `stashes[]` → `sources[]` migration was advertised for one release cycle in 0.6.x; that cycle has now expired. 0.5.x configs that have not been touched since will produce a `ConfigError` on parse instead of auto-migrating. Run `akm setup` (or rename the key by hand) to migrate.
- **`searchPaths` legacy migration** (#284 Wave B, PR #285) — pre-0.5.x config key; deprecation window long expired.
- **`context-hub` source-kind migration paths** (#284 Wave B, PR #285) — `STASH_TYPE_ALIASES`, the `parseSourceSpec` `case "context-hub"` arm, the `context-hub-${key}` git rename migration, and the `normalizeToggleTarget("context-hub")` arm are all gone. Per CLAUDE.md, `context-hub` is just a git repo and was never a first-class kind.
- **Legacy lockfile migration** (#284 Wave B, PR #285) — `migrateLegacyLockfileIfNeeded` (the `stash.lock` → `akm.lock` rename) is removed; the rename ran for at least two release cycles.

### Internal

- 9 `console.warn` sites migrated to `warn()` from `src/core/warn.ts` for uniform `--quiet` honoring (#284 Waves A/B, PR #285).
- 6 unused exports removed: `StashLockEntry`, `listProviderTypes`, `resetBuiltinsCache`, and two `GraphRelation` re-exports (#284 Wave A, PR #285).
- ~472 LoC net deletion from `src/core/config.ts` from removing the legacy migration paths above (#284 Wave B, PR #285).
- `--for-agent` deprecation note retained in `docs/technical/akm-core-principles.md` and `docs/technical/search-updated.md` for at least one more cycle.
- Workflow-runs state machine, lesson-init scaffolding, and the proposal/reflect/propose/distill CLI now have direct test coverage (#284 Wave D, PR #285).

### Migration

- See [`docs/migration/release-notes/0.7.0.md`](docs/migration/release-notes/0.7.0.md) for the operator summary and [`docs/migration/v1.md`](docs/migration/v1.md) for the canonical per-surface delta from any 0.6.x baseline.

## [0.6.0] - 2026-04-23

### Added

- **`akm workflow validate <ref|path>`** — new subcommand that validates a workflow markdown file or ref, surfacing every error in one pass (without running a full reindex).
- **`akm feedback` now accepts any indexed ref** — previously type-restricted. `memory:`, `vault:`, `workflow:`, `wiki:` refs all work. Vault feedback never echoes vault values.
- **`akm upgrade` runs post-upgrade tasks automatically.** After a successful upgrade, the new binary is invoked as a child process running `akm index`, which auto-migrates any legacy `stashes` → `sources` config keys via `loadConfig` and rebuilds the index against the new schema (`DB_VERSION` 8 → 9 forces a rebuild). Pass `--skip-post-upgrade` to opt out (config migration still runs on the next `akm` invocation; you'd just need to run `akm index` yourself). Result is reported in the `postUpgrade` field of the upgrade response.
- **`writable` flag on sources.** New optional `SourceConfigEntry.writable` controls whether write commands (`akm remember`, `akm import`, `akm save`, `akm clone`) may target the source. Defaults: `true` for `filesystem`, `false` for `git` / `website` / `npm`. `writable: true` on `website` or `npm` is rejected at config load with `ConfigError("writable: true is only supported on filesystem and git sources")`.
- **`defaultWriteTarget` root config key.** Names the source that receives writes when no `--target` flag is given. Resolution order: `--target` → `defaultWriteTarget` → `stashDir` (working stash) → `ConfigError("no writable source configured; run \`akm init\`")`. There is no implicit "first writable in `sources[]` order" fallback.

### Changed

- **Workflows are now stored as validated `WorkflowDocument` JSON** — workflows are compiled into a validated `WorkflowDocument` JSON shape with line-anchored `SourceRef`s back into the source markdown, cached in a new `workflow_documents` table in `index.db`. The run engine reads from the cache on `akm workflow next` instead of re-parsing markdown each step.
- **Feedback events flow into utility recomputation** — positive/negative feedback signals now feed utility scoring alongside search/show events. Telemetry records both `entry_ref` and `entry_id` so feedback signals survive a reindex.

### Changed (breaking)

- **v1 architecture refactor.** The internal architecture was rebuilt around a single minimal `SourceProvider` interface (`{ name, kind, init, path, sync? }`), a unified FTS5 index that owns search and show, and a single `writeAssetToSource` helper that owns all writes. The CLI command surface and all user-visible config keys are unchanged. See `docs/migration/v1.md` for the full guide.
- **Config key `stashes[]` renamed to `sources[]`.** Configs with the legacy key load with one deprecation warning and are auto-migrated in memory; the new key is persisted on the next `akm config` write. New configs should use `sources[]`. Configs that contain both keys are rejected with `ConfigError`.
- **Error hints surface without `--verbose`.** Error classes own their `hint()` text; the regex-on-message hint chain in `cli.ts` is removed. Hints print to stderr inline alongside the error message.
- **Registry providers loop through a uniform interface.** Context Hub is no longer a special-cased provider type. Add it as a regular git source (`akm add github:andrewyng/context-hub`) or include it as a kit in your registry index. Legacy `type: "context-hub"` entries normalize to `type: "git"` at load time.
- **Terminology cleanup — clean break from "kit" → "stash"** (#148). Pre-v1, no fallback period.
  - **Wire format**: `RegistryIndex.kits[]` renamed to `RegistryIndex.stashes[]`. Schema version bumped to **v3** — `akm-cli >= 0.6.0` only parses indexes with `version: 3`. v1/v2 indexes are no longer accepted. Every static-index registry must regenerate its `index.json` with `version: 3` to be readable. The official `akm-registry` ships a regenerated index alongside this release.
  - **Discovery**: npm packages and GitHub repos are now discovered via the `akm-stash` keyword/topic only. Legacy `akm-kit` and `agentikit` keywords/topics are no longer honored. Publishers must retag.
  - **Schemas**: `schemas/registry-index.json` and `docs/technical/registry-index.schema.json` updated (`RegistryKit` → `RegistryStash`, `kits` → `stashes`).
  - **Internal types**: `RegistryKitEntry` → `RegistryStashEntry`, `InstalledKitEntry` → `InstalledStashEntry`, `KitInstallStatus` → `StashInstallStatus`, `KitSource` → `StashSource`. Files `src/kit-include.ts` → `src/stash-include.ts` and `src/installed-kits.ts` → `src/installed-stashes.ts`.
  - **Asset hit field**: `RegistryAssetSearchHit.kit` → `RegistryAssetSearchHit.stash`.
  - **Docs**: `docs/kit-makers.md` → `docs/stash-makers.md`. All user-facing "kit" references in docs and the README replaced with "stash".
  - **Preserved**: the *Agent Kit Manager* tagline, the `akm-cli` npm package name, and the `akm.include` package.json field.
  - **Migration**: a curated registry author should regenerate their `index.json` (rename `kits` → `stashes`, drop legacy keyword filtering). Publishers should add the `akm-stash` keyword/topic and remove `akm-kit`/`agentikit`.
- **`akm registry` description**: changed from "Manage kit registries" to "Manage stash registries".

### Migration / Breaking

- **`DB_VERSION` bumped 8 → 9.** On first run after upgrade, the version-mismatch path in `ensureSchema()` drops + recreates all `index.db` tables (preserving `usage_events` via a typed backup); the next `akm index` rebuilds the index. `workflow.db` (run state) is unaffected.

### Removed (breaking)

- **OpenViking source provider.** The `openviking` source kind is no longer supported. Configs that contain one fail to load with `ConfigError("openviking is not supported in akm v1. …")` and a hint pointing to `akm config sources remove <name>`. API-backed sources will return as a separate `QuerySource` tier post-v1. To downgrade in the meantime, pin to `akm-cli@0.5`.
- **`akm enable context-hub` / `akm disable context-hub` toggles.** Add Context Hub as a regular git source (`akm add github:andrewyng/context-hub`) or list it as a kit entry in your registry; remove or disable it via `akm config sources remove context-hub` or by editing the entry's `enabled` flag.
- **Legacy re-export shims** `src/llm.ts`, `src/registry-provider.ts`, and `src/ripgrep.ts`. akm has no public API (CLI-only package, no barrel exports), so external consumers should be unaffected.

### Internal

- **`src/` reorganized into purpose-named subdirectories** (`commands/`, `core/`, `indexer/`, `output/`, `registry/`, `setup/`, `sources/`, `wiki/`, `workflows/`). No public API surface change.
- **Single `writeAssetToSource` helper** under `src/core/write-source.ts` is the only place that branches on `source.kind` to add behaviour. All write call sites (`remember`, `import`, `clone`, `save`) route through it.
- **`SourceProvider` interface simplified** to `{ name, kind, init, path, sync? }`. The previous `LiveStashProvider` / `SyncableStashProvider` split is gone.

## [0.5.0] - 2026-04-22

### Added

- **Multi-wiki support** (#119, #121, #136, #139, #144): new `wiki` asset type with ten CLI verbs under `akm wiki …` (`create`, `register`, `list`, `show`, `remove`, `pages`, `search`, `stash`, `lint`, `ingest`). Each wiki lives at `<stashDir>/wikis/<name>/` with `schema.md`, `index.md`, `log.md`, `raw/`, and agent-authored pages. Wiki pages are first-class in stash-wide `akm search`. `akm index` regenerates each wiki's `index.md` as a side effect and is resilient to malformed workflow assets. Raw sources under `raw/` and the `schema.md` / `index.md` / `log.md` infrastructure files are intentionally excluded from the search index. See `docs/wikis.md` for the full guide. Design principle: **akm surfaces, the agent writes** — no LLM calls, no network access; akm owns only operations with invariants an agent can't reliably enforce (lifecycle, raw-slug uniqueness, structural lint, index regeneration, workflow discovery).
- **External wiki registration** (#139, #144): `akm wiki register <name> <path-or-repo>` and `akm add --type wiki --name <name> <source>` register an existing directory or git/website repo as a first-class wiki without copying or mutating it; source and wiki search state are refreshed immediately and refs/state are normalized on subsequent indexing.
- **Workflow asset type** (#118): new `workflow` type with `akm workflow` subcommands `template`, `create`, `start`, `next`, `complete`, `status`, `list`, and `resume` for authoring and stepping through multi-step workflows stored in the stash. Runs snapshot their step list at start so edits to the source workflow do not affect an in-flight run.
- **Vault asset type** (#117): new `vault` type backed by `.env` files; `akm vault` subcommand with `list`, `show`, `create`, `set`, `unset`, and `load` (emits a `source` snippet for the current shell via a mode-0600 temp file); values never appear in structured output.
- **`--trust` flag for installs**: `akm add <source> --trust` performs a one-off trusted install, bypassing the install audit for that source. Blocked install errors now include a `hint` pointing to `--trust` as a remediation option.
- **Writable git stash + `akm save`** (#114): `akm add … --writable` opts a remote git-backed stash into push-on-save; `akm save [name] [-m message]` commits (and pushes when writable + remote is set); default stash is auto-initialized as a git repo; git stash provider now uses `git clone` instead of HTTP tarball download.
- **`akm help migrate <version>`** (#132): prints the release notes and migration guidance for a given version (accepts `0.5.0`, `v0.5.0`, or `latest`). Pulls the matching section from `CHANGELOG.md` when available and supplements it with embedded migration notes for major releases.
- **Broader `akm upgrade` coverage** (#132, #134): self-update now detects and upgrades npm, bun, pnpm, and standalone-binary installs (previously binary-only). Runtime assets covered by the upgrade flow were also expanded so newly shipped asset types stay current.

### Fixed

- **0.5.0 QA follow-ups** (#130): fixes across the new wiki, workflow, vault, and save/trust surfaces surfaced during release-candidate QA.

### Removed (breaking)

- The unreleased single-wiki LLM POC: removes `akm lint` command, `akm import --llm` / `--dry-run` flags, `knowledge.pageKinds` config, and the `ingestKnowledgeSource` / `lintKnowledge` LLM prompts. Users of the POC should migrate to the new `akm wiki …` surface; raw content can be manually moved to `wikis/<name>/raw/`.

### Documentation

- **Technical docs refresh** (#138): stash and search architecture docs updated to match the current implementation.
- **Wiki configuration guide** (#115): new docs page covering wiki configuration and ingest flow.

## [0.4.1] - 2026-04-21

### Added

- **`akm enable` / `akm disable`** (#108): toggle optional components (`skills.sh`, `context-hub`) on/off without manually editing config
- **`akm remember` and `akm import` commands** (#110): capture in-session knowledge directly from the CLI; `akm remember` records a memory to the default stash (supports stdin); `akm import` ingests a file or stdin as a knowledge asset
- **Karpathy-style wiki workflow in knowledge assets** (#113): `akm show knowledge:<doc>` now surfaces an `ingest` workflow for knowledge documents; `--dry-run` flag added; `pageKind` taxonomy made extensible
- Documentation: expanded `agent-install.md`, added `info` and `feedback` command docs, global flags reference (#106)

### Fixed

- Remote embedding endpoint URL normalization — trailing slashes and path segments now handled correctly (#112)
- Reduced fallback capture-name collisions in `akm remember`

## [0.4.0] - 2026-04-19

### Added

- **Install security audit**: new pre-install scanner inspects kit contents for dangerous patterns and executable scripts before install; configurable via `config` CLI
- **Project-level config stash merging**: `.akm.json` in a project directory merges its stash/registry entries with user config during CLI runs
- **Disable inherited project stashes**: project config can disable stashes inherited from parent/user scopes
- **`akm curate` command**: new subcommand for curating assets from the stash (initial skeleton)

### Fixed

- Index nested agent markdown files as agents so `akm search agent:...` finds them
- `install-audit` now reads at most `MAX_SCANNED_FILE_BYTES` per file using `Buffer.alloc`, with the file descriptor always closed via `try/finally`, and corrects the `scannedBytes` counter

## [0.3.1] - 2026-04-01

### Added

- **Website stash provider**: add a URL directly as a stash source with `akm stash add <url>`; crawls the site and indexes pages as knowledge assets
- Website provider options: `--max-pages` and `--depth` flags to bound crawling

### Fixed

- Relaxed HTTP warnings for localhost website sources
- Addressed review feedback around website provider routing and security heuristics

## [0.3.0] - 2026-03-30

### Added

- Regression tests for vector/semantic search readiness, install, and setup flows
- `CONTRIBUTING.md` and "Why akm" section in documentation
- Three draft SEO blog posts

### Changed

- **Unified source model**: replaced the `kit` vs `stash` split with a single source concept; `akm add` works for all source types
- Removed `stash` and `kit` subcommand groups; their behaviors fold into the top-level CLI (`akm list`, `akm add`, etc.)
- Refactored semantic search readiness tracking for clearer state transitions
- Aligned documentation voice and updated older posts for the current CLI surface

### Fixed

- Embedding fingerprint is purged on model change and `usage_events` are re-linked correctly
- Local embedder dtype selection
- Release validation workflow
- Prereleases (versions with suffixes) are marked as such on GitHub releases and published to npm with `--tag next`

## [0.2.2] - 2026-03-28

### Fixed

- Binary install detection in `akm upgrade` self-update; centralized `AKM_VERSION` declaration with binary detection tests

## [0.2.1] - 2026-03-25

### Added

- Docker-based install tests covering multiple OS configurations (skipped in CI)
- Detailed error reporting in embedding availability checks
- Actionable guidance when `sqlite-vec` fails to open the DB

### Changed

- **Rename**: project renamed from `Agent-i-Kit` to `akm` across docs and links
- Local embeddings switched to `@huggingface/transformers`
- `@huggingface/transformers` moved to `optionalDependencies`, then promoted to a runtime dependency
- Improved semantic search setup and index UX

## [0.2.0] - 2026-03-18

### Added

- **Extensible asset type system**: `AkmAssetType` (formerly `AgentIKitAssetType`) is now `string` instead of a fixed union; new types can be registered at runtime via `registerAssetType()`
- **Memory asset type**: built-in `memory` type stored in `memories/`, with `memory-md` renderer and directory/parent-dir-hint matchers
- **OpenViking stash provider**: `openviking` provider type for searching OpenViking servers via REST; add with `akm stash add <url> --provider openviking`
- **Remote show for `viking://` URIs**: `akm show viking://resources/my-doc` fetches content directly from an OpenViking server (returns `editable: false`)
- **`--options` flag** for `akm registry add` and `akm stash add`: pass provider-specific JSON config (e.g., `--options '{"apiKey":"key"}'`)
- **`akm registry build-index` command**: generates a v2 registry index JSON from npm/GitHub discovery with `--out`, `--manual`, `--npmRegistry`, `--githubApi`, and `--format` flags
- Exact-name match, type-relevance, and alias boosts in the search scoring pipeline
- Ranking regression tests with a synthetic fixture stash and a 41-case benchmark suite (MRR / Recall@5)
- `estimatedTokens` on context-hub provider search results and in `--for-agent` output
- Architecture docs and test fixture for OpenViking manual testing (`tests/fixtures/openviking/`)

### Changed

- Unified context-hub indexing and fair provider scoring: local FTS scores are preserved everywhere and remote provider scores compete on equal footing
- Replaced RRF with normalized BM25 scoring across all merge paths
- EMA utility decay is now time-proportional instead of tied to index frequency
- Replaced the `(Bun as any).YAML` hack with a proper `yaml` package dependency
- YAML output format fixed; local registry refs now use a `file:` prefix

### Removed

- `manifest` subcommand (adds no value over `search`)
- URI schemes (`viking://`, `context-hub://`) from user-facing refs — assets are addressed as `type:name`; sources use URLs
- Stale audit/ergonomics markdown from the repo

### Fixed

- `skills.sh` install refs now produce valid `akm add` commands (#82)
- Prevented `akm remove` and `akm update --force` from deleting user-owned local source directories installed via path refs
- `usage_events` reverted to `DELETE` on full reindex

## [0.1.0] - 2026-03-10

Major internal overhaul and rebrand. This release simplifies the asset model,
cleans up the CLI surface, and renames the package from `agent-i-kit` to `akm-cli`.

### Added

- `--verbose` flag on `search` for detailed scoring output
- ExecHints system (`run`, `cwd`, `setup`) for script assets, replacing the old tool-runner
- New environment variable overrides: `AKM_CONFIG_DIR`, `AKM_CACHE_DIR`, `AKM_STASH_DIR`
- CI workflow running lint, type-check, and tests on every push/PR
- Biome linter and formatter configuration
- README badges (npm version, CI status, license)

### Changed

- **Rebrand**: npm package `agent-i-kit` renamed to `akm-cli`; binary remains `akm`
- **Rebrand**: config field `"agent-i-kit"` renamed to `"akm"` in `package.json`
- **Rebrand**: plugin `agent-i-kit-opencode` renamed to `akm-opencode`
- **Rebrand**: registry `agent-i-kit-registry` renamed to `akm-registry`
- **Rebrand**: default paths changed (`~/agent-i-kit` to `~/akm`, `~/.config/agent-i-kit` to `~/.config/akm`)
- **Rebrand**: environment variables `AGENT_I_KIT_*` renamed to `AKM_*`
- Removed `tool` asset type entirely; `script` is the only script-like type
- `.stash.json` field renames: `intents` to `searchHints`, `entry` to `filename`; removed `generated` boolean
- `show` command: `--view` flag replaced with positional syntax (`akm show <ref> toc`)
- Collapsed `AssetTypeHandler` handlers into a unified renderer pipeline
- Dropped provider presets (raw JSON config only)
- Pinned `sqlite-vec` to exact version `0.1.7-alpha.2` (removed caret range)
- Replaced `(Bun as any).YAML` cast with proper type guard in CLI
- Version now injected at compile time via `--define AKM_VERSION` with safe runtime fallback

### Removed

- `submit` command
- Provider presets (configure providers with raw JSON)
- `generated` boolean from `.stash.json`

### Fixed

- CLI crash on macOS when running as compiled binary (`package.json` not embedded)
- Cleaned up search output formatting

## [0.0.17] - 2026-03-12

Registry refactor and documentation overhaul. This release introduces a
first-class registry management CLI, modernizes the config schema, and
rewrites all documentation against the final asset model.

### Added

- `akm registry` subcommand group with `list`, `add`, `remove`, and `search` subcommands
- `akm registry search --assets` flag for asset-level search against v2 registry indexes
- `registries` config field (`RegistryConfigEntry[]`) with `url`, `name`, and `enabled` properties
- Registry Index v2 schema with optional `assets` array on kit entries for asset-level discovery
- Official registry pre-configured by default in new installations
- Type names: `KitSource`, `InstalledKitEntry`, `KitInstallResult`, `KitInstallStatus`, `InstalledKitListEntry`

### Changed

- Config: `installed` is now a top-level field (`config.installed`) instead of nested under `config.registry.installed`
- Config: registry URLs configured via `registries` array instead of `registryUrls`
- Documentation: complete rewrite of concepts, registry, CLI reference, README, and all technical docs
- Documentation: added "Mental Model" (registries --> kits --> stash --> assets) to concepts
- Documentation: added asset classification taxonomy description
- Documentation: merged ref format documentation into concepts (removed "opaque handle" framing)
- Documentation: revised apt analogy in core principles to map registries, kits, stash, and assets
- Documentation: added `akm registry` subcommand group to CLI reference
- Documentation: added registry hosting and v2 index format guides

### Removed

- `tool` asset type (fully removed across all documentation and code)
- `registryUrls` config field (replaced by `registries`)
- `config.registry.installed` nesting (replaced by `config.installed`)
- All `tools/` directory references from documentation

## [0.0.13] - 2026-03-09

Initial public release of Agent-i-Kit (`akm` CLI).

### Added

- CLI tool (`akm`) for searching, showing, and running Agent-i-Kit stash assets
- Hybrid search with FTS5 full-text and optional vector similarity scoring
- Registry support for discovering, installing, and updating community kits
- Multiple install sources: npm, GitHub, git URLs, and local directories
- Self-update via `akm upgrade`
- Multiple output formats: plain text, YAML, and JSON (`--json`)
- Knowledge asset navigation with TOC, section, and line-range views
- `akm clone` to fork installed assets into your working stash
- Configuration system with embedding and LLM provider management
- Standalone binary distribution (no runtime dependencies)
