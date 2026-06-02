# CLI Reference

The CLI is called `akm` (Agent Knowledge Management). Commands default to structured
JSON at `--detail brief`. Use `--format json|jsonl|text|yaml` and `--detail
brief|normal|full|summary` when you want a different presentation. Errors
include `error` and `hint` fields.

> **Status legend.** Every command on this page runs today on the
> current pre-release build. Commands shipped in 0.8.0 — `health`, `agent`,
> `improve`, `propose`, `proposals`, `accept`, `reject`, and the `feedback --reason`
> extension — carry an **Available since 0.8.0** marker so you can tell at
> a glance which surface arrived in that release. The locked v1.0 surface
> is declared in
> [`docs/technical/v1-architecture-spec.md`](technical/v1-architecture-spec.md)
> §9.4.

## Global Flags

These flags are accepted by all commands:

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--format` | `json`, `text`, `yaml`, `jsonl` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output **verbosity** level |
| `--shape` | `human`, `agent`, `summary` | `human` | Output **projection** (was `--detail summary\|agent`) |
| `--for-agent` | boolean | `false` | **Deprecated alias** for `--shape=agent` (removed in 0.9.0). Prefer `--shape=agent` |
| `--quiet` / `-q` | boolean | `false` | Suppress stderr warnings |
| `--verbose` | boolean | `false` | Enable verbose diagnostics gated behind `isVerbose()`. Parsed globally before any subcommand runs. The `AKM_VERBOSE` env var honours the same setting and wins when both are present (see `src/core/warn.ts`). |

`--detail` controls **how much** is returned (`brief|normal|full`); `--shape`
controls the **projection** (`human` for people, `agent` for a token-lean
action view, `summary` for capability discovery). The legacy spellings
`--detail summary`, `--detail agent`, and `--for-agent` are deprecated aliases
that warn on stderr and map to `--shape` (removed in 0.9.0).

### `--format jsonl`

Outputs one JSON object per line. For `search` and `registry search`, each hit
is a separate line. For other commands, the entire result is a single line.
Useful for streaming consumption by scripts or agents.

### `--shape=agent` (was `--detail=agent` / `--for-agent`)

Strips output to only action-relevant fields:

- **search**: keeps `name`, `ref`, `type`, `description`, `action`, `score`, `estimatedTokens`
- **show**: keeps `type`, `name`, `description`, `action`, `content`, `template`, `prompt`, `run`, `setup`, `cwd`, `toolPolicy`, `modelHint`, `agent`, `parameters`, `workflowTitle`, `workflowParameters`, `steps`, `keys`, `comments`

Prefer `--shape=agent` going forward. The `--detail=agent` and `--for-agent`
spellings are kept as deprecated aliases that warn on stderr (removed in
0.9.0).

### `--shape summary`

Available for `show` and `search`. Returns a compact view suitable for
capability discovery:

- **show**: `type`, `name`, `description`, `tags`, `parameters`, `workflowTitle`, `action`, `run`, `origin`, `keys`, `comments`
- **search**: For `search`, `summary` currently behaves the same as the default `brief` envelope; per-hit content shaping is reserved for a future minor release.

The legacy `--detail summary` spelling is a deprecated alias for `--shape
summary` (removed in 0.9.0).

## Exit Codes and Error Envelope

Every command exits with one of the following codes:

| Exit code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or general error | `NotFoundError`, other |
| 2 | Usage / bad input | `UsageError` |
| 4 | Health warning (`akm health` only) | — |
| 78 | Configuration error | `ConfigError` |

On failure, every command emits a JSON error envelope on **stderr** before
exiting; stdout is left empty (or contains only command-specific side-effect
output such as a direct path from `env path`):

```json
{"ok": false, "error": "<message>", "hint": "<optional hint>"}
```

The `hint` field is present only when actionable remediation is available
(e.g. a suggested flag or alternate command). Agents should check
`ok === false` on the parsed stderr envelope or a non-zero exit code to
detect failure. Scripts can rely on the exit code alone.

## Commands

### init

> **Note:** `akm setup` is the recommended entry point — it runs the same directory initialization plus guides you through AI connection configuration. `akm init` remains available as a low-level building block.

Create the stash directory structure and persist the working stash path in
config.

```sh
akm setup                        # Interactive setup wizard (creates stash + configures connections)
akm setup --dir ~/custom-stash   # Initialize at a custom location
akm setup --yes                  # Non-interactive, accepts all defaults
```

Creates one subdirectory per asset type under the stash path — currently
`scripts/`, `skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`,
`memories/`, `env/`, `secrets/`, `wikis/`, and `lessons/`. See
[technical/filesystem.md](technical/filesystem.md) for config file locations.

### setup

Run the interactive first-run wizard.

```sh
akm setup
```

The setup wizard configures AKM in two steps:

**Step 1 — Small model connection** (for background processing)
Configures the OpenAI-compatible endpoint and model used for `akm index`
metadata enhancement, `akm remember --enrich`, and `akm curate --rerank`. Supports Ollama,
OpenAI, LM Studio, or any custom endpoint. Skipping disables enrichment features.

**Step 2 — Agent connection** (for agentic commands)
Configures how `akm improve`, `akm propose`, and `akm tasks run` dispatch AI sessions.
Options:
- **Same connection** — reuse the Step 1 endpoint with a (optionally different) model
- **New connection** — separate endpoint, model, and API key
- **Installed CLI agent** — use an installed agent binary (opencode, claude, codex, etc.)
- **None** — agentic commands disabled with a clear warning

A feature capability summary is shown at the end of setup.

The wizard also lets you choose a stash directory, review registries, and add stash
sources. When you save, akm writes the config file, initializes the stash directory,
and builds the search index.

### index

Build or refresh the search index.

```sh
akm index            # Incremental (only changed directories)
akm index --full     # Full rebuild
akm index --verbose  # Print phase progress to stderr
akm index --clean    # Normal index + remove stale entries from the DB
akm index --clean --dry-run # Report stale entries without deleting
```

Returns stats: `totalEntries`, `generatedMetadata`, `directoriesScanned`,
`directoriesSkipped`, `verification`, optional `warnings`, and `timing`
breakdown in milliseconds. Use `--verbose` to print the indexing mode,
semantic-search settings, and phase-by-phase progress to stderr while the
index is being built. Malformed workflow assets are skipped with file-path
warnings instead of aborting the full run.

**`--clean` flag:** After indexing completes, verifies every indexed entry's source
file still exists on disk. Removes any entries whose file is missing (for local
stash sources only; remote entries are skipped). Returns a `clean` block in the
JSON result with `checked`, `removed`, `removedRefs` arrays, and `dryRun` flag.
Use `--clean` to resolve the edge case where a deleted file in an unchanged
directory lingers in the index across incremental runs. With `--dry-run`, reports
which entries would be removed without modifying the database.

`akm index` always rebuilds the search index and keeps metadata in the index.
When `akm.llm` is configured and the per-pass gate allows it, metadata
enhancement runs during indexing. In text mode, the default CLI UI shows a
spinner with processed-versus-total source counts; structured output modes
(`json`, `yaml`, `jsonl`) stay clean and machine-readable.

### info

Show system capabilities, configuration, and index state.

```sh
akm info
```

Returns a JSON object with:

| Field | Description |
| --- | --- |
| `version` | Current akm version |
| `assetTypes` | List of recognized asset types |
| `searchModes` | Active search modes (`fts`, optionally `semantic` and `hybrid`) |
| `semanticSearch` | Semantic search status: `mode`, `status`, and optional `reason`/`message` |
| `registries` | Configured registries |
| `sourceProviders` | Configured sources (filesystem, git, website, npm) |
| `indexStats` | Index stats: `entryCount`, `lastBuiltAt`, `hasEmbeddings`, `vecAvailable` |

`semanticSearch.status` values:
- `"ready-vec"` — native sqlite-vec extension active (fastest)
- `"ready-js"` — pure JS fallback active (correct but slower at scale)
- `"pending"` — not yet initialized (run `akm index` to set up)
- `"blocked"` — setup failed (see `reason` and `message` fields)
- `"disabled"` — semantic search is turned off in config

Use `akm info` to verify that semantic search is working after setup.

### health

**Status: Available since 0.8.0.**
Check akm runtime health, durable state, and recent improve-loop telemetry.

```sh
akm health
akm health --since 24h
akm health --since 7d --format text
akm health --since 2026-05-01T00:00:00Z
```

| Flag | Description |
| --- | --- |
| `--since` | Rolling window start for task-history, improve, and advisory metrics. Accepts ISO 8601, `YYYY-MM-DD`, epoch milliseconds, or shorthand like `24h` / `7d`. Default: last 24 hours. |

The command reads `state.db`, verifies that the required tables exist, performs a
write-read probe against the events stream, inspects `task_history`, checks the
default agent profile, and summarizes recent `improve_*` events.

Primary result fields:

| Field | Description |
| --- | --- |
| `status` | Overall health verdict: `pass`, `warn`, or `fail` |
| `hardChecks` | Deterministic checks such as `state-db-schema`, `state-db-round-trip`, `task-log-backing`, `active-runs`, and `agent-profile` |
| `advisories` | Non-fatal warnings such as semantic-search runtime status and repeated external session-log failures |
| `metrics` | Aggregate task/runtime metrics: `taskFailRate`, `agentFailureRate`, `stuckActiveRuns`, `logBackingRate`, `probeRoundTripMs` |
| `improve` | Recent improve-loop counts derived from `improve_invoked`, `improve_skipped`, and `improve_completed` events |
| `sessionLogAdvisories` | Repeated session-log topics detected from external agent logs |

The `improve` section includes counts for planned refs, reflect/distill actions,
memory-prune actions, memory-inference writes, graph-extraction refreshes,
dead-URL detections, and skip reasons observed in the selected time window.

### graph

Inspect and export the indexed graph data stored in `index.db`.

```sh
akm graph                            # Alias for `akm graph summary`
akm graph summary
akm graph entities --limit 25
akm graph relations --limit 25
akm graph entity "React Router"
akm graph related knowledge:react-router
akm graph orphans --limit 20
akm graph export --out ./graph.json
akm graph export --out ./graph.jsonl --format jsonl
akm graph update                        # Re-extract all eligible files
akm graph update memory:foo             # Re-extract only this ref
akm graph update memory:foo skill:bar   # Re-extract multiple refs
akm graph update --source my-stash      # Target a specific stash source
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `summary` | Show graph counts and optional quality telemetry (`consideredFiles`, `extractedFiles`, `extractionCoverage`, `density`) |
| `entities` | List deduplicated entities with per-file occurrence counts and best confidence |
| `entity <name>` | Show every asset that contains the given entity, ordered by per-asset confidence. Inverts the `entities` view |
| `relations` | List deduplicated relations with occurrence counts and best confidence |
| `related <ref>` | Show assets related to `<ref>` via shared graph entities (asset neighbors) |
| `orphans` | List assets with zero extracted graph entities — useful for quality triage |
| `export` | Write the graph to disk as `json` or `jsonl` |
| `update [refs...]` | Re-run graph extraction outside the improve loop, optionally scoped to specific refs. Unknown refs emit a warning and are skipped. |

