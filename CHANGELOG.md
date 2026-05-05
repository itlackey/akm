# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

- **Proposal queue (`akm proposal *`)** (#225, #226, #233) — durable queue for proposal-producing commands. New verbs `akm proposal {list, show, diff, accept, reject}`. Promotion runs full validation before routing through `writeAssetToSource()`. Multiple proposals for the same `ref` coexist without filesystem collisions. Auto-accept is gated per-source via `autoAcceptProposals: true` (default off; requires a writable source). See v1 spec §11.
- **`akm reflect`, `akm propose`, `akm distill`** (#225, #226, #227) — three new commands that write **only** to the proposal queue. `reflect` and `propose` shell out via the agent CLI (`agent.*` config); `distill` is the canonical bounded in-tree LLM call gated behind `llm.features.feedback_distillation`. Usage events `reflect_invoked`, `propose_invoked`, `distill_invoked`.
- **`lesson` asset type** (#227) — first-class well-known type with required frontmatter `description` and `when_to_use`, stored under `lessons/<name>.md`. Normally produced by `akm distill <ref>` as a `proposed`-quality proposal and promoted via `akm proposal accept`.
- **`llm.features.*` map with default-false gates** (#227, #284) — every bounded in-tree LLM call site is gated behind exactly one feature flag. Four keys ship: `curate_rerank`, `feedback_distillation`, `memory_inference`, `graph_extraction`. All defaults are `false`. Wrapper `tryLlmFeature(feature, config, fn, fallback)` in `src/llm/feature-gate.ts` guarantees disabled/throw/timeout fall back without crashing the call site. See v1 spec §14.
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
