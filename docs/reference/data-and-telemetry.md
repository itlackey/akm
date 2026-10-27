# Data and Telemetry

akm keeps your data on your machine. It has no analytics or crash reporting.
It makes network requests only to the endpoints you configure or the commands
you run, listed below. This page covers what akm sends, and what it stores and
where.

## Network destinations

- **Your model connections and embedding endpoint** (`connections` and
  `embedding` in [Configuration](configuration.md)) receive the prompts and
  asset content that `improve`, `proposal new`, `index`, enrichment and the
  other model-backed features send. `akm setup`, `akm models` and `akm health`
  ask each endpoint which models it serves. Your API key is sent only to the
  endpoint of the connection it belongs to.
- **The curate reranker** (`search.curateRerank`, off by default) receives the
  query and, for each top candidate `akm curate` fetches, its name, description
  and the start of its indexed content (2,000 characters in all).
- **A harness you enable** (Claude Code, Codex, OpenCode, ...) is a program akm
  runs on your machine, and what akm hands it reaches whatever that harness is
  configured for: its own provider, its own tools, its own MCP servers. It runs
  with your environment as it is ([How akm runs a
  harness](configuration.md#how-akm-runs-a-harness)). akm's own agent runtime
  (used when no harness is enabled) sends to your connection only; on its first
  use it fetches its pinned OpenCode binary once from `registry.npmjs.org` into
  `$CACHE/opencode/<version>/`.
- **Hugging Face Hub** serves the local embedding model when
  `semanticSearchMode` is `auto` and no remote embedding endpoint is set. The
  model is downloaded once into `$CACHE/models` (or `HF_HOME`, if set). Set
  `HF_HUB_OFFLINE=1` to forbid the download. The ONNX Runtime binding it runs on
  is fetched once from `registry.npmjs.org` into `$CACHE/onnxruntime`.
- **Bundle and registry hosts**: the git remotes, npm registries and websites of
  the bundles you add, and the registries behind `akm search --from registry`
  (by default `raw.githubusercontent.com/itlackey/akm-registry`, which the
  `akm setup` wizard also reads to list bundles). They receive the clone,
  fetch, crawl and search requests.
- **Snapshot fetchers** for website sources contact `public.api.bsky.app`
  (Bluesky), `youtube.com`, `api.x.com` (with `X_BEARER_TOKEN`, or the
  `secrets/x-bearer-token` secret) and `api.github.com` when a crawled URL
  matches that fetcher. See [Website sources](website-sources.md).
- **`akm upgrade`** calls `registry.npmjs.org` and `github.com` (release
  metadata and downloads) and `api.github.com`. It attaches `GITHUB_TOKEN`,
  `GH_TOKEN`, or the output of `gh auth token` to GitHub API requests. Its
  plugin step runs `npm view` and the `claude`, `codex` or `opencode` CLIs.
- **`akm health`**, unless you pass `--no-probe`, sends a reachability probe to
  each connection's endpoint, runs each harness's `--version`, calls
  `api.github.com` to compare your version with the latest release, and runs
  `git ls-remote --symref` against the remote of an installed Claude plugin
  marketplace clone.
- **`akm sync`** and the syncs `akm improve` runs before and after a run fetch
  from and push bundle content to the git remote you configured.
- **`akm improve` dead-link checks** send `HEAD` requests to the URLs found in
  the bodies of the knowledge assets being improved. No asset content is sent.
- **`akm setup`** looks for an OpenAI-compatible server on `localhost` (ports
  11434, 1234 and 8080) with one `GET /v1/models` each, and asks the endpoint
  you give it (and the embedding endpoint, if you pick another) for its model
  list. `--no-probe` contacts none of them.
- **HTML reports** (`akm health --format html`, `akm metrics --format html`)
  load ECharts from `cdn.jsdelivr.net` in the browser that opens them.

## Where akm stores data

On Linux and macOS the directories follow the XDG Base Directory conventions.
Windows uses per-user app-data directories (`%LOCALAPPDATA%\akm\data`,
`%LOCALAPPDATA%\akm\state`).

### Config directory

`$XDG_CONFIG_HOME/akm` (default `~/.config/akm/`). Override with
`AKM_CONFIG_DIR`.

| Path | Contents |
| --- | --- |
| `config.json` | Your configuration: connections, harnesses, improve strategies, bundles, registries and experimental opt-ins. See [Configuration](configuration.md). Deleting it resets all settings. |
| `config.json.lck` | Write sentinel held while `config.json` is saved. |
| `credentials.json` | The API keys akm holds for your connections and for the `embedding` and `search.curateRerank` services, each with the endpoint it was stored for, written with mode 0600 (see [Credentials](configuration.md#credentials)). Deleting it removes those keys; akm sends requests without them. |

### Data directory

`$XDG_DATA_HOME/akm` (default `~/.local/share/akm/`). Override with
`AKM_DATA_DIR`.

| Path | Contents |
| --- | --- |
| `index.db` | The search index. Rebuilt by `akm index --full`. |
| `state.db` | Durable local state: events, usage records, proposals, task history, improve runs, workflow runs. Not regenerable. |
| `logs.db` | Log lines from scheduled task runs. Old lines are purged by `akm improve`. |
| `akm.lock` | The lockfile: resolved version, revision and integrity of each installed bundle. `akm.lock.lck` is its write sentinel. |
| `index.rebuild.lock`, `index.db.write.lock` | Lock files for `akm index` and asset writes. |
| `secret-locks/` | Per-secret lock files taken while a secret is written. |
| `state.db.pre-<migration id>.bak` | A copy of `state.db` taken before a migration that drops schema (`018`, `028`) runs. Yours to delete. |
| `workflow-run-locks/` | One lock file per running workflow run. |
| `backups/tasks/` | Copies of task files made by `akm migrate apply` before it rewrites them. |
| `backups/asset-engine-keys/` | Copies of commands, agents, workflows and task sources made by `akm migrate apply` before it rewrites their `engine:` key. |
| `migrate/engine-targets.json` | The connection or harness each old engine name became, kept by `akm migrate apply` until every `engine:` key is rewritten. |
| `opencode-runtime/` | Everything akm's own agent runtime keeps: OpenCode's `config/` (with akm's plugin), `data/` (logs, repositories, shell output, and `data/opencode/opencode.db`, the runtime's sessions, which `akm proposal extract --type opencode` reads back, read-only), `cache/`, `state/` and `tmp/` (the binary's own native pieces). Recreated on next use; deleting it loses the runtime's session history. |

If akm cannot read this directory, commands fail with `DATA_DIR_UNREADABLE`
(exit 78) naming the path; `akm health` still runs and reports it.
If the directory is read-only (an agent sandbox that only allows writes in the
workspace, for example), `akm feedback` fails with `DATA_DIR_NOT_WRITABLE`
instead of reporting success for feedback it could not store.

### State directory

`$XDG_STATE_HOME/akm` (default `~/.local/state/akm/`). Override with
`AKM_STATE_DIR`.

| Path | Contents |
| --- | --- |
| `locks/scheduler.lock` | Serializes writes to the native scheduler (`akm task`). |
| `locks/<bundle-key>/improve.lock` | Whole-run lock for `akm improve`, one directory per bundle. |

### Cache directory

`$XDG_CACHE_HOME/akm` (default `~/.cache/akm/`). Override with
`AKM_CACHE_DIR`. Everything here is regenerable; deleting the directory is safe.

| Path | Contents |
| --- | --- |
| `config-backups/` | The last 5 pre-save snapshots of `config.json`, plus `config.latest.json`. `akm migrate apply` also leaves `credentials.json.<ts>` (a copy of your API keys, taken before it re-files older entries) and `models.json.<ts>` (the retired file) here; those are not pruned. Owner-only (file `0600`, directory `0700`); on a filesystem without POSIX permissions, such as a CIFS/Azure Files share, the mount options decide them instead. |
| `registry/` | Downloaded npm and git packages for installed bundles. |
| `registry-index/` | Git mirrors (`git-<key>/`) and website snapshots (`website-<key>/`). |
| `models/` | The local embedding model downloaded from Hugging Face. |
| `onnxruntime/` | The ONNX Runtime binding and library for local embeddings, downloaded once from the npm registry. |
| `opencode/<version>/` | The OpenCode binary akm's own agent runtime runs (about 240 MB), fetched from the npm registry on the runtime's first use. |
| `tasks/logs/` | Per-run log files of scheduled tasks. |
| `logs/index/`, `logs/improve/` | One log file per `akm index` run and per `akm improve` run; `akm improve` deletes files older than `improve.eventRetentionDays`. |

### Bundle directory

`~/akm/` by default; override with `AKM_BUNDLE_DIR`, or configure `bundles` and
`defaultBundle` in `config.json`. This holds your asset files and is not
regenerable. akm also writes into it:

| Path | Contents |
| --- | --- |
| `<bundle>/<type>/...` | Your assets: skills, knowledge, memories, workflows, tasks, env files, secrets and the rest. |
| `<bundle>/.akm/memory-cleanup/` | Retired memories (`archive/`) and a log of belief changes (`belief-transitions.jsonl`). |
| `<bundle>/sessions/` | Session assets written by `akm proposal extract` and the improve extract stage. |

## What state.db records

- **Events**: an append-only log of what you do with akm: bundle changes,
  `remember`, `import`, `search`, `curate`, `show`, `feedback`, `sync`, proposal
  decisions, improve and workflow activity, and LLM call usage (model, outcome,
  duration, token counts). Each event has a type, timestamp, optional asset ref
  and a small metadata payload; search events include the query text and the
  refs returned. `akm env run`, a workflow unit's `env:` binding and
  `akm secret run` record the names of the keys injected, not their values.
- **Usage records**: queries, search impressions, show/curate engagement and
  feedback. They feed utility scores and `akm metrics`, and the feedback recorded
  as the user adjusts search ranking. Each record is stamped with its source
  (`user`, `improve`, `task`, `audit` or `unknown`); only `user` records count.
- **Proposals**: pending, accepted, rejected and reverted improvement proposals,
  with their full content, plus the improve ledger of what each stage last did
  with each asset.
- **Task history and workflow runs**: scheduled task runs and workflow run
  state.

Event types, for `akm log --type <type>`:

- Bundles and assets: `add`, `remove`, `update`, `remember`, `import`
- Retrieval and sync: `search`, `curate`, `show`, `select`, `feedback`, `sync`,
  `stash_synced`, `index_completed`, `index_db_vacuumed`, `env_access`,
  `secret_access`
- Proposals: `promoted`, `rejected`, `proposal_reopened`, `proposal_reverted`,
  `proposal_expired`, `proposal_expiration_pass`, `proposal_orphan_purge`,
  `proposal_creation_rejected`, `triage_drained`, `triage_deferred`
- Improve: `improve_invoked`, `improve_completed`, `improve_failed`,
  `improve_skipped`, `improve_lock_recovered`, `improve_review_needed`,
  `reflect_invoked`, `reflect_completed`, `improve_reflect_outcome`,
  `propose_invoked`, `distill_invoked`, `extract_invoked`, `extract_triaged`,
  `schema_repair_invoked`, `proactive_selected`, `events_purged`,
  `improve_runs_purged`, `asset_state_gc`, `state_db_vacuumed`,
  `task_logs_purged`, `task_log_files_purged`, `run_log_files_purged`
- Workflows: `workflow_started`, `workflow_step_completed`,
  `workflow_step_updated`, `workflow_finished`, `workflow_abandoned`,
  `workflow_unit_started`, `workflow_unit_finished`
- LLM usage: `llm_usage`, `llm_usage_summary`

Events and improve run rows older than 90 days are purged by `akm improve`
(`improve.eventRetentionDays`; `0` disables). Usage records older than 90 days
are purged on `akm index`. Read these with `akm log`, `akm metrics`,
`akm proposal list` and `akm task history`.

## Inspect and clear

```sh
akm metrics                                   # usage report for the last 30 days
akm log --type search --limit 20              # recent events
akm proposal list                             # pending proposals
akm info                                      # where config, bundle, cache and index live
```

```sh
rm ~/.local/share/akm/index.db && akm index --full   # rebuild the index
rm -rf ~/.cache/akm                                  # drop all caches
```

`state.db` has no clearing command. Removing it deletes events, proposals, task
history and workflow runs. To reset everything except your bundle files, remove
the config, data, state and cache directories.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`, `AKM_CACHE_DIR` | Override the config, data, state and cache directories |
| `AKM_BUNDLE_DIR` | Default bundle directory (`~/akm/`) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | XDG bases; akm appends `/akm` |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode: `WAL` (default), `DELETE` or `TRUNCATE`. On a detected network filesystem the default falls back to `DELETE`. |
| `AKM_NPM_REGISTRY` | Base URL of an npm mirror. Replaces `registry.npmjs.org` for npm bundle resolution. |
| `AKM_REGISTRY_URL` | Comma-separated registry URLs that replace the configured `registries` for `akm search --from registry`. Prefix an entry with `<provider>::` (for example `skills-sh::https://skills.sh`) to choose a provider; the default is `static-index`. |