`akm graph related <ref>` returns the closest graph neighbors of an asset:
each hit lists the asset's `type`, label, the `shared` entities, and the
`relationCount` connecting them. The text formatter also appends a `Next:` hint
pointing at the top hit so agents know which ref to load next.

`akm graph entity <name>` lists assets that mention an entity, ordered by
extraction confidence — useful when you have an entity name from
`akm graph entities` and want to inspect every source that surfaced it.

`akm graph orphans` lists assets that produced zero entities during the
extraction pass. These are good candidates for re-extraction, content
improvement, or pruning.

**`akm graph update` [refs...]:** Re-extract graph entities from eligible files.
When refs are provided, only those assets are re-extracted (incremental scoped
pass). When no refs are given, performs a full re-extraction over all eligible
files. Unknown refs (not currently in the index) emit a warning and are skipped
without error. Returns a `graph-update` shaped result with `filesExtracted`,
`entitiesUpserted`, `relationsUpserted`, `durationMs`, and `scoped` (true if
specific refs were targeted).

Common flags:

| Flag | Description |
| --- | --- |
| `--source <name\|path>` | Select which configured source stash to inspect (defaults to primary source) |
| `--limit <n>` | Cap rows returned by `entities`, `entity`, `relations`, `related`, `orphans` |
| `--out <path>` | Required for `export`; output file path |
| `--format json\|jsonl` | Export format for `export` (default `json`) |

If no graph artifact exists yet, run the flow that refreshes graph extraction for your stash.

