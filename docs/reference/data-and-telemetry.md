# AKM Data & Telemetry

AKM stores your data locally on your machine and has **no telemetry**: it does not send usage data, analytics, or crash reports to Anthropic or to the AKM project, and it has no servers of its own that receive your data. It does, however, make network requests to the endpoints **you** configure — your LLM/embedding provider, the registries and source hosts you install from, and GitHub for upgrades — and those endpoints necessarily receive whatever those requests contain. This document describes exactly what AKM reads, writes, and sends.

## No Telemetry

AKM does not:
- Send usage data, events, or crash reports to Anthropic or the AKM project
- Contact any AKM-operated analytics or telemetry endpoint at runtime
- Include any analytics SDK or beacon
- Collect your email, name, or any personally-identifying information for the project's benefit

AKM adds no network destinations of its own. The requests it *does* make all go to endpoints you chose or invoked, and those third parties receive whatever the request contains:

1. **Your configured LLM/embedding provider** (e.g. Anthropic, OpenAI, a local Ollama, or any OpenAI-compatible endpoint) receives the prompts and asset content sent for reflect/propose/distill/embedding when you enable those features. If you point AKM at Anthropic, Anthropic receives those requests.
2. **Registry metadata and bundle packages** from sources you explicitly configure (GitHub, npm, git remotes, websites) — those hosts receive the fetch/clone/crawl requests, and website sources receive requests for the pages you crawl.
3. **`akm upgrade`** — fetches the latest release from GitHub releases (GitHub sees the request).
4. **`akm setup`** — a single DNS lookup for `github.com` to decide whether to skip network-dependent steps (Ollama detection, remote embedding probes) when offline. No HTTP request is made by this probe; if it succeeds, akm proceeds with the network-dependent steps you already configured.
5. **`akm improve` dead-link checks** — a full-scope improve run (the default for a bare `akm improve`) sends best-effort `HEAD` requests (following redirects, with a short per-request timeout, checked at a bounded concurrency rather than all at once) to every URL found in the bodies of the knowledge assets it is improving, to flag dead links. The hosts of those URLs see a `HEAD` request; no asset content is sent. Keep URLs you don't want probed out of knowledge-asset bodies, or run improve with an explicit narrower scope.

In every case the receiving endpoint is one you configured or invoked; the data leaving your machine is the data you directed AKM to send there.

---

## Dry runs and diagnostic output

Command dry-run is an intentionally zero-write diagnostic.
A command dry-run does not mutate or write authored source.
A command dry-run does not mutate or write durable state.
A command dry-run records no usage.
A command dry-run emits no events.
A command dry-run performs no accounting.

`akm command run --dry-run` still reads the selected source and configuration,
performs authorization, and lowers a request. It does not dispatch or
materialize credentials. Its output contains only safe field provenance and
fixed lowering notices; resolved prompt, command, environment, endpoint,
model, and credential values are excluded. Live `--verbose` writes the same
safe diagnostic metadata to stderr while preserving normal stdout.

---

## Local On-Disk Surface

AKM writes to these locations on your machine. All paths follow [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/) conventions on Linux/macOS and Windows conventions on Windows.

### Config Directory (`$XDG_CONFIG_HOME/akm` or `~/.config/akm/`)

| Path | Contents | Safe to delete? |
|---|---|---|
| `config.json` | Your AKM configuration: engines, improve strategies, bundles (bundle sources), and experimental opt-ins — see [Configuration](configuration.md) | **No** — deleting resets all settings |

Override: set `AKM_CONFIG_DIR` or `XDG_CONFIG_HOME`.

### Data Directory (`$XDG_DATA_HOME/akm` or `~/.local/share/akm/`)

