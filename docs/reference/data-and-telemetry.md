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
2. **Registry metadata and stash packages** from sources you explicitly configure (GitHub, npm, git remotes, websites) — those hosts receive the fetch/clone/crawl requests, and website sources receive requests for the pages you crawl.
3. **`akm upgrade`** — fetches the latest release from GitHub releases (GitHub sees the request).
4. **`akm setup`** — a single DNS lookup for `github.com` to decide whether to skip network-dependent steps (Ollama detection, remote embedding probes) when offline. No HTTP request is made by this probe; if it succeeds, akm proceeds with the network-dependent steps you already configured.

In every case the receiving endpoint is one you configured or invoked; the data leaving your machine is the data you directed AKM to send there.

---

## Local On-Disk Surface

AKM writes to these locations on your machine. All paths follow [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/) conventions on Linux/macOS and Windows conventions on Windows.

### Config Directory (`$XDG_CONFIG_HOME/akm` or `~/.config/akm/`)

| Path | Contents | Safe to delete? |
|---|---|---|
| `config.json` | Your AKM configuration: engines, strategies, stash paths, and feature settings | **No** — deleting resets all settings |

Override: set `AKM_CONFIG_DIR` or `XDG_CONFIG_HOME`.

### Data Directory (`$XDG_DATA_HOME/akm` or `~/.local/share/akm/`)

| Path | Contents | Safe to delete? |
|---|---|---|
| `index.db` | Search index for all your stash assets (FTS5 + metadata) | Yes — rebuilds via `akm index --full` |
| `state.db` | Events, local usage telemetry, proposals, task history, improve run results, and workflow run state/history (the former `workflow.db` was folded in during the 0.9.0 cutover) | **No** — deletes event/usage logs, proposal queue, improve history, and workflow run history |
| `akm.lock` | Inter-process write lock | Yes — recreated automatically |
| `akm.lock.lck` | Lock write sentinel | Yes — recreated automatically |

Override: set `AKM_DATA_DIR` or `XDG_DATA_HOME`.

### Cache Directory (`$XDG_CACHE_HOME/akm` or `~/.cache/akm/`)

Everything in the cache is regenerable. It is safe to delete the entire cache directory; AKM will recreate what it needs on next use.

| Path | Contents | Safe to delete? |
|---|---|---|
| `config-backups/config-<timestamp>.json` | Pre-save config snapshots (5 retained; owner-only permissions — file `0600`, dir `0700`, since 08-F4) | Yes |
| `config-backups/config.latest.json` | Latest backup alias (owner-only `0600`) | Yes |
| `registry/` | Downloaded registry tarballs (stash packages from npm, GitHub, etc.) | Yes — re-downloaded on next `akm add` or `akm update` |
| `registry-index/` | Legacy per-URL JSON cache (v0.7 artifact) | Yes — fully replaced by `index.db` in 0.8.0 |
| `semantic-status.json` | Semantic index build status marker | Yes |
| `bin/` | Downloaded AKM binary cache (used by `akm upgrade`) | Yes |
| `tasks/logs/` | Scheduled task log files | Yes — ephemeral logs |
| `tasks/history/` | Legacy task history JSONL (v0.7 migration artifact) | Yes |

Override: set `AKM_CACHE_DIR` or `XDG_CACHE_HOME`.

### Stash Directory (`~/akm/` by default, or user-configured)

| Path | Contents | Safe to delete? |
|---|---|---|
| `<stash>/` | All your asset files: agents, skills, commands, knowledge, workflows, memories, env files, secrets, wikis, lessons, facts | **No** — this is YOUR data |
| `<stash>/.akm/` | Hidden AKM metadata (v0.7 proposals, legacy runs) | Caution — check for pending proposals first |

Override: set `AKM_STASH_DIR` (or configure `stashDir` in `config.json`).

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

**Retention:** Events older than 90 days are purged automatically when `akm improve` runs its maintenance pass. Purge is controlled by `purgeOldEvents()` with a 90-day default.

**Full event type list:**

