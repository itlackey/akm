# Data and Telemetry

akm keeps your data on your machine. It sends no crash reports. It records
[local-only counts of its own commands](#cli-usage-counts) and, at most once a
day per surface, sends an [anonymous usage report](#daily-usage-report) built
from them. Apart from that report it makes network requests only to the
endpoints you configure or the commands you run, listed below. This page covers
what akm sends, and what it stores and where.

## Network destinations

- **Your model connections and embedding endpoint** (`connections` and
  `embedding` in [Configuration](configuration.md)) receive the prompts and
  asset content that `improve`, `proposal new`, `index`, enrichment and the
  other model-backed features send. `akm setup`, `akm models` and `akm doctor`
  ask each endpoint which models it serves. Your API key is sent only to the
  endpoint of the connection it belongs to.
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
- **`akm doctor`**, unless you pass `--no-probe`, sends a reachability probe to
  each connection's endpoint, runs each harness's `--version`, calls
  `api.github.com` to compare your version with the latest release, and runs
  a blobless, no-checkout `git clone` of the channel's branch of the
  Claude and Codex plugin marketplace source the harness registered, to read the
  catalog and plugin manifest (`akm upgrade --check` makes the same read); a
  marketplace pinned to a tag is not read.
- **`akm sync`** and the syncs `akm improve` runs before and after a run fetch
  from and push bundle content to the git remote you configured.
- **`akm improve` dead-link checks** send `HEAD` requests to the URLs found in
  the bodies of the knowledge assets being improved. No asset content is sent.
- **`akm setup`** looks for an OpenAI-compatible server on `localhost` (ports
  11434, 1234 and 8080) with one `GET /v1/models` each, and asks the endpoint
  you give it (and the embedding endpoint, if you pick another) for its model
  list. `--no-probe` contacts none of them.

## Where akm stores data

On Linux and macOS the directories follow the XDG Base Directory conventions.
Windows uses per-user app-data directories (`%LOCALAPPDATA%\akm\data`,
`%LOCALAPPDATA%\akm\state`).

### Config directory

`$XDG_CONFIG_HOME/akm` (default `~/.config/akm/`). Override with
`AKM_CONFIG_DIR`. `credentials.json` and `models.json` always live here, even when
`--config` or `AKM_CONFIG_FILE` selects a config file elsewhere.

| Path | Contents |
| --- | --- |
| `config.json` | Your configuration: connections, harnesses, improve strategies, bundles, registries and experimental opt-ins. See [Configuration](configuration.md). Deleting it resets all settings. |
| `config.json.lck` | Write sentinel held while `config.json` is saved. |
| `credentials.json` | The API keys akm holds for your connections and for the `embedding` service, each with the endpoint it was stored for, written with mode 0600 (see [Credentials](configuration.md#credentials)). Deleting it removes those keys; akm sends requests without them. |

### Data directory

`$XDG_DATA_HOME/akm` (default `~/.local/share/akm/`). Override with
`AKM_DATA_DIR`.

| Path | Contents |
| --- | --- |
| `index.db` | The search index. Rebuilt by `akm index --full`. |
| `state.db` | Durable local state: events, usage records, proposals, task history, improve runs, workflow runs. Not regenerable. |
| `logs.db` | Log lines from scheduled task runs. Old lines are purged by `akm improve`. |
| `metrics.db` | Local CLI usage counts, in tables named `cli_usage_*` (see [CLI usage counts](#cli-usage-counts)). Deleting it only discards those counts. |
| `akm.lock` | The lockfile: resolved version, revision and integrity of each installed bundle. `akm.lock.lck` is its write sentinel. |
| `index.rebuild.lock`, `index.db.write.lock` | Lock files for `akm index` and asset writes. |
| `state.db.pre-<migration id>.bak` | A copy of `state.db` taken before a migration that drops schema (`018`, `028`) runs. Yours to delete. |
| `workflow-run-locks/` | One lock file per running workflow run. |
| `backups/tasks/` | Copies of task files made by `akm migrate apply` before it rewrites them. |
| `backups/asset-content-refs/` | Copies of the markdown and YAML files `akm migrate apply` rewrote to the current ref spelling. `akm backups prune` removes the old ones. |
| `backups/asset-engine-keys/` | Copies of commands, agents, workflows and task sources made by `akm migrate apply` before it rewrites their `engine:` key. |
| `migrate/engine-targets.json` | The connection or harness each old engine name became, kept by `akm migrate apply` until every `engine:` key is rewritten. |
| `opencode-runtime/` | Everything akm's own agent runtime keeps: OpenCode's `config/` (with akm's plugin), `data/` (logs, repositories, shell output, and `data/opencode/opencode.db`, the runtime's sessions, which `akm proposal extract --sessions opencode` reads back, read-only), `cache/`, `state/` and `tmp/` (the binary's own native pieces). Recreated on next use; deleting it loses the runtime's session history. |

If akm cannot read this directory, commands fail with `DATA_DIR_UNREADABLE`
(exit 78) naming the path; `akm doctor` still runs and reports it.
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

`~/akm/` by default; configure `bundles` and `defaultBundle` in `config.json`
(`AKM_BUNDLE_DIR` still overrides it, Deprecated). This holds your asset files and is not
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
  refs returned. `--env` and `--secret` (`akm exec`, `akm run`) and a workflow unit's `env:`
  binding record the names of the keys injected, not their values.
- **Usage records**: queries, search impressions, show/curate engagement, rule loads
  (`akm rules`: the refs and characters loaded) and
  feedback. They feed utility scores and `akm doctor metrics`, and the feedback recorded
  as the user adjusts search ranking. Each record is stamped with its source
  (`user`, `improve`, `task`, `audit` or `unknown`); only `user` records count.
  When akm runs under an agent harness it can recognize (the same detection
  workflow runs use: `AKM_AGENT_HARNESS`, a harness's session variable such as
  `CLAUDE_CODE_SESSION_ID`, or a harness presence flag), the record's metadata
  also carries `agent: { harness, session }`, the session only when the harness
  names one.
- **Proposals**: pending, accepted, rejected and reverted improvement proposals,
  with their full content, plus the improve ledger of what each stage last did
  with each asset.
- **Task history and workflow runs**: scheduled task runs and workflow run
  state. A task run records whether the OS scheduler started it (`trigger`:
  `schedule` or `manual`).

`index_completed` metadata carries the phase timings plus `totalEntries`
(library size after the run). Runs recorded before this field was added omit it;
readers must treat it as optional.

`search` metadata carries `source` (the usage source that ran it) and `searchId`
(a UUID). A `select` copies both from the search it followed, and `akm doctor metrics`
counts one select per (`searchId`, ref). Events written before these fields
existed have neither: they are counted as recorded, for every source, and
`akm doctor metrics` notes the day deduplication starts.

Event types, for `akm doctor log --type <type>`:

- Bundles and assets: `add`, `remove`, `update`, `remember`, `import`
- Retrieval and sync: `search`, `curate`, `show`, `select`, `feedback`, `sync`,
  `stash_synced`, `moved`, `index_completed`, `index_db_vacuumed`, `env_access`,
  `secret_access`
- Proposals: `promoted`, `rejected`, `proposal_reopened`, `proposal_reverted`,
  `proposal_expired`, `proposal_expiration_pass`, `proposal_orphan_purge`,
  `proposal_creation_rejected`, `triage_drained`, `triage_deferred`
- Improve: `improve_invoked`, `improve_completed`, `improve_failed`,
  `improve_skipped`, `improve_lock_recovered`, `improve_review_needed`,
  `reflect_invoked`, `reflect_completed`, `improve_reflect_outcome`,
  `propose_invoked`, `distill_invoked`, `extract_invoked`, `extract_triaged`,
  `schema_repair_invoked`, `proactive_selected`, `improve_salience_rank_change` (no longer emitted; old rows only), `events_purged`,
  `improve_runs_purged`, `asset_state_gc`, `state_db_vacuumed`,
  `task_logs_purged`, `task_log_files_purged`, `run_log_files_purged`
- Workflows: `workflow_started`, `workflow_step_completed`,
  `workflow_step_updated`, `workflow_finished`, `workflow_abandoned`,
  `workflow_unit_started`, `workflow_unit_finished`
- LLM usage: `llm_usage`, `llm_usage_summary`

Events and improve run rows older than 90 days are purged by `akm improve`
(`improve.eventRetentionDays`; `0` disables). Usage records older than 90 days
are purged on `akm index`. Read these with `akm doctor log`, `akm doctor metrics`,
`akm proposal list` and `akm doctor log --task <id>`.

## CLI usage counts

akm records how its own commands are used, on your machine. The counts are
outside learning, feedback and ranking; the only thing sent from them is the
[daily usage report](#daily-usage-report), as counts.

- **Where:** the `cli_usage_*` tables of `metrics.db` in the data directory.
- **What is recorded** for every command, including `--help`, `--version` and
  failed attempts: the command path, the flags that were used (their names and,
  for a few enumerated flags such as `--format` or `--detail`, a safe value),
  whether each flag was typed or a default, the akm version, the event source
  (`agent` inside a detected agent harness, `user` at a terminal with none,
  `task`, `improve` or `audit` for akm's own runs, else `unknown`), the agent
  harness when one is detected, the type of the asset `akm show` or `akm run`
  resolved (when it is one of akm's own types), the outcome, exit code and
  duration, a UTC day, and a random instance UUID created on first use, which
  no command prints.
- **What is not recorded:** queries, notes, URLs, refs, paths, filter values,
  secret values, and the arguments passed to a child program. Boolean flags are
  stored as true or false; every other flag value is stored as `[redacted]`.
- **How long:** per-invocation detail for 30 days; daily aggregate counters
  are kept indefinitely.
- **Reading it:** `akm doctor metrics usage` reports it; `--export` writes the
  same data as JSON.
- **Turning it off:** set `usage.capture` to `false` in the config file
  (`akm config set usage.capture false`). `--read-only` also records nothing for
  that invocation.
- It never changes a command's output or exit code: an unwritable, locked or
  corrupt `metrics.db` is skipped silently.

## Daily usage report

On by default. Once a day each, the CLI and AKM Desktop send a report to a
privately hosted service run by the akm maintainers. It holds no personal
information. It shows which parts of akm are used, so the unused ones can be
dropped.

**What can be in it.** Apart from the system fields below, every value in a
report is a number. Every name in it (an event's name, a count's name) is built
from akm's own definitions: its commands, the flags it declares and their fixed
lists of choices, the agent harnesses it knows, its asset types. Anything you
or a bundle named is counted as `other` or `[unknown]`, or left out: a custom
asset type, a task's own input flag, a harness akm does not know, a command that
does not exist. Nothing is read from an argument's value, a ref, a path, a
bundle's name or a file.

- **When:** after a command finishes (one command a day pays for it, within a
  1.5 second limit) or, for Desktop, in the background when its server starts.
  Nothing is ever printed or changed in a command's result. A fresh data
  directory sends nothing until its next UTC day. A failed send is not retried
  that day; the next day's CLI report counts the days a failed one missed.
- **Install id:** the random instance UUID of `metrics.db` (see
  [CLI usage counts](#cli-usage-counts)), sent as the session id of every event,
  so that the reports of one install count as one install. It is derived from
  nothing on the machine, and the CLI and Desktop of one data directory share
  it. It goes to the report and nowhere else: no command prints it, including
  `akm doctor metrics usage --export`. Deleting `metrics.db` makes a new one.
- **Daily event (`cli_daily`, `desktop_daily`):**
  - What is set up, from the config, as counts and 0-or-1 switches: `bundles`
    (enabled bundles), `bundles_git`, `bundles_website`, `bundles_npm`,
    `registries` (akm's own defaults included), `connections`, `harnesses`,
    `projects`, `tasks_enabled`, `semantic_search`, `improve` and `exec`.
  - Library sizes: `assets` (indexed assets), `assets_<type>` for each of akm's
    own asset types (skill, command, and so on) and `assets_other` for every
    other type. They are left out when there is no readable index; the report
    never builds or changes the index.
  - From the CLI only, totals for the period: `period_days` (the complete UTC
    days after the last one the server accepted, up to yesterday; `0` for the
    first report), `commands`, `failures`, `src_<source>` for each event source
    and `h_<harness>` for each agent harness that ran akm.
- **Command events (CLI only):** one for each command that ran in the period,
  named as it was typed: `akm search`, `akm task run`, `akm health`. A command
  that does not exist is `akm [unknown]`. Each carries `period_days`, `count`,
  `failures`, `duration_ms` (the total), `src_<source>` and `h_<harness>` as
  above (`h_other` for a harness akm does not know), and:
  - `flag_<name>`: the runs in which a flag akm declares was typed. For
    `--format`, `--detail`, `--type` (akm's own types only) and flags with a
    fixed list of choices, also `flag_<name>_<choice>`. No other value is sent.
  - `out_<category>`: the runs that did not succeed, by akm's outcome category
    (`usage`, `config`, `general`, `internal`, `transient`, `health-warning`,
    `failure`, `cancelled`).
  - `type_<asset type>`: the runs of `akm show` and `akm run` by the type of
    asset they resolved (`type_other` for a type that is not akm's own).
- **System fields, on every event:** `osName` (Linux, macOS or Windows),
  `osVersion` (the numbers of the release only), `locale` (language, script and
  region only), `engineName` and `engineVersion` (`bun` or `node`), `appVersion`
  (the akm version), `sdkVersion` (`akm@<version>`), `isDebug: false`, the
  install id as the session id, and the time the report was sent.
- **Never sent:** queries, refs, paths, bundle names, argument values, secrets,
  the host or user name, or any asset content.
- **What the service keeps:** the events, and the country, region and city it
  derives from the request's IP address. It does not store the IP address; it
  stores a one-day id hashed from it with a salt it changes daily.
- **Seeing what happened:** `akm doctor metrics usage` shows, under `report`,
  each surface's last try (`last_day`), the last day whose counts the server
  accepted (`through`), and what the last try came to (`last_outcome`: `sent`,
  `rejected` or `failed`, with `last_detail`).
- **Turning it off:** `akm config set usage.report false` (the config key
  `usage.report`), or the **Usage reports** switch in AKM Desktop's settings. The switch follows
  `extends`: `false` in a base config turns it off unless a nearer layer sets it
  to `true`, and a config that cannot be loaded sends nothing. `--read-only` and `usage.capture: false` also send nothing from
  the CLI. Runs in CI (the `CI` variable) or under `bun test` never send.

## Inspect and clear

```sh
akm doctor metrics                                   # usage report for the last 30 days
akm doctor log --type search --limit 20              # recent events
akm proposal list                             # pending proposals
akm doctor info                                      # where config, bundle, cache and index live
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
| `AKM_BUNDLE_DIR` | Deprecated: register the bundle and select `defaultBundle`. Default bundle directory (`~/akm/`) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | XDG bases; akm appends `/akm` |
| `AKM_SQLITE_JOURNAL_MODE` | Deprecated, no replacement; removed in 0.11. SQLite journal mode: `WAL` (default), `DELETE` or `TRUNCATE`. akm falls back from WAL to `DELETE` on its own when the data directory is on a detected network filesystem (NFS, SMB/CIFS, 9p, CephFS, FUSE such as sshfs or virtiofs); detection works on Linux only, so a data directory on a network filesystem on macOS or Windows is unsupported. In containers that are thrown away, keep SQLite on local disk and use snapshots. |
| `AKM_NPM_REGISTRY` | Base URL of an npm mirror. Replaces `registry.npmjs.org` for npm bundle resolution. |
| `AKM_REGISTRY_URL` | Comma-separated registry URLs that replace the configured `registries` in every registry search akm performs; `akm registry list`, `akm doctor info` and the `egress-endpoints` health advisory still show the configured list. Prefix an entry with `<provider>::` (for example `skills-sh::https://skills.sh`) to choose a provider; the default is `static-index`. |