| Path | Contents | Safe to delete? |
|---|---|---|
| `index.db` | Search index for all your bundle assets (FTS5 + metadata) | Yes — rebuilds via `akm index --full` |
| `state.db` | Events, local usage telemetry, proposals, task history, improve run results, and workflow run state/history (the former `workflow.db` was folded in during the 0.9.0 cutover) | **No** — deletes event/usage logs, proposal queue, improve history, and workflow run history |
| `logs.db` | Structured, high-volume task/run log lines (`{ts, task_id, run_id, stream, level, line}`), joined to `state.db`'s `task_history` rows by `task_id@started_at`. Kept separate from `state.db` because log lines are append-only and freely purgeable, unlike durable state | Yes — log lines are regenerable per run; deleting loses historical run output only |
| `akm.lock` | Inter-process write lock | Yes — recreated automatically |
| `backups/task-v3/`, `backups/task-v4/` | Copies of task files taken by `akm migrate apply` before it rewrites them, one timestamped directory per run; the five most recent per generation are kept (#897) | Yes — once the migrated tasks are verified |
| `akm.lock.lck` | Lock write sentinel | Yes — recreated automatically |

Override: set `AKM_DATA_DIR` or `XDG_DATA_HOME`.

These files take your **process umask** — akm does not set or change their
permissions. They hold task history, captured command output, and indexed
content, so on a shared machine you probably do not want them world-readable;
set a tighter umask, or `chmod` the directory yourself. akm will not do it for
you, and `akm health` will not nag about it either — `0644` under a default
`022` umask is simply the expected state.

If akm **cannot read** this directory — a uid/ownership mismatch, for instance
when two accounts share one `$XDG_DATA_HOME` — commands fail loudly with a
`DATA_DIR_UNREADABLE` config error (exit 78) naming the path, the errno, the
mode and owner, and the uid you are running as. They do **not** report an empty
index. `akm health` stays runnable in that state and reports it as a failing
`state-db-readable` check, so it remains the command to reach for.

> **0.9.1 note.** A pre-release build briefly chmodded this directory to `0700`
> and the databases to `0600` on every open. That was reverted: it silently
> changed the permissions of directories akm did not create, which broke installs
> sharing `$XDG_DATA_HOME` between two uids. If a 0.9.1 pre-release tightened
> your data directory and you need it shared again, `chmod` it back.

### Cache Directory (`$XDG_CACHE_HOME/akm` or `~/.cache/akm/`)

Everything in the cache is regenerable. It is safe to delete the entire cache directory; AKM will recreate what it needs on next use.

| Path | Contents | Safe to delete? |
|---|---|---|
| `config-backups/config-<timestamp>.json` | Pre-save config snapshots (5 retained; owner-only permissions — file `0600`, dir `0700`, since 08-F4) | Yes |
| `config-backups/config.latest.json` | Latest backup alias (owner-only `0600`) | Yes |
| `registry/` | Downloaded registry tarballs (bundle packages from npm, GitHub, etc.) | Yes — re-downloaded on next `akm bundle add` or `akm bundle update` |
| `registry-index/` | Legacy per-URL JSON cache (v0.7 artifact) | Yes — fully replaced by `index.db` in 0.8.0 |
| `semantic-status.json` | Semantic index build status marker | Yes |
| `bin/` | Downloaded AKM binary cache (used by `akm upgrade`) | Yes |
| `tasks/logs/` | Scheduled task log files. Written at your umask; they hold captured command/agent output, so tighten the directory yourself if the machine is shared | Yes — ephemeral logs |
| `tasks/history/` | Legacy task history JSONL (v0.7 migration artifact) | Yes |

Override: set `AKM_CACHE_DIR` or `XDG_CACHE_HOME`.

### Bundle Directory (`~/akm/` by default, or user-configured)

| Path | Contents | Safe to delete? |
|---|---|---|
| `<stash>/` | All your asset files: agents, skills, commands, knowledge, instructions, workflows, scripts, memories, env files, secrets, lessons, tasks, sessions, facts, plus any bundle-adapter-owned content (e.g. `llm-wiki` bundle roots — not an AKM `PLACEMENT_SPECS` type) | **No** — this is YOUR data |
| `<stash>/.akm/` | Hidden AKM metadata (v0.7 proposals, legacy runs) | Caution — check for pending proposals first |

Override: set `AKM_BUNDLE_DIR`, or configure `bundles`/`defaultBundle` in `config.json` (the top-level `stashDir` key from 0.8 is retired and rejected in 0.9 — see [Configuration](configuration.md#bundles-and-write-target)).

---

## What Is Stored in `state.db`

`state.db` holds four categories of non-regenerable data:

### 1. Events Table

An append-only log of every mutating action you perform with AKM. Events are stored locally for self-improvement (the improve loop uses them to surface usage patterns) and for inspection via `akm log`.

**What is recorded:**
- `event_type` — what action was taken (see full list below)
- `ts` — ISO-8601 UTC timestamp
- `ref` — the asset ref affected (e.g. `skills/code-review`), if applicable
- `metadata` — structured payload specific to the event type (e.g. query text for `search`, score for `feedback`)

**What is NOT recorded:**
- File contents
- LLM prompts or responses
- API keys or secrets (config is not stored in events)
- Personal information

**Retention:** Events older than 90 days are purged automatically when `akm improve` runs its maintenance pass. The window is `improve.eventRetentionDays` (default `90`; set `0` to disable), enforced by `purgeOldEvents()`.

**Full event type list.** `EventType` (`src/core/events.ts`) is an open
string union — new types can be added without a schema bump — so this is
the set of types the code actually emits at HEAD (verified against every
`appendEvent(...)` call site, 2026-07-27), grouped by area:

*Asset lifecycle*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `add` | `akm bundle add <source>` | `ref`, `provider` |
| `remove` | `akm bundle remove <source>` | `ref` |
| `update` | `akm bundle update [source]` | `ref` |
| `remember` | `akm remember <text>` | `ref` |
| `import` | `akm import <file>` | `ref` |
| `rekey` | `scripts/rekey-asset-ref.ts` moved at least one row onto a renamed asset's new ref — nothing is emitted on a no-op re-run | `ref` (the new ref); metadata `{from, to, changed}` (row counts only) |

*Search, retrieval, sync*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `search` | `akm search <query>` | `query`, `source`, `signal` |
| `curate` | `akm curate <prompt>` | `query`, `source` |
| `show` | `akm show <ref>` | `ref`, `type`, `name` |
| `select` | `akm show` after a search returning the same ref | `ref`, `entryId` |
| `feedback` | `akm feedback <ref>` | `signal` (positive/negative) |
| `sync` | `akm sync` | `ref` |
| `stash_synced` | `akm improve`'s internal auto-sync pass (the `sync.push` feature), **distinct from** the `akm sync` command above | `committed`, `pushed`, `skipped`, `reason`, `attributed` (paths the run wrote and staged), `unattributed` (in-scope paths that went dirty during the run without the run writing them — left for their author) |
| `env_access` | `akm env run <name> -- <command>` (audit trail: key **names** only, values never recorded) | `ref`, `keys` |
| `secret_access` | `akm secret run <ref> <VAR> -- <command>` (audit trail: var **name** only, value never recorded) | `ref`, `var` |

*Proposals*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `promoted` | `akm proposal accept <id>` | `ref` |
| `rejected` | `akm proposal reject <id>` | `ref` |
| `proposal_reverted` | `akm proposal revert <id>` (undoes a previously-accepted proposal, restores prior content) | `ref` |
| `proposal_expired` | A pending proposal aged past the retention window and was auto-expired | `ref` |
| `proposal_expiration_pass` | Summary emitted once per `akm improve` maintenance run after per-proposal `proposal_expired` events | expiry counts |
| `proposal_orphan_purge` | Stale proposals whose target asset no longer exists on disk, pruned by improve maintenance | `checked`, `rejected` |
| `proposal_creation_rejected` | `createProposal()` validation failed before write | `ref`, `reason`, `source` |
| `triage_drained` | `akm proposal drain` run summary | `promoted`, `rejected`, `deferredByReason`, `skippedByCap`, `policy`, `applyMode` |
| `triage_deferred` | `akm proposal drain` left items unresolved after the (optional) judgment tier | `deferred`, `deferredByReason`, `reason` |

*`akm improve` pipeline*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `improve_invoked` | Start of an `akm improve` run | `ref` (scope); `strategy`, `scope`, `dryRun`, `eligibleCount` |
| `improve_completed` | `akm improve` run finished | run stats |
| `improve_failed` | `akm improve` run errored | error |
| `improve_skipped` | Asset skipped by cooldown or budget | `ref`, `reason` |
| `improve_lock_recovered` | Stale improve lock cleared at startup | |
| `improve_review_needed` | `akm feedback` pushed a high-utility asset's utility below the review threshold — a review-needed escalation is recorded (not a proposal, so it can't accidentally overwrite the asset) | `ref`, `previousUtility`, `nextUtility` |
| `reflect_invoked` | Start of reflect phase in `akm improve` | `ref`, engine |
| `reflect_completed` | Reflect phase produced a proposal | `ref` |
| `improve_reflect_outcome` | Per-asset reflect result | `ref`, `ok`, `durationMs`, `reason` |
| `propose_invoked` | `akm proposal new` | `ref` |
| `distill_invoked` | Distill phase inside the `akm improve`/`akm proposal new` pipeline. **`akm distill` is not a CLI command** — there is no standalone verb by that name | `ref`, outcome |
| `consolidate_completed` | `akm improve`'s consolidate pass processed at least one memory | `ref` (`memories/_consolidation`) |
| `extract_invoked` | `akm proposal extract --type <harness>` / `--auto`, or improve-stage session extraction | `outcome`, `sessionId`, `harness` |
| `extract_triaged` | The pre-LLM extract triage gate evaluated at least one session | `evaluated`, `passed`, `triagedOut`, `sourceRun` (aggregated) |
| `schema_repair_invoked` | The schema-repair pass inside `akm improve` (`runSchemaRepairPass`) attempts to patch missing frontmatter on an asset that failed schema validation. **There is no `akm lint --repair` flag** — `lint` has `--fix`/`--auto-fix`, unrelated to this event | `ref`, outcome |
| `proactive_selected` | The proactive-maintenance selector runs (once per `akm improve` run) | `count`, `dueTotal`, `neverReflected` (aggregated) |
| `improve_replay_selected` | Bounded replay-budget selection ran | `count`, `budget`, `convergedSkipped`, `candidatePool` (aggregated) |
| `improve_salience_first_run` | First improve run with no pre-existing salience baseline to compare against | `candidateCount`, `note` |
| `improve_salience_rank_change` | Bundle-wide rank-change report, from the second improve run onward | `stashSize`, `totalChanged`, `forgettingCandidates`, `topDrops` |
| `outcome_proxy_inverted` | Proxy-adequacy tripwire: `outcome_score` correlates *negatively* with accepted-change rate (corr < −0.3) | `correlation`, `n` |
| `outcome_proxy_dead` | Proxy-adequacy tripwire: `outcome_score` is statistically unrelated to accepted-change rate (\|corr\| < 0.1, n ≥ 500) | `correlation`, `n` |
| `collapse_detector_alert` | The collapse/churn detector trips an alert rule during an improve cycle | `kind` (collapse-recall\|collapse-entropy\|collapse-shrink\|churn\|merge-floor), `detail`, `metrics`, `canarySetId`, `runId` |
| `events_purged` | Old events deleted by improve maintenance (90-day default retention) | `purgedCount`, `retentionDays` |
| `improve_runs_purged` | Old `improve_runs` rows deleted by improve maintenance (same retention window as events) | `purgedCount`, `retentionDays` |
| `improve_cycle_metrics_purged` | Old `improve_cycle_metrics` rows (365-day retention) deleted by improve maintenance | `purgedCount`, `retentionDays` |
| `task_logs_purged` | Old scheduled-task log files purged by improve maintenance | |

*Workflows*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `workflow_started` | `akm workflow run <ref>` creates a run (including native workflow task execution) | `ref`, `runId` |
| `workflow_step_completed` | The run completion path records a genuine `completed` transition | `ref`, `runId`, `stepId`, `status` |
| `workflow_step_updated` | The run completion path records a non-`completed` transition (`failed`/`skipped`/`blocked`) | `ref`, `runId`, `stepId`, `status` |
| `workflow_finished` | A `run` transition makes the run terminal | `ref`, `runId` |
| `workflow_abandoned` | `akm workflow abandon` | `runId` only — never the workflow title |
| `workflow_unit_started` | A unit begins through `akm workflow run` | ids/status only — never unit instructions or results |
| `workflow_unit_finished` | A workflow unit terminates | ids/status/tokens only — never unit instructions or results |

*LLM usage and health*

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `llm_usage` | Per-attempt LLM call usage telemetry (#576) | model provenance, terminal outcome, duration, optional token usage |
| `llm_usage_summary` | The owning LLM telemetry sink's terminal-record count marker | `expectedTerminalRecords` |
| `health_probe` | `akm health`'s state.db round-trip write/read probe. **Not durably retained**: the row is inserted then deleted within the same connection once the round trip is confirmed, so the net effect on the `events` table is always zero rows | n/a (ephemeral) |

`llm_usage` rows also carry `process`/`engine`/`stage` (each optional; a call
made outside any attributed scope carries none of them). `akm improve`
(#944) aggregates a run's own `llm_usage` events into a process x engine x
model cross-tab — `summarizeLlmUsageCrossTab` in `src/commands/health/llm-usage.ts`
— persisted on the run result as `usageReport.byProcessEngineModel` and
queryable per-run or aggregated with `akm improve report`; see
`docs/reference/cli.md`'s `#### improve report` section.

### 2. Usage Events Table

`usage_events` is the local analytical record behind utility ranking,
retrieval-demand counts, GRR, and real-query eval generation (0.9.0: its CLI
read surface, `akm history`, was removed — the table itself and everything
below still applies). It stores
search/curate queries, per-entry search impressions, explicit show/curate
engagement, feedback signals, stable refs, and timestamps. It never leaves the
machine unless you explicitly copy the database or send derived content to a
configured endpoint.

Successful `search`, `curate`, and `show` commands record usage by default.
Pass `--no-track-usage` to any of those commands to leave local usage events
and ranking signals unchanged.

Every runtime writer stamps provenance as `user`, `improve`, `task`, `audit`, or
`unknown`. Direct interactive CLI traffic defaults to `user`; internal improve,
scheduled-task, and eval subprocesses preserve their stamp across nested
search/curate/show/remember/agent reads. Omitted or invalid writer provenance is
`unknown`, and pre-provenance rows rescued at the 0.9 cutover are also
`unknown`. Only exact `source='user'` rows contribute demand, utility, GRR, or
real-query labels.

Per-entry `search`, `curate`, and `show` rows carry a local-only
`metadata.downstreamAttribution` object. Version 1 uses `control: true` for
current traffic where neither memory inference nor graph extraction applies;
rows without the version marker are historical/unattributed. Attributed rows
use `control: false` and may contain:

- `memoryInference`: `direct` when the emitted ref is an inferred child, or
  `surface` when derived description/tags were actually present in the emitted
  search or selected curate output. Brief output and internally replaced
  descriptions are controls, not surface attribution.
- `graphExtraction`: the positive graph-ranking contribution that was actually
  applied after the shared contributor cap, plus `bodyHash` and
  `extractionRunId` when available. It is absent when `graph-ranking` is
  ablated. The number is a ranking-input contribution, not proof that graph
  changed final rank, selection, or outcome; score saturation and competing
  contributors can leave ordering unchanged.

Attribution metadata contains fully-qualified refs and graph identifiers, never
asset bodies or provenance content. It is not added to `search`, `curate`, or
`show` result payloads; there is no CLI surface that reads it back (0.9.0:
`akm history` was removed). The full index still applies its existing
higher-priority-wins `(type, entry.name)` dedup across sources: attribution
source-qualifies every indexed row but does not invent a lower-priority row for
an identity that production indexing omitted.

### 3. Proposals Table

The proposal queue: pending, accepted, and rejected improvement proposals for your bundle assets. Generated by `akm improve`, `akm proposal new`, and related proposal-producing flows.

Contents:
- Proposal UUID (primary key)
- Target asset ref
- Status (pending/accepted/rejected)
- Source (which process generated it — e.g. `reflect`, `distill`)
- Full proposal content (Markdown text)
- Created/updated timestamps

### 4. Task History Table

A record of scheduled task runs (from `akm task`):
- Task ID, status, start/end times
- Log file path (the log content stays in `$CACHE/tasks/logs/`)

---

## How to Inspect and Clear Local Data

### Inspect events

```sh
# List recent events
akm log

# Filter by type
akm log --type search --limit 20

# Filter by asset ref
akm log --ref skills/code-review
```

### Inspect proposals

```sh
# List pending proposals
akm proposal list

# Show a specific proposal
akm proposal show <id>
```

### Clear specific data

```sh
# Delete the search index (safe — rebuilds with akm index --full)
rm ~/.local/share/akm/index.db

# Delete all cached registry downloads
rm -rf ~/.cache/akm/registry/

# Delete config backups
rm -rf ~/.cache/akm/config-backups/

# Delete the events log from state.db (non-reversible)
# There is no akm CLI command to do this directly (`akm log` only exposes
# `list`/`tail`, no delete/purge verb). Use SQLite directly:
sqlite3 ~/.local/share/akm/state.db "DELETE FROM events;"

# Delete all proposals
sqlite3 ~/.local/share/akm/state.db "DELETE FROM proposals;"
```

### Start completely fresh (nuclear reset)

```sh
rm -f ~/.config/akm/config.json
rm -rf ~/.local/share/akm/
rm -rf ~/.cache/akm/
# Your stash files in ~/akm/ are NOT touched by the above.
```

---

## Environment Variable Overrides

You can redirect any AKM directory to a custom path:

| Variable | Overrides |
|---|---|
| `AKM_CONFIG_DIR` | Config directory (`~/.config/akm/`) |
| `AKM_DATA_DIR` | Data directory (`~/.local/share/akm/`) |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE`, or `TRUNCATE`. Use `DELETE`/`TRUNCATE` on network filesystems (NFS/SMB) where WAL is impossible. When left at the `WAL` default, akm auto-detects a network FS for the data dir and falls back to `DELETE`. |
| `AKM_STATE_DIR` | State directory (`~/.local/state/akm/`) |
| `AKM_CACHE_DIR` | Cache directory (`~/.cache/akm/`) |
| `AKM_BUNDLE_DIR` | Default bundle directory (`~/akm/`) |
| `XDG_CONFIG_HOME` | XDG base — akm appends `/akm` |
| `XDG_DATA_HOME` | XDG base — akm appends `/akm` |
| `XDG_STATE_HOME` | XDG base — akm appends `/akm` |
| `XDG_CACHE_HOME` | XDG base — akm appends `/akm` |