| Event type | When emitted | Key metadata fields |
|---|---|---|
| `add` | `akm add <source>` | `ref`, `provider` |
| `remove` | `akm remove <source>` | `ref` |
| `update` | `akm update [source]` | `ref` |
| `remember` | `akm remember <text>` | `ref` |
| `import` | `akm import <file>` | `ref` |
| `save` | `akm sync` | `ref` |
| `feedback` | `akm feedback <ref>` | `signal` (positive/negative) |
| `search` | `akm search <query>` | `query`, `source`, `signal` |
| `curate` | `akm curate <prompt>` | `query`, `source` |
| `show` | `akm show <ref>` | `ref`, `type`, `name` |
| `select` | `akm show` after a search returning the same ref | `ref`, `entryId` |
| `promoted` | `akm proposal accept <id>` | `ref` |
| `rejected` | `akm proposal reject <id>` | `ref` |
| `reflect_invoked` | Start of reflect phase in `akm improve` | `ref`, engine |
| `reflect_completed` | Reflect phase produced a proposal | `ref` |
| `improve_reflect_outcome` | Per-asset reflect result | `ref`, `ok`, `durationMs`, `reason` |
| `propose_invoked` | `akm propose` | `ref` |
| `distill_invoked` | `akm distill` | |
| `improve_skipped` | Asset skipped by cooldown or budget | `ref`, `reason` |
| `improve_completed` | `akm improve` run finished | run stats |
| `improve_failed` | `akm improve` run errored | error |
| `improve_lock_recovered` | Stale lock cleared at startup | |
| `proposal_orphan_purge` | Stale proposals pruned | `checked`, `rejected` |
| `proposal_creation_rejected` | `createProposal()` validation failed | `ref`, `reason`, `source` |
| `proposal_expired` | Proposal expired | `ref` |
| `events_purged` | Old events deleted by maintenance | `purgedCount`, `retentionDays` |
| `workflow_started` | `akm workflow start <ref>` | `ref`, `runId` |
| `workflow_step_completed` | `akm workflow next` (genuine `completed` transition only) | `ref`, `runId`, `stepId`, `status` |
| `workflow_step_updated` | `akm workflow next` (non-`completed` transitions: `failed`/`skipped`/`blocked`) | `ref`, `runId`, `stepId`, `status` |
| `workflow_finished` | `akm workflow complete` | `ref`, `runId` |
| `schema_repair_invoked` | `akm lint --repair` triggered schema repair | `ref` |
| `archive_cleanup` | Archive cleanup during consolidation | |

### 2. Usage Events Table

`usage_events` is the local analytical record behind `akm history`, utility
ranking, retrieval-demand counts, GRR, and real-query eval generation. It stores
search/curate queries, per-entry search impressions, explicit show/curate
engagement, feedback signals, stable refs, and timestamps. It never leaves the
machine unless you explicitly copy the database or send derived content to a
configured endpoint.

Every runtime writer stamps provenance as `user`, `improve`, `task`, `audit`, or
`unknown`. Direct interactive CLI traffic defaults to `user`; internal improve,
scheduled-task, and eval subprocesses preserve their stamp across nested
search/curate/show/remember/agent reads. Omitted or invalid writer provenance is
`unknown`, and pre-provenance rows rescued at the 0.9 cutover are also
`unknown`. Only exact `source='user'` rows contribute demand, utility, GRR, or
real-query labels.

### 3. Proposals Table

The proposal queue: pending, accepted, and rejected improvement proposals for your stash assets. Generated by `akm improve`, `akm propose`, and related proposal-producing flows.

Contents:
- Proposal UUID (primary key)
- Target asset ref
- Status (pending/accepted/rejected)
- Source (which process generated it — e.g. `reflect`, `distill`)
- Full proposal content (Markdown text)
- Created/updated timestamps

### 4. Task History Table

A record of scheduled task runs (from `akm tasks`):
- Task ID, status, start/end times
- Log file path (the log content stays in `$CACHE/tasks/logs/`)

---

## How to Inspect and Clear Local Data

### Inspect events

```sh
# List recent events
akm log list

# Stream live events (tail)
akm log tail

# Filter by type
akm log list --type search --limit 20

# Filter by asset ref
akm log list --ref skills/code-review
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
# There is no akm CLI command to do this directly in 0.8.0.
# Use SQLite directly:
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
| `AKM_STASH_DIR` | Default stash directory (`~/akm/`) |
| `XDG_CONFIG_HOME` | XDG base — akm appends `/akm` |
| `XDG_DATA_HOME` | XDG base — akm appends `/akm` |
| `XDG_STATE_HOME` | XDG base — akm appends `/akm` |
| `XDG_CACHE_HOME` | XDG base — akm appends `/akm` |
