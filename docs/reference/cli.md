# CLI Reference

The CLI is called `akm` (Agent Knowledge Manager). Commands default to structured
JSON at `--detail brief`. Use `--format json|jsonl|yaml|text|md|html`,
`--detail brief|normal|full`, and `--shape human|agent|summary` when you want a
different presentation. Errors include `error` and `hint` fields.

This page is authoritative for the current CLI. For per-release behavior
changes, see [`CHANGELOG.md`](../../CHANGELOG.md) and
[`docs/migration/`](../migration/). For the bundle formats akm recognizes
(detection, ref shapes, indexing, validation, read/write), see
[Bundle Types](bundle-types.md).

## Global Flags

These flags are accepted by all commands:

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--format` | `json`, `jsonl`, `yaml`, `text`, `md`, `html` | `json` | Output format |
| `--output` | path | _(none)_ | Write rendered output to a file instead of stdout (all formats except `jsonl`) |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output **verbosity** level |
| `--shape` | `human`, `agent`, `summary` | `human` | Output **projection** |
| `--quiet` / `-q` | boolean | `false` | Suppress stderr warnings |
| `--verbose` | boolean | `false` | Enable verbose diagnostics gated behind `isVerbose()`. Parsed globally before any subcommand runs. The `AKM_VERBOSE` env var honours the same setting and wins when both are present (see `src/core/warn.ts`). |

`--detail` controls **how much** is returned (`brief|normal|full`); `--shape`
controls the **projection** (`human` for people, `agent` for a token-lean
action view, `summary` for capability discovery).

### `--format jsonl`

Outputs one JSON object per line. For `search` (including `--from registry`),
each hit is a separate line. For other commands, the entire result is a single line.
Useful for streaming consumption by scripts or agents.

### `--format md` and `--format html`

`json`, `jsonl`, and `yaml` serialize the result envelope; `text`, `md`, and
`html` render it. Every result-envelope command supports all six.

A command may register a renderer for a document format when it has something
better to say than the generic one: `akm health --group-by run --format md`
emits its per-run table, and `akm health --report --format html` renders the
full report with KPI cards, charts, and advisories. The renderers are
data-driven — they fire when the result carries the report dataset, never on
the format alone, so the same dataset is available as JSON too. Every other command falls back to a
generic rendering derived from its own envelope — headings for the top-level
keys, a table for an array of uniform objects, lists otherwise. HTML output is a
self-contained document with no external references, so it can be redirected to
a file and opened directly.

A small set of commands is **format-exempt** because their output is not a
result envelope at all — `completions`, child-process passthrough (`env run`
and `secret run`), document payloads (`help`,
`help migrate`), and `env path` (a bare filesystem path is the payload, the
documented shell-substitution primitive — wrapping it in an envelope would
break `$(akm env path <ref>)` substitutions). Passing `--format` to one of
those **warns on stderr** and is otherwise ignored; the exempt set is declared
in `src/output/format-exempt.ts`. `migrate status`/`apply` invoke the packaged
task migrator but are NOT exempt: the CLI parses its task plan and renders it
through the normal `--format` pipeline, so `text`/`md`/`html`/`yaml` genuinely
reformat it.

Scripted `setup` modes emit a normal format-aware result. Interactive `setup`
is a terminal UI and emits no result document. `agent` leaves inherited child
streams raw, then formats its final `agent-result` envelope normally.

### `--shape=agent`

Strips output to only action-relevant fields:

- **search**: keeps `name`, canonical `ref`, absolute `path`, `editable`, `type`, `description`, `action`, `score`, and optional `estimatedTokens`/`keys`
- **show**: adds absolute `path`, `editable`, and the existing type-specific action/content fields on top of the canonical `ref` that every `show` shape returns (`ref` is not agent-exclusive — see `--shape summary` below)
- **curate**: local items keep canonical `ref`, absolute `path`, `editable`, and their follow-up fields

For local materialized assets, `editHint` is added only when `editable` is
`false`. It is supplemental guidance and does not replace the normal show, run,
or use `action` (or curate `followUp`). Registry-only results have no local
`path`, `editable`, or `editHint`.

### The `results` collection alias

Every list-returning command names its collection field differently —
`search` returns `hits`, `curate` returns `items`, `proposal list` returns
`proposals`, `bundle list` returns `sources`, `env list` returns `envs`,
`secret list` returns `secrets`, `registry list` returns `registries`,
`registry search` returns `hits`, `workflow list` returns `runs`,
`task history` returns `rows`, `log list` returns `events`. A caller that does
not already know each command's key cannot write one accessor across all of
them.

Every one of these commands also carries a `results` field — the identical
array, not a copy — alongside its semantic key, in every `--format`/`--detail`
combination and both `--shape human` (the default) and `--shape agent`. Code
written against a single command should keep using its semantic key for
clarity; code that needs to handle several list commands uniformly can read
`results` and never maintain a per-command lookup table.

### `--shape summary`

Valid **only on `akm show`**. Every other command rejects `--shape summary`
with an `INVALID_SHAPE_VALUE` usage error (exit 2) — an honest rejection rather
than a silent fallback. It returns a compact view suitable for capability
discovery:

- **show**: `type`, `name`, canonical `ref`, `description`, `tags`, `parameters`, `workflowTitle`, `action`, `run`, `origin`, `keys`, `related`

## Exit Codes and Error Envelope

Every command exits with one of the following codes:

| Exit code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or command-reported failure | `NotFoundError`, command result |
| 2 | Usage / bad input | `UsageError` |
| 4 | Health warning (`akm health` only) | — |
| 70 | Internal / unclassified error | unexpected throw |
| 75 | Transient — retry shortly (sysexits `EX_TEMPFAIL`); another akm process holds a lock or is writing `state.db` or `index.db` right now, not a bad command line | `TransientError` |
| 78 | Configuration error | `ConfigError` |

Failures classified by akm emit a JSON error envelope on **stderr** before
exiting; stdout is normally left empty:

```json
{"ok": false, "error": "<message>", "hint": "<optional hint>"}
```

The `hint` field is present only when actionable remediation is available
(e.g. a suggested flag or alternate command). Agents should check
`ok === false` on the parsed stderr envelope or a non-zero exit code to
detect failure. Scripts can rely on the exit code alone.

Every success envelope produced by the passthrough stamp — `config`, `clone`,
`models`, `task-*`, `workflow-*`, `registry-*`, and the rest of that shared
handler — also carries `ok: true` (0.9.12+), so a caller branching on `.ok`
sees the same field on both sides — success and failure — instead of
`undefined` on success. A command that already computes its own `ok` from a
graded outcome (e.g. `task run`'s exit-code mapping, `akm lint`, `akm proposal
extract`) keeps that value, `false` included.

`env run`, `secret run`, and `migrate` preserve the spawned process's exact
status and raw streams instead of replacing them with an akm failure envelope.
`task run` maps completed, active, and disabled status to 0; blocked and failed
status to 1; and configuration errors to 78. It retains a command child's exact
status in `result.detail.exitCode`. `agent` maps a failed dispatch to 1 while
retaining the child status in its formatted result envelope.

## Commands

### bundle create

> **Note:** `akm setup` is the recommended entry point — it runs the same directory initialization plus guides you through AI connection configuration. `akm bundle create` remains available as a low-level building block.

Create the bundle directory structure and persist the working bundle path in
config.

```sh
akm setup                        # Interactive setup wizard (creates bundle + configures connections)
akm setup --dir ~/custom-bundle   # Initialize at a custom location
akm setup --yes                  # Non-interactive, accepts all defaults
```

Creates one subdirectory per asset type under the bundle path — currently
`scripts/`, `skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`,
`instructions/`, `memories/`, `env/`, `secrets/`, `lessons/`, `tasks/`,
`sessions/`, and `facts/`. See
[technical/filesystem.md](https://github.com/itlackey/akm/blob/main/docs/architecture/internals/storage-locations.md) for config file locations.

```sh
akm bundle create                              # Initialize the default bundle (~/akm) and set it as default
akm bundle create --dir ~/scratch-bundle        # Scaffold a secondary bundle WITHOUT changing your default
akm bundle create --dir ~/scratch-bundle --set-default  # Scaffold AND make it the default bundle
```

**`--dir <path>`** scaffolds (and backfills) the target directory. By design it
does **not** change your configured default bundle unless you ask: `bundle
create` updates the primary `bundles` entry and `defaultBundle` in
`config.json` only when (a) no `--dir` is given, (b) no default is configured
yet (first-time bootstrap), or (c) you pass **`--set-default`**. When a `--dir`
is given and a default already exists without `--set-default`, your default
bundle pointer is left untouched and `bundle create` prints a note telling you
so. This prevents `akm bundle create --dir /tmp/throwaway` from silently
hijacking your real default bundle.

### setup

Run the interactive first-run wizard.

```sh
akm setup
```

The setup wizard configures AKM in two steps:

**Step 1 — Small model connection** (for background processing)
Configures the OpenAI-compatible endpoint and model used for `akm index`
metadata enhancement and `akm remember --enrich`. Supports Ollama,
OpenAI, LM Studio, or any custom endpoint. Skipping disables enrichment features.

**Step 2 — Agent connection** (for agentic commands)
Configures how `akm improve`, `akm proposal new`, and `akm task run` dispatch AI sessions.
Options:
- **Same connection** — reuse the Step 1 endpoint with a (optionally different) model
- **New connection** — separate endpoint, model, and API key
- **Installed CLI agent** — use an installed agent binary (opencode, claude, codex, etc.)
- **None** — agentic commands disabled with a clear warning

A feature capability summary is shown at the end of setup.

The wizard also lets you choose a bundle directory, review registries, and add bundle
sources. When you save, akm writes the config file, initializes the bundle directory,
and builds the search index.

### index

Build or refresh the search index.

```sh
akm index            # Incremental (only changed directories)
akm index --full     # Full rebuild (reuses unchanged embeddings — see below)
akm index --verbose  # Print phase progress to stderr
akm index --clean    # Normal index + remove stale entries from the DB
akm index --clean --dry-run # Report stale entries without deleting
akm index --reembed  # Force re-embedding of every entry
akm index --skip-if-locked  # for scheduled/opportunistic runs: skip (exit 0) if a run is already in progress
```

Returns stats: `totalEntries`, `generatedMetadata`, `directoriesScanned`,
`directoriesSkipped`, `verification`, optional `warnings`, and `timing`
breakdown in milliseconds. Use `--verbose` to print the indexing mode,
semantic-search settings, and phase-by-phase progress to stderr while the
index is being built. Malformed workflow assets are skipped with file-path
warnings instead of aborting the full run.

**Progress in non-verbose JSON mode (default output format, #954):** even
without `--verbose`, phase-start messages and the embedding heartbeat
(`Still generating embeddings: X/N stored, F failed; waiting on embedding
provider.`) are now written to stderr, and a failed embedding batch logs at
the default level instead of `--verbose`-only — a long-running index build
against a slow or unresponsive provider is no longer silent until the whole
run finishes. Text-mode output keeps its spinner instead (no stderr line
growth); JSON stdout output is unaffected either way. The high-frequency
per-batch `Embedded N/M entries.` line stays out of non-verbose stderr (it
fires after every committed batch) — pass `--verbose` for that level of
detail.

**`--clean` flag:** After indexing completes, verifies every indexed entry's source
file still exists on disk. Removes any entries whose file is missing (for local
bundle sources only; remote entries are skipped). Returns a `clean` block in the
JSON result with `checked`, `removed`, `removedRefs` arrays, and `dryRun` flag.
Use `--clean` to resolve the edge case where a deleted file in an unchanged
directory lingers in the index across incremental runs. With `--dry-run`, reports
which entries would be removed without modifying the database.

**`--full` no longer re-embeds unchanged content (#955):** a full rebuild
(and an index-generation bump on first open under a new binary) used to
delete every embedding unconditionally, forcing a full re-embed of the
whole corpus even when nothing changed. Vectors about to be discarded are
now salvaged (keyed by a hash of their content plus the fingerprint they
were generated under) and handed straight back to unchanged entries at the
start of the next embedding pass, with zero provider calls for them — a
progress line reports the split (`Reused N embeddings from the previous
generation; embedding M new.`). Content that changed even by one byte, or
a fingerprint that no longer matches, still goes through the provider
normally. `--reembed` is the way to force a full re-embed regardless.

**`--reembed` flag:** Forces a full purge and re-embed of every entry,
independent of the embedding-model-rename compatibility check described
below. Ordinary indexing already tells a config-only rename of
`embedding.model` (e.g. a gateway that changes how it names the same model)
apart from a genuine model change, and keeps the stored vectors when they
are still compatible; `--reembed` skips that check and forces a rebuild
regardless of what it would have decided.

**`--skip-if-locked` flag:** Every explicit `akm index` run acquires an
opt-in, PID-liveness-only rebuild lock and releases it on exit — this is
advisory, never the blocking lock #872 removed (see
[Locks](https://github.com/itlackey/akm/blob/main/docs/architecture/internals/indexing.md#locks)). A human-typed
`akm index` with no flag is never gated by it: if another run already holds
the lock, it warns and proceeds anyway, contending with the existing run. If
that contention makes index.db genuinely busy (SQLite `database is locked`)
long enough to exhaust the driver's retry window, the run now fails with
exit 75 (`TransientError`, code `INDEX_DB_CONTENDED`) instead of the raw
driver error at exit 70 — the same retry-shortly contract as
`STATE_DB_CONTENDED`, so a scheduler can branch on it instead of alerting.
The rebuild lock itself is registered through a brief internal barrier
(`getMaintenanceBarrierPath()`) shared with every other akm lock/lease; two
`akm index` runs launched close enough together to collide on that
registration step retry briefly and then, if it is still busy, also exit 75
(code `MAINTENANCE_BARRIER_BUSY`) rather than the config-error exit 78 a
2026-09-10 field report found — a busy registration barrier is ordinary
contention between two legitimate runs, never a broken config file.
`--skip-if-locked` changes that only for the invocation that passes it: if
the lock is already held by a live process, it skips gracefully (exit 0,
`{ ok: true, skipped: { reason: "lock-held", pid, launcherPid, startedAt } }`
— `launcherPid` is the holder's launcher pid when known, `null` otherwise,
#956) instead of contending. `akm index` and `akm curate` are both safe to call frequently —
`curate` never blocks on a rebuild in progress ([read-path indexing stays
non-blocking](#curate)) — but a hook, cron job, or scheduled task that
invokes `akm index` directly should pass `--skip-if-locked` so it steps
aside instead of piling up behind a longer rebuild (the shipped
`index-refresh` task does this).

`akm index` always rebuilds the search index and keeps metadata in the index.
When a selected named LLM engine (`defaults.llmEngine` or an indexing-pass
override) is configured and the per-pass gate allows it, metadata
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
| `bundleDir` | Primary bundle directory — same resolution `akm bundle list` uses |
| `defaultBundle` | Name of the primary bundle from config, or `null` when none is configured |
| `dataDir` | Resolved data directory (`getDataDir()`) |
| `configDir` | Resolved config directory (`getConfigDir()`) |
| `cacheDir` | Resolved cache directory (`getCacheDir()`) |
| `stateDir` | Resolved state directory (`getStateDir()`) |
| `assetTypes` | List of recognized asset types |
| `searchModes` | Active search modes (`fts`, optionally `semantic` and `hybrid`) |
| `semanticSearch` | Semantic search status: `mode`, `status`, and optional `reason`/`message` |
| `registries` | Configured registries |
| `sourceProviders` | Configured sources (filesystem, git, website, npm) |
| `indexStats` | Index stats: `entryCount`, `byType` (per-asset-type breakdown), `lastBuiltAt`, `hasEmbeddings`, `vecAvailable` |

`semanticSearch.status` values:
- `"ready-vec"` — native sqlite-vec extension active (fastest)
- `"ready-js"` — pure JS fallback active (correct but slower at scale)
- `"pending"` — not yet initialized (run `akm index` to set up)
- `"blocked"` — setup failed (see `reason` and `message` fields)
- `"disabled"` — semantic search is turned off in config

Use `akm info` to verify that semantic search is working after setup.

Scripts that need akm's resolved paths (for example a health check that
differs between a host install and a container) can read them with
`akm info --format json | jq -r .dataDir` instead of hardcoding a path.

### health

Check akm runtime health, durable state, and recent improve-loop telemetry.

```sh
akm health
akm health --since 24h
akm health --since 7d --format text
akm health --since 2026-05-01T00:00:00Z
akm health --report --format html         # full report: per-run rows, trends, proposal queue
akm health --report --format json         # the same dataset as data
akm health --report --window-compare 7d --format html
```

| Flag | Description |
| --- | --- |
| `--since` | Rolling window start for task-history, improve, and advisory metrics. Accepts ISO 8601, `YYYY-MM-DD`, epoch milliseconds, or shorthand like `24h` / `7d`. Default: last 24 hours. |
| `--report` | Fetch the full report dataset: per-run rows, trend deltas vs the prior window (default: the `--since` window, so deltas are like-for-like), and the pending proposal queue. A **data** flag — the same dataset comes back in every `--format`; `md`/`html` render it as the rich report. |
| `--window-compare` | Compare the current window against the prior window of the same duration (e.g. `24h`, `7d`). With `--report`, overrides the default trend window. |
| `--group-by` | Group rows by `run` (one row per `improve_runs` entry). Omit for the default summary. |
| `--windows` | Explicit comparison window(s) as `name=...,since=ISO,until=ISO` (repeatable, up to 4). Mutually exclusive with `--window-compare`. |
| `--no-probe` | Skip the `default-llm-engine` / `configured-engines` reachability probes, the `cli-version` update check, and the `scheduler-binary` version check (for an offline or air-gapped host). |

The command reads `state.db`, verifies that the required tables exist, performs a
write-read probe against the events stream, inspects `task_history`, checks the
default agent engine, and summarizes recent `improve_*` events. Unless
`--no-probe` is given, it also sends a bounded (3s timeout) reachability probe
to the `default-llm-engine` and every `configured-engines` LLM connection (and
an SDK engine's LLM fallback), one probe per distinct endpoint, checks the
installed akm-cli version against the latest GitHub release (`cli-version`),
and runs the scheduler's recorded akm binary with `--version` to check it
against the running CLI (`scheduler-binary`).

Primary result fields:

| Field | Description |
| --- | --- |
| `status` | Overall health verdict: `pass`, `warn`, or `fail` |
| `hardChecks` | Deterministic checks such as `state-db-schema`, `state-db-round-trip`, `state-db-migrations`, `task-log-backing`, `active-runs`, `default-engine`, `model-map-files`, `default-llm-engine`, `configured-engines`, and `active-improve-strategy` |
| `advisories` | Non-fatal warnings including `semantic-search-runtime`, `session-extraction` (akmExtract pipeline health), `cli-version` (installed vs latest release), `thinking-control` (an `enableThinking: false` engine whose recorded usage still shows reasoning tokens), and `engine-last-used` (an engine bound to an enabled improve process with no recorded use in 30 days) |
| `metrics` | Aggregate task/runtime metrics: `taskFailRate`, `agentFailureRate`, `stuckActiveRuns`, `logBackingRate`, `probeRoundTripMs` |
| `improve` | Recent improve-loop counts derived from `improve_invoked`, `improve_skipped`, and `improve_completed` events |

The `improve` section includes counts for planned refs, reflect/distill actions,
memory-prune actions, memory-inference writes, graph-extraction refreshes,
session-extraction outcomes (`sessionsScanned`, `sessionsExtracted`, `proposalsCreated`),
dead-URL detections, and skip reasons observed in the selected time window.

`state-db-migrations` reports whether `state.db`'s migration ledger has any
pending entries (checked read-only, without applying anything). It `fail`s
when migrations are pending — naming them and pointing at `akm migrate apply`
— rather than the command crashing, which is what happens when `state.db`
holds a pending historical-destructive migration and something other than
`akm upgrade` / `akm migrate apply` opens it directly. Read this check's
`status` instead of grepping akm's error text for that case.

`default-llm-engine` and `configured-engines` probe reachability (not just
configuration) for a `kind: "llm"` engine — an unreachable endpoint is a hard
`fail` for `default-llm-engine` and a `warn` for any other engine. `--no-probe`
skips this. When a required credential is missing from the shell but an
`env/` asset defines the same variable name, the warn names that asset's ref
(never the variable name) and points at `akm env run <ref> -- ...`.
`active-improve-strategy` names the resolved engine per process
in its evidence and message, so a strategy-level `engine` pin that shadows
`defaults.llmEngine` is visible without config archaeology.

`cli-version` compares the installed akm-cli version against the latest
GitHub release — the same source `akm upgrade` trusts — and `warn`s with the
upgrade command when a newer release exists. `--no-probe`, offline, or a
rate-limited request all degrade it to `unknown`, never a false `warn`.

`engine-last-used` checks, for every engine bound to an enabled process in
the active improve strategy, whether it has a recorded `llm_usage` call in
the last 30 days (independent of `--since`). It `warn`s naming the idle
engine and its bound process, and stays `unknown` — not a noisy `warn` —
until at least one improve run has been recorded (started) in that window,
so a fresh install is quiet.

The `session-extraction` advisory is derived from the `extract_sessions_seen`
ledger for the last 7 days — not `improve_runs`, which the hook-driven `akm
proposal extract --session-id ...` invocation never writes. It reports
`unknown` when nothing was recorded in the window (cannot tell "off on
purpose" from "broken"), `warn` when every session in the window was skipped
for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`,
`locked_concurrent`) — naming the reason and, when recorded, the engine — and
`pass` otherwise, with per-outcome counts.