Graph data is automatically re-extracted on the first `akm improve` cycle after
a `DB_VERSION` upgrade. In v0.8.0 the graph schema was redesigned (entry-id
primary key with FK cascade to `entries(id)`); upgrading from a 0.7.x install
drops the graph tables and repopulates them on next improve. See
[docs/migration/v0.7-to-v0.8.md](migration/v0.7-to-v0.8.md#graph-extraction-will-re-run-after-upgrade).

Search ranking can optionally use graph-derived confidence-weighted boosts.
Tune `search.graphBoost.confidenceMode` and `search.graphBoost.confidenceWeight`
in [`docs/configuration.md#graph-boost-search-tuning`](configuration.md#graph-boost-search-tuning).

### db

Inspect the AKM SQLite data directory.

```sh
akm db backups        # List pre-upgrade snapshots, newest first
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `backups` | List pre-upgrade snapshots written by AKM under `<dataDir>/backups/`. Returns a JSON list with `path`, `name`, `createdAt`, `sizeBytes`, and `sourceVersion` per entry. |

Pre-upgrade snapshots are created automatically whenever the binary detects an
on-disk `DB_VERSION` that differs from its own — that's the same moment the
destructive `handleVersionUpgrade()` codepath drops every table to rebuild. The
snapshot is a recursive `fs.cpSync` of the data directory; restoration is
intentionally manual for the MVP: stop akm, then run
`scripts/migrations/restore-data-dir.sh <backup-dir> <live-data-dir>` to roll
back the data dir wholesale, or use the targeted helper scripts in
`scripts/migrations/` to scavenge specific tables. See
[`docs/configuration.md`](configuration.md) for the `AKM_DB_BACKUP` and
`AKM_DB_BACKUP_RETAIN` environment variables.

### search

Search stash assets, registry stashes, or both.

```sh
akm search "deploy"
akm search "deploy" --type script --limit 10
akm search "lint" --source registry
akm search "docker" --source both --detail full

# Multi-tenant scope filtering (0.7.0+):
akm search "deploy" --filter user=alice
akm search "deploy" --filter user=alice --filter agent=claude

# Include proposal-queue entries (v1 spec §4.2):
akm search "deploy" --include-proposed
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `memory`, `script`, `env`, `secret`, `wiki`, `lesson`, `any` | `any` | Filter by asset type |
| `--limit` | number | `20` | Maximum results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search (`local` is an alias for `stash`) |
| `--filter` | `<key>=<value>` | _(none)_ | Scope filter — repeatable. Valid keys: `user`, `agent`, `run`, `channel`. Example: `--filter user=alice --filter channel=ops`. Narrows the result set; ranking is unchanged. |
| `--include-proposed` | flag | `false` | Include entries with `quality: "proposed"` in the result set. Default search excludes them; `generated` and `curated` quality entries are always included. Unknown quality values warn once and remain searchable. |
| `--format` | `json`, `text`, `yaml`, `jsonl` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output verbosity level |
| `--shape` | `human`, `agent`, `summary` | `human` | Output projection. For `search`, `summary` currently behaves the same as the default `brief` envelope; per-hit content shaping is reserved for a future minor release. |

`--filter` flags AND-join: every supplied key must match the entry's
`scope` for the entry to appear in the result set. Entries without any scope
are excluded as soon as a filter is supplied. With no `--filter` (the
default), unfiltered queries continue to surface all entries — including
legacy memories that pre-date the scope contract.

The `ref` handle for `akm show` is **only present at `full` detail and under
`--shape=agent`** for local stash hits; `brief` and `normal` omit it
intentionally to keep the payload compact. Use `--shape=agent` to get `ref`
without the full hit payload. Key fields by availability:

- **`ref`** -- The asset handle to pass to `akm show` (e.g. `script:deploy.sh`);
  present at `full` and `agent` only (for local hits)
- **`name`** -- The asset's filename or identifier; present at all levels
- **`origin`** -- The source stash (e.g. `npm:@scope/pkg`), present only for
  managed source assets; surfaced at `full` only
- **`id`** -- Registry-level stash identifier (registry hits only)

The default brief shape is intentionally small. The exact field set per
detail level (and per `--shape`) is authoritative in `src/output/shapes.ts`
(`shapeSearchHit` / `shapeSearchHitForAgent`):

| Level | Local stash hits | Registry hits |
| --- | --- | --- |
| `brief` (default) | `type`, `name`, `action`, `estimatedTokens` | `name`, `installRef`, `score` |
| `normal` | adds `description`, `score`, optional `warnings`, optional `quality` | adds `description`, `action`, `installRef`, `score`, and optional `warnings` |
| `full` | full hit object (includes `ref`, `origin`, `tags`, `whyMatched`, optional `warnings`, optional `quality`, timings, stash metadata) | full hit object |
| `--shape summary` | currently identical to `brief`; per-hit content shaping is reserved for a future minor release | — |
| `--shape agent` (was `--detail agent` / `--for-agent`) | `name`, `ref`, `type`, `description`, `action`, `score`, `estimatedTokens` | — |

The legacy registry boolean `curated` is removed in v1 (spec §4.2). Renderers
surface an optional `warnings: string[]` field on hits when a provider has
non-fatal issues to report; the field is omitted otherwise. Per spec §4.2,
populating `warnings` does not affect ranking.

> **Score ranges differ between local and registry hits.** Local
> `SearchHit.score` is the locked v1 contract value in `[0, 1]`, higher = better
> (CLAUDE.md and v1-architecture-spec §4). Registry `RegistrySearchHit.score`
> is registry-native: provider-defined and may exceed `1` (the bundled
> `static-index` provider can emit values up to ~1.85 from `scoreStash()`).
> Use registry scores only for ranking within a single registry — do **not**
> compare them numerically against local `SearchHit.score` values or across
> registries with different scoring formulas. See
> `docs/technical/v1-architecture-spec.md` §4 for the type-level distinction.

### curate

Curate the best matching assets for a task or prompt by combining search with a
compact, follow-up-friendly summary.

```sh
akm curate "plan a release"
akm curate "deploy a Bun app" --limit 3
akm curate "review an architecture proposal" --type skill
akm curate "learn the release workflow" --source both --format text
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `memory`, `script`, `env`, `secret`, `wiki`, `lesson`, `any` | `any` | Filter curated results by asset type |
| `--limit` | number | `4` | Maximum curated results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search before curating |

`akm curate` selects high-signal results, prefers one strong match per asset
type by default, and includes direct follow-up commands such as `akm show <ref>`
or `akm add <stash>` so you can immediately inspect or install what it found.
Use `--type workflow` when you want curated step-by-step procedures instead of
individual scripts, skills, or docs.

### show

Display an asset by ref. Knowledge assets support view modes as positional
arguments after the ref.

```sh
akm show script:deploy.sh
akm show skill:code-review
akm show agent:architect
akm show command:release
akm show workflow:ship-release
akm show knowledge:guide toc
akm show knowledge:guide section "Authentication"
akm show knowledge:guide lines 10 30
akm show knowledge:guide frontmatter

# Multi-tenant scope filtering (0.7.0+):
akm show memory:retro --scope user=alice
akm show memory:retro --scope user=alice --scope agent=claude
```

`--scope` accepts the same `<key>=<value>` shape as `akm search --filter`
(repeatable; valid keys: `user`, `agent`, `run`, `channel`). When supplied,
the resolved asset's frontmatter `scope_*` keys must match every supplied
filter. A mismatch (or absent scope) returns `NotFoundError` so the caller
cannot accidentally read out-of-scope content.

The default `show` JSON includes the asset body when applicable. Use
`--detail brief` for a reduced metadata-first view without
`content`/`template`/`prompt`; `--detail full` adds verbose metadata such as
`schemaVersion`, `path`, `editable`, and `editHint`; `--detail summary`
returns a compact view with only `type`, `name`, `description`, `tags`,
`parameters`, `workflowTitle`, `action`, `run`, `origin`, `keys`, and
`comments`.

Returns type-specific payloads:

| Type | Key fields |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` with view modes: `full`, `toc`, `frontmatter`, `section`, `lines` |
| workflow | `workflowTitle`, `workflowParameters`, `steps` |
| memory | `content` |
| env | `keys`, `comments` (vault: deprecated alias) |
| lesson | `content` plus `when_to_use` surfaced from frontmatter |

Assets from non-writable sources (git clones, npm packages, websites) return
`editable: false`. `akm show` queries the local FTS5 index directly — there
is no remote-provider fallback. If the ref points to a package origin that
is not installed, `akm show` returns guidance to run `akm add <origin>` first.

`akm show wiki:<name>` returns the same summary as `akm wiki show <name>` —
path, description from `schema.md`, page and raw counts, and the last 3
`log.md` entries.

### workflow

Author, inspect, and execute structured workflow assets.

```sh
akm workflow template
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow validate workflow:ship-release    # Validate a workflow ref
akm workflow validate ./workflows/release.md   # Validate a workflow file
akm workflow start workflow:ship-release --params '{"version":"1.2.3"}'
akm workflow next workflow:ship-release
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'
akm workflow complete <run-id> --step validate --state completed --notes "Inputs verified"
akm workflow status <run-id>
akm workflow status workflow:ship-release
akm workflow resume <run-id>
akm workflow list --active
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `template` | Print a valid starter workflow markdown document |
| `create <name>` | Validate and write a workflow under `workflows/<name>.md` |
| `validate <ref\|path>` | Validate a workflow markdown file or ref and print any errors |
| `start <ref>` | Create a new persisted workflow run |
| `next <run-id\|ref>` | Return the current actionable step; resumes active runs and starts a new run when the ref has no active run |
| `complete <run-id> --step <step-id>` | Update the current pending step on an active run and persist status, notes, and evidence |
| `status <run-id\|ref>` | Show the full run state, including all step statuses |
| `list` | List workflow runs (optionally filtered by `--ref` and `--active`) |
| `resume <run-id>` | Flip a `blocked` or `failed` run back to `active`. Completed runs cannot be resumed |

Workflow runs are scoped to the current working context, not globally across all
repos or directories. akm resolves that context from the nearest `.akm/config.json`
ancestor when present, otherwise the nearest git root, otherwise the stash root
when the cwd is inside it, otherwise the cwd itself. In practice this means:

- `workflow next workflow:<name>` resumes the active run for the current project/worktree/directory only.
- `workflow status workflow:<name>` resolves the most-recently-updated run in the current scope only.
- `workflow list` shows runs for the current scope only.
- Direct run-id commands like `workflow status <run-id>` still work even if the run was started from another directory.

#### workflow create

```sh
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow create ship-release --from ./ship-release.md --force
akm workflow create ship-release --force --reset
```

`--force` requires either `--from <file>` (replace from a source file) or
`--reset` (explicitly acknowledge you are overwriting in place). Without one of
these, `--force` is rejected to prevent silent template overwrites.

Workflow names must match `^[a-z0-9][a-z0-9._/-]*$` — lowercase letters and
digits, hyphens, dots, underscores, and forward slashes allowed; must start
with a lowercase letter or digit. Forward slashes are supported for
hierarchical names (e.g. `release/ship`).

#### workflow next

```sh
akm workflow next workflow:ship-release
akm workflow next <run-id>
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'
```

When multiple active runs exist for the same workflow ref in the current scope,
`next` selects the **most-recently-updated** run.

When no active run exists, `next` auto-starts a new run for the workflow ref.
Pass `--params` to supply parameters for the auto-started run. If an active run
already exists, `--params` is rejected with a usage error.

Response shape:

| Field | When present |
| --- | --- |
| `step` | The current actionable step object, or `null` when the run is complete |
| `done` | `true` when the resolved run is already complete |
| `autoStarted` | `true` when `next` auto-started a new run (no active run existed) |
| `run` | The run object |

When `done: true` is present, `step` is `null` and no further action is needed
for this run. Start a new run with `akm workflow start` if required.

**Snapshot isolation:** workflow runs snapshot their step list when started.
Edits to the source workflow file after a run has started do not affect
in-flight runs. The run always follows the steps that were defined at start
time.

#### workflow complete

```sh
akm workflow complete <run-id> --step <step-id>
akm workflow complete <run-id> --step <step-id> --state completed --notes "Done"
akm workflow complete <run-id> --step <step-id> --state skipped
```

`--state` defaults to `completed` when omitted. Accepted values: `completed`,
`blocked`, `failed`, `skipped`.

#### workflow status

```sh
akm workflow status <run-id>
akm workflow status workflow:ship-release
```

Accepts either a run-id or a workflow ref. When given a workflow ref, resolves
to the most-recently-updated run for that ref in the current working scope.

#### workflow resume

```sh
akm workflow resume <run-id>
```

Flips a `blocked` or `failed` run back to `active`. Completed runs cannot be
resumed. Use `workflow list` to find runs by status.

Workflow markdown contract:

- Optional frontmatter only supports `description`, `tags`, and `params`.
- `tags` may be a string or an array of non-empty strings.
- `params` must be a mapping of parameter names to non-empty string descriptions.
- The document must contain exactly one `# Workflow: <title>` heading.
- Each step must be a `## Step: <title>` section.
- Each step must include exactly one `Step ID: <id>` line. IDs must start with a letter or number and then use only letters, numbers, `.`, `_`, or `-`.
- Each step must include exactly one `### Instructions` section with non-empty text.
- `### Completion Criteria` is optional, but when present it must contain at least one non-empty item. Each non-empty line is treated as one criterion, with an optional leading `-` or `*` removed.
- No other frontmatter keys, top-level headings, or step subsections are accepted.

### How `add` works

`akm add` infers what to do from the input:

| Input | What happens |
| --- | --- |
| `akm add ~/.claude/skills` | Registers a local directory as a `filesystem` source |
| `akm add github:owner/repo` | Clones the repo into akm's cache as a `git` source |
| `akm add @scope/stash` | Installs the npm package as a `git`/`npm` source |
| `akm add https://docs.example.com` | Crawls and caches a website as a `website` source |
| `akm registry add <url>` | Adds a discovery registry (separate concept) |

HTTP(S) URLs pointing to known git hosts (GitHub, GitLab, Bitbucket, Codeberg,
SourceHut) or ending in `.git` are treated as git sources. All other HTTP(S)
URLs are treated as website sources.

### add

Add a source — a local directory, npm package, GitHub repo, git URL, or website.

```sh
akm add ~/.claude/skills              # Local directory
akm add @scope/stash                    # npm package
akm add npm:@scope/stash@latest         # npm with version
akm add github:owner/repo#v1.2.3     # GitHub with tag
akm add https://github.com/owner/repo
akm add git+https://gitlab.com/org/stash
akm add ./path/to/local/stash
akm add github:andrewyng/context-hub --name context-hub  # context-hub as a git stash
akm add https://docs.example.com --name docs              # Website
akm add https://docs.example.com --max-pages 100 --max-depth 5
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly name for the source |
| `--provider` | Provider type (e.g. `website`, `npm`). Required for URL sources where inference would be ambiguous |
| `--writable` | Mark a git source as writable so `akm sync` also pushes (default: false) |
| `--options` | Provider options as JSON (e.g. `'{"ref":"main"}'`) |
| `--type` | Override asset type for all files in this source (currently supports: `wiki`) |
| `--allow-insecure` | Bypass plain-HTTP source rejection **and** dangerous env key blocking. Accepts two risks: (1) plain-HTTP download without TLS, (2) env keys that can hijack process execution. Use only after reviewing the stash manually |
| `--max-pages` | Maximum pages to crawl for website sources (default: 50) |
| `--max-depth` | Maximum crawl depth for website sources (default: 3) |

#### Dangerous env key audit

When `akm add` installs a stash that contains env files (`env/`, or legacy
`vaults/`), it scans every file for environment variable names that can be used
for process-execution hijacking. The flagged key names are: `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_DEBUG`, `DYLD_INSERT_LIBRARIES`,
`DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `PATH`, `BASH_ENV`, `ENV`,
`PROMPT_COMMAND`, `PS1`, `PS2`, `NODE_OPTIONS`, `NODE_PATH`,
`PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONINSPECT`, `RUBYLIB`, `RUBYOPT`,
`PERL5LIB`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, and
`_JAVA_OPTIONS` (23 keys total).

When dangerous keys are found, `akm add` pauses and prompts for
confirmation (default: No). In non-interactive mode (CI, scripts) the
install fails with exit 2 unless `--allow-insecure` is passed.

```sh
# Interactive: prompts before continuing
akm add github:owner/repo-with-sensitive-env

# Non-interactive: fails unless bypassed
akm add github:owner/repo-with-sensitive-env --allow-insecure
```

Stash publishers: see the [Stash Maker's Guide](stash-makers.md#vault-security)
for guidance on env files that legitimately need these keys.

#### Website sources

When the input is an HTTP(S) URL that isn't a known git host, akm treats it as
a website source. It crawls the site breadth-first from the given URL, converts
each page to markdown, and stores the results as knowledge assets with the URL
path hierarchy preserved.

```sh
akm add https://www.agentic-patterns.com/ --name agent-patterns
akm add https://docs.example.com/guide --name guide --max-pages 200
```

Pages are cached locally and refreshed every 12 hours. The crawl stays within
the same origin (hostname) and skips static assets (images, CSS, JS, etc.).

Use `--max-pages` and `--max-depth` to control how many pages are fetched and
how many link levels deep the crawler goes. These values are persisted in your
config so subsequent re-indexes use the same limits.

See [registry.md](registry.md) for the full install flow for managed sources.

> **0.6.0 note:** the pre-0.6.0 `akm add context-hub` convenience alias and
> the `akm enable context-hub` / `akm disable context-hub` commands were
> removed. Add it explicitly as a git stash:
> `akm add github:andrewyng/context-hub --name context-hub`. The legacy
> stash *type* string `"context-hub"` in existing configs still normalizes
> to `"git"` at load time, so you don't need to edit your config files.

### list

Show all sources — local directories, managed packages, and remote providers.

```sh
akm list                            # All sources
akm list --kind local               # Only local directories
akm list --kind managed             # Only managed packages
akm list --kind remote              # Only remote providers
akm list --kind local,remote        # Multiple kinds
```

| Flag | Description |
| --- | --- |
| `--kind` | Filter by source kind: `local`, `managed`, `remote` (comma-separated) |

### remove

Remove a source by id, ref, path, URL, or name and reindex.

```sh
akm remove npm:@scope/stash           # Managed source by id
akm remove owner/repo               # Managed source by ref
akm remove ~/.claude/skills         # Local source by path
akm remove my-provider              # Any source by name
```

### update

Update one or all managed sources to the latest available version. Local and
remote sources are not updatable — akm explains why if you target one.

```sh
akm update npm:@scope/stash
akm update --all
akm update --all --force   # Force fresh download even if version is unchanged
```

| Flag | Description |
| --- | --- |
| `--all` | Update all managed sources |
| `--force` | Delete cached extraction before re-downloading |

Reports per-entry change flags: `changed.version`, `changed.revision`,
`changed.any`.

### upgrade

Upgrade `akm` itself to the latest release. This is for users who installed
`akm` as a standalone binary. For npm installs, it prints guidance instead.

```sh
akm upgrade              # Download and replace the running binary
akm upgrade --check      # Check for updates without installing
akm upgrade --force      # Force upgrade even if already on latest
```

| Flag | Description |
| --- | --- |
| `--check` | Check for updates without installing |
| `--force` | Force upgrade even if on latest version |
| `--skip-checksum` | Skip checksum verification during upgrade (not recommended) |

### clone

Copy an asset from any source into the working stash (or a custom
destination) for editing.

```sh
akm clone script:deploy.sh
akm clone "npm:@scope/pkg//script:deploy.sh"
akm clone script:deploy.sh --name my-deploy.sh
akm clone script:deploy.sh --force
akm clone script:deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//script:deploy.sh" --dest /tmp/preview
```

| Flag | Description |
| --- | --- |
| `--name` | New name for the cloned asset |
| `--force` | Overwrite if the asset already exists at the destination |
| `--dest` | Destination directory (default: working stash). The type subdirectory (`scripts/`, `skills/`, etc.) is appended automatically |

Skills (directories) are copied recursively. Other types copy a single file.

**Remote clone:** When the origin in the ref points to a package that is not
installed locally (e.g. an npm package or local path not in your stash
sources), akm fetches it to the cache automatically and extracts the
requested asset. The package is **not** registered as a managed source --
use `akm add` for that.

```sh
# Clone a single script from a remote package without installing the full stash
akm clone "npm:@scope/pkg//script:deploy.sh"

# Clone from a local directory that isn't configured as a search path
akm clone "/path/to/stash//skill:code-review" --dest ./project/.claude
```

When `--dest` is provided, the working stash (`AKM_STASH_DIR`) is not
required. This makes clone usable in CI or fresh environments without
running `akm setup` first.

### sync

Stage and commit local changes in a git-backed stash. If the stash has a
remote configured and is marked `writable: true`, the commit is also pushed.

> **Renamed in 0.8.0.** `akm save` is the deprecated spelling — it still works
> and delegates to `akm sync`, but prints a stderr deprecation warning and is
> removed in 0.9.0. `sync` connotes the commit+push behaviour better than
> `save`.

```sh
akm sync                            # Sync primary stash (auto timestamp message)
akm sync -m "Add deploy skill"     # Sync with custom message
akm sync --no-push                  # Commit only; never push even when writable
akm sync --format json             # Explicit format (both --format json and --format=json work)
akm sync my-skills                  # Sync a named writable git stash
akm sync team/core -m "Update"    # Slash-containing source names are valid selectors
akm sync my-skills -m "Update"     # Sync named stash with message
```

| Argument / Flag | Description |
| --- | --- |
| `[name]` | Optional git-backed stash selector. Matches the configured source name exactly and also accepts canonical GitHub aliases such as `owner/repo`, `github:owner/repo`, and branch-ref forms like `github:owner/repo#branch`. Forward slashes are allowed. Defaults to the primary stash |
| `-m`, `--message` | Commit message. Defaults to `akm save <timestamp>` |
| `--no-push` | Commit only; never push even when the stash is writable with a remote configured |
| `--format` | Output format (`json`, `text`, `yaml`). Both `--format json` and `--format=json` are accepted |

If no positional selector is provided, `akm sync --format json` still targets
the primary stash. If a positional selector is provided, it wins even when the
value also looks like a format token.

**Behaviour by repo state:**

| State | Result |
| --- | --- |
| Not a git repo | Exit 0, `skipped: true` in JSON output — no error |
| Git repo, no remote | Stage and commit only |
| Git repo, has remote, not writable | Stage and commit only |
| Git repo, has remote, `writable: true` | Stage, commit, and push |
| Any writable repo with `--no-push` | Stage and commit only (push suppressed) |

**Primary stash writable config:**

To make the primary stash push on sync, set `writable: true` at the root of
your config file (`~/.config/akm/config.json` or the path shown by
`akm config path`):

```json
{
  "stashDir": "~/akm",
  "writable": true
}
```

When `writable: true` is set and the primary stash has a git remote configured,
`akm sync` will stage, commit, and push.

When `akm setup` successfully initializes the default stash as a local git repo
(requires `git` to be installed), `akm sync` will commit there safely without
pushing. If git is unavailable, the stash will not be a git repo and sync will
return a skipped result.

To make a named remote git stash writable, pass `--writable` when adding it:

```sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

### remember

Record a memory. This writes a markdown file into `memories/` in the configured
write target and returns the resulting ref.

**Write target resolution:** the destination is the working stash (`stashDir`)
unless `defaultWriteTarget` is set in config, which overrides it to a named
source. An explicit `--target <name>` flag overrides both. The full order is
`--target` → `defaultWriteTarget` → `stashDir` → `ConfigError`. See
[Configuration](configuration.md#defaultwritetarget) for details.

```sh
akm remember "Deployment needs VPN access"
akm remember --name release-retro < notes.md
akm remember "Pair with ops before rotating prod secrets" --name ops/prod-secrets

# With structured frontmatter (0.6.0+):
akm remember "VPN required for staging deploys" \
  --tag ops --tag networking \
  --expires 90d \
  --source "skill:deploy"

# Opt-in heuristic tagging — derives `code`, `source`, `observed_at`, `subjective`:
akm remember "Found this snippet: \`curl -fsSL ... | bash\`" --tag ops --auto

# Opt-in LLM enrichment (requires configured LLM endpoint; fails soft):
akm remember "Long meeting notes..." --enrich

# Multi-tenant / multi-agent scope (0.7.0+):
akm remember "Use staging cluster for blue-green" \
  --user alice --agent claude --run run-42 --channel "#ops"

# Route the write to a specific writable stash (0.8.0+):
akm remember "Deployment needs VPN access" --target team-stash

# Save into a wiki directory instead of memories/ (0.8.0+):
akm remember "Deployment needs VPN access" --wiki architecture
```

| Flag | Description |
| --- | --- |
| `--name` | Optional memory name. Defaults to a slug derived from the content |
| `--force` | Overwrite an existing memory with the same name |
| `--description <text>` | Short description written to frontmatter (persisted as the memory's `description` field). Honoured by both the zero-flag form and the tagged form. |
| `--tag <v>` | Tag to attach to the memory. Repeatable: `--tag foo --tag bar` |
| `--expires <dur>` | Expiry shorthand (`30d`, `12h`, `6m`). Resolved to an ISO date |
| `--source <s>` | Free-form source reference — URL, asset ref, file path, or any string |
| `--auto` | Apply heuristic tagging from the body (opt-in, zero-latency, pure TS) |
| `--enrich` | Call the configured LLM for tag/description proposals (opt-in, 10s timeout, fails soft) |
| `--user <id>` | Scope this memory to a user id. Persisted as the canonical `scope_user` frontmatter key. |
| `--agent <id>` | Scope this memory to an agent id. Persisted as `scope_agent`. |
| `--run <id>` | Scope this memory to a run id. Persisted as `scope_run`. |
| `--channel <name>` | Scope this memory to a channel name. Persisted as `scope_channel`. |
| `--target <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working stash. |
| `--wiki <name>` | Save the content into the named wiki directory (`wikis/<name>/`) instead of `memories/`. The wiki must already exist (created with `akm wiki create`). |

Pass the content as a quoted positional argument for short notes, or pipe
markdown into stdin for longer memories.

**Zero-flag form** (`akm remember "body"`) writes a bare memory with no
frontmatter — existing agent scripts keep working unchanged. `--tag` /
`--expires` / `--source` still trigger the required-field check: if `tags`
cannot be derived, the command rejects *before* writing the file, so you
never end up with an orphan. `--auto` and `--enrich` are fail-soft metadata
helpers: if they derive nothing, the memory still writes successfully.

**Scope flags** (`--user`, `--agent`, `--run`, `--channel`) are independent
of the tag-required check. They write the four canonical top-level
frontmatter keys (`scope_user`, `scope_agent`, `scope_run`, `scope_channel`)
and a memory with only scope flags is valid (no tags required). Scope is the
multi-tenant / multi-agent contract; the same shape is read back by
`akm search --filter` and `akm show --scope`. See
[Configuration → Memory scope](configuration.md#memory-scope) for the
frontmatter schema and round-trip rules.

### import

Import a knowledge document. This writes a markdown file into `knowledge/` in
the configured write target and returns the resulting ref. The source may be a
file path, a single HTTP/HTTPS URL, or `-` for stdin.

**Write target resolution:** the destination is the working stash (`stashDir`)
unless `defaultWriteTarget` is set in config, which overrides it to a named
source. An explicit `--target <name>` flag overrides both. The full order is
`--target` → `defaultWriteTarget` → `stashDir` → `ConfigError`. See
[Configuration](configuration.md#defaultwritetarget) for details.

```sh
akm import ./docs/auth-flow.md
akm import ./notes/release.txt --name release-checklist
akm import - --name scratch-notes < notes.md
akm import https://example.com/docs/auth

# Route the write to a specific writable stash (0.8.0+):
akm import ./docs/auth-flow.md --target team-stash

# Save into a wiki directory instead of knowledge/ (0.8.0+):
akm import ./docs/auth-flow.md --wiki architecture
akm import https://example.com/docs/auth --wiki research
```

| Flag | Description |
| --- | --- |
| `--name` | Optional knowledge name. Defaults to the source filename, URL path, or a slug from stdin content |
| `--force` | Overwrite an existing knowledge document with the same name |
| `--target <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working stash. |
| `--wiki <name>` | Save the content into the named wiki directory (`wikis/<name>/raw/`) instead of `knowledge/`. The wiki must already exist (created with `akm wiki create`). |

URL imports fetch only the exact page you pass, convert it to markdown, and do
not register a persistent website source. The default knowledge name comes from
the URL path (for example, `/docs/auth` -> `knowledge/docs/auth.md`).

The source must be a readable file path, a reachable HTTP/HTTPS URL, or `-` to
read the document from stdin.

### feedback

Record positive or negative feedback for any indexed stash asset. Feedback
influences utility scores during the next index run, causing highly-rated
assets to rank higher in search results over time.

```sh
akm feedback script:deploy.sh --positive
akm feedback agent:reviewer --negative
akm feedback memory:deployment-notes --positive
akm feedback vault:prod --positive
akm feedback skill:code-review --positive --note "Worked perfectly for PR reviews"
```

| Flag | Description |
| --- | --- |
| `--positive` | Record positive feedback (use when an asset was helpful) |
| `--negative` | Record negative feedback (use when an asset was not useful) |
| `--note` | Optional text note to attach to the feedback event |
| `--applied-to <ref>` | Credit a `lesson:<name>` that helped resolve this task. When combined with `--positive`, appends this feedback ref to the target lesson's `lessonStrength[]` frontmatter array (dedup, idempotent). Silently ignored on non-lesson targets. |

Specify exactly one of `--positive` or `--negative`. The ref must already be
present in the current local index.

The `--applied-to` flag drives the lesson-strength ranking signal: lessons that
have demonstrably helped resolve tasks receive a small additive ranking boost
(capped at +0.3) so they float to the top of search. Pair with `akm lessons
coverage` to find tags that don't yet have a crystallized lesson.

### lessons

**Status: Available since 0.8.0.**
Lesson-asset tooling. Currently exposes a single subcommand for tag-coverage
analysis.

#### lessons coverage

```sh
akm lessons coverage
akm lessons coverage --format text
```

Reports tags that exist on indexed assets but are NOT yet covered by any
lesson. Useful for spotting topics where the stash has skills/commands/scripts
but no crystallized lesson — a signal that the team has tacit knowledge worth
distilling.

Default output is JSON:

```json
{
  "ok": true,
  "uncoveredTags": ["auth", "networking", "observability"],
  "lessonTagCount": 12,
  "totalTagCount": 47
}
```

### history

Surface per-asset state changes recorded in the local `usage_events` log
(searches, shows, feedback, and any other mutations the indexer has captured).
Use it for audit trails, lifecycle inspection, and debugging utility-score
shifts without re-deriving an audit log from raw SQL.

`history` is the *per-asset state-change* view. It complements the realtime
events stream proposed in [#204](https://github.com/itlackey/akm/issues/204):
events emit at the moment a mutation happens; `history` is the durable replay
of what was recorded for an asset (or for the whole stash).

```sh
akm history                                    # Stash-wide, oldest first
akm history --ref skill:deploy                 # Filter to one asset ref
akm history --since 2026-04-01T00:00:00Z       # Filter by ISO timestamp
akm history --since 1717200000000              # Filter by epoch ms
akm history --ref skill:deploy --format jsonl  # One entry per line
akm history --format text                      # Human-readable trail
```

| Flag | Description |
| --- | --- |
| `--ref` | Filter to a single asset ref (`[origin//]type:name`). Omit for stash-wide history. |
| `--since` | Lower bound on `createdAt`. Accepts ISO 8601, `YYYY-MM-DD`, or epoch milliseconds. |
| `--generator` | Filter by event generator: `user` (default) or `improve` (`akm improve` operations). `--source` is a deprecated alias (removed 0.9.0). |
| `--format` | Standard global flag. `text` renders a chronological trail; `json`/`jsonl`/`yaml` emit the envelope. |

Output envelope (JSON):

```json
{
  "schemaVersion": 1,
  "ref": "skill:deploy",
  "since": "2026-04-01 00:00:00",
  "totalCount": 3,
  "entries": [
    {
      "id": 17,
      "eventType": "feedback",
      "ref": "skill:deploy",
      "entryId": 42,
      "query": null,
      "signal": "positive",
      "metadata": null,
      "createdAt": "2026-04-12 14:03:21"
    }
  ],
  "warnings": []
}
```

`schemaVersion` is always `1` for this release. `ref` and `since` are echoed
back only when the corresponding flags were supplied. `totalCount` matches
`entries.length` (no server-side pagination yet). `warnings` is omitted when
empty. Entries are returned in chronological order (oldest first).

If the stash has never been indexed, the `usage_events` schema is created
on demand and the command returns an empty `entries` array rather than
erroring.

### events (alias: `log`)

Append-only realtime events stream (#204). Every mutating CLI verb appends
an event row to `<dataDir>/state.db`; `akm events list` reads it and
`akm events tail` follows it via polling.

> **Alias:** `akm log` resolves to this same command in 0.8 (`akm log list`,
> `akm log tail`). In 0.9.0 `log` becomes the primary spelling and `events`
> becomes the deprecated alias.

```sh
akm events list                                   # All events, oldest first
akm log list                                      # Same — `log` is an alias for `events`
akm events list --type feedback                   # Filter by event type
akm events list --ref skill:deploy                # Filter by asset ref
akm events list --since 2026-04-01T00:00:00Z      # ISO timestamp
akm events list --since '@offset:12345'           # Resume from a row-id cursor
akm events tail --max-events 10                   # Follow until 10 events
akm events tail --format jsonl                    # Stream as JSONL
```

**`history` vs `events`/`log` — which one do I want?**

| | `akm history` | `akm events` / `akm log` |
| --- | --- | --- |
| Scope | Per-asset (or stash-wide) state changes | Raw stash-wide mutation stream |
| Backing store | `usage_events` table (built by the indexer) | `state.db` append-only events |
| Granularity | Analytical replay — what was *recorded* for an asset | Every mutating verb, at the moment it happens |
| Cross-source | Yes — aggregates across configured sources | No — the local `state.db` only |
| Resumable cursor | No | Yes (`--since '@offset:<id>'`) |
| Typical use | Audit a specific asset; debug utility-score shifts | Tail the live mutation bus; drive cooperating processes |

In short: reach for `history` when you care about *an asset's lifecycle*, and
for `events`/`log` when you care about *the raw, resumable mutation stream*.

| Flag | Description |
| --- | --- |
| `--since` | Lower bound. Accepts ISO 8601, epoch ms, or `@offset:<id>` for a durable row-id cursor that survives across processes. |
| `--type` | Filter by event type. Common values include `add`, `remove`, `update`, `remember`, `import`, `save`, `feedback`, `promoted`, `rejected`, `propose_invoked`, `reflect_invoked`, `distill_invoked`, `select`, and `improve_skipped`. |
| `--ref` | Filter by asset ref (`[origin//]type:name`). |
| `--interval-ms` | (`tail` only) Polling interval. Default `75`. |
| `--max-events` | (`tail` only) Stop after this many events. |
| `--max-duration-ms` | (`tail` only) Stop after this many ms. |

The list/tail envelope echoes a `nextOffset` row-id cursor — persist it and
pass it back as `--since '@offset:<nextOffset>'` to resume from exactly
where you stopped, with no duplicates and no losses, even across process
boundaries.

Streaming output (`--format jsonl` / `--format text`) emits each event as
a single line on stdout, then a trailer:

- `--format jsonl` ends with a final discriminated row on stdout:
  `{"_kind":"trailer","schemaVersion":1,"nextOffset":<id>,"totalCount":<n>,"reason":"signal|maxEvents|maxDuration"}`.
- `--format text` writes the trailer to stderr to keep stdout pristine for
  line-oriented parsers: `[events-tail] reason=<r> nextOffset=<n> total=<t>`.

#### Environment isolation

The events stream lives in `<dataDir>/state.db`, where `<dataDir>` is derived
from `XDG_DATA_HOME` (or `AKM_DATA_DIR`) at the time of each call. Two
processes with different inherited data-dir env values write to different
databases; if the events stream is being used as a shared bus between
cooperating processes, set those env vars consistently across them.

### registry

Manage stash registries. The `registry` command has four subcommands:

#### registry list

List all configured registries and their status.

```sh
akm registry list
```

#### registry add

Add a third-party registry by URL.

```sh
akm registry add https://example.com/registry/index.json
akm registry add https://example.com/registry/index.json --name my-team
akm registry add https://skills.sh --name skills.sh --provider skills-sh
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly label for the registry |
| `--provider` | Provider type (e.g. `static-index`, `skills-sh`). Default: `static-index` |
| `--options` | Provider-specific options as JSON (e.g. `'{"apiKey":"key"}'`) |
| `--allow-insecure` | Allow a plain HTTP registry URL (rejected by default) |

Duplicate URLs are rejected.

#### registry remove

Remove a registry by URL or name.

```sh
akm registry remove https://example.com/registry/index.json
akm registry remove my-team
```

#### registry build-index

Generate a v3 registry index from npm/GitHub discovery and manual entries.

```sh
akm registry build-index
akm registry build-index --out dist/index.json
```

| Flag | Description |
| --- | --- |
| `--out` | Output path for the generated index (default: `./index.json`) |
| `--manual` | Path to a JSON file with manual stash entries |
| `--npm-registry` | Override npm registry base URL |
| `--github-api` | Override GitHub API base URL |

#### registry search

Search all enabled registries for stashes.

```sh
akm registry search "deploy"
akm registry search "code review" --assets
akm registry search "docker" --limit 5
```

| Flag | Description |
| --- | --- |
| `--limit` | Maximum number of results |
| `--assets` | Include asset-level results from v3 registry indexes |

### config

Read and write configuration.

```sh
akm config                          # Show current config
akm config list                     # List current config
akm config get output.format        # Read one key
akm config set output.detail full   # Set one key
akm config unset llm                # Remove an optional key
akm config path                     # Print path to config file
akm config path --all               # Print all config-related paths
```

See [configuration.md](configuration.md) for details.

### help

Print focused help topics. Currently the only subcommand is `migrate`, which
prints release notes and migration guidance for a specific version so you can
review what changed — and what to do about it — without leaving the terminal.

```sh
akm help migrate 0.6.0         # Notes for a specific release
akm help migrate v0.6.0        # v-prefix accepted
akm help migrate v0.6.0-rc1    # Prereleases normalize to the stable note
akm help migrate latest        # Resolve against the most recent CHANGELOG entry
```

Migration notes live as one markdown file per release in
[`docs/migration/release-notes/`](migration/release-notes/). Adding notes for a
future version is a one-file drop — no code edit required. Requesting an
unknown version prints the list of bundled notes so you can pick one that
exists. See [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md#shipping-a-release--migration-notes)
for the per-release workflow.

### hints

Print agent-facing instructions for using `akm`. Add this output to your
`AGENTS.md`, `CLAUDE.md`, or system prompt so your agent knows how to use
the CLI.

```sh
akm hints
```

### env vs secret — which do I use?

Both protect their values identically (values never reach akm's stdout, the
index, or `akm show`). They differ in **purpose**, not in how well they hide
data:

| | `env` | `secret` |
| --- | --- | --- |
| **Purpose** | **configuration** — a group of related settings for an app/service | **authentication** — one sensitive value used on its own |
| **Holds** | a `.env` file of **many** `KEY=value` pairs (URLs, flags, and any credentials it needs) | **one** value per file (an API token, PEM key, cert, service-account JSON) |
| **Sensitivity** | values may or may not be sensitive — **all are protected anyway** | the value is always a credential |
| **Injects** | many env vars at once (`env run`) | one env var (`secret run <ref> <VAR>`) |
| **Discoverable** | key *names* (not values) | name only (the whole file is the value) |

**`env` is primarily for configuration — a group of related values you load
together, protected whether or not any are sensitive. `secret` is primarily for
a single sensitive value used for authentication.** Reach for `env` to load a
service's config; reach for `secret` when one value *is* an auth credential.

### env

Manage `.env`-backed **environment files** — a group of related **configuration**
for an app or service (URLs, feature flags, and any credentials it needs),
loaded together. Each `env` asset is an entire `.env` file stored under `env/`
in your stash (mode 0600). Values may or may not be sensitive; **akm protects
them all the same** — key *names* and comments are discoverable, values never
appear in structured output. akm does **not** manage individual entries — you
edit the `.env` with your own editor (or ingest one with `--from-file`) and akm
loads it wholesale. `list` and `show` surface key names + comments only; `run`
and `export` are the supported value-use paths.

```sh
akm env list
akm env create prod                          # creates env/prod.env (mode 0600)
akm env create prod --from-file ./.env        # ingest an existing .env
$EDITOR "$(akm env path env:prod --quiet)"    # edit the file directly
akm env run env:prod -- npm test              # run a command with the whole file injected
akm env run env:prod -- $SHELL                # interactive shell with the env loaded
akm env run env:prod --only DATABASE_URL -- ./migrate   # inject just one var
akm env remove env:prod --yes
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `list` | List all env files across all stashes with key names only |
| `run <ref> -- <command>` | Run a command with the env injected (the **agent-safe** path — values never reach stdout). `--only` / `--except` filter which keys are injected |
| `create <name>` | Create an env file. Empty by default; seed with `--from-file <path>` or `--from-stdin` |
| `path <ref>` | Print the absolute env file path (Docker `_FILE` / `--env-file` / direct editing). `--quiet` suppresses the warning |
| `export <ref> --out <file>` | Write a safe sourceable `export` script to a file (never to stdout) |
| `remove <ref>` | Delete an env file (and its `.sensitive` marker) |

#### env run — the primary (and agent-safe) path

```sh
akm env run env:prod -- <command>
akm env run env:prod -- $SHELL          # interactive: a shell with the env loaded
akm env run env:prod --only A,B -- cmd  # inject only A and B
akm env run env:prod --except DEBUG -- cmd
```

Runs the command with the env file's values injected **directly into the child
process** — never through a shell, and never into akm's stdout. **This is the
only value path safe for AI agents:** the secrets reach the subprocess without
ever passing through the agent's captured output/context. `--only` / `--except`
(comma-separated key names, mutually exclusive) restrict which variables are
injected. Before spawning, the injected key names are scanned for known
process-hijacking variables (`LD_PRELOAD`, `PATH`, …): a first-party stash warns
and proceeds; a third-party-sourced stash is refused.

> The single-key `run <ref>/KEY` form was removed. To inject one value, store it
> as a [secret](#secret) and use `akm secret run secret:<name> <VAR> -- …`, or
> use `akm env run <ref> --only <KEY> -- …`.

> Values injected via `env run` live in the child process environment for its
> entire lifetime and are visible to all subprocesses it spawns. Avoid
> `env run` for long-lived daemon or server processes.

#### env create

```sh
akm env create prod                       # empty
akm env create prod --from-file ./.env    # seed from an existing .env (byte-for-byte)
printf 'A=1\nB=2\n' | akm env create prod --from-stdin
```

Creates `env/prod.env` with mode 0600. Empty `create` is a no-op if the file
exists; `--from-file`/`--from-stdin` **refuse to clobber** an existing env (remove
it first). `--sensitive` hides the file from `env list` and the search index.

#### env list

```sh
akm env list
```

One entry per env file across all configured stashes. The structured shape is
`envs: [{ ref, keys }]` — values are never included and the absolute `path` is
omitted from JSON output. Text output uses Markdown sections:

```md
## env:prod

- DATABASE_URL
- API_KEY
```

#### env path

```sh
akm env path env:prod            # warns: don't source the raw file
akm env path env:prod --quiet    # for `_FILE` / `--env-file` use
```

Prints the absolute path to the env file — for the Docker `_FILE` convention
(`MY_VAR_FILE=$(akm env path env:prod --quiet)`), `docker run --env-file`, or
editing the file directly. By default a stderr warning steers you away from
`source`-ing the raw file (its shell substitutions would execute); `--quiet`
suppresses it for the legitimate file-path uses.

#### env export

```sh
akm env export env:prod --out /tmp/prod.sh && source /tmp/prod.sh && rm -f /tmp/prod.sh
```

Writes a safe, sourceable `export KEY='value'` script to `--out <file>` (mode
0600). Values are re-serialised single-quoted, so a raw `.env` containing shell
substitutions (e.g. `X=$(rm -rf ~)`) becomes a **literal string** — sourcing the
generated file can never execute it. `export` **never prints values to stdout**
(that would leak them into a captured/agent context) and so requires `--out`.

> For most uses prefer `akm env run` (no file, no cleanup). `export` exists for
> the case where a tool must `source` a file or you need a generated env script.

### vault (deprecated)

> **Deprecated in 0.8.0, removed in 0.9.0 — use [`env`](#env).** The `akm vault`
> verb now prints a stderr deprecation warning and delegates `list` / `path` /
> `export` / `run` / `create` to the `env` handlers. `vault set` and
> `vault unset` are hard-errors (akm no longer manages individual entries — edit
> the `.env` directly, or use [`akm secret`](#secret) for a single value), as is
> the removed single-key `vault run <ref>/KEY` form. Existing `vault:` refs
> still resolve, and `akm-migrate-storage` copies `vaults/` → `env/` (see the
> [0.8 → 0.9 migration guide](migration/v0.8-to-v0.9.md)).

### vault (deprecated)

> **Deprecated in 0.8.0, removed in 0.9.0 — use [`env`](#env).** The `akm vault`
> verb now prints a stderr deprecation warning and delegates `list` / `path` /
> `export` / `run` / `create` to the `env` handlers. `vault set` and
> `vault unset` are hard-errors (akm no longer manages individual entries — edit
> the `.env` directly, or use [`akm secret`](#secret) for a single value), as is
> the removed single-key `vault run <ref>/KEY` form. Existing `vault:` refs
> still resolve, and `akm migrate` copies `vaults/` → `env/` (see the
> [0.8 → 0.9 migration guide](migration/v0.8-to-v0.9.md)).

### secret

Manage **secrets** — a single sensitive value used on its own for
**authentication**: an API token, a PEM private key, a TLS cert, a
service-account JSON. Where an [env](#env) file holds a *group* of related
configuration and exposes key *names*, a secret is *one* value and its **entire
file is the value**, so only the secret's *name* is ever surfaced. Each secret
is a mode-0600 file under `secrets/` in your stash.

This mirrors Docker's secret model (one value per file, mounted at
`/run/secrets/<name>`, read at runtime, never baked into the image or env at
build time). The key security property: **secret values never appear in
structured output** — not in the index, `akm search`, `akm curate`, or
`akm show`. The supported value-use paths are `secret run` (inject into a child
env var) and `secret path` (hand the command the file path).

```sh
akm secret list
printf '%s' "$TOKEN" | akm secret set secret:deploy-token
akm secret set secret:deploy-key --from-file ~/.ssh/id_ed25519   # byte-exact
AKM_VALUE="$TOKEN" akm secret set secret:api --from-env AKM_VALUE
akm secret path secret:deploy-key                                # absolute path
akm secret run secret:deploy-token GITHUB_TOKEN -- gh release create v1.0.0
akm secret remove secret:deploy-token --yes
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `list` | List all secrets across all stashes by name (contents never shown) |
| `set <ref>` | Create/overwrite a secret — value from stdin (default), `--from-file`, or `--from-env` |
| `path <ref>` | Print the absolute secret file path (for the Docker `_FILE` convention) |
| `run <ref> <VAR> -- <command>` | Run a command with the secret value injected into `$VAR` in the child only |
| `remove <ref>` | Delete a secret (and its `.sensitive` marker, if any) |

#### secret set

```sh
# Default: read the value from stdin (never crosses argv)
printf '%s' "$TOKEN" | akm secret set secret:deploy-token

# Import an existing file byte-exact (multi-line PEM keys, certs, binary)
akm secret set secret:deploy-key --from-file ~/.ssh/id_ed25519

# From an environment variable
AKM_VALUE="$TOKEN" akm secret set secret:api --from-env AKM_VALUE
```

The value is **never accepted via positional arguments**. With stdin, a single
trailing newline is stripped (so `echo "$TOKEN" | akm secret set …` stores the
token without the shell-added newline); use `--from-file` for byte-exact storage
of multi-line material. Writes are atomic (mode 0600) under an exclusive
`<secret>.lock`. Maximum size is 5 MB.

#### secret path

```sh
akm secret path secret:deploy-key
# Docker `_FILE` convention — hand the command the path, not the value:
MY_SECRET_FILE="$(akm secret path secret:deploy-key)" ./start.sh
```

Prints the absolute path to the secret file. The file's contents are never
printed.

#### secret run

```sh
akm secret run secret:deploy-token GITHUB_TOKEN -- gh release create v1.0.0
```

Runs one subprocess with the secret's value set as `$VAR` in the child's
environment. **The value never appears in akm's structured output** — it is
passed directly to the child process. The target variable name is validated and
known process-hijacking names (`LD_PRELOAD`, `PATH`, etc.) are rejected.

> Secrets injected via `secret run` live in the child process environment for
> its entire lifetime and are visible to all subprocesses it spawns. For
> long-lived daemons, prefer `secret path` so the process reads the file
> directly and the value never sits in an environment variable.

#### Sensitive marker

A sibling `<name>.sensitive` marker file excludes a secret from `secret list`
**and** from indexing entirely (parallel to vaults). The secret remains usable
via `secret path` / `secret run`.

### wiki

Manage multiple markdown wikis following the Karpathy LLM-wiki pattern.
Each wiki lives at `<stashDir>/wikis/<name>/` and contains `schema.md`
(the per-wiki rulebook), `index.md` (a regenerable catalog), `log.md`
(append-only activity log), a `raw/` directory of immutable ingested
sources, and any number of agent-authored pages. See
[wikis.md](wikis.md) for the full guide.

Design principle: **akm surfaces, the agent writes.** akm owns lifecycle,
raw-slug generation, structural lint, and index regeneration. Page edits
use the agent's native `Read` / `Write` / `Edit` tools. No LLM calls are
made anywhere in the wiki surface.

```sh
akm wiki create research
akm wiki list
akm wiki show research
echo "# Attention Is All You Need" | akm wiki stash research - --as attention
akm wiki pages research
akm wiki search research "attention"
akm wiki lint research
akm wiki ingest research               # dispatches defaults.agent to run the ingest workflow
akm wiki ingest research --profile claude --model sonnet  # explicit overrides
akm wiki remove research --force       # preserves raw/ by default
akm wiki remove research --force --with-sources
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `create <name>` | Scaffold `wikis/<name>/` with empty `schema.md`, `index.md`, `log.md`, and `raw/` |
| `register <name> <path-or-repo>` | Register an existing directory or repo as a first-class wiki without copying it |
| `list` | List wikis with page and raw counts plus last-modified timestamps |
| `show <name>` | Path, description (from `schema.md`), counts, and the last 3 `log.md` entries |
| `remove <name>` | Delete pages + schema + index + log. Preserves `raw/` unless `--with-sources`. Requires `--force`. External wikis are unregistered without deleting source files |
| `pages <name>` | List page refs + frontmatter descriptions (excludes `schema.md`, `index.md`, `log.md`, `raw/`) |
| `search <name> <query>` | Scope-filtered search over wiki pages — equivalent to `akm search <query> --type wiki` filtered to one wiki. Excludes `raw/`, `schema.md`, `index.md`, and `log.md` |
| `stash <name> <source>` | Copy `source` into `wikis/<name>/raw/<slug>.md`. Source is a file path or `-` for stdin. `--as <slug>` overrides the derived slug. Never overwrites |
| `lint <name>` | Deterministic structural checks (no LLM): orphans, broken xrefs, missing descriptions, uncited raws, stale index, broken sources |
| `ingest <name>` | Dispatch the configured agent (`--profile` or `config.defaults.agent`) to execute the ingest workflow end-to-end. Requires an accessible agent profile. Flags: `--profile <name>`, `--model <model>`, `--timeout-ms <ms>` |

Wiki names must match `^[a-z0-9][a-z0-9-]*$` — lowercase letters and digits
only; must start with a lowercase letter or digit.

`akm add --type wiki --name <name> <path-or-repo>` is a shortcut to
`akm wiki register <name> <path-or-repo>`.

**Side effect:** `akm index` regenerates each wiki's `index.md` as part of
its normal stash walk — there is no separate `reindex` verb.

**Search/index scope:** stash-wide `akm search --type wiki` and `akm wiki search`
index and return wiki pages only. Files under `raw/` plus the wiki root
infrastructure files `schema.md`, `index.md`, and `log.md` are intentionally
excluded from the search index and search results.

**Not provided:** no `page-create`, `page-append`, `xref`, `log-append`,
`reindex`, or `migrate` verb. Those are the agent's job using its native
file tools against paths surfaced by `show` and `pages`.

#### wiki lint

```sh
akm wiki lint research
```

Runs deterministic structural checks and exits 1 when findings exist, 0 when
the wiki is clean. Output is always JSON with a `findings` array.

Finding kinds:

| Kind | Description |
| --- | --- |
| `orphan` | A page not linked from `index.md` |
| `broken-xref` | An internal link that points to a non-existent page |
| `missing-description` | A page without a frontmatter `description` field |
| `uncited-raw` | A file in `raw/` not referenced by any page |
| `stale-index` | `index.md` is out of date and needs to be regenerated |
| `broken-source` | A `sources:` entry in a page's frontmatter points to a raw file that does not exist |

#### wiki stash

```sh
akm wiki stash research ./paper.md
akm wiki stash research ./paper.md --as my-paper
akm wiki stash research ./paper.md --target my-stash  # Route write to a named writable stash source
echo "..." | akm wiki stash research -
akm wiki stash research https://example.com/papers/attention
```

Copies a file, URL snapshot, or stdin payload into `wikis/<name>/raw/<slug>.md`.
Never overwrites an existing raw file.

When `--as <slug>` is passed and the slug already exists, the command errors
with a `UsageError` — it does not silently rename the slug. Without `--as`,
auto-increment applies: if `paper` exists, the next attempt uses `paper-1`,
then `paper-2`, and so on.

URL sources fetch only the exact page you pass and convert it to markdown
before writing under `raw/`. They do not register a persistent website source
or crawl linked pages.

### completions

Generate or install a bash completion script for `akm`. The script is built
dynamically from the command tree, so it always reflects the current set of
subcommands and flags.

```sh
akm completions                # Print bash completion script to stdout
akm completions --install      # Install to the appropriate directory
```

| Flag | Description |
| --- | --- |
| `--install` | Write the script to the XDG-compliant completions directory |
| `--shell` | Shell type (currently only `bash` is supported) |

**Manual activation:** pipe the output into your shell or source it from
your profile:

```sh
source <(akm completions)
```

**Install locations** (checked in order):

1. `$XDG_DATA_HOME/bash-completion/completions/akm`
2. `~/.local/share/bash-completion/completions/akm`
3. `~/.bash_completion.d/akm`

---

## Improvement Flow (0.8.0+)

These commands define the v0.8.0 self-improvement surface. This is a hard
break from the older `reflect` / `proposal` / `distill` public UX.

### agent

**Status: Available since 0.8.0.**
Dispatch a configured external agent profile, optionally embodying a stash agent asset.

```sh
akm agent <profile> [<agent-ref>] [--prompt <text>] [--model <model>] [--command <ref>] [--workflow <ref>] [--timeout-ms <ms>]
```

| Argument / Flag | Description |
| --- | --- |
| `<profile>` | Agent profile / platform to use (`opencode`, `claude`, `codex`, `gemini`, `aider`, or any custom profile name from config) |
| `<agent-ref>` | Optional agent asset ref (e.g. `agent:code-reviewer`). Loads system prompt, model, and tool policy from the stash asset. |
| `--prompt <text>` | Task prompt to pass to the agent |
| `--model <model>` | Model override. Accepts aliases (`opus`, `sonnet`, `haiku`) or exact platform model IDs. Overrides the model in the agent asset. Resolved per platform: `opencode/claude-opus-4-7` for opencode, `claude-opus-4-7` for claude. |
| `--command <ref>` | Load prompt from a `command:` asset |
| `--workflow <ref>` | Load prompt from a `workflow:` asset |
| `--timeout-ms <ms>` | Override the agent CLI timeout in milliseconds |

When `<agent-ref>` is provided, akm loads the stash agent asset and extracts
its system prompt, `modelHint`, and `toolPolicy`. The `--model` flag wins
over any model specified in the asset.

**Platform-specific dispatch:** akm uses a platform builder to construct the
CLI argv for each profile. `opencode` profiles emit:
`opencode run [--system-prompt "..."] [--model opencode/claude-opus-4-7] "<prompt>"`.
`claude` profiles emit:
`claude [--system-prompt "..."] [--model claude-opus-4-7] [--allowedTools ...] --print "<prompt>"`.
Custom profiles may set `commandBuilder` in config to map to a known builder.

Without any `--prompt`, `<agent-ref>`, or `--model`, the agent is launched
interactively (no injected prompt, no platform-specific flags beyond the
profile's base args) — the same behaviour as before 0.8.0.

Profiles ship for `opencode`, `claude`, `codex`, `gemini`, and `aider` and
can be extended via `profiles.agent.<name>` in config (see
[Configuration](configuration.md)). akm spawns the profile's `bin` via the
shared spawn wrapper described in v1 spec §12.2 — captured or interactive
stdio, hard timeout, structured failure reasons.

```sh
# Interactive launch (unchanged from pre-0.8.0):
akm agent opencode

# Dispatch with a prompt only:
akm agent claude --prompt "summarize recent changes"

# Embody a stash agent asset:
akm agent opencode agent:code-reviewer --prompt "review src/"

# Model override with alias:
akm agent claude agent:planner --model sonnet --prompt "plan the sprint"

# Exact model ID override:
akm agent opencode --model opencode/claude-opus-4-7 --prompt "audit the API"
```

Returns `{ ok, exitCode, stdout?, stderr?, durationMs, reason? }`. On
failure, `reason` is one of `timeout | spawn_failed | non_zero_exit |
parse_error`.

### improve

**Status: Available since 0.8.0.**
Improve existing assets and write the results to the proposal queue.

```sh
akm improve
akm improve memory
akm improve skill:code-review
akm improve workflow:release-checklist --task "reduce duplication"
```

| Flag | Description |
| --- | --- |
| `--task` | Optional extra guidance for this improvement pass |
| `--dry-run` | Show planned refs without generating proposals |
| `--target` | Override the write target used later by `accept` |
| `--auto-accept[=<value>]` | Confidence threshold (0-100) for auto-accepting proposals. Default ON at 90 when the flag is absent. Bare `--auto-accept` = 90. `--auto-accept=<N>` sets the threshold to integer N (0-100). `--auto-accept=safe` is a permanent alias for 90. `--auto-accept=false` disables auto-accept and restores the interactive prompt on the HTTP consolidation path. |
| `--limit <n>` | Maximum number of assets to process |
| `--timeout-ms <ms>` | Wall-clock budget for the run |
| `--consolidate-recovery <abort|clean>` | Handle stale consolidate journal by aborting (default) or cleaning stale artifacts |
| `--require-feedback-signal` | Only process assets with recent feedback signals |
| `--min-retrieval-count <n>` | Minimum retrieval count for zero-feedback fallback (default: 1; set 0 to include all assets regardless of retrieval history) |
| `--profile <name>` | Override the active improve profile (e.g. `default`, `quick`, `thorough`, `memory-focus`, or any custom entry under `profiles.improve`) |
| `--json-to-stdout` | Emit the full JSON result on stdout (legacy behaviour). Without this flag the full JSON is written to `<stash>/.akm/runs/<run-id>/improve-result.json` and stdout stays empty; pass `--json-to-stdout` to restore the pre-0.8.0 `akm improve \| jq` pipeline. |

`akm improve` is the public entrypoint for whole-stash, type-scoped, and
ref-scoped improvement. It owns the memory-cleanup and lesson-distillation
flow that used to be split across multiple commands.

The maintenance pass run by `improve` also expires stale proposals: any pending
proposal older than `improve.archiveRetentionDays` (default 30) is moved to the
archive with the reason `expired: no action within retention window` and a
`proposal_expired` event is emitted. Set `archiveRetentionDays` to 0 to disable
expiration entirely. The total expired count surfaces in the improve result as
`proposalsExpired`.

When auto-accept is enabled, the threshold from `--auto-accept` is compared
against each proposal's `confidence` score (set by reflect/propose). Proposals
with `confidence × 100 >= threshold` are promoted into the stash automatically.
Reflect emits `confidence` as part of its JSON response schema; agents and
custom runners should populate it (0..1) so auto-accept has signal to act on.

Selection behavior defaults to recent feedback signals first, with a
zero-feedback retrieval fallback for high-traffic refs. Use
`--require-feedback-signal` to disable retrieval fallback for the run.

When reinforced facts need promotion, `knowledge` is the higher-authority
destination than `memory`. The deterministic search ranking also prefers
`knowledge` over `memory` hits, including inferred `.derived` memories, when
the evidence is otherwise comparable.

### propose

**Status: Available since 0.8.0.**
Generate a brand-new asset proposal from a description. Output is always a
proposal — never a direct write.

```sh
akm propose <type> <name> --task "..."
akm propose <type> <name> --file ./prompt.md
akm propose skill code-review --task "PR-style review skill"
akm propose lesson docker-cleanup --file ./prompts/docker-cleanup.md
```

| Flag | Description |
| --- | --- |
| `--task` | Inline task text |
| `--file` | Read task text from a UTF-8 file |
| `--profile` | Override the default agent profile |
| `--timeout-ms` | Override the agent profile's `timeoutMs` for this call |

Exactly one of `--task` or `--file` is required. Emits `propose_invoked`.

**Per-task `timeoutMs` in task YAML files:** a task `.yml` file may set
`timeoutMs` to override the agent profile's `timeoutMs` (i.e.
`profiles.agent.<name>.timeoutMs`) for that task only. Set `timeoutMs: null` to
disable the kill timer entirely (useful for long-running local-model tasks), or
a positive integer (milliseconds) to apply a task-specific limit.

### proposal

**Status: Available since 0.8.0.**
Manage the proposal queue. The canonical grammar is `akm proposal <verb>`:
`list`, `show`, `diff`, `accept`, `reject`, `revert`. Bare `akm proposal`
behaves as `akm proposal list`.

The flat verbs `akm proposals`, `akm show proposal <id>`, `akm accept`,
`akm reject`, `akm diff`, and `akm revert` remain as **deprecated aliases** that
warn on stderr and delegate to the `proposal <verb>` forms. They are removed in
0.9.0.

#### proposal list

List proposal queue entries.

```sh
akm proposal list
akm proposal list --status pending|accepted|rejected|reverted
akm proposal list --ref skill:deploy
```

| Flag | Description |
| --- | --- |
| `--status` | Filter by `pending`, `accepted`, `rejected`, or `reverted` |
| `--ref` | Filter by exact asset ref |
| `--type` | Reserved type filter |

Each proposal record carries an optional `confidence` field (0..1) emitted by
reflect/propose runs. The `--auto-accept` flag on `improve` uses this score to
auto-promote high-confidence proposals — see the `improve` section above. After
promotion, accepted proposals that overwrote an existing asset also carry a
`backup` field pointing to the captured prior content, which
`akm proposal revert` uses.

#### proposal show

Inspect a queued proposal and its validation findings.

```sh
akm proposal show <id>
```

#### proposal accept

Accept a proposal and promote it into the stash. Accepts a full UUID, an
8-character UUID prefix, or an asset ref.

```sh
akm proposal accept <id>
akm proposal accept 7c115132                  # 8-char UUID prefix
akm proposal accept skill:akm-dream           # Asset ref
akm proposal accept <id> --target team-stash
akm proposal accept --generator reflect -y    # Bulk-accept by generator (requires -y)
```

Bulk-accept all pending proposals from one generator with `--generator <name>`
(e.g. `reflect`, `distill`) and no positional id. `--source` is a deprecated
alias for `--generator` (removed 0.9.0). Bulk accept requires `-y`/`--yes` in
non-interactive shells.

#### proposal reject

Reject a proposal and archive the reason. Accepts a full UUID, an 8-character
UUID prefix, or an asset ref.

```sh
akm proposal reject <id> --reason "duplicates existing workflow"
akm proposal reject 7c115132 --reason "not ready"      # 8-char UUID prefix
akm proposal reject skill:my-skill --reason "not ready" # Asset ref
akm proposal reject --generator reflect --reason "noisy" -y  # Bulk-reject by generator
```

Bulk-reject all pending proposals from one generator with `--generator <name>`
and no positional id. `--source` is a deprecated alias for `--generator`
(removed 0.9.0). Bulk reject requires `-y`/`--yes` in non-interactive shells.

#### proposal revert

Revert an accepted proposal by restoring the prior asset content from the
backup captured at promotion time. Only works on proposals that overwrote an
existing asset; new-asset proposals leave no backup. Sets the proposal's status
to `reverted` and appends a `proposal_reverted` event to the audit log.

```sh
akm proposal revert <id>
akm proposal revert skill:akm-dream           # Asset ref
akm proposal revert <id> --target team-stash
```

| Flag | Description |
| --- | --- |
| `--target <name>` | Override the write destination by source name |

Accepts the full proposal UUID or the asset ref. UUID prefixes are **not**
supported for reverting (archived proposals require the full identifier). Errors
with exit code 2 if the proposal is not in `accepted` status, has no captured
backup, or cannot be found.

#### proposal diff

Preview the proposed change against the live asset. Accepts a full UUID, an
8-character UUID prefix, or an asset ref directly.

```sh
akm proposal diff <id>
akm proposal diff skill:akm-dream             # Asset ref form
akm proposal diff 7c115132                    # 8-char UUID prefix
akm proposal diff <id> --target team-stash
```

| Flag | Description |
| --- | --- |
| `--target <name>` | Override the write destination by source name for `proposal accept` and `proposal diff` |

`proposal accept` runs full validation before promoting. `proposal reject`
requires `--reason`.

### feedback (`--reason` extension)

**Status: Available since 0.8.0.**
Existing `akm feedback` keeps its current shape (positive/negative/`--note`)
and gains an optional `--reason <slug>` flag whose value is forwarded into
feedback metadata and consumed by improve/distill proposal prompts.
Backwards compatible: scripts without `--reason`
behave exactly as today.

### tasks

**Status: Available since 0.8.0.**
`akm tasks` is the scheduling surface for workflows, agent prompts, and
shell commands. It manages on-disk task definitions under
`<stash>/tasks/<id>.yml` and reconciles them with the OS-native scheduler
(cron / launchd / schtasks). Task `.md` files from 0.7.x are not discovered
— see the migration guide for the conversion path.

```sh
akm tasks list                              # List all tasks in the stash
akm tasks show <id>                         # Show one parsed task
akm tasks add <id> --schedule "@daily" \    # Register a new task and install it
  --command "akm improve --auto-accept=90"
akm tasks run <id>                          # Execute now (what the scheduler calls)
akm tasks enable <id> / disable <id>        # Toggle scheduler entry
akm tasks remove <id>                       # Delete task file and uninstall
akm tasks history [--id <id>] [--limit <n>] # Recent runs from state.db
akm tasks sync                              # Reconcile on-disk YAML with scheduler
akm tasks doctor                            # Report scheduler backend + paths
```

Each task targets exactly one of `--workflow <ref>`, `--prompt <text-or-ref>`,
or `--command <shell>`. Prompt targets dispatch through the configured agent
profile; command targets run as plain shell. Optional fields include
`--profile`, `--params` (JSON for workflow params), `--name`,
`--when-to-use`, `--description`, and `--tags`. Per-task `timeoutMs` is set
in the task YAML itself.

`akm tasks run` is what cron / launchd / schtasks invoke at the scheduled
time — `tasks_invoked` and `tasks_completed` events land in `state.db` so
runs are auditable via `akm events`.