The indexed entity graph (entities/relations extracted from bundle assets) has
no dedicated inspection command; its summary counts surface as an info-level
metric in `akm health`. Graph data is automatically re-extracted on the first
`akm improve` cycle after a `DB_VERSION` upgrade, and search ranking can
optionally use graph-derived confidence-weighted boosts — tune
`search.graphBoost.confidenceMode` and `search.graphBoost.confidenceWeight` in
[`docs/reference/configuration.md#search-tuning`](configuration.md#search-tuning).

### search

Search bundle assets, registries, or both.

```sh
akm search "deploy"
akm search "deploy" --type script --limit 10
akm search "lint" --from registry
akm search "docker" --from all --detail full

# Multi-tenant scope filtering:
akm search "deploy" --filter user=alice
akm search "deploy" --filter user=alice --filter agent=claude

# Include proposal-queue entries:
akm search "deploy" --include-proposed

# ConceptId-prefix enumeration — list a subtree instead of keyword-matching:
akm search "memories/projectA/"
akm search "knowledge/"
akm search "team-catalog//"
akm search "team-catalog//skills/"
```

A query ending in `/` is a **conceptId prefix**, not a keyword search. It
enumerates the entries whose conceptId starts with that prefix: `akm search
"memories/projectA/"` lists exactly the `projectA/` subtree of memories
(recursive, `/`-boundary exact — a sibling `projectAlpha/` scope does not
leak), and `akm search "sessions/"` lists every session (a prefix is explicit
intent, so the default `session` exclusion — an untyped-path policy — does not
apply). A `<bundle>//` prefix scopes enumeration to one bundle, optionally
narrowed further (`team-catalog//skills/`); `<bundle>//` alone lists the whole
bundle, which is what replaced `akm bundle items`.

Because the prefix matches the **conceptId** — the same spelling every emitted
`ref` carries — a ref copied out of search output can be truncated to a prefix
and pasted straight back in. Hits carry the fixed browse score `1` in
deterministic listing order, matching the empty-query enumeration contract, and
compose with `--limit`, `--belief`, `--filter`, and named `--from` narrowing.
A full ref without the trailing slash (`memories/projectA/auth-tip`) stays an
ordinary keyword search — use `akm show` to resolve a single ref. An explicit
`--type` flag wins over the prefix.

The pre-0.9.0 `<type>:` / `<type>:<prefix>/` spelling was removed. A query in
that shape is now an ordinary keyword search, and when it returns nothing the
tip names the conceptId spelling that replaces it.

Local search responses include `searchMode`: `semantic` when vector ranking
ran, `keyword` when keyword-only search was intentional or semantic search was
not ready, and `fts-fallback` when a ready semantic backend failed during this
query. The last case also adds one sanitized, endpoint-naming entry to
`warnings`; it never repeats the provider/runtime error text. Both fields are
preserved by `--shape agent` so machine consumers can lower their confidence
instead of treating keyword fallback as healthy semantic ranking.

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `instruction`, `workflow`, `script`, `memory`, `env`, `secret`, `lesson`, `task`, `session`, `fact`, `any` | `any` | Filter by asset type. Free-form and unvalidated — an unknown type returns no hits. Also accepts any adapter-defined type (e.g. `website`) — see [Bundle Types](bundle-types.md) for the open types each adapter emits. |
| `--limit` | number | `20` | Maximum results |
| `--from` | `local`, `registry`, `all` | `local` | Where to search |
| `--assets` | flag | `false` | Include asset-level registry results (only meaningful with `--from registry\|all`; folds in the retired `akm registry search --assets`) |
| `--filter` | `<key>=<value>` | _(none)_ | Scope filter — repeatable. Valid keys: `user`, `agent`, `run`, `channel`. Example: `--filter user=alice --filter channel=ops`. Narrows the result set; ranking is unchanged. |
| `--include-proposed` | flag | `false` | Include entries with `quality: "proposed"` in the result set. Default search excludes them; `generated` and `curated` quality entries are always included. Unknown quality values warn once and remain searchable. |
| `--belief` | `all`, `current`, `historical` | `all` | Memory belief filter. `current` keeps active memory beliefs; `historical` keeps contradicted/superseded/archived ones. |
| `--no-project-context` | flag | `false` | Disable the automatic project-context ranking boost for this search only |
| `--track-usage`, `--no-track-usage` | flag | `true` | Record or suppress local usage-event and ranking updates for this successful read |
| `--include-sessions` | flag | `false` | Include session assets, which are excluded from default results via `config.search.defaultExcludeTypes` |
| `--format` | `json`, `jsonl`, `yaml`, `text`, `md`, `html` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output verbosity level |
| `--shape` | `human`, `agent`, `summary` | `human` | Output projection. `--shape summary` is valid **only on `akm show`**; passing it here is an `INVALID_SHAPE_VALUE` usage error (exit 2), like on every other command. |

`--filter` flags AND-join: every supplied key must match the entry's
`scope` for the entry to appear in the result set. Entries without any scope
are excluded as soon as a filter is supplied. With no `--filter` (the
default), unfiltered queries continue to surface all entries — including
legacy memories that pre-date the scope contract.

Local refs come from the index's canonical fully qualified `item_ref`; output
keeps the short form for the default bundle and qualifies non-default bundles.
Local paths are absolute materialized `file_path` values. Key fields by
availability:

- **`ref`** -- The asset handle to pass to `akm show` (for example
  `team//scripts/deploy.sh`); present at `brief`, `full`, and `agent` for local
  hits
- **fragment provenance** -- when `ref` selects an indexed Markdown fragment,
  `selectedRef` and `parentRef` distinguish the ranked evidence from its parent;
  one-based `fragmentOrdinal`, `fragmentCount`, source-line bounds, neighbor
  refs, and separate fragment/parent size estimates are available without
  changing ranking. `estimatedTokens` describes the fragment for a
  fragment-qualified hit; `parentEstimatedTokens` describes the whole asset.
- **`name`** -- The asset's filename or identifier; present at all levels
- **`origin`** -- The source bundle (e.g. `npm:@scope/pkg`), present only for
  managed source assets; surfaced at `full` only
- **`id`** -- Registry-level identifier (registry hits only)
- **`matchStage`** -- Which stage of the progressive AND->OR lexical search
  ladder produced the hit: `exact` (strict AND), `prefix` (prefix AND), or
  `relaxed` (OR/prefix-OR recovery). Omitted for hits with no FTS component
  (e.g. a pure-semantic hybrid match) and for registry hits; surfaced at
  `normal`, `full`, and `--shape agent`

The default brief shape is intentionally small. The exact field set per
detail level (and per `--shape`) is authoritative in
`src/output/shapes/helpers.ts` (`shapeSearchHit` / `shapeSearchHitForAgent`),
assembled into the shape registry by the `src/output/shapes.ts` barrel:

| Level | Local bundle hits | Registry hits |
| --- | --- | --- |
| `brief` (default) | `type`, `name`, `ref`, `action`, `estimatedTokens` | `name`, `installRef`, `score` |
| `normal` | `type`, `name`, `description`, `action`, `score`, `estimatedTokens`, optional `warnings`/`quality`/`keys`/`matchStage` | `name`, `description`, `action`, `installRef`, `score`, optional `warnings` |
| `full` | full hit object (includes `ref`, `origin`, `tags`, `whyMatched`, optional `warnings`, optional `quality`, optional `matchStage`, timings, bundle metadata) | full hit object |
| `--shape agent` | `name`, `ref`, `type`, `path`, `editable`, conditional `editHint`, `description`, `action`, `score`, optional `estimatedTokens`/`keys`/`matchStage` | no local access fields |

`--shape summary` is **not valid on `search`** — see
[`--shape summary`](#--shape-summary) above; it is a usage error (exit 2)
everywhere except `akm show`.

There is no registry `curated` boolean. Renderers surface an optional
`warnings: string[]` field on hits when a provider has non-fatal issues to
report; the field is omitted otherwise. Populating `warnings` does not affect
ranking.

> **Score ranges differ between local and registry hits.** Local
> `SearchHit.score` is a fixed contract value in `[0, 1]`, higher = better.
> Registry `RegistrySearchHit.score`
> is registry-native: provider-defined and may exceed `1` (the bundled
> `static-index` provider can emit values up to ~1.85 from `scoreStash()`).
> Use registry scores only for ranking within a single registry — do **not**
> compare them numerically against local `SearchHit.score` values or across
> registries with different scoring formulas. See
> `docs/architecture/architecture.md` for the current type-level distinction.

### curate

Pick the assets worth loading for a task. Unlike `akm search`, curate attaches
a preview and run details per hit, adds related support refs, and summarizes
the set — the usual starting point for an agent.

```sh
akm curate "plan a release"
akm curate "deploy a Bun app" --limit 3
akm curate "review an architecture proposal" --type skill
akm curate "learn the release workflow" --from all --format text
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `instruction`, `workflow`, `script`, `memory`, `env`, `secret`, `lesson`, `task`, `session`, `fact`, `any` | `any` | Filter curated results by asset type |
| `--limit` | number | `4` | Maximum curated results |
| `--from` | `local`, `registry`, `all` | `local` | Where to search before curating |
| `--track-usage`, `--no-track-usage` | flag | `true` | Record or suppress local usage-event and ranking updates for this successful read |

`akm curate` selects a small relevance-first shortlist. It preserves the
strongest search hits first, uses only small type-aware nudges for close-score
ties, can collapse obvious root/reference families into one top-level result,
and falls back to token searches when the phrase result set is weak. Curate
includes direct follow-up commands such as `akm show <ref>` or `akm bundle add <ref>`
so you can immediately inspect or install what it found.
`--detail` and `--shape agent` both work on curate output; `--shape summary`
does not.
Curate preserves the underlying `searchMode` and deduplicates semantic fallback
warnings across its full-query and token-fallback searches.
Agent-shaped local items include `ref`, `path`, and `editable`, plus `editHint`
only for read-only items. Their `followUp` remains `akm show <ref>` rather than
being replaced by clone guidance.
Use `--type workflow` when you want curated step-by-step procedures instead of
individual scripts, skills, or docs.
`akm curate` is safe to call frequently, including from a hook that fires on
every prompt: it only ever reads the index as it currently stands (the same
non-blocking `ensureIndex()` path `search` uses) and never waits on or
contends with a full `akm index` rebuild in progress.
Use `--no-track-usage` when this inspection must not update local usage or
ranking signals.

### show

Display an asset by ref. On a markdown document `#fragment` selects one
section by heading slug (falling back to case-insensitive heading text); an
unmatched fragment lists the available slugs.

Successful reads record local usage and ranking signals by default; pass
`--no-track-usage` to suppress those updates.

```sh
akm show scripts/deploy.sh
akm show skills/code-review
akm show agents/architect
akm show commands/release
akm show workflows/ship-release
akm show knowledge/guide                 # the whole document
akm show knowledge/guide#authentication  # just that section
akm show '<search-result-ref>' --context lead --max-tokens 800
akm show knowledge/guide#nope            # lists the available fragment slugs

# Bundle .meta/ orientation docs — direct-read, not indexed:
akm show meta                       # working bundle's .meta/index.md
akm show meta:about                 # working bundle's .meta/about.md
akm show akm//meta                  # the primary bundle explicitly
akm show github:owner/repo//meta    # an installed bundle's .meta/index.md

# Multi-tenant scope filtering:
akm show memories/retro --filter user=alice
akm show memories/retro --filter user=alice --filter agent=claude
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--context` | `exact`, `lead` | `exact` | Fragment presentation. `exact` preserves the selected-section behavior. `lead` returns the indexed-safe first fragment followed by `[Selected matching fragment]` and the selected fragment. |
| `--max-chars` | positive integer | `3200` for `lead` | Hard contextual content budget in characters; requires `--context lead` and is mutually exclusive with `--max-tokens`. |
| `--max-tokens` | positive integer | _(none)_ | Approximate contextual budget using four characters per token; requires `--context lead` and is mutually exclusive with `--max-chars`. |
| `--filter` | `<key>=<value>` | _(none)_ | Repeatable scope filter (`user`, `agent`, `run`, `channel`). |
| `--track-usage`, `--no-track-usage` | flag | `true` | Record or suppress local usage-event and ranking updates for this successful read. |

`meta` is not an asset type — `[<origin>//]meta[:<name>]` direct-reads a
human-authored orientation doc from a bundle's optional `.meta/` directory
(`<name>` defaults to `index`; `.meta/<name>.md` is tried before an
extensionless `.meta/<name>`). These files are never indexed, so they do not
appear in `akm search`. See [concepts.md](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md#bundle-orientation-the-meta-convention)
for the full convention.

`--filter` accepts the same `<key>=<value>` shape as `akm search --filter` — one
spelling for the scope-narrowing axis on both commands (`--scope` was removed
in 0.9.0)
(repeatable; valid keys: `user`, `agent`, `run`, `channel`). When supplied,
the resolved asset's frontmatter `scope_*` keys must match every supplied
filter. A mismatch (or absent scope) returns `NotFoundError` so the caller
cannot accidentally read out-of-scope content.

The default `show` JSON includes the asset body when applicable. Canonical
`ref` is always present, in every `--shape` (`human`, `agent`, and `summary`
alike) and at every `--detail` level. Absolute `path` and `editable` are
always present too, at every `--detail` level, in the `human` (default) and
`agent` shapes — `--shape summary` omits both, since it is a compact
capability-discovery view, not an edit-target view. None of `ref`/`path`/
`editable` are gated behind `--detail full`. Use `--detail brief` for a
reduced metadata-first view without `content`/`template`/`prompt`;
`--detail full` adds verbose extras such as `schemaVersion` and, when
`editable` is `false`, `editHint`; `--shape agent` strips non-action metadata
(e.g. `origin`, `tags`) down to the action-relevant field set while still
including `ref`/`path`/`editable`; `--shape summary`
returns a compact view with `type`, `name`, `ref`, `description`, `tags`,
`parameters`, `workflowTitle`, `action`, `run`, `origin`, and `keys`, plus the
optional fragment metadata described below.

Opaque fragment shows and `--context lead` keep `ref` as the canonical parent
identity and add
`selectedRef`, `parentRef`, one-based `fragmentOrdinal`, `fragmentCount`,
`startLine`, `endLine`, optional `previousRef`/`nextRef`, and separate
fragment/parent character and token estimates. Contextual shows also report
`contextMode`, `contextMaxChars`, and `contextTruncated`. Heading aliases are
canonicalized in contextual `selectedRef` to the resolved opaque indexed
selector. Default exact shows through a friendly `#heading` retain their
source-live body and do not attach indexed-safe provenance that could describe
a different revision or projection.

`--context lead` is opt-in and accepts only fragment-qualified indexed Markdown
assets. Both the lead and selected content come from the same line-preserving,
safe indexed revision used by fragment search, even when the source file changes
between search and show. The selected block is labelled and kept last. When the
budget is tight, AKM clips or omits lead content before clipping selected
evidence; `contextTruncated` reports either case.

Returns type-specific payloads:

| Type | Key fields |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` — the whole document, or one section via `#fragment` |
| workflow | `workflowTitle`, `workflowParameters`, `steps` (each step's `orchestration` summary names its engine/model, or — for an [exec step](https://github.com/itlackey/akm/blob/main/docs/reference/workflow-schema.md#what-akm-show-reports-for-an-exec-step) — its `exec.command` and no engine at all) |
| memory | `content` |
| env | `keys` (key names only — values and comment text never returned) |
| lesson | `content` plus `when_to_use` surfaced from frontmatter |

`editable` means current AKM source policy authorizes direct in-place
modification of that exact path. It is computed from current source ownership
and effective `writable` policy, not persisted in the index; unknown paths fail
closed. `editHint` is present only when `editable` is `false`. `akm show` uses
the local index and materialized disk path, with no remote-provider fallback. If
the ref points to a package origin that is not installed, it returns guidance
to run `akm bundle add <origin>` first.

### workflow

Author, inspect, and execute structured workflow assets.

```sh
akm workflow create ship-release --print
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow run workflows/ship-release --version 1.2.3
akm workflow run <run-id>                  # continue an active partial run
akm workflow run workflows/ship-release --new  # start a fresh run even if one is already active
akm workflow status <run-id>
akm workflow status workflows/ship-release
akm workflow status 7c115132               # 8+ char run-id prefix also works
akm workflow resume <run-id>
akm workflow abandon <run-id>
akm workflow list --active
akm workflow list --children               # also list child workflow runs
akm workflow list --all-scopes             # include runs started from a different working directory
akm workflow plan workflows/ship-release    # compile+freeze preview, zero writes
```

Bare `akm workflow` (no subcommand) is a usage error (exit 2), the canonical
bare-group behavior — name a subcommand.

Subcommands:

| Subcommand | Description |
| --- | --- |
| `create <name>` | Validate and write a Markdown workflow under `workflows/`. `--path <dir>` places it in a subdirectory; `--from <file>` imports content; `--force` (requires `--from` or `--reset`) overwrites; `--print` prints the template that would be written instead of writing it |
| `run <run-id\|ref>` | Stable canonical start/resume/execute command. A ref starts a run or resumes the active run in the current scope (announced as `resumed: true`, see below); a run id continues that exact active run. `--new` starts a fresh run even when one is already active. Executes until completion, failure, verification rejection, interruption, or an explicit limit |
| `status <run-id\|ref>` | Show the full run state, including all step statuses. `--units` also lists per-unit rows from the run journal (diagnostics only). Renders a `children:` tree when the run composes child workflows. `--all-scopes` widens the ref-fallthrough lookup (only reached when the target does not resolve to a run id) to every scope instead of just the current one |
| `list` | List workflow runs (optionally filtered by `--ref`; `--active` shows only `status=active` runs, excluding `blocked`/`failed`/`completed`). Child workflow runs are excluded unless `--children` is passed. `--all-scopes` searches every scope instead of only the current one (#942) |
| `resume <run-id>` | Flip a `blocked` or `failed` run back to `active`. Completed runs cannot be resumed |
| `abandon <run-id>` | Mark a run failed so it stops counting as active (`resume` can reopen it) |
| `plan <ref>` | **Evolving.** Compile and freeze a workflow WITHOUT publishing a run: the canonical step graph, per-step frozen target kinds, task/child expansion, input bindings, source read set, and lowering notices — zero durable writes. Returns the full JSON envelope by default, like every other command; pass `--format text` for a human-readable summary |

Everywhere a run id is accepted (`run`, `status`, `resume`, `abandon`), a
unique run-id **prefix** of 8 or more characters works too — the same
convention `akm proposal accept`/`reject` use for proposal UUIDs. A prefix
matching more than one run is a usage error listing every candidate; a
prefix matching none is a not-found error. Only strings shaped like a run id
(hex digits and hyphens, 8+ characters) are ever treated as a prefix, so a
workflow ref is never mistaken for one.

The public `workflow start`, `next`, and `complete` lifecycle was removed in
0.9, along with the experimental `brief`/`report` external-driver protocol.
Use `workflow run` for execution and `workflow status` for inspection. The
removed commands fail with an `UNKNOWN_COMMAND` envelope and a migration hint;
there are no compatibility aliases.

There is also no `akm workflow template`, `validate`, or `watch`.
`workflow create --print` prints a starter, `akm lint --type workflows`
validates it, and `akm log --run <id> --since '@offset:<id>'` provides durable
event polling.

#### workflow run

```sh
akm workflow run workflows/ship-release --version 1.2.3
akm workflow run workflows/review --files a.ts --files b.ts
akm workflow run <run-id> --max-steps 3
akm workflow run <run-id> --max-retries 2 --timeout 10m
akm workflow run <run-id> --skip-if-locked   # for scheduled runs: skip (exit 0) instead of failing on contention
```

Parameter flags must follow the target and exactly match keys declared in the
workflow's `params` frontmatter. AKM coerces each value from the declared JSON
Schema before persisting the run:

- strings retain their exact spelling;
- numbers, integers, booleans, and `null` use their schema types;
- object values are JSON;
- array flags may be repeated (`--files a.ts --files b.ts`) or supplied once as
  a JSON array.

A bare boolean flag means `true`. Hyphen/underscore aliases are not inferred:
declared `include_processes` requires `--include_processes`, not
`--include-processes`. Parameters can be supplied only when a new run is
created; a later invocation against an active run rejects parameter flags.
The old `--params <json>` bag is removed.

| Flag | Description |
| --- | --- |
| `--max-steps <n>` | Stop once this many steps have finished, leaving a partial run active. Must be at least 1. |
| `--max-retries <n>` | When a step fails, reopen the same run and retry the failed step up to this many additional times. Range: 0 through 100; default 0. Gate rejection and interruption are not retried. |
| `--timeout <duration>` | Abort the whole invocation after `N`, `Nms`, `Ns`, or `Nm`; bare `N` is milliseconds. The active step remains resumable. |
| `--new` | Start a fresh run even when one is already active for this ref, instead of resuming it. The existing active run is left untouched — it is never abandoned automatically. A workflow ref only: passing a run id with `--new` is a usage error (exit 2). Parameter flags are allowed together with `--new`, since it is starting a new run. |
| `--skip-if-locked` | If another akm process already holds this run's engine lease (`RUN_LEASE_HELD`), or `state.db` is busy with another writer (`STATE_DB_CONTENDED`), skip gracefully (exit 0) instead of failing (exit 75, `TransientError`). The envelope reports `{ skipped: { reason: "lock-held" \| "state-db-contended", message } }`. Every other failure (a bad flag, an unresolvable target) still fails loudly regardless of this flag. Use for high-frequency scheduled runs so they don't pile up failures while a longer-running invocation is in progress — same family as `improve --skip-if-locked`. |

**Resuming an active run is announced, not silent.** Passing a ref that
already has an active run in the current scope resumes that run rather than
starting a new one (unchanged since #485) — but the envelope now carries
`resumed: true` alongside the resumed run's `run.id`, and the default text
output leads with `resuming existing run <id> for <ref>; pass --new to start
a fresh run`. Pass `--new` to start a second, independent run instead.

The result includes the current `run`, an `executed` step report list, a
`stepsProcessed` count of the steps that finished, and optional `done`,
`gateRejection`, `aborted`, or `timedOut` markers. A failed run, rejected
verification gate, timeout, or interrupt exits nonzero. `SIGINT` and `SIGTERM`
map to 130 and 143; a timeout maps to exit 1. Reaching `--max-steps` with an
active resumable run is successful. A `--timeout` that lands during the run's
final bookkeeping is not reported as a timeout: a run that reached `completed`
has nothing left to abort and nothing left to resume.

**What `--max-steps` counts.** The budget is spent by the **steps that
finish** — completed, failed, or gate-rejected with the loop budget spent — not
by entries in the `executed` report, which gains one per gate-loop iteration
and one per route-skip. So a step's whole bounded `gate.max_loops` loop costs
one, a route-skipped step costs nothing (no work was dispatched for it), and a
step the invocation left unfinished — an abort, a verification-judge outage —
costs nothing either, because the next invocation still owes that work.
`--max-retries` subtracts the same way: a reopened run's remaining budget is
not shrunk by loops or skips.

The budget is checked **between** steps, so it does not bound what any single
step dispatches — a step's gate loop runs to its own limit no matter how little
budget is left. `gate.max_loops` (1–100) is the per-step ceiling;
`budget.max_units` and `budget.max_tokens` are the whole-run ceilings, seeded
from the unit journal so they hold across resumes.

`run` is Stable and does not consult `experimental.workflowEngine`. Every
non-empty `### gate` requires `workflow.judgeEngine` to name a configured LLM
or agent engine before a new run can be frozen. Gate evaluation is fail-closed.

Workflow runs are scoped to the current working context, not globally across all
repos or directories. akm resolves that context from the nearest `.akm/config.json`
ancestor when present, otherwise the nearest git root, otherwise the bundle root
when the cwd is inside it, otherwise the cwd itself. In practice this means:

- `workflow run workflows/<name>` resumes the active run for the current project/worktree/directory (announced with `resumed: true`), or starts one when none is active. `--new` always starts a fresh run.
- `workflow status workflows/<name>` resolves the most-recently-updated run in the current scope only, unless `--all-scopes` is passed.
- `workflow list` shows runs for the current scope only, unless `--all-scopes` is passed. Its envelope always carries a top-level `scopeKey` naming the scope that was searched (`null` under `--all-scopes`), so an empty `runs: []` is never indistinguishable from "nothing anywhere".
- Direct run-id commands like `workflow status <run-id>`, `workflow resume <run-id>`, and `workflow abandon <run-id>` still work even if the run was started from another directory.
- Starting a ref by name (`workflow run workflows/<name>`) never collides across scopes — each scope can hold its own active run of the same ref — but if an active run of that ref exists in a *different* scope, the started run's envelope carries a `warnings[]` entry naming that run's id, scope, and start time, with the `akm workflow run <id>` / `akm workflow abandon <id>` remedy, so a stray run in another scope does not go unnoticed (#942).

#### workflow create

```sh
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow create ship-release --from ./ship-release.md --force
akm workflow create ship-release --force --reset
akm workflow create ship --path release          # writes workflows/release/ship.md
```

| Flag | Description |
| --- | --- |
| `--path <dir>` | Relative subdirectory under `workflows/` to place the workflow in. The filename comes from `<name>`. |
| `--from <file>` | Import and validate a Markdown workflow from an existing file |
| `--force` | Overwrite an existing workflow. Requires `--from` or `--reset`. |
| `--reset` | Explicitly replace an existing workflow with a fresh template (use with `--force`) |
| `--print` | Print the Markdown template without creating anything |

`--force` requires either `--from <file>` (replace from a source file) or
`--reset` (explicitly acknowledge you are overwriting in place). Without one of
these, `--force` is rejected to prevent silent template overwrites.

`<name>` itself must be **flat** — `^[a-z0-9][a-z0-9._/-]*$` after combining
with `--path`, but the bare `--name` positional is rejected if it contains a
`/`. Hierarchical placement (`release/ship`) goes through `--path release
--name ship`, the same convention every other `create` command
(`knowledge`, `env`, `secret`, …) uses — `akm workflow create release/ship`
directly is a usage error (exit 2).

**Snapshot isolation:** `workflow run` compiles and freezes the workflow plan
when it creates a run. Edits to the source workflow after that point do not
affect the in-flight run.

#### workflow status

```sh
akm workflow status <run-id>
akm workflow status workflows/ship-release
akm workflow status <run-id> --units    # also list per-unit rows from the run journal
akm workflow status workflows/ship-release --all-scopes  # resolve across every scope, not just the current one
```

Accepts a run id, a unique 8+ character run-id prefix, or a workflow ref.
When given a workflow ref, resolves to the most-recently-updated run for that
ref in the current working scope, unless `--all-scopes` is passed (only
relevant when the target does not resolve to a run id; a run id is always
scope-agnostic, `--all-scopes` or not, #942). `--units` adds per-unit rows
(unit id, status, failure reason, and any result/error diagnostic text) from
the run journal — diagnostics only; step evidence stays deterministic and is
unaffected.

#### workflow plan

```sh
akm workflow plan workflows/release
akm workflow plan workflows/release --format json
```

**Evolving** (see [STABILITY.md](../../STABILITY.md)). Compiles, resolves,
and freezes the named workflow exactly as `akm workflow run` would when
starting a new run — the same two calls, `loadWorkflowAsset` +
`compileResolveFreezeWorkflowV4` — and stops. It publishes **no** run row,
takes **no** lease, appends **no** event, and writes to no other table:
zero durable writes, verified by row count before and after, not merely
assumed. Use it to preview what a run *would* freeze — the canonical step
graph, which steps expand through a task or a composed child workflow, and
any freeze-time lowering notices or compile warnings — before committing to
a run, or to inspect a workflow's shape without side effects.

Two output modes:

- **No `--format`** (the default for this command only — every other verb
  defaults to JSON): a human-readable text summary.
- **`--format json`**: the full envelope — `ok`, `ref`, `title`,
  `sourceFormat`, `sourcePath`, `irVersion`, `planHash`, `published` (always
  `false`, so a consumer can never mistake this for a run envelope),
  `execution`, `budget?`, `params?`, `outputs?`, `steps[]`, `sourceReadSet[]`,
  `notices[]`, `warnings[]`. Each step entry carries an `expansion` field
  naming how its target was reached: `{via: "direct"}`, `{via: "task",
  taskRef}`, or — for a step composing a child workflow —
  `{via: "child", childRef, childPlanHash, childOutputs, steps[]}` with the
  child's own step list nested recursively in the same shape.

Text-mode example:

```
workflow: team//workflows/release (markdown)
source:   workflows/release.md
plan:     irVersion 5, hash 4f2ba91c3d0e… (not published)
limits:   maxConcurrency 4; budget max_units 50, max_tokens 100000
params:   channel, version
outputs:  report <- steps.summarize.output
steps:
  1. notify   [command]        direct
  2. build    [script]         via tasks/plan-v4-task
  3. dispatch [child-workflow] -> workflows/release-checklist (plan 91acbe20f5d1…)
       with: channel="stable" (literal), files <- steps.build.output.files (reference)
       exports: report, changed_count
       3.1 verify [command] direct
  4. summarize [command]       direct
read set:
  workflows/release.md
  commands/notify.md
  workflows/release-checklist.md
```

**Secret-free by construction.** Neither mode ever prints a resolved
reference value (references resolve at pre-attempt, not here), request
content (`request.command.content`, `request.persona`, `request.conversation`,
`request.runtime.environment`), a script's `bytesBase64`, or any credential —
only binding *shapes* (`inputBindings[].name`/`.kind`, a literal's `.value`,
a reference's `.from`), environment binding *names* (`environment[].kind`/
`.name`, an `env-ref`'s `.ref`/`.keys`/`.secretNames`), and engine *names*
(`gate.judgeEngine`).

#### workflow resume

```sh
akm workflow resume <run-id>
```

Flips a `blocked` or `failed` run back to `active`. Completed runs cannot be
resumed. Use `workflow list` to find runs by status.

Workflow markdown contract:

- Frontmatter carries the asset envelope and orchestration graph (`params`,
  `steps`, `defaults`, and `budget`).
- Every `## <step-id>` heading must name a declared step exactly. Unit and map
  steps require a section; route-only steps may omit one.
- An optional `### gate` inside a step section carries its gate rubric. Omitted
  or empty rubric text skips validation.

See [Workflows](workflows.md) for the complete authoring contract.

### How `bundle add` works

`akm bundle add` infers what to do from the input:

| Input | What happens |
| --- | --- |
| `akm bundle add ~/.claude/skills` | Registers a local directory as a `filesystem` source |
| `akm bundle add github:owner/repo` | Clones the repo into akm's cache as a `git` source |
| `akm bundle add @scope/pkg` | Installs the npm package as an `npm` source |
| `akm bundle add https://docs.example.com` | Crawls and caches a website as a `website` source |
| `akm registry add <url>` | Adds a discovery registry (separate concept) |

HTTP(S) URLs on known Git hosts, and URLs ending in `.git`, are treated as git
sources. Other HTTP(S) URLs are crawled as website sources.

### bundle add

Add a source — a local directory, npm package, GitHub repo, git URL, or website.
akm detects the bundle's **format** automatically (its own native workspace,
a Claude Code or OpenCode tool directory, an OKF or LLM-wiki knowledge base,
…) — see [Bundle Types](bundle-types.md) for how detection works and what
each format gives you.

```sh
akm bundle add ~/.claude/skills              # Local directory
akm bundle add @scope/pkg                    # npm package
akm bundle add npm:@scope/pkg@latest         # npm with version
akm bundle add github:owner/repo#v1.2.3     # GitHub with tag
akm bundle add https://github.com/owner/repo
akm bundle add git+https://gitlab.com/org/bundle
akm bundle add ./path/to/local/bundle
akm bundle add github:andrewyng/context-hub --name context-hub  # context-hub as a git bundle
akm bundle add https://docs.example.com --name docs
akm bundle add https://docs.example.com --max-pages 100 --max-depth 5
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly name for the source |
| `--provider` | Explicit provider for declarative source configuration; normally inferred from the input |
| `--writable` | Mark a git source as writable so `akm sync` also pushes (default: false) |
| `--options` | Provider options as JSON (e.g. `'{"ref":"main"}'`) |
| `--allow-insecure` | Bypass plain-HTTP source rejection **and** dangerous env key blocking. Accepts two risks: (1) plain-HTTP download without TLS, (2) env keys that can hijack process execution. Use only after reviewing the bundle manually |
| `--max-pages` | Maximum pages to crawl for website sources (default: 50) |
| `--max-depth` | Maximum crawl depth for website sources (default: 3) |

#### Dangerous env key audit

When `akm bundle add` installs a bundle that contains env files, it recursively scans
every `.env`-suffixed file under `env/` (the same "real env file" test used
everywhere else — a bare `.env` or any name ending `.env`, at any depth) for
environment variable names that can be used for process-execution hijacking. A
non-`.env` file under `env/` (e.g. `env/notes.txt`) is never scanned — such a
file is never sourced as environment variables by any akm codepath, so a
dangerous key sitting in its contents cannot hijack anything. The flagged key
set is 41 literal names plus 2 regex pattern families (`src/commands/lint/env-key-rules.ts`):
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_DEBUG`, `LD_BIND_NOW`,
`LD_PROFILE`, `LD_ASSUME_KERNEL`, `LD_TRACE_LOADED_OBJECTS`,
`DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `PATH`,
`BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PS1`, `PS2`, `IFS`, `ZDOTDIR`,
`NODE_OPTIONS`, `NODE_PATH`, `NODE_TLS_REJECT_UNAUTHORIZED`, `PYTHONSTARTUP`,
`PYTHONPATH`, `PYTHONINSPECT`, `PYTHONHOME`, `PYTHONNOUSERSITE`, `RUBYLIB`,
`RUBYOPT`, `PERL5LIB`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`,
`_JAVA_OPTIONS`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`,
`GIT_EDITOR`, `EDITOR`, `VISUAL`, and `PAGER` (41 literals), plus any key
matching `^BASH_FUNC_` (Shellshock-class injection) or `^GIT_CONFIG_` (git
config override injection).

When dangerous keys are found, `akm bundle add` pauses and prompts for
confirmation (default: No). In non-interactive mode (CI, scripts) the
install fails with **exit 1** unless `--allow-insecure` is passed, and the
freshly-installed bundle is rolled back before the process exits.

```sh
# Interactive: prompts before continuing
akm bundle add github:owner/repo-with-sensitive-env

# Non-interactive: fails unless bypassed
akm bundle add github:owner/repo-with-sensitive-env --allow-insecure
```

Bundle publishers: see the [Author Bundles guide](https://github.com/itlackey/akm/blob/main/docs/guides/author-bundles.md#env-security)
for guidance on env files that legitimately need these keys.

#### Website sources

An HTTP(S) URL outside known Git hosts is treated as a website source. akm
crawls the site breadth-first from the given URL, converts each page to markdown,
and stores the results as knowledge assets with the URL path hierarchy preserved.

```sh
akm bundle add https://www.agentic-patterns.com/ --name agent-patterns
akm bundle add https://docs.example.com/guide --name guide --max-pages 200
```

Pages are cached locally and refreshed every 12 hours. The crawl stays within
the same origin (hostname) and skips static assets (images, CSS, JS, etc.).

Use `--max-pages` and `--max-depth` to control how many pages are fetched and
how many link levels deep the crawler goes. These values are persisted in your
config so subsequent re-indexes use the same limits.

See [registry.md](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md) for the full install flow for managed sources.

> **Note:** there is no `akm bundle add context-hub` convenience alias or `akm
> enable`/`disable context-hub` command — add it explicitly as a git bundle:
> `akm bundle add github:andrewyng/context-hub --name context-hub`. A bundle *type*
> string of `"context-hub"` in an existing config still normalizes to
> `"git"` at load time, so you don't need to edit your config files.

### bundle list

Show all sources — local directories, managed packages, and remote providers.

```sh
akm bundle list                            # All sources
akm bundle list --kind filesystem          # Only plain filesystem/local directory sources
akm bundle list --kind git                 # Only git sources
akm bundle list --kind npm                 # Only npm-managed sources
akm bundle list --kind website             # Only crawled website sources
akm bundle list --kind filesystem,git      # Multiple kinds (comma-separated)
```

| Flag | Description |
| --- | --- |
| `--kind` | Filter by source provider: `filesystem`, `git`, `npm`, `website` (comma-separated). Any other value is a usage error (exit 2) — there is no `local`/`managed`/`remote` grouping. |

### bundle remove

Remove a source by id, ref, path, URL, or name and reindex.

```sh
akm bundle remove npm:@scope/pkg           # Managed source by id
akm bundle remove owner/repo               # Managed source by ref
akm bundle remove ~/.claude/skills         # Local source by path
akm bundle remove my-provider              # Any source by name
akm bundle remove my-provider --yes        # Skip the confirmation prompt
```

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Skip the confirmation prompt |

### bundle update

Update one bundle, or refresh every configured bundle with `--all`. Git, npm,
and website candidates are staged and audited before they replace the active
generation. Filesystem bundles require no hydration; update reconciles their
current files into the index immediately.

```sh
akm bundle update npm:@scope/pkg
akm bundle update --all
akm bundle update --all --force   # Force fresh download even if version is unchanged
akm bundle update --all --yes     # Skip confirmation when an update needs to delete a moved install dir
akm bundle update npm:@scope/pkg --allow-insecure  # Explicitly approve reviewed dangerous env keys
```

| Flag | Description |
| --- | --- |
| `--all` | Update all managed sources |
| `--force` | Delete cached extraction before re-downloading |
| `--allow-insecure` | Permit a staged update containing dangerous environment keys after warning. Without it, an interactive terminal prompts with a default of No; non-interactive use fails closed. This is independent of `--yes`. |
| `-y`, `--yes` | Skip the confirmation prompt for the rare branch where the resolved content location moved and the previous install directory must be deleted. No effect on a normal refresh, which deletes nothing. |

The audit examines key names in `.env`-suffixed files under the staged
component root. Publisher lint suppressions do not bypass it. Rejection or an
audit/publication/index failure preserves the prior active bytes, lock/config
generation, and searchable index for that bundle.

Writable Git updates resolve configured roots to their physical checkout,
reject component symlinks that escape it, and re-audit the exact materialized
worktree before activation. AKM holds its source/index writer lease through
that check and commit, and rechecks after the index pass at the final database
commit boundary. All AKM writers cooperate with this lease. A non-cooperating
local process can still edit ordinary files because POSIX/Windows filesystems
provide no mandatory recursive directory lock: writes observed by either
generation check make the update fail and restore the pre-update checkout, but
a write racing after the final filesystem read cannot be guaranteed detectable
and a write during compensation can be overwritten. Do not edit a writable
checkout from another process while its update is running.

The index and its update-owned state maintenance share one deferred SQLite
transaction. WAL readers continue to see the last committed generation while a
full update index pass runs, and competing writers wait for that pass to commit
or roll back. The semantic-status JSON file is a recomputable advisory: failure
to refresh it after the database commit warns but does not undo a committed
bundle update.

This boundary guarantees rollback for handled process faults (throws and
SQLite commit failures); it is not an abrupt-termination or cross-database
power-loss guarantee. Both `index.db` and `state.db` remain in WAL mode, where
SQLite does not guarantee an atomic commit across attached database files after
`SIGKILL`, abrupt power loss, or storage failure. The durable outcome may
therefore combine approved old/new source bytes and lock state with adjacent
index/state generations. `akm health` reports `index-state-generation` when a
durable usage link disagrees with the searchable index, but that advisory
cannot identify every theoretical split. Stop concurrent writers, rerun the
targeted bundle update if the checkout/lock is not the intended approved
revision, then run `akm index --full` to rebuild the search index and relink
durable usage state.

Reports per-entry change flags: `changed.version`, `changed.revision`, and
`changed.any`. With `--all`, each bundle is isolated: successful entries appear
in `processed`/`plainSynced`; rejected entries report `status: "blocked"` and a
security code; provider or transaction errors report `status: "failed"`. The
command continues with later bundles without half-publishing a blocked one.

### upgrade

Upgrade `akm` itself to the latest release. Standalone binaries are downloaded,
checksummed, and staged before replacement; npm, Bun, and pnpm global installs
use their package manager.

Upgrade replaces the installed program when a newer release exists, then runs
`akm-migrate apply` — the migrator that shipped with whatever is now installed
— and rebuilds the derived index. The migration step runs on every
`akm upgrade`, install or no install, and its plan is reported under
`migration`; an upgrade whose migration is blocked or could not run exits 1.
That makes `akm upgrade` safe as a container entrypoint: on a current
installation it is a no-op. An akm installed as a dependency of another
package (`installMethod: "package-local"`) is never reinstalled — the parent
package owns that copy — but its migrations still run. Standalone downloads
use a temporary rollback copy only during atomic executable replacement.

Standalone downloads are streamed directly to the staged file while SHA-256 is
computed, with a 256 MiB binary limit. Release/checksum metadata is capped at
1 MiB; an oversized response is cancelled and the staged file is removed.

```sh
akm upgrade              # Install a newer release if there is one, then run every pending migration
akm upgrade --check      # Check for updates without installing (no migration step)
akm upgrade --force      # Force the install even if already on latest
```

| Flag | Description |
| --- | --- |
| `--check` | Check for updates without installing |
| `--force` | Force upgrade even if on latest version |
| `--skip-post-upgrade` | Skip the post-upgrade index rebuild |

Offline, or to migrate without a release check, run `akm migrate apply`
directly: it is the same step.

Checksum verification is not optional and has no flag. If a release's
`checksums.txt` is genuinely unreachable, the recovery hatch is the
`AKM_UPGRADE_SKIP_CHECKSUM=1` environment variable (Internal — deliberately
not a discoverable, tab-completable flag). See STABILITY.md.

Shipping akm inside your own product (a Docker image, a plugin's own
`node_modules`)? See [Bundling akm](../integration/bundling-akm.md) for the
full boot contract, JSON shapes, and exit codes.

`akm upgrade` replaces the binary in place for its own install method, but a
scheduler binding recorded by an earlier `akm task sync` under a *different*
install method is not repointed automatically — the scheduler runs the
binary path recorded at sync time, not whichever akm `upgrade` just
installed. Run `akm task sync` after switching installers so scheduled runs
pick up the new binary; see [`task sync`](#task) and `akm health`'s
`scheduler-binary` advisory.

### clone

Copy an asset from any source into a managed writable bundle or an unmanaged
custom destination for editing.

```sh
akm clone scripts/deploy.sh
akm clone "npm:@scope/pkg//scripts/deploy.sh"
akm clone scripts/deploy.sh --name my-deploy.sh
akm clone scripts/deploy.sh --force
akm clone scripts/deploy.sh --bundle team-bundle
akm clone scripts/deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//scripts/deploy.sh" --dest /tmp/preview
```

| Flag | Description |
| --- | --- |
| `--name` | New name for the cloned asset |
| `--force` | Overwrite if the asset already exists at the destination |
| `--bundle <name>` | Managed destination bundle. When omitted, clone falls back to `defaultWriteTarget`, then the working bundle |
| `--dest <path>` | Unmanaged destination directory. Bypasses managed target resolution and cannot be combined with `--bundle`; the type subdirectory is appended automatically |

Skills (directories) are copied recursively. Other types copy a single file.

**Remote clone:** When the origin in the ref points to a package that is not
installed locally (e.g. an npm package or local path not in your bundle
sources), akm fetches it to the cache automatically and extracts the
requested asset. The package is **not** registered as a managed source --
use `akm bundle add` for that.

```sh
# Clone a single script from a remote package without installing the full bundle
akm clone "npm:@scope/pkg//scripts/deploy.sh"

# Clone from a local directory that isn't configured as a search path
akm clone "/path/to/bundle//skills/code-review" --dest ./project/.claude
```

Without `--dest`, clone uses normal write-target resolution: explicit
`--bundle` -> `defaultWriteTarget` -> working bundle. Managed clones use the
destination bundle's canonical ref and are indexed immediately. When `--dest`
is provided, no managed write target is required, which keeps clone usable in
CI or fresh environments without running `akm setup` first.

### sync

Stage and commit local changes in a git-backed bundle. If the bundle has a
remote configured and is marked `writable: true`, the commit is also pushed.

> **Note:** there is no `akm save` command — use `akm sync`.

```sh
akm sync                            # Sync primary bundle (auto timestamp message)
akm sync -m "Add deploy skill"     # Sync with custom message
akm sync --no-push                  # Commit only; never push even when writable
akm sync --format json             # Explicit format (both --format json and --format=json work)
akm sync my-skills                  # Sync a named writable git bundle
akm sync team/core -m "Update"    # Slash-containing source names are valid selectors
akm sync my-skills -m "Update"     # Sync named bundle with message
```

| Argument / Flag | Description |
| --- | --- |
| `[name]` | Optional git-backed bundle selector. Matches the configured source name exactly and also accepts canonical GitHub aliases such as `owner/repo`, `github:owner/repo`, and branch-ref forms like `github:owner/repo#branch`. Forward slashes are allowed. Defaults to the primary bundle |
| `-m`, `--message` | Commit message. Defaults to `akm save <timestamp>` |
| `--no-push` | Commit only; never push even when the bundle is writable with a remote configured |
| `--format` | Output format (any of the six global values). Both `--format json` and `--format=json` are accepted |

If no positional selector is provided, `akm sync --format json` still targets
the primary bundle. If a positional selector is provided, it wins even when the
value also looks like a format token.

**Behaviour by repo state:**

| State | Result |
| --- | --- |
| Not a git repo | Exit 0, `skipped: true` in JSON output — no error |
| Git repo, no remote | Stage and commit only |
| Git repo, has remote, not writable | Stage and commit only |
| Git repo, has remote, `writable: true` | Stage, commit, and push |
| Any writable repo with `--no-push` | Stage and commit only (push suppressed) |

**Primary bundle writable config:**

To make the primary bundle push on sync, set `writable: true` on its `bundles`
entry in your config file (`~/.config/akm/config.json` or the path shown by
`akm config path`):

```json
{
  "bundles": { "primary": { "path": "~/akm", "writable": true } },
  "defaultBundle": "primary"
}
```

When `writable: true` is set and the primary bundle has a git remote configured,
`akm sync` will stage, commit, and push.

When `akm setup` successfully initializes the default bundle as a local git repo
(requires `git` to be installed), `akm sync` will commit there safely without
pushing. If git is unavailable, the bundle will not be a git repo and sync will
return a skipped result.

To make a named remote git bundle writable, pass `--writable` when adding it:

```sh
akm bundle add git@github.com:org/skills.git --provider git --name my-skills --writable
```

### remember

Record a memory. This writes a markdown file into `memories/` in the configured
write target and returns the resulting ref.

**Write target resolution:** the destination is the working bundle
(`defaultBundle`) unless `defaultWriteTarget` is set in config, which
overrides it to a named source. An explicit `--bundle <name>` flag overrides
both. The full order is `--bundle` → `defaultWriteTarget` → working bundle →
`ConfigError`. See [Configuration](configuration.md#bundles-and-write-target) for
details.

A bundle-qualified mutation ref implies that bundle. In particular, a
qualified `--supersedes team//memories/old` routes the correction and demotion
to `team`; a different explicit `--bundle` is a usage error. Qualified `--xref`
values only identify the cited copy and do not select the write target.

```sh
akm remember "Deployment needs VPN access"
akm remember --name release-retro < notes.md
akm remember "Pair with ops before rotating prod secrets" --name ops/prod-secrets

# With structured frontmatter:
akm remember "VPN required for staging deploys" \
  --tag ops --tag networking \
  --expires 90d \
  --source "skills/deploy"

# Opt-in heuristic tagging — derives `code`, `source`, `observed_at`, `subjective`:
akm remember "Found this snippet: \`curl -fsSL ... | bash\`" --tag ops --auto

# Opt-in LLM enrichment (requires configured LLM endpoint; fails soft):
akm remember "Long meeting notes..." --enrich

# Multi-tenant / multi-agent scope:
akm remember "Use staging cluster for blue-green" \
  --user alice --agent claude --run run-42 --channel "#ops"

# Cite provenance / related assets in frontmatter `xrefs:` (validated at write time):
akm remember "The token rotation quirk applies to staging too" \
  --xref knowledge/auth/vendor-x-token-api \
  --xref memories/projectA/token-quirk

# Correct an existing memory: write the fix AND demote the stale incumbent
# (beliefState: superseded + supersededBy on the old asset, in one step):
akm remember "Staging now uses the new gateway endpoint" \
  --name new-endpoint --supersedes memories/projectA/old-endpoint

# Route the write to a specific writable bundle:
akm remember "Deployment needs VPN access" --bundle team-bundle
```

| Flag | Description |
| --- | --- |
| `--name` | Optional memory name. Defaults to a slug derived from the content |
| `--force` | Overwrite an existing memory with the same name |
| `--description <text>` | Short description written to frontmatter (persisted as the memory's `description` field). Honoured by both the zero-flag form and the tagged form. |
| `--tag <v>` | Tag to attach to the memory. Repeatable: `--tag foo --tag bar` |
| `--expires <dur>` | Expiry shorthand (`30d`, `12h`, `6m`). Resolved to an ISO date |
| `--source <s>` | Free-form source reference — URL, asset ref, file path, or any string |
| `--xref <ref>` | Cross-reference ref recorded in the memory's `xrefs:` frontmatter list. Repeatable: `--xref knowledge/auth-flow --xref memories/vpn-note`. Each ref must resolve in the write target or a configured source (read-only sources count); an unresolvable ref fails with exit 2 before anything is written. More than 5 refs warns (soft cap) but still writes. Does not trigger the tags-required check. |
| `--supersedes <ref>` | Ref of an existing asset this memory corrects. Repeatable. Writes the correction with the old ref folded into its `xrefs:` (correction provenance) AND demotes the old asset — `beliefState: superseded` + `supersededBy: [<new ref>]`, a metadata-only frontmatter edit that preserves every other key and the body — then reindexes it so ranking prefers the correction and `--belief current` hides the stale version immediately. An unresolvable ref fails with exit 2 before anything is written or demoted; so does a ref naming the asset being written itself (a correction cannot supersede itself, e.g. `--force` overwriting the same name). A ref that resolves only outside the write target and the working bundle still writes the correction but skips the demotion: stderr warns and the JSON output reports `superseded: [{ref, applied: false, reason}]` — the reason names the `--bundle` remedy when the old asset lives in a configured writable source. An old asset whose existing frontmatter is not parseable YAML is skipped the same way (`applied: false`) instead of being rewritten lossily. Re-running the same correction is idempotent. On a git write target the correction and the demoted old asset land in the same single boundary commit. |
| `--auto` | Apply heuristic tagging from the body (opt-in, zero-latency, pure TS) |
| `--enrich` | Call the configured LLM for tag/description proposals (opt-in, 10s timeout, fails soft) |
| `--user <id>` | Scope this memory to a user id. Persisted as the canonical `scope_user` frontmatter key. |
| `--agent <id>` | Scope this memory to an agent id. Persisted as `scope_agent`. |
| `--run <id>` | Scope this memory to a run id. Persisted as `scope_run`. |
| `--channel <name>` | Scope this memory to a channel name. Persisted as `scope_channel`. |
| `--bundle <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working bundle. |

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
`akm search --filter` and `akm show --filter`.

**Cross-references** (`--xref`) implement the bundle back-linking conventions'
provenance channel: the refs land in the memory's `xrefs:` frontmatter list,
which the indexer folds into the asset's search hints, so the new memory is
findable from searches for its source. Refs are validated before anything is
written — against the write target plus every configured source, including
read-only cross-bundle sources — so a typo'd ref fails fast (exit 2) instead
of becoming permanent silent noise. When a write lands at the type root (no
`--path`, flat name) in a bundle that carries convention facts, the JSON output
includes an additive `hint` key pointing at the bundle's placement conventions.

**Corrections** (`--supersedes`) implement the conventions' two-write
corrections pattern in one command: the new asset is written with an xref to
what it corrects, and the old asset gets a metadata-only demotion
(`beliefState: superseded` + `supersededBy: [<new ref>]`) that the write path
reindexes immediately. A qualified superseded ref selects that bundle as the
write target. Same-bundle frontmatter edges remain short; cross-bundle edges stay
qualified. The old asset is demoted only when it lives in the
write target or the working bundle — a match in any other configured source
(read-only, or writable but not this write's target) is reported as
`applied: false` (with a stderr warning) while the correction still writes;
so is an old asset whose existing frontmatter is not parseable YAML, which a
demotion rewrite would corrupt. Validation happens before any write, so a
typo'd ref, or a ref naming the asset being written itself (exit 2), leaves
both assets untouched — no partial correction.

### import

Import a knowledge document. This writes a markdown file into `knowledge/` in
the configured write target and returns the resulting ref. The source may be a
file path, a single HTTP/HTTPS URL, or `-` for stdin.

**Write target resolution:** the destination is the working bundle
(`defaultBundle`) unless `defaultWriteTarget` is set in config, which
overrides it to a named source. An explicit `--target <name>` flag overrides
both. The full order is `--target` → `defaultWriteTarget` → working bundle →
`ConfigError`. See [Configuration](configuration.md#bundles-and-write-target) for
details.

```sh
akm import ./docs/auth-flow.md
akm import ./notes/release.txt --name release-checklist
akm import - --name scratch-notes < notes.md
akm import https://example.com/docs/auth

# Cite provenance in the document's frontmatter `xrefs:` (validated at write time):
akm import ./notes/oauth-quirks.md --xref knowledge/auth/vendor-x-token-api

# Import a corrected doc AND demote the one it replaces (in one step):
akm import ./notes/modern-guide.md --supersedes knowledge/legacy-guide

# Route the write to a specific writable bundle:
akm import ./docs/auth-flow.md --target team-bundle
```

| Flag | Description |
| --- | --- |
| `--name` | Optional knowledge name. Defaults to the source filename, URL path, or a slug from stdin content |
| `--force` | Overwrite an existing knowledge document with the same name |
| `--target <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working bundle. |
| `--xref <ref>` | Cross-reference ref merged into the document's `xrefs:` frontmatter list. Repeatable. A document without frontmatter gains a block; a document with valid frontmatter keeps every existing key and value and gets the refs dedupe-appended (never a nested second block). Each ref must resolve in the write target or a configured source; an unresolvable ref fails with exit 2 before anything is written. If the document's existing frontmatter is not a parseable YAML mapping, the import fails (exit 2) rather than rewriting the block lossily — fix the frontmatter or import without `--xref`, which preserves the file verbatim. |
| `--supersedes <ref>` | Ref of an existing asset this document corrects. Repeatable. Imports the correction with the old ref merged into its `xrefs:` AND demotes the old asset (`beliefState: superseded` + `supersededBy: [<new ref>]`, a metadata-only frontmatter edit), then reindexes it. Same validation (including the self-supersede rejection), skipped-demotion (`applied: false`), idempotence, and git-boundary-commit behaviour as on `remember` (see above). |

URL imports fetch only the exact page you pass, convert it to markdown, and do
not register a persistent website source. The default knowledge name comes from
the URL path (for example, `/docs/auth` -> `knowledge/docs/auth.md`).

The source must be a readable file path, a reachable HTTP/HTTPS URL, or `-` to
read the document from stdin.

`--xref` behaves as on `remember` (validated refs, soft ~5 cap, additive
`hint` output key on type-root writes), with one import-specific rule: because
imported documents may already carry frontmatter, the refs are **merged** —
existing keys are preserved and the `xrefs:` list is dedupe-appended, so the
result always has exactly one frontmatter block. The merge requires the
existing block to parse as a YAML mapping; a malformed block aborts the import
(exit 2, nothing written) instead of silently flattening the values the parser
could not read. Importing the same document *without* `--xref` always
preserves it byte-for-byte.

### feedback

Record positive or negative feedback for any indexed bundle asset. Feedback
influences utility scores during the next index run, causing highly-rated
assets to rank higher in search results over time.

```sh
akm feedback scripts/deploy.sh --positive
akm feedback agents/reviewer --negative
akm feedback memories/deployment-notes --positive
akm feedback env/prod --positive
akm feedback skills/code-review --positive --reason "Worked perfectly for PR reviews"
akm feedback skills/code-review --negative --failure-mode outdated --reason "references a removed flag"
akm feedback skills/code-review --negative --reason "flaky" --tag slice:train --tag team:platform
```

| Flag | Description |
| --- | --- |
| `--positive` | Record positive feedback (use when an asset was helpful) |
| `--negative` | Record negative feedback (use when an asset was not useful) |
| `--reason` | Optional text reason to attach to the feedback event (required for negative feedback by default) |
| `--failure-mode` | Structured failure-mode taxonomy for negative feedback: `incorrect`, `outdated`, `dangerous`, `incomplete`, `redundant`. Stored alongside `--reason` in event metadata for the distill pipeline. |
| `--tag` | Tag to attach to the feedback (repeatable, e.g. `--tag slice:train --tag team:platform`) |
| `--applied-to <ref>` | Credit a `lessons/<name>` lesson that helped resolve this task. When combined with `--positive`, appends this feedback ref to the target lesson's `lessonStrength[]` frontmatter array (dedup, idempotent). A non-lesson target, or a missing `--positive`, produces a warning rather than silently doing nothing. |

Specify exactly one of `--positive` or `--negative`. The ref must already be
present in the current local index.

The `--applied-to` flag drives the lesson-strength ranking signal: lessons that
have demonstrably helped resolve tasks receive a small additive ranking boost
(capped at +0.3) so they float to the top of search.

### log

Append-only realtime events stream (#204). Every mutating CLI verb appends an
event row to `<dataDir>/state.db`; `akm log` reads it.

> **Note:** there is no `akm events` command, and no `akm history` command —
> use `akm log`. There is no `akm log tail` either (0.9.0: dropped — a
> foreground polling daemon in a one-shot CLI); poll `--since
> '@offset:<id>'` from a cooperating process instead.

```sh
akm log                                      # All events, oldest first
akm log --type feedback                      # Filter by event type
akm log --ref skills/deploy                   # Filter by asset ref
akm log --since 2026-04-01T00:00:00Z         # ISO timestamp
akm log --since '@offset:12345'              # Resume from a row-id cursor
akm log --limit 20                           # Only the 20 most recent events (unlimited by default)
akm log --run <run-id>                       # Only events for one workflow run
```

| Flag | Description |
| --- | --- |
| `--since` | Lower bound. Accepts ISO 8601, epoch ms, or `@offset:<id>` for a durable row-id cursor that survives across processes. |
| `--type` | Filter by event type. Common values include `add`, `remove`, `update`, `remember`, `import`, `sync`, `feedback`, `promoted`, `rejected`, `propose_invoked`, `reflect_invoked`, `distill_invoked`, `select`, and `improve_skipped`. |
| `--ref` | Filter by asset ref (`[bundle//]conceptId`). |
| `--run` | Filter to one workflow run's events (`metadata.runId`) — the replacement for the dropped `akm workflow watch <run-id>`. Poll with `--since '@offset:<id>'` for a live tail; there is no daemon. |
| `--limit` | Return only the most recent N events matching every other filter. Default: unlimited. |
| `--include-tags` | Only include events with ALL these tags (repeatable). |
| `--exclude-tags` | Exclude events matching these tags (repeatable). |

The envelope echoes a `nextOffset` row-id cursor — persist it and pass it
back as `--since '@offset:<nextOffset>'` to resume from exactly where you
stopped, with no duplicates and no losses, even across process boundaries
(poll on an interval from a cooperating process if you need to follow the
stream live).

#### Environment isolation

The events stream lives in `<dataDir>/state.db`, where `<dataDir>` is derived
from `XDG_DATA_HOME` (or `AKM_DATA_DIR`) at the time of each call. Two
processes with different inherited data-dir env values write to different
databases; if the events stream is being used as a shared bus between
cooperating processes, set those env vars consistently across them.

### registry

Manage bundle registries. The `registry` command has three subcommands: `list`,
`add`, and `remove`. Searching registries is `akm search --from registry`
(0.9.0: `registry search` was dropped in favor of it — see [search](#search)).

Building a registry index is maintainer tooling, not a CLI command — see
`bun scripts/build-registry-index.ts` in the akm repository.

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
akm registry remove my-team --yes    # Skip the confirmation prompt
```

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Skip confirmation prompt |

### migrate

Inspect or apply every pending migration in one plan. `akm migrate` is a thin
wrapper over the standalone `akm-migrate` executable (installed alongside
`akm`, and embedded in the release binary), which owns every historical shape
akm has ever written so the CLI proper reads only current schemas. The steps,
in order:

1. legacy config `extraParams` keys lifted onto first-class engine fields
   (`configExtraParams`);
2. pending `state.db` migrations, historical-destructive ones included, with
   a verified sibling safety copy (`stateMigrations`) — the only path besides
   `akm upgrade` that admits released migration 018, which an ordinary
   command refuses;
3. task-v2 files to task v3, then task-v3 files to task source v4
   (`taskV3Migration`, `taskV4Migration`), each keeping its own lock, backup,
   prevalidation, and rollback, so a file blocked in the first generation does
   not stop the second from converting files already at `version: 3`;
4. superseded pre-0.9.0 `.akm` residue and stale filesystem transactions
   (`deadResidue`, `staleTxns`).

```sh
akm migrate status
akm migrate apply --dry-run
akm migrate apply
akm-migrate apply          # the same, without the akm wrapper
```

`status` and `apply --dry-run` are read-only. Apply skips blocked task
sources rather than failing (and exits 1 while any remain), backs up each
changed file immediately before replacement, and atomically publishes strict
task source v4 YAML; it is idempotent, so a current installation is a no-op.
`akm upgrade` runs `apply` after its install step. See [Tasks: Migrating to
task source v4](tasks.md#migrating-to-task-source-v4) for the full
blocked-reason table and worked examples, and
[Bundling akm](../integration/bundling-akm.md) for the plan JSON shape and
how to drive this from a container/image boot step.

### config

Read and write configuration. Bare `akm config` (no subcommand) is a usage
error (exit 2), the canonical bare-group behavior — name a subcommand.

```sh
akm config list                     # List current config
akm config get output.format        # Read one key
akm config get output.format --show-source  # Read one key, with where it came from
akm config set output.detail full   # Set one key
akm config set output.detail full --silent  # Set without the post-write config dump on stdout
akm config unset llm                # Remove an optional key
akm config path                     # Print path to config file
akm config path --all               # Print all config-related paths
akm config diff other-host/config.json  # Effective-config differences, secrets redacted
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `get <key>` | Read one config key (the effective, post-`extends` value). `--show-source` wraps it as `{ value, source }`, where `source` is `local`, `extends:<ref>`, or `default`. |
| `list` | List current configuration |
| `set <key> <value>` | Set one config key; prints the resulting config with `ok: true` |
| `unset <key>` | Unset an optional key, or a whole `embedding`/engine section; prints the resulting config with `ok: true` |
| `path` | Show paths to config, bundle, cache, and index. `--all` prints every path; without it, just the config path. Load-bearing: `config path` is the one subcommand the CLI still allows to run when the on-disk config itself fails to load, so you always have a way to locate a broken config. |
| `diff <path\|bundle//path>` | Compare this instance's effective config (its own `extends` already applied) against another config file or bundle-relative file (loaded through the same loader — its `extends` honoured too); prints sorted `{ path, local, other }` rows for every differing leaf, secrets redacted on both sides. |

`set` and `unset` accept `--silent` to suppress the post-write config dump
entirely — nothing is printed on stdout, and the exit code is the status (the
write still happens and errors still print) — use it from hooks and CI
scripts.

See [configuration.md](configuration.md)'s "Sharing configuration across
installs" for the `extends` config key that `diff` and `get --show-source`
work with.

> **Removed in 0.9.0:** `akm config enable`/`akm config disable`. Use
> `akm registry add|remove` to toggle a registry, the general mechanism.
> `akm config show` (an alias of `list`) and `akm config validate` (load-time
> schema checks already reject an invalid config) were also removed.

See [configuration.md](configuration.md) for details.

### models

Manage the installed and operator-owned model intent map. Bare `akm models`
is a usage error; use `list` to inspect the effective table or `copy-defaults`
when you want an editable full map.

```sh
akm models list
akm models copy-defaults
akm models copy-defaults --overwrite
```

`list` shows the fully resolved alias table — one row per (alias, column)
pair with its `model`, optional `inference`, `source` (`default`: unchanged
from the installed file; `user`: touched by the user overlay), and `via`
(`literal`: a model string; `engine`: borrowed from a configured
`engines.<name>` connection, in which case the row also names that `engine`).
Read-only; it never writes `models.json`.

`copy-defaults` validates the packaged version-1 `models.json`, then stages and
syncs it beside the normal AKM configuration target. Creation uses an atomic
no-replace publish and fails safely on filesystems that cannot provide it.
`--overwrite` performs an atomic pathname replacement after a best-effort
regular-file identity recheck; it never dereferences a symlink, but portable
filesystems do not offer a conditional rename that locks the previously
observed inode. Symlinks and other non-regular targets observed during checks
are refused. See
[Model-map files](configuration.md#model-map-files) for schema, overlay, and
resolution semantics — including the `engine` field (0.9.15) that lets a
column borrow its model from a configured engine instead of a literal string.

### help

Print the sectioned command overview, detailed help for any command, agent
usage instructions, or a release's migration guidance.

```sh
akm help                       # Sectioned command overview (same as `akm --help`)
akm help bundle                # Detailed options and subcommands for `bundle`
akm help env                   # Detailed options and subcommands for `env`
akm help agents                # Agent-facing usage instructions
akm help migrate 0.6.0         # Notes for a specific release
akm help migrate v0.6.0        # v-prefix accepted
akm help migrate v0.6.0-rc1    # Prereleases normalize to the stable note
akm help migrate latest        # Resolve against the most recent CHANGELOG entry
```

`akm help <command>` is equivalent to `akm <command> --help`. Bare `akm help`
prints the same sectioned overview as `akm --help` and exits
`0` — this is the one group where a bare invocation is a complete request,
not the canonical bare-group usage error.

Migration notes live as one markdown file per release in
[`docs/migration/release-notes/`](../migration/release-notes/). Adding notes for a
future version is a one-file drop — no code edit required. Requesting an
unknown version prints the list of bundled notes so you can pick one that
exists. See [`CONTRIBUTING.md`](https://github.com/itlackey/akm/blob/main/.github/CONTRIBUTING.md#shipping-a-release--migration-notes)
for the per-release workflow.

### help agents

Print agent-facing instructions for using `akm`. Add this output to your
`AGENTS.md`, `CLAUDE.md`, or system prompt so your agent knows how to use
the CLI. Prints the short guide by default; pass `--full` for the complete
one.

```sh
akm help agents
```

### hints

Print the agent-facing CLI guide directly. The complete guide is the default;
use `--detail brief` for the compact version. `akm help agents` remains the
short-first form and accepts `--full`.

```sh
akm hints
akm hints --detail brief
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

> **Note:** there is no `akm vault` command — use `env` or `secret`.

### env

Manage `.env`-backed **environment files** — a group of related **configuration**
for an app or service (URLs, feature flags, and any credentials it needs),
loaded together. Each `env` asset is an entire `.env` file stored under `env/`
in your bundle (mode 0600). Values may or may not be sensitive; **akm protects
them all the same** — key *names* are discoverable; values and comment text
never appear in structured output (comments routinely contain commented-out
credentials, so they are treated like values). akm does **not** manage
individual entries — you edit the `.env` with your own editor (or ingest one
with `--from-file`) and akm loads it wholesale. `list` and `show` surface key
names only; `run` and `export` are the supported value-use paths.

```sh
akm env list
akm env create prod                          # creates env/prod.env (mode 0600)
akm env create prod --from-file ./.env        # ingest an existing .env
akm env create prod --path staging            # creates env/staging/prod.env
$EDITOR "$(akm env path env/prod --quiet)"    # edit the file directly
akm env run env/prod -- npm test              # run a command with the whole file injected
akm env run env/prod -- $SHELL                # interactive shell with the env loaded
akm env run env/prod --only DATABASE_URL -- ./migrate   # inject just one var
akm env remove env/prod --yes                 # remove the whole env file
```

akm does not manage individual keys — edit the `.env` file directly (`$EDITOR
"$(akm env path <ref>)"`). `env remove <ref>` removes the whole file.

Env mutations (`create`, `remove`) pick their write destination the same way
every other write command does: an explicit `--target <source>` wins, else
`defaultWriteTarget`, else the working bundle. The chosen source must be
writable — a non-writable `--target`/`defaultWriteTarget` fails with a
`ConfigError` before anything is written — and on a git-backed writable target
the mutation lands in a single boundary commit (filesystem targets are
committed by `akm sync`; `env/` stays out of git when your bundle `.gitignore`
excludes it). Reads (`list`, `path`, `run`, `export`) still span all configured
sources and are unchanged.

Subcommands:

| Subcommand | Description |
| --- | --- |
| `list` | List all env files across all bundles with key names only |
| `run <ref> -- <command>` | Run a command with the env injected. `--only` / `--except` filter which keys are injected; `--clean` starts from a minimal inherited environment |
| `create <name>` | Create an env file. Empty by default; seed with `--from-file <path>` or `--from-stdin` |
| `path <ref>` | Print the absolute env file path (Docker `_FILE` / `--env-file` / direct editing). `--quiet` suppresses the warning |
| `export <ref> --out <file>` | Write a safe sourceable `export` script to a file (never to stdout) |
| `remove <ref>` | Delete an env file (and its `.sensitive` marker) |

> **Removed in 0.9.0:** `akm env set`/`akm env unset`. akm does not manage
> individual keys — edit the `.env` file directly.

#### env run — the primary value path

```sh
akm env run env/prod -- <command>
akm env run env/prod -- $SHELL          # interactive: a shell with the env loaded
akm env run env/prod --only A,B -- cmd  # inject only A and B
akm env run env/prod --except DEBUG -- cmd
akm env run env/prod --clean -- cmd
akm env run env/prod --clean --inherit SSH_AUTH_SOCK -- cmd
```

Runs the command with the env file's values injected **directly into the child
process** — never through a shell, and never into akm's own structured output.
However, the child process controls its own stdout/stderr: if it prints its
environment, those values will appear in your terminal or agent transcript.
`--only` / `--except` (comma-separated key names, mutually exclusive) restrict
which env-file keys are injected. `--clean` starts from a minimal inherited
environment (PATH/HOME/locale/terminal basics) instead of inheriting the full
parent environment; use `--inherit KEY1,KEY2` to pass specific parent vars
through in clean mode. Before spawning, the injected key names are scanned for
known process-hijacking variables (`LD_PRELOAD`, `PATH`, `GIT_CONFIG_*`, ...):
a first-party bundle warns and proceeds; a third-party-sourced bundle is refused.

> The single-key `run <ref>/KEY` form was removed. To inject one value, store it
> as a [secret](#secret) and use `akm secret run secrets/<name> <VAR> -- …`, or
> use `akm env run <ref> --only <KEY> -- …`.

> Values injected via `env run` live in the child process environment for its
> entire lifetime and are visible to all subprocesses it spawns. Avoid
> `env run` for long-lived daemon or server processes, and do not use commands
> like `env`, `printenv`, shell tracing, or verbose diagnostics in agent
> contexts unless you explicitly intend to expose the child environment.

#### env create

```sh
akm env create prod                       # empty
akm env create prod --from-file ./.env    # seed from an existing .env (byte-for-byte)
printf 'A=1\nB=2\n' | akm env create prod --from-stdin
akm env create prod --path staging        # creates env/staging/prod.env
akm env create prod --sensitive           # hidden from `env list` and the search index
akm env create prod --target team         # write to the `team` source
```

| Flag | Description |
| --- | --- |
| `--path <dir>` | Relative subdirectory under `env/` to place the file in. The filename comes from `<name>`. |
| `--from-file <path>` | Seed the env file from an existing `.env` at this path |
| `--from-stdin` | Seed the env file from stdin |
| `--sensitive` | Exclude this env file from `env list` output and the search index |
| `--target <source>` | Override the write destination (falls back to `defaultWriteTarget` then the working bundle) |

Creates `env/prod.env` with mode 0600. Empty `create` is a no-op if the file
exists; `--from-file`/`--from-stdin` **refuse to clobber** an existing env (remove
it first). `--sensitive` hides the file from `env list` and the search index.

#### env list

```sh
akm env list
```

One entry per env file across all configured bundles. The structured shape is
`envs: [{ ref, keys }]` — values are never included and the absolute `path` is
omitted from JSON output. Text output uses Markdown sections:

```md
## env/prod

- DATABASE_URL
- API_KEY
```

#### env path

```sh
akm env path env/prod            # warns: don't source the raw file
akm env path env/prod --quiet    # for `_FILE` / `--env-file` use
```

Prints the absolute path to the env file — for the Docker `_FILE` convention
(`MY_VAR_FILE=$(akm env path env/prod --quiet)`), `docker run --env-file`, or
editing the file directly. By default a stderr warning steers you away from
`source`-ing the raw file (its shell substitutions would execute); `--quiet`
suppresses it for the legitimate file-path uses. Format-exempt
(`src/output/format-exempt.ts`) — this command's stdout is always the bare
path, never a result envelope; passing `--format` warns rather than doing
anything.

#### env export

```sh
akm env export env/prod --out /tmp/prod.sh && source /tmp/prod.sh && rm -f /tmp/prod.sh
```

Writes a safe, sourceable `export KEY='value'` script to `--out <file>` (mode
0600). Values are re-serialised single-quoted, so a raw `.env` containing shell
substitutions (e.g. `X=$(rm -rf ~)`) becomes a **literal string** — sourcing the
generated file can never execute it. `export` **never prints values to stdout**
(that would leak them into a captured/agent context) and so requires `--out`.

> For most uses prefer `akm env run` (no file, no cleanup). `export` exists for
> the case where a tool must `source` a file or you need a generated env script.

### secret

Manage **secrets** — a single sensitive value used on its own for
**authentication**: an API token, a PEM private key, a TLS cert, a
service-account JSON. Where an [env](#env) file holds a *group* of related
configuration and exposes key *names*, a secret is *one* value and its **entire
file is the value**, so only the secret's *name* is ever surfaced. Each secret
is a mode-0600 file under `secrets/` in your bundle.

This mirrors Docker's secret model (one value per file, mounted at
`/run/secrets/<name>`, read at runtime, never baked into the image or env at
build time). The key security property: **secret values never appear in
structured output** — not in the index, `akm search`, `akm curate`, or
`akm show`. The supported value-use path is `secret run` (inject into a child
env var).

```sh
akm secret list
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token
akm secret set secrets/deploy-key --from-file ~/.ssh/id_ed25519   # byte-exact
AKM_VALUE="$TOKEN" akm secret set secrets/api --from-env AKM_VALUE
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `list` | List all secrets across all bundles by name (contents never shown) |
| `set <ref>` | Create/overwrite a secret — value from stdin (default), `--from-file`, or `--from-env` |
| `run <ref> <VAR> -- <command>` | Run a command with the secret value injected into `$VAR` in the child only |

> **Removed in 0.9.0: `secret path` and `secret remove`.** The two resolved a
> ref through *different* bundle-selection logic — `path` through the read-side,
> all-sources resolver and `remove` through the write-target resolver — so for a
> ref present in more than one bundle they could silently name different files:
> you could inspect one secret and delete another. Both now exit 2 with
> `Unknown command`. A ref's file lives at `<bundle>/secrets/<name>` (run
> `akm bundle list` for bundle roots); locate or delete it there directly, or
> use `akm secret run` to consume the value without touching disk.

#### secret set

```sh
# Default: read the value from stdin (never crosses argv)
printf '%s' "$TOKEN" | akm secret set secrets/deploy-token

# Import an existing file byte-exact (multi-line PEM keys, certs, binary)
akm secret set secrets/deploy-key --from-file ~/.ssh/id_ed25519

# From an environment variable
AKM_VALUE="$TOKEN" akm secret set secrets/api --from-env AKM_VALUE
```

The value is **never accepted via positional arguments**. With stdin, a single
trailing newline is stripped (so `echo "$TOKEN" | akm secret set …` stores the
token without the shell-added newline); use `--from-file` for byte-exact storage
of multi-line material. Writes are atomic (mode 0600) under an exclusive
`<secret>.lock`. Maximum size is 5 MB.

`secret set` selects its write destination like every other write command: an
explicit `--target <source>` wins, else `defaultWriteTarget`, else the working
bundle. The chosen source must be writable (a non-writable target fails with a
`ConfigError`), and on a git-backed writable target the mutation lands in a
single boundary commit. Reads (`list`, `run`) still span all configured sources.

#### secret run

```sh
akm secret run secrets/deploy-token GITHUB_TOKEN -- gh release create v1.0.0
akm secret run secrets/deploy-token GITHUB_TOKEN --clean -- gh auth status
```

Runs one subprocess with the secret's value set as `$VAR` in the child's
environment. **The value never appears in akm's structured output** — it is
passed directly to the child process. The target variable name is validated and
known process-hijacking names (`LD_PRELOAD`, `PATH`, etc.) are rejected.
`--clean` starts from a minimal inherited environment instead of inheriting the
full parent environment; use `--inherit KEY1,KEY2` to pass specific parent vars
through in clean mode.

> Secrets injected via `secret run` live in the child process environment for
> its entire lifetime and are visible to all subprocesses it spawns. For
> long-lived daemons, point the process at the secret file directly
> (`<bundle>/secrets/<name>`) so the value never sits in an environment
> variable. Avoid commands that print the environment in agent contexts unless
> you explicitly intend to expose the child environment.

#### Sensitive marker

A sibling `<name>.sensitive` marker file excludes a secret from `secret list`
**and** from indexing entirely (parallel to env files). The secret remains usable
via `secret run`.

### Wikis (no dedicated command)

An LLM wiki (the Karpathy pattern — `schema.md` rulebook, agent-authored
`pages/`, immutable `raw/` sources) is a **bundle format**, not a command
family. There is no `akm wiki` verb; a bundle whose root holds `schema.md`
plus `pages/` is recognized automatically at install time, and its pages are
indexed and addressed like any other asset:

```sh
akm bundle add github:team/research-wiki        # install a wiki bundle (or a local dir)
akm search "attention"                   # pages rank alongside all other assets
akm show research-wiki//pages/attention  # read a page by bundle//conceptId ref
```

Writing pages, ingesting raw sources, and maintaining `index.md`/`log.md` are
the agent's job, using its native `Read`/`Write`/`Edit` tools guided by
`schema.md` — akm's job is recognition, indexing, and search. See
[wikis.md](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) for the full format.

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

## Improvement Flow

These commands define the self-improvement and agent-dispatch surface.

### command run

Resolve a stored command through its owning bundle adapter and execute one
fresh session through the common engine/model cascade:

```sh
akm command run <command-ref> [--arguments <exact-text>] [--agent <selector>] [--engine <name>] [--model <id-or-alias>] [--timeout-ms <ms>] [--cwd <path>] [--dry-run]
```

`--dry-run` does not dispatch and does not materialize credentials.

| Argument / Flag | Description |
| --- | --- |
| `<command-ref>` | Local indexed command ref, optionally bundle-qualified (for example `commands/review` or `team//commands/review`) |
| `--arguments <exact-text>` | Exact string substituted for every literal `$ARGUMENTS`; it is not trimmed, tokenized, quoted, or recursively expanded |
| `--agent <selector>` | Portable `agents/...` ref or a native harness selector |
| `--engine <name>` | Current-invocation engine override |
| `--model <id-or-alias>` | Current-invocation exact model or operator model-map alias |
| `--timeout-ms <ms>` | Current-invocation timeout override |
| `--cwd <path>` | Current-invocation workspace override |
| `--dry-run` | Resolve, authorize, and lower the command without dispatching or materializing credentials |

Commands and portable personas are rendered by their bundle adapter. Native
frontmatter is never sent as prompt text and native files are never rewritten.
The only portable template token is literal `$ARGUMENTS`. Positional, named,
expression, legacy `{{...}}`, and other native-only constructs fail before
authorization or dispatch; invoke those templates through their native tool.
Omitting `--arguments` and passing an explicit empty string both substitute
empty text, but remain distinct in the resolved request.

`akm command run ... --dry-run` performs the real adapter read, cascade/model
resolution, operator authorization or policy check, and engine lowering. It
returns a successful JSON result with `schemaVersion: 1`,
`shape: "command-dry-run"`, `ok: true`, `dryRun: true`, the selected engine
name, safe `provenance`, and safe lowering `notices`. It has no fake exit code,
stdout, stderr, or duration.

Each provenance entry contains only `field`, `layer`, `kind`, and `via`. Each
lowering notice contains `code`, `severity`, `adapter`, optional `field`, and
fixed `message`. Dry-run does not dispatch and does not materialize
credentials. It uses a read-only source lookup and records no usage, events, or
accounting.

Diagnostics exclude resolved values. They never include prompt content.
They never include command content. They never include environment values.
They never include credential values. User-authored
inference keys are collapsed to the safe wildcard field instead of being
echoed.

For live execution, global `--verbose` emits the same safe provenance and
notices to stderr before dispatch. The normal command result on stdout is
preserved unchanged, so enabling verbose diagnostics does not corrupt scripts
that consume stdout.

### agent

Dispatch a configured agent engine, optionally selecting a bundle agent persona
and model defaults. A nonempty tool request from that asset is not
authorization: the current CLI rejects it at the execution boundary.
Stored command assets execute only through `akm command run`; `akm agent` has
no command compatibility alias.

```sh
akm agent [<agent-ref>] [--engine <name>] [--prompt <text>] [--model <model>] [--timeout-ms <ms>] [--cwd <path>]
```

| Argument / Flag | Description |
| --- | --- |
| `<agent-ref>` | Optional agent asset ref (e.g. `agents/code-reviewer`). Resolves persona and model defaults; a nonempty tool request still requires separate operator authorization. |
| `--engine <name>` | Agent engine to use; defaults to `defaults.engine` |
| `--prompt <text>` | Task prompt to pass to the agent |
| `--model <model>` | Model override. Accepts aliases (`opus`, `sonnet`, `haiku`) or exact platform model IDs. Overrides the model in the agent asset. Resolved per platform: `opencode/claude-opus-4-7` for opencode, `claude-opus-4-7` for claude. |
| `--timeout-ms <ms>` | Override the agent CLI timeout in milliseconds |
| `--cwd <path>` | Working directory for the spawned agent (defaults to the current directory) |

When `<agent-ref>` is provided, akm resolves the bundle agent's persona,
`modelHint`, and requested `toolPolicy`. The `--model` flag wins over any model
specified in the asset. An alias resolves per the selected `--engine`'s
model-map column (see [Model-map files](configuration.md#model-map-files)),
which — as of 0.9.15 — may itself be an `engine`-backed indirection, so
`--engine local-fast --model fast` can resolve to `local-fast`'s own
`engines.local-fast.model` instead of a hardcoded per-platform literal. The
requested tool policy never grants access by itself: authorization runs before
lowering, credentials, or provider dispatch.
The current CLI has no built-in allow-all authorizer, so a nonempty request is
rejected rather than silently weakened.
Selecting a persona or model without `--prompt` or `--prompt-stdin` is also
rejected; akm never fabricates an empty command. The
prompt-free interactive exemption applies only when no persona/model/tool/schema
or inference payload was selected.

**Platform-specific dispatch:** akm uses a platform builder to construct the
CLI argv for each engine's harness platform. `platform: "opencode"` engines emit:
`opencode run [--system-prompt "..."] [--model opencode/claude-opus-4-7] "<prompt>"`.
`platform: "claude"` engines emit:
`claude [--system-prompt "..."] [--model claude-opus-4-7] --print -- "<prompt>"`.
Agent engines may set `bin`, `args`, `workspace`, `model`, and `timeoutMs` in
config. Semantic model aliases live only in the installed/user `models.json`
files and resolve before dispatch.

Without any `--prompt`, `<agent-ref>`, or `--model`, the agent is launched
interactively (no injected prompt, no platform-specific flags beyond the
engine's base args).

Configure agent engines under `engines.<name>` with `kind: "agent"` and a
registered harness `platform` (see [Configuration](configuration.md)). AKM
lowers the selected engine to the spawn or embedded SDK runner with captured or
interactive stdio, hard timeout, and structured failure reasons.

```sh
# Interactive launch:
akm agent --engine opencode

# Dispatch with a prompt only:
akm agent --engine claude --prompt "summarize recent changes"

# Embody a bundle agent asset:
akm agent agents/code-reviewer --engine opencode --prompt "review src/"

# Model override with alias:
akm agent agents/planner --engine claude --model sonnet --prompt "plan the sprint"

# Exact model ID override:
akm agent --engine opencode --model opencode/claude-opus-4-7 --prompt "audit the API"
```

Returns `{ ok, exitCode, stdout?, stderr?, durationMs, reason? }`. On
failure, `reason` is one of `timeout | spawn_failed | non_zero_exit |
parse_error`. Captured dispatches render this final envelope using the selected
akm format. Interactive child stdout/stderr remain inherited and raw. A failed
dispatch exits 1; `exitCode` in the envelope retains the child's exact status
when one exists.

### lint

Scan bundle markdown files for structural issues: unquoted colons, missing
`updated` field, orphaned stubs, placeholder stubs, missing `name`/`type`,
stale paths, and broken refs — in body text and in
`refs`/`xrefs`/`supersededBy`/`contradictedBy` frontmatter. A belief edge
pointing at a memory that `akm improve` pruned resolves through the archive
tombstone under `.akm/memory-cleanup/archive/` and is not reported (#884). Also reports
`dangerous-env-key` findings for env files (the same key set `akm bundle add`
enforces — see [Dangerous env key audit](#dangerous-env-key-audit) — but
non-blocking here; `lint` only warns). `--type workflows` structurally parses
and compiles peer Markdown and GitHub-shaped YAML workflows; errors surface as
`invalid-workflow-structure` findings (0.9.0: this is the only
structural-validation surface now that `akm workflow validate` is gone).

```sh
akm lint                        # Report findings; exits 0 regardless
akm lint --fix                  # Auto-fix Tier-1 issues in place
akm lint --type workflows       # Only lint one asset type
akm lint --dir ~/other-bundle    # Override the bundle root (default: from config)
akm lint --fail-on-flagged      # CI-friendly: exit non-zero when summary.flagged > 0
akm lint --prune-dangling-edges # Opt-in: drop belief edges whose target is gone
```

| Flag | Description |
| --- | --- |
| `--fix` (alias `--auto-fix`) | Apply auto-fixes in place. Refused with a usage error when the target bundle is configured `writable: false`. |
| `--dir` | Override the bundle root directory (default: from config) |
| `--type` | Only lint assets of this type (e.g. `workflows`, `tasks`, `memories`). **akm bundles only** — every other adapter validates the whole bundle and warns on stderr that the flag had no effect. |
| `--fail-on-flagged` | Exit non-zero when `summary.flagged > 0`. Default: exit 0 regardless of findings. |
| `--prune-dangling-edges` | Opt-in repair (#884): drop `supersededBy`/`contradictedBy` entries whose target has neither a file nor a prune tombstone. **Not** implied by `--fix` — it edits well-formed files to delete a belief-graph claim, so review a plain `akm lint` report first. Clears the same `writable: false` gate `--fix` does. |

Returns `fixed[]` and `flagged[]` arrays plus a `summary: { fixed, flagged }`
count. Each entry carries `file`, `issue`, `detail`, and whether it was
`fixed`.

Task files are checked for more than their fields: a `tasks/*.yml` whose YAML
does not parse is reported as `invalid-task-yaml` (it used to fall through as an
empty mapping and lint clean), and a `tasks/*.yaml` file — a spelling akm never
indexes or schedules — is flagged for the extension rather than skipped.

`--fix` is transactional per file: a fix that cannot be written (read-only file,
full disk) is reported as `fixed: "failed"` on that file and the sweep continues,
so a mid-run write failure can no longer abort the command and hide the fixes
that already landed.

### improve

Improve existing assets and write the results to the proposal queue.

```sh
akm improve
akm improve memory
akm improve skills/code-review
akm improve workflows/release-checklist --task "reduce duplication"
akm improve --skip-if-locked           # for high-frequency scheduled runs: skip (exit 0) if a run is already in progress
akm improve --require-engines          # for scheduled runs: abort (exit 78) instead of degrading if an engine/credential is unavailable
akm improve --no-sync                  # skip the end-of-run git commit entirely (default: on for git-backed bundles)
akm improve --sync --no-push           # commit only, skip the push after it
akm improve --plan --strategy thorough # preview thorough's resolved engine/model routing; nothing is dispatched
akm improve lessons/my-lesson --show-prompt # print the composed reflect prompt for one asset; no lock/index/engine call
akm improve report                     # LLM usage/routing report for the most recent real run
akm improve report --run <id>          # ...for one specific improve_runs id
akm improve report --since 7d          # ...aggregated over every real run started in the last 7 days
```

| Flag | Description |
| --- | --- |
| `--run <id>` | `report` scope only (#944): show the usage report for one specific `improve_runs` row instead of the most recent real run. Mutually exclusive with `--since`. Rejected with any other scope, or no scope. |
| `--since <window>` | `report` scope only (#944): aggregate the usage report over every real (non-dry-run) run started since `<window>` (a duration like `24h`/`7d`, or an ISO timestamp) instead of one run. Mutually exclusive with `--run`. Rejected with any other scope, or no scope. |
| `--task` | Optional extra guidance for this improvement pass |
| `--dry-run` | Show the schema-v2 result on stdout without creating config, data, state, cache, bundle, log, or result artifacts. Dry-run results are never persisted, including on errors or signals. |
| `--plan` | Alias for `--dry-run` (#947). Sets the exact same internal flag; no separate code path. Prefer this spelling when the goal is previewing `plan.processes` (resolved process -> engine -> model routing) rather than checking what would be written. |
| `--bundle` | Select the proposal/write target; when the ref scope is bundle-qualified, it must name the same bundle |
| `--limit <n>` | Base cap for ordinary assets (highest utility first); configured replay slots are additive |
| `--timeout-ms <ms>` | Wall-clock budget for the run (default: `7200000` = 2 hours) |
| `--require-feedback-signal` | Only process assets with recent feedback signals |
| `--strategy <name>` | Override the active improve strategy (a built-in or entry under `improve.strategies`) |
| `--json-to-stdout` | Also emit the full persisted JSON result on stdout for a live run. Without this flag, stdout stays empty. Dry-runs always emit their result and are never persisted. |
| `--skip-if-locked` | If another improve run already holds the lock, skip gracefully (exit 0) instead of failing with "already running" (exit 78). Use for high-frequency scheduled runs so they don't pile up failures while a longer run is in progress. |
| `--require-engines` | Abort (exit 78, before any indexing, lock, or log side effect) if the active strategy would enable a process whose engine or credential cannot be resolved in this process's environment, OR whose endpoint fails a bounded reachability probe — the same probe `akm health`'s `default-llm-engine`/`configured-engines` checks run, once per distinct endpoint. Without this flag, improve degrades gracefully: it skips the affected processes and reports them in the result's `skippedProcesses`. Recommended alongside `--skip-if-locked` for scheduled runs, since the operator's own shell can pass config validation while a scheduler's stripped-down environment (see #953) cannot. |
| `--show-prompt` | Print the composed reflect prompt (#952) for one asset and exit — before any lock, index write, or engine dispatch. Requires a fully-qualified asset ref as the scope (`akm improve lessons/my-lesson --show-prompt`); rejected with a type or whole-bundle scope. JSON/yaml output carries the prompt as a `prompt` field alongside the resolved `engine`/`engineKind`; text output (the default) prints the prompt itself, unwrapped. |
| `--sync` / `--no-sync` | Commit (and optionally push) the git-backed primary bundle when the run finishes. Default: on for git-backed bundles (per profile config). |
| `--push` / `--no-push` | Push after the end-of-run sync commit when writable with a remote configured. `--no-push` commits only, skipping the push. Default: per profile config (`true`). `sync.push` stays outside the autonomy gate — this is a per-run opt-out, not a default change. |

`akm improve` is the public entrypoint for whole-bundle, type-scoped, and
ref-scoped improvement. It owns the memory-cleanup and lesson-distillation
flow. A qualified scope such as `team//skills/code-review` selects that bundle;
a different explicit `--bundle` is a usage error. Inspecting or re-minting the
collapse-detector canary set is maintainer tooling, not a CLI verb — run
`bun scripts/refresh-canary-set.ts` (add `--refresh` to mint a new set and
deactivate the old one; old rows and their cycle history are retained).

Built-in `default` and `frequent` leave the improve-stage extract process off,
and `default` plus `reflect-distill` leave proactive maintenance off. Use the
explicit `proactive-maintenance` strategy or set the selected strategy's
process `enabled: true` to opt in. The stage toggle does not disable a direct
`akm proposal extract --type <harness>` or `akm proposal extract --auto`
invocation.

The maintenance pass run by `improve` also expires stale proposals: any pending
proposal older than the top-level `archiveRetentionDays` config key (default
**90**, not `improve.archiveRetentionDays`) is moved to the archive with the
reason `expired: no action within retention window` and a `proposal_expired`
event is emitted. Set `archiveRetentionDays` to `0` to disable expiration
entirely. The total expired count surfaces in the improve result as
`proposalsExpired`.

`improve` never promotes proposals on its own — there is no confidence gate.
Every generated proposal lands in the queue with a `pending` status
and is adjudicated later with `akm proposal accept` / `akm proposal reject` or
the drain engine. Reflect still emits a `confidence` score (0..1) in its JSON
response schema; it is recorded on the proposal for triage and ranking, but no
threshold auto-accepts anything.

Selection behavior defaults to recent feedback signals first, with a
zero-feedback retrieval fallback for high-traffic refs. Use
`--require-feedback-signal` to disable retrieval fallback for the run.

When the active strategy enables a process (or the triage judgment engine)
whose engine or credential cannot be resolved in this process's environment,
the run does not silently do nothing for it: the process is skipped, and the
result carries `skippedProcesses` — an array of `{process, configKey, reason}`
entries (omitted entirely when nothing was skipped). When the process resolved
a real engine whose credential just isn't reachable here (as opposed to never
resolving an engine at all), the entry also carries the structurally resolved
`engine`/`model`/`contextLength` it would have used — never the credential
itself. `ok` and the exit code are unchanged either way, matching `extract`'s
`skipReasons` contract: consumers that need to know branch on
`skippedProcesses` (or pass `--require-engines` to abort instead of
degrading). `reason` names which engine and which credential reference (an env
var, `apiKeyFile` path, or `secret://` reference — never its value) is
missing. A `--dry-run`/`--plan` preview never dispatches, so it never aborts
on an unavailable credential either — even a strategy left with every process
disabled this way still returns its plan, with the affected processes in
`skippedProcesses`.

`--timeout-ms` is a run-wide wall-clock budget: when it expires, the run
cooperatively aborts any in-flight engine request (the same `AbortSignal`
every LLM call already honors) instead of waiting out the engine's own,
much longer, per-call timeout — the run then finishes and reports normally
rather than hanging past its budget. SIGTERM/SIGINT/SIGHUP end a live run
the same way, within a short bounded grace period, and the process exits
with a stable per-signal code (`143`/`130`/`129`) rather than needing a
`kill -9`. If a live run has waited more than a few seconds without any
engine response at all, one default-level line ("Still waiting for the
first engine response...") is printed so a scheduled run's log is never
silently empty while an engine is slow or dead.

For dry runs, `plannedRefs` is the effective post-limit work set, not every
ref in the requested scope. The `plan` object preserves both views: raw scope
size and per-gate removals, configured and effective caps, final ranked refs
and their selection lanes, proactive and consolidation statistics, stage
decisions, triage mode/caps, and `snapshot.status`/`snapshot.reason` for the
read-side index boundary. `limits.effective` is the ordinary-ref base cap;
`limits.additiveReplayAllowance` is the separate replay budget, and
`limits.totalCeiling` is their finite sum (omitted when the base run is
unbounded). A missing or incompatible index is an explicit empty snapshot and
is not created or migrated. `plan.mode` is `estimate` and `plan.dispatch` is
`false`; live JSON results use the same projection with `mode: "execution"`.
The dry result is a best-effort observation assembled during that invocation,
not an atomic cross-store snapshot or a reservation. Live execution re-inspects
mutable inputs, so a later run can differ after index, state, filesystem,
clock, or session-log changes.

`plan.processes` (#947) is the resolved process -> engine -> model routing
table: one row per improve process (`reflect`, `distill`, `consolidate`,
`memoryInference`, `graphExtraction`, `extract`, `validation`, `triage`,
`proactiveMaintenance`), plus a `triage.judgment` row when the strategy
configures a judgment engine. Each row carries `enabled`, the resolved
`engine`/`model` (llm-backed processes only) and `engineKind`, this process's
own lowering `notices`, and — for reflect/distill/consolidate only —
`eligibleRefs`, the count of this run's `effectiveRefs` the process would act
on (`shouldSkipRef`'s allowedTypes/process-disabled check; a count, not a
per-ref matrix, to keep the envelope bounded). A row that could not resolve an
engine or credential carries `unavailable: {configKey, reason}` — the same
data behind `skippedProcesses` above, reshaped per process. When the process
resolved a real engine whose credential just isn't reachable here, the row
still carries that engine's `engine`/`model`/`engineKind` alongside
`unavailable`, rather than omitting them the way a never-configured process
does — so a preview can show what would have run. This table is
resolved before any dispatch on every invocation (dry or live), so
`akm improve --dry-run --strategy <name>` (or `--plan`) previews an ad-hoc
strategy override without changing config first; `akm health`'s
`active-improve-strategy` check performs the equivalent resolution but only
for the configured default strategy (`defaults.improveStrategy`), and reports
no model or per-process notices. Neither `--dry-run` nor `--plan` probes
engine reachability over the network — pair with `akm health --probe` (or the
default probe-on behavior) to check whether a named engine actually answers.

`--show-prompt` (#952) is the cheapest way to exercise reflect alone: it
builds the exact prompt reflect would send for one asset — the same source
resolution, runner selection, feedback/schema-hint/related-lesson/rejected-
proposal gathering `akm improve`'s live reflect step uses — and prints it
without acquiring a dispatch lease, so it never calls an engine. Use it to
confirm by eye that recent feedback is framed as an unverified report to
investigate (never a fact to insert verbatim) and that the response contract
tells the model never to emit the truncation marker or any content from
outside the shown asset.

When reinforced facts need promotion, `knowledge` is the higher-authority
destination than `memory`. The deterministic search ranking also prefers
`knowledge` over `memory` hits, including inferred `.derived` memories, when
the evidence is otherwise comparable.

#### improve report

`akm improve report` (#944) answers "which engine did each LLM-backed process
use this run, how much did it cost, and which enabled processes made zero
calls (and why)" without hand-written SQLite against `state.db`. It is a
`scope` value, not a subcommand — `report` is not, and will never be, a real
asset type, so it is intercepted before any lock/log/index side effect (same
precedent as the retired `canary` scope).

Every real (non-dry-run) `akm improve` invocation persists a `usageReport`
field on the result (`result_json` in `improve_runs`, and in the
`--json-to-stdout` / dry-run JSON): `{ byProcessEngineModel, noCalls }`.
`byProcessEngineModel` is a cross-tab of this run's own `llm_usage` events
(#576) — one row per distinct `(process, engine, model)` triple, each with
`calls`, `failures`, `promptTokens`, `completionTokens`, `totalTokens`,
`reasoningTokens`, and `totalDurationMs`. `noCalls` lists every LLM-backed
process (`reflect`, `distill`, `consolidate`, `memoryInference`,
`graphExtraction`, `extract`, `validation` — not `triage`/`proactiveMaintenance`,
which never make an attributable LLM call themselves) the active strategy
enabled but that ended the run with zero calls, each with a `reason` drawn
from the existing skip-reason vocabulary: `"engine_unavailable"` (also in
`skippedProcesses`), `"autonomy_gated"`, `"strategy_filtered_all_passes"`, a
reflect/distill dominant skip reason (e.g. `"no_new_signal"`, `"cooldown"`),
or `"no_signal"` as the fallback — never a fabricated category. The field is
omitted entirely when both would be empty. The same table is printed to
stderr (`[improve] usage report ...`) after every real run, independent of
`--json-to-stdout`.

`akm improve report` reads that field back: with no flags, the most recent
real run; `--run <id>`, one specific run; `--since <window>`, summed across
every real run in the window (`byProcessEngineModel` rows merged by
`(process, engine, model)`; `noCalls` lists a process only if it made zero
calls across every included run). A run recorded before 0.9.15 has no
persisted `usageReport` — the command recomputes `byProcessEngineModel` from
that run's own `llm_usage` events instead of erroring, sets `noCalls` to `[]`
(eligibility reasons are not reconstructable after the fact), and adds a
`notes` entry saying so rather than fabricating precision the old row can't
support.

### proposal

Manage the proposal queue. The canonical grammar is `akm proposal <verb>`:
`extract`, `new`, `list`, `show`, `diff`, `accept`, `reject`, `revert`,
`drain`. Bare `akm proposal` is a usage error (exit 2) as of 0.9.0 — it used
to behave as `akm proposal list`; name the verb. There are no flat-verb
spellings (`akm proposals`, `akm extract`, `akm propose`, `akm accept`, `akm
reject`, `akm diff`, `akm revert`) — use the `akm proposal <verb>` form.

`list`, `show`, `diff`, `accept`, `reject`, and `revert` (and bulk accept/
reject) support `--queue <source>`. It selects the proposal queue stored for
that configured writable source root; without it, commands use the primary
queue. Queue selection is not a destination override. `drain` does **not**
take `--queue` — it operates on the standing backlog via a policy, not a
single queue.

New qualified proposals record their destination source name and materialized
root. `proposal diff`, `accept`, and `revert` use that recorded target by
default; an explicit `--target` must resolve to the same source and root or the
command fails with exit 2. An unbound proposal in a selected non-primary queue
uses that authenticated queue root. A short historical unbound proposal
mutation requires either an explicit `--target` or a selected `--queue` that
authenticates its root; it never falls back to an ambient write target.

#### proposal extract

Extract durable insights from native coding-agent session files (claude-code,
opencode) and queue them as proposals. This is the standalone entrypoint for
session extraction — it replaces the legacy session-checkpoint hook and runs
independently of the improve-stage extract toggle (see `improve` above).

```sh
akm proposal extract --type claude --session-id <id>
akm proposal extract --type claude --since 24h
akm proposal extract --type opencode --since 7d --dry-run
akm proposal extract --auto                 # iterate every available harness
akm proposal extract --type claude --location /custom/path --session-id <id>
```

| Flag | Description |
| --- | --- |
| `--type <harness>` | Harness name (`claude`, `opencode`). Required unless `--auto`. |
| `--session-id <id>` | Process only this session ID. When absent, discover sessions via `--since`. |
| `--location <path>` | Override the harness's default session-discovery location. |
| `--since <cutoff>` | Discovery cutoff. ISO timestamp or duration (`24h`, `7d`, `30m`). Default `24h`. |
| `--auto` | Iterate every available harness with the default `--since`. Mutually exclusive with `--type`. |
| `--dry-run` | Show candidates without queuing proposals. |
| `--force` | Re-process sessions even if they were already extracted and have no new events. Default: skip already-seen sessions. |
| `--timeout-ms <ms>` | Per-session LLM timeout in ms (default `600000`). |
| `--engine <name>` | Named LLM engine for this invocation. Mutually exclusive with `--strategy`. |
| `--strategy <name>` | Improve strategy supplying extract behavior and engine. Mutually exclusive with `--engine`. |

`--type` and `--auto` are mutually exclusive; one of them is required.
`--auto` iterates `getAvailableHarnesses()` — every harness with a detectable
session-log location on the current machine — and returns an aggregated
`extract-auto-result` envelope (`harnessesProcessed`, `totalProposals`,
per-harness `results`); the run exits non-zero only when every harness
failed.

There is no `akm proposal extract --watch`/`--debounce-ms` either (0.9.0:
dropped — a foreground polling daemon in a one-shot CLI); the shipped
`core/extract.yml` cron template (`akm proposal extract --auto` on a
schedule) is the answer.

Requires an LLM engine: pass `--engine`, select a `--strategy` whose
`processes.extract.engine` is set, or configure `defaults.llmEngine`.

**Output.** `ok` means the command ran to completion — it is `true` even when
every session was skipped (an unreachable LLM engine included); it does not
mean anything was harvested. Consumers that need "did this run actually
harvest" branch on `skipReasons`, `warnings`, or `sessionsProcessed` /
`sessionsSkipped` instead. The envelope also reports:

| Field | Description |
| --- | --- |
| `engine` | Resolved LLM engine name for this run. Absent only when extract is disabled by the selected improve strategy (the run returns before an engine is resolved). |
| `engineKind` | `"llm"`, `"sdk"`, or `"agent"` — the kind of runner `engine` resolved to. Same absence condition as `engine`. |
| `skipReasons` | Per-`skipReason` count across `sessions[]` (e.g. `{ "llm_unavailable": 25 }`). Present only when `sessionsSkipped > 0`. |
| `warnings` | Includes one aggregate line per infrastructure skip reason that fired (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`) — e.g. `25 of 25 sessions skipped: llm_unavailable (engine "default")` — so an engine outage is visible without inspecting `sessions[]`. Session-content skips (`already_extracted`, `too_short`, `triaged_out`) are counted in `skipReasons` but never produce a warning line. |

#### proposal new

Generate a brand-new asset proposal from a description. Output is always a
proposal — never a direct write.

```sh
akm proposal new <type> <name> --task "..."
akm proposal new <type> <name> --file ./prompt.md
akm proposal new skill code-review --task "PR-style review skill"
akm proposal new lesson docker-cleanup --file ./prompts/docker-cleanup.md
akm proposal new skill code-review --path team --task "PR-style review skill"  # writes under skills/team/
```

| Flag | Description |
| --- | --- |
| `--path` | Relative subdirectory under the type dir to place the proposed asset in (e.g. `release`). The filename comes from `<name>`. |
| `--task` | Inline task text |
| `--file` | Read task text from a UTF-8 file |
| `--engine` | Override the default execution engine |
| `--timeout-ms` | Override the selected engine timeout for this call |

Exactly one of `--task` or `--file` is required. Emits `propose_invoked`.

**Prompt-task `timeoutMs`:** a version-2 prompt task may set `timeoutMs` to
override its selected engine timeout. Set it to `null` to disable the timer, or
to a positive integer (milliseconds) to apply a task-specific limit.

#### proposal list

List proposal queue entries.

```sh
akm proposal list
akm proposal list --queue team-bundle
akm proposal list --status pending|accepted|rejected|reverted
akm proposal list --ref skills/deploy
```

| Flag | Description |
| --- | --- |
| `--queue <source>` | Select the proposal queue by configured writable source name |
| `--status` | Filter by `pending`, `accepted`, `rejected`, or `reverted` |
| `--ref` | Filter by asset ref. A qualified ref preserves bundle identity; a short ref matches that concept in the selected queue |
| `--type` | Reserved type filter |

Each proposal record carries an optional `confidence` field (0..1) emitted by
reflect/propose runs. It is recorded for triage and ranking only — there is no
confidence gate or auto-promotion; proposals are
adjudicated with `akm proposal accept` / `reject`. Once accepted, a proposal
that overwrote an existing asset also carries a `backup` field pointing to the
captured prior content, which `akm proposal revert` uses.

#### proposal show

Inspect a queued proposal and its validation findings.

```sh
akm proposal show <id>
akm proposal show <id> --queue team-bundle
```

#### proposal accept

Accept a proposal and promote it into its recorded destination. Accepts a full
UUID, an 8-character UUID prefix, or an asset ref.

```sh
akm proposal accept <id>
akm proposal accept 7c115132                  # 8-char UUID prefix
akm proposal accept skills/akm-dream           # Asset ref
akm proposal accept <id> --queue team-bundle
akm proposal accept <id> --target team-bundle  # Must match a recorded target
akm proposal accept --generator reflect -y    # Bulk-accept by generator (requires -y)
akm proposal accept --generator reflect --max-diff-lines 50 -y    # ...only if <= 50 lines
akm proposal accept --generator reflect --older-than 7 --dry-run  # Preview a bulk accept
```

| Flag | Description |
| --- | --- |
| `--queue <source>` | Select the proposal queue by configured writable source name |
| `--target <name>` | Write destination; must match the proposal's recorded target |
| `--generator <name>` | Bulk-accept all pending proposals from this generator (e.g. `reflect`, `distill`). Requires no positional id. |
| `--max-diff-lines` | When bulk-accepting, only accept proposals whose content is `<=` this many lines. Larger proposals are skipped. |
| `--older-than` | When bulk-accepting, only accept proposals created more than this many days ago |
| `--dry-run` | List proposals that would be bulk-accepted without accepting them |
| `-y`, `--yes` | Skip confirmation (required in non-interactive mode for bulk accept) |

Bulk-accept all pending proposals from one generator with `--generator <name>`
(e.g. `reflect`, `distill`) and no positional id. Bulk accept requires
`-y`/`--yes` in non-interactive shells.

#### proposal reject

Reject a proposal and archive the reason. Accepts a full UUID, an 8-character
UUID prefix, or an asset ref.

```sh
akm proposal reject <id> --reason "duplicates existing workflow"
akm proposal reject <id> --queue team-bundle --reason "duplicates existing workflow"
akm proposal reject 7c115132 --reason "not ready"      # 8-char UUID prefix
akm proposal reject skills/my-skill --reason "not ready" # Asset ref
akm proposal reject --generator reflect --reason "noisy" -y  # Bulk-reject by generator
akm proposal reject --generator reflect --reason "noisy" --max-diff-lines 50 -y
```

| Flag | Description |
| --- | --- |
| `--reason` | Reason for rejection (required) |
| `--queue <source>` | Select the proposal queue by configured writable source name |
| `--generator <name>` | Bulk-reject all pending proposals from this generator (e.g. `reflect`, `distill`). Requires no positional id. |
| `--max-diff-lines` | When bulk-rejecting, only reject proposals whose content is `<=` this many lines. Larger proposals are skipped. |
| `--older-than` | When bulk-rejecting, only reject proposals created more than this many days ago |
| `--dry-run` | List proposals that would be bulk-rejected without rejecting them |
| `-y`, `--yes` | Skip confirmation (required in non-interactive mode for bulk reject) |

Bulk-reject all pending proposals from one generator with `--generator <name>`
and no positional id. Bulk reject requires `-y`/`--yes` in non-interactive shells.

#### proposal revert

Revert an accepted proposal by restoring the prior asset content from the
backup captured at promotion time. Only works on proposals that overwrote an
existing asset; new-asset proposals leave no backup. Sets the proposal's status
to `reverted` and appends a `proposal_reverted` event to the audit log.

```sh
akm proposal revert <id>
akm proposal revert skills/akm-dream           # Asset ref
akm proposal revert <id> --queue team-bundle
akm proposal revert <id> --target team-bundle  # Must match a recorded target
```

| Flag | Description |
| --- | --- |
| `--queue <source>` | Select the proposal queue by configured writable source name |
| `--target <name>` | Select the destination for an unbound proposal, or confirm a recorded destination; a conflict with a recorded target is rejected |

Accepts the full proposal UUID or the asset ref. UUID prefixes are **not**
supported for reverting (archived proposals require the full identifier). Errors
with exit code 2 if the proposal is not in `accepted` status, has no captured
backup, or cannot be found.

#### proposal diff

Preview the proposed change against the live asset. Accepts a full UUID, an
8-character UUID prefix, or an asset ref directly.

```sh
akm proposal diff <id>
akm proposal diff skills/akm-dream             # Asset ref form
akm proposal diff 7c115132                    # 8-char UUID prefix
akm proposal diff <id> --queue team-bundle
akm proposal diff <id> --target team-bundle    # Must match a recorded target
```

| Flag | Description |
| --- | --- |
| `--queue <source>` | Select the proposal queue by configured writable source name |
| `--target <name>` | Select an unbound destination or confirm a recorded one for `proposal accept`, `diff`, or `revert`; a conflict with a recorded target is rejected |

`proposal accept` runs full validation before promoting. `proposal reject`
requires `--reason`.

#### proposal drain

Drain the standing pending-proposal backlog using a deterministic triage
policy, instead of adjudicating proposals one at a time. Default mode stages
decisions (queue mode); pass `--promote` to actually accept matching
proposals.

```sh
akm proposal drain --dry-run                        # Preview without writing
akm proposal drain --policy personal-stash --promote -y
akm proposal drain --policy conservative --max-accepts 10 --promote -y
akm proposal drain --max-diff-lines 50 --older-than 7 --promote -y
akm proposal drain --strategy default --promote -y  # Read the triage block from an improve strategy
```

| Flag | Description |
| --- | --- |
| `--policy` | Built-in preset (`personal-stash`, `conservative`, `manual`) or a path to a policy file |
| `--strategy` | Read the triage block (policy, apply mode, ceilings, judgment) from this improve strategy instead |
| `--promote` | Promote (accept) matching proposals. Default is queue mode — stage only, no writes to assets. |
| `--dry-run` | List what would be accepted/rejected/deferred, without writing |
| `--max-accepts` | Hard per-run accept ceiling; accepts beyond this are reported as `skippedByCap` |
| `--max-diff-lines` | Defer (never promote) accepts whose proposed content exceeds this many lines |
| `--older-than` | Only consider proposals created more than this many days ago |
| `--judgment` | Explicitly enable the judgment tier for this standalone drain, including when the selected strategy says `judgment.enabled: false`; execution overrides still come from that strategy. Without this flag, strategy judgment config does not enable standalone drain judgment. A missing runner remains a no-op with a logged `triage_deferred` summary. |
| `-y`, `--yes` | Skip the confirmation prompt (required in non-interactive mode for promotion) |

### feedback (`--reason`)

`akm feedback` accepts an optional `--reason <text>` flag whose value is
forwarded into feedback metadata and consumed by improve/distill proposal
prompts. Negative feedback requires a reason by default.

### task

`akm task` is the scheduling surface for workflows, agent prompts, and
shell commands. It manages on-disk task definitions under
`<bundle>/tasks/<id>.yml` and reconciles them with the OS-native scheduler
(cron / launchd / schtasks). Task source v4 YAML (`version: 4`) is the only
executable source contract this release accepts; `akm task add` writes v4 —
see the canonical [Tasks reference](tasks.md). The
group is `add | run | explain | validate | list | sync | doctor | history | prune`
— there is no `show` or `remove`; use `akm show tasks/<id>` to inspect one
task, and edit the file + `akm task sync` to change or remove a schedule.
`task list` is a delegating alias for `akm search --type task` — both
spellings return the identical envelope.

```sh
akm task list                                # List tasks (cross-bundle) — alias for `search --type task`
akm show tasks/<id>                          # Inspect one task
akm task add <id> --schedule "@daily" \     # Register a new task and install it
  --command "akm improve --strategy default"
akm task add review --schedule "@daily" --prompt "Review recent changes" --engine reviewer
akm task add nightly --schedule "@daily" --command "akm improve" --disabled  # register but leave off
akm task add nightly --schedule "@daily" --command "akm improve" --force    # overwrite an existing task id
akm task run <id>                           # Execute now (what the scheduler calls)
akm task explain <ref>                      # Read-only: declared inputs, target, schedule — spawns nothing
akm task validate <path>                    # Read-only: parse one task file by path, report sync's diagnostic
akm task history [<id>] [--id <id>] [--limit <n>]  # Recent runs from state.db (positional id == --id)
akm task sync                               # Reconcile on-disk YAML with scheduler
akm task sync --dry-run                     # Preview the reconcile — zero scheduler writes
akm task sync --rebind                      # Also capture the current installed runtime
akm task doctor                             # Report scheduler backend + paths
akm task prune                              # Preview orphaned scheduler entries — zero writes
akm task prune --yes                        # Remove every currently-computed orphan
akm task prune --id ghost,stale --yes       # Remove only the named orphan ids
```

`task add` also accepts `--disabled` (register but leave off in the OS
scheduler), `--force` (overwrite an existing task with the same id), and
`--rebind` (explicitly permit scheduler creation from a local invocation that
would otherwise be considered ineligible).

`akm task list [<query>] [--limit <n>] [--from local|registry|all]` is a
pure alias for `akm search --type task` with the query, `--limit`, and
`--from` flags passed through — same envelope, same `results` alias, no
second implementation. 0.9.0 removed `task list` as a redundant
implementation of task listing (see the 0.9.0 CHANGELOG entry); this
reintroduces only the spelling, not the logic.

`akm task explain <ref> [input flags]` prints a task's declared `inputs:`,
the values that would actually be supplied (with provenance), the resolved
target, effective execution settings, and schedule bindings — **read-only**:
it never spawns anything, writes history, or touches the scheduler. A
secret-shaped value prints as `<redacted>`. See
[`akm task explain`](tasks.md#akm-task-explain).

`akm task validate <path>` parses ONE task file by filesystem path — not a
concept ref or id, and the file need not live in any configured bundle —
and reports the same diagnostic `akm task sync` would produce for it,
INCLUDING sync's own cron-dialect check and its per-schedule-entry
input-contract check (so a file `sync` would reject can never be reported
`valid`/`converts` here): `{ok, path, sourceVersion, outcome, reason?,
resolved?}` where `outcome` is `valid` (parses as task source v4 directly
and passes both sync checks), `converts` (task v2/v3 that the deterministic
migrator converts in memory and which then also passes both sync checks),
`blocked` (task v2/v3 the migrator itself cannot convert — needs a human
decision), `invalid` (the YAML doesn't parse, or the document fails schema
validation, or it parsed but fails one of the two sync checks), or
`not-a-task` (the YAML parses but never declares a `version:` field — not
shaped like a task source). `resolved` is the compiled task shape
`akm task sync` itself would build a scheduler binding from — id, the
compiled schema version, resolved `uses`/`run` target, declared `inputs`
contract, and `schedule` bindings — present only on `valid`/`converts`.
Unlike `akm task explain`, it never runs execution lowering: a command-kind
task validates the same whether or not the local config has an engine
configured. Exits 0 for `valid`/`converts`, 1 for
`blocked`/`invalid`/`not-a-task`, 2 for a missing or unreadable path.
**Read-only**: it never touches the scheduler and never requires the file to
be indexed or wired into a bundle.

`akm task run` is what cron / launchd / schtasks invoke at the scheduled
time. Each run is recorded as a row in the durable `task_history` table
(`state.db`), surfaced by `akm task history` — **not** by `akm log`; there is
no `task_invoked`/`task_completed` event type on the `akm log` stream.

To disable a scheduled task, set `enabled: false` on its `schedule:` entry
(task source v4 has no document-level `enabled` flag — it lives per
schedule-binding) and run `akm task sync`. To remove one, delete its file
(`<bundle>/tasks/<id>.yml`) and run `akm task sync` — sync uninstalls the
orphaned scheduler entry.

`akm task sync --dry-run` prints the planned adds/updates/removes (removals
carry their owning bundle) without touching the scheduler — zero writes.
Exits non-zero when removals are pending, so it can gate a CI/health check
on "sync would change something."

`akm task prune` reclaims installed scheduler entries that `sync` can never
clean up on its own: entries whose own `--scheduler-context` descriptor no
longer resolves to a live bundle (a corrupt/missing descriptor, or the
bundle directory it pointed at is gone). It never touches an entry that
still resolves to a live bundle — that's `sync`'s job. Like `sync
--dry-run`, the default is a dry-run preview (zero scheduler writes) that
exits non-zero when there are candidates to remove; `--yes` executes the
printed plan, and `--id <id1,id2,...>` narrows a `--yes` run (or a preview)
to specific binding ids — naming an id that isn't a current orphan
candidate (not installed, or it still resolves to a live bundle) is
refused with a usage error and removes nothing.

Scheduler activation captures the installed akm runtime. Ordinary `task sync`
reconciles definitions, schedules, and enabled state while preserving that
runtime binding. Use `task sync --rebind` only after intentionally moving or
replacing the installation, or to repair a stale runtime path, then verify the
result with `akm task doctor`. Interactive `akm setup` reviews every embedded
task template (both the core set and the improve-schedule set) and asks once
before changing task files or scheduler state; non-interactive setup changes
neither.

Because the scheduler runs the exact binary path recorded at the last `task
sync`, upgrading akm through a different installer than the one active at
that sync (npm-global to a standalone download, or vice versa) leaves
scheduled runs invoking the old, now-stale binary — `task sync` re-resolves
the current path and repoints them. `akm health --probe`'s `scheduler-binary`
advisory warns when the two diverge, naming both versions.

Setup reconfiguration preserves existing scheduler runtime bindings. Changing
the AKM storage path or installed runtime path therefore requires an explicit
`akm task sync --rebind`; setup does not silently migrate those entries.

**Bundle targeting (`--bundle <bundle>`).** By default every subcommand
operates on the primary/default bundle. `add`, `history`, `sync`, `run`, and
`explain` all accept `--bundle <bundle>` to schedule, reconcile, or inspect
tasks that live in another configured bundle (`doctor` reports scheduler-wide
state and takes no `--bundle`; `validate` takes a bare filesystem path
instead of a ref, so it has no bundle to target either):

```sh
akm task add nightly --schedule "@daily" --command "akm improve" --bundle team-bundle
akm task sync --bundle team-bundle             # reconcile only that bundle
```

A non-default bundle is recorded in the installed scheduler entry as a
`--bundle <bundle>` token, so the scheduled `akm task run` resolves the task
(and its relative asset refs) from that bundle. `sync` reconciles one bundle at a
time and only touches entries attributed to it, so a plain (primary) sync never
disturbs another bundle's scheduled tasks. Scheduler ids are the bare task id and
are never namespaced: registering a task whose id is already scheduled from a
different bundle is a hard error.

`task add` accepts exactly one CLI target selector (`--workflow <ref>`,
`--prompt <text-or-ref>`, or `--command <shell>`) and writes a task source v4
document (`version: 4`). In the file, exactly one of `uses` or `run` is
allowed. `uses` accepts command, workflow, and script refs plus `akm/command`;
agents and task refs are not executable. `run` accepts a shell string with the
closed shell and contained working-directory contract. Task source v4 has no
`akm:` options bag or `on:` trigger block — scheduling, resolver overrides,
`timeout`, `maxSteps`, `maxRetries`, and redaction names are all top-level
keys on the document itself. Normal execution rejects v2 and v3 and points to
`akm migrate apply --dry-run` followed by `akm migrate apply`. See
[Tasks](tasks.md#migrating-to-task-source-v4) for the complete grammar and
fail-closed migration behavior.

**Task-log redaction and `redact:`.** A task's persisted output — the run `.log`
file and its `logs.db` rows — is scrubbed before it is written. Two passes run:
credential *shapes* (`Bearer …`, `sk-…`, webhook URLs) are matched by pattern,
and exact secret values are matched by value. akm knows a value is secret when
the config declares it (`engines.<name>.apiKey`, `embedding.apiKey`, and the
`AKM_ENGINE_<NAME>_API_KEY` / `AKM_LLM_API_KEY` / `AKM_EMBED_API_KEY` recipes),
and it infers others from the variable name (`*_TOKEN`, `*_SECRET`, `*_API_KEY`,
`*_PASSWORD`, …) provided the value is at least 8 characters — a short one is
far more likely to be a flag than a credential, and redaction replaces
substrings, so guessing wrong mangles the log.

Any task kind may add `redact:` for a secret exported under a name none of those
rules recognise:

```yaml
version: 4
run: ./deploy.sh
schedule: "0 3 * * *"
redact: [ACME_DEPLOY_TOKEN]   # NAMES, never values
```

akm looks each name up in the environment the run is given; a name that is unset
contributes nothing. **Names only.** A literal secret in a task file would leak
far more widely than the redaction closes: task files are indexed into the search
database, can be sent to an embedding provider, are printed verbatim by `akm
show`, and ship inside bundles over git and npm. This is the same rule exec
units' `pass_env:` follows.

A workflow-target task executes the same native orchestration as `akm workflow
run`; it does not stop after creating a run. Completion maps to task
`completed`, while workflow failure or verifier rejection maps to task
`failed`. A workflow-target task's declared `inputs:` (with their `default:`
values) remain the non-CLI way a scheduled definition supplies its new-run
parameter snapshot.

**Workflow-task run bounds.** Top-level `timeout`, `maxSteps`, and
`maxRetries` correspond to `akm workflow run --timeout`, `--max-steps`, and
`--max-retries`. Unlike the interactive command, a scheduled workflow task gets
a **default whole-run timeout of 6 hours**
(`DEFAULT_WORKFLOW_TASK_TIMEOUT_MS`): nobody is at the terminal to Ctrl-C an
unattended run, so without one a single wedged unit hangs the task forever. An
explicit `timeout` always wins, and `timeout: null` opts out entirely. On
expiry the runner aborts the run's signal, which the engine treats as a
graceful break at the next step boundary — the journal is kept and the run
stays resumable with `akm workflow resume <run-id>` (the run id is in the task
run's `detail.error` and log). The attempt itself is recorded as `failed`, so
the OS scheduler sees a non-zero exit.

```yaml
version: 4
uses: workflows/nightly-report
inputs:
  region:
    type: string
    default: us-east-1
schedule: "@daily"
timeout: 3600000   # 1h whole-run bound (omit for the 6h default, null for none)
maxSteps: 20       # optional
maxRetries: 1      # optional
```
