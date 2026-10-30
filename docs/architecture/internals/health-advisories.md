# `akm health` checks

`akm health` prints JSON by default (`--format text` for the table view) and
emits the checks below. Each result has a `name`, and lands in `hardChecks` (the
state.db, `task-history-read`, `active-runs`, connection and harness, and
semantic-search checks) or `advisories` (the rest). The list comes from
`HEALTH_CHECKS` in `src/commands/health/checks.ts`, `akmHealth` in
`src/commands/health.ts`, and the collectors in `src/commands/health/`. The
checks from `index-state-generation` down to `opencode-plugin-version` appear
only when they have something to report, and `state-db-readable` only in place
of every other check; the others are always present.

## Status and exit code

Each check is `pass`, `warn`, `fail`, or `unknown`, and `deterministic` or
`heuristic`.

- Any `fail` in `hardChecks` makes the overall status `fail` and the exit code 1.
- Otherwise, any `warn` from a `deterministic` check (hard or advisory) makes it `warn` and the exit code 4.
- `heuristic` warns (`session-extraction`, `auto-accept-validation`) and `unknown` results do not change the overall status.

`--since` sets the window the task and improve checks read. The default is 24 hours.

## Network and processes

Probing is on by default; `--no-probe` turns it off. With probing on, health sends a
`GET` to `<endpoint>/models` of each configured connection (3 second timeout; any HTTP
response counts as reachable, so a cold local server is never asked to load a model; one
request per distinct endpoint per invocation, with no cross-run cache), runs each configured
harness's `--version`, looks up the latest akm release on GitHub for `cli-version`
(5 second timeout, no retries), and runs the akm binary recorded by the scheduler with
`--version` for `scheduler-binary`. `plugin-version` runs `git ls-remote --symref origin`
(it lists refs and fetches nothing) against the Claude plugin marketplace clone whenever a
Claude plugin is installed. With
`--no-probe` none of these runs: the connection rows carry no `reachable` field and the
message says reachability was not probed, and `plugin-version` reports `unknown` (its
`AKM_MIN_VERSION` (or legacy `AKM_VERSION_RANGE`) check is local and still runs). The `plugin-version` and `cli-version`
lookups are best-effort and silent on failure; see `src/commands/health/plugin-staleness.ts`
and `src/commands/health/version-drift.ts`.

## Checks

| Check | Fires when | Remedy |
|---|---|---|
| `state-db-schema` | `fail`: state.db is missing one of `events`, `proposals`, `schema_migrations`, `task_history`. | The message lists the missing tables. |
| `state-db-round-trip` | `fail`: appending and reading back a probe event failed. The probe row is deleted again. | The message gives the error. |
| `state-db-integrity` | `fail`: `PRAGMA integrity_check` failed, or reading the freelist failed. `warn`: more than 50% of the pages are free. | For a failed check, follow the repair in the message: back up state.db, run `sqlite3 -readonly state.db ".recover" \| sqlite3 state.new.db`, confirm `state.new.db` passes `integrity_check`, stop every akm process, delete `state.db-wal` and `state.db-shm`, then swap `state.new.db` in as state.db. The free-page warning clears when `akm improve`'s retention purge VACUUMs state.db. |
| `state-db-migrations` | Always `pass` in a normal run; the message lists the migrations this open applied and the pre-migration copy (`evidence.applied`, `evidence.backupPath`). `fail` when the open could not apply a pending migration, or a read-only run (the `akm ui` health view) finds one pending, which it must not apply; this row is then the whole report. | Run `akm migrate apply`. |
| `task-history-read` | Always `pass`; reports the number of `task_history` rows read in the window. | None. |
| `active-runs` | `warn`: a task run has been active for more than 15 minutes. The message names the tasks and their age. | Inspect with `akm task history`. |
| `connections-and-harnesses` | One table of every configured connection (endpoint, whether its key is held — a `$VAR` set in this shell, a `credentials.json` entry, or none — and whether the endpoint answers) and harness (platform, whether its binary is on `PATH`, and with a probe its `--version`), then the work that runs on them: improve, judges, agents, extract, enrich, index, embedding and curate rerank, each naming the connection or harness and the model it resolves to through the same resolver the calls use (`evidence.rows`, typed `connection`, `harness` or `process`). `warn` when a key variable is unset, an endpoint does not answer, a harness is not installed, several connections (or harnesses) are configured and none is called `default` (said once, with the fix: name one `default`), or a work row cannot resolve because of the config; `unknown` when neither a connection nor a harness is configured; otherwise `pass`. Endpoint reachability is one bounded `GET /models` and the version is the harness's own `--version`; with `--no-probe` neither runs and the message says so. | Correct the named connection, key or harness; run `akm setup` when nothing is configured. A work row whose parts run somewhere other than the row's own target lists them in `overrides`, each with the kind (connection or harness), name and model it runs on: that is a per-process pin, working as set. |
| `semantic-search` | What the last `akm index` recorded about semantic search, with the index's entry and vector counts read now; no model load, no request. `pass` when every entry has a vector (local: on `onnxruntime-node`) or `semanticSearchMode` is `off`; `warn` when vectors lag entries, local embeddings ran on another runtime, or akm offers no local embeddings on this platform (`unavailable: platform`, where keyword search or an endpoint is the default); `fail` when the last index found it `blocked` (endpoint or model download failed) or `unavailable: load` (the runtime could not be downloaded or did not load, for example from a `noexec` cache directory), with the reason; `unknown` before the first index. A hard check, so a `fail` fails `akm health`. | `fail`: fix the reason named, then run `akm index`; the check reads the next index's record. `warn` for the platform: `akm setup --embedding off` for keyword search, or `akm setup --embedding <model> --embedding-endpoint <url>` for a remote endpoint. |
| `task-fail-rate` | `warn`: at least 5% of task runs in the window failed, or one task with at least 5 runs fails at that rate. The message names the dominant `detail.reason` (`timeout`, `non_zero_exit`, `spawn_failed`, ...) when one reason is at least half of the command-task failures. | Inspect failed runs with `akm task history` and `akm task doctor`. `evidence.agentFailureReasonCounts` breaks command-task failures down by reason. |
| `session-extraction` | `heuristic`. Reads the last 7 days of the extract ledger. `unknown`: nothing recorded. `warn`: every session was skipped or failed for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`); the message names the reason and the connection or harness that ran extraction. | Fix the named connection or harness. `unknown` is normal on a machine that does not extract sessions. |
| `auto-accept-validation` | `heuristic`. Reads `triage.promoted` and `gateAutoAcceptFailedCount` (only rows an older release wrote carry it) from the improve runs in the window. `warn`: proposals passed the confidence gate but failed validation (truncated description, invalid frontmatter); they stay pending. | Review them with `akm proposal list`. |
| `cli-version` | `warn`: a newer akm release exists on GitHub. `unknown`: `--no-probe`, or the release lookup failed. | Run `akm upgrade`. |
| `scheduler-binary` | `warn`: the akm binary recorded in the scheduler reports a different version than the running CLI. `unknown`: `--no-probe`, no scheduled task installed, or the recorded binary cannot be run. | Run `akm task sync` to rebind the schedule. |
| `index-state-generation` | `warn`: usage links in state.db point at index entries that no longer match (an index and state.db from different generations). | Stop concurrent writers and run `akm index --full`. |
| `stash-git-exposure` | `warn`: `env/` or `secrets/` files are tracked by git in the working bundle and the bundle has a remote. Skipped when the bundle has no `.git`. | Run `git rm --cached` on the listed files and add `env/` and `secrets/` to `.gitignore`. A `.gitignore` rule alone does not untrack files. When `.gitignore` carries `# akm: intentionally track env and secrets`, the warning stays but drops this instruction: confirm every configured remote is one you trust (the marker is not evidence that it is private). |
| `binary-config-skew` | `warn`: `config.json` has a `configVersion` newer than this binary knows. | Upgrade this install. |
| `egress-endpoints` | Every remote destination in the effective config, as one informational entry: enabled registries, git and website bundles, each connection's endpoint and the embedding endpoint (credentials in a URL are masked). Silent when nothing remote is configured. | Eyeball it against what you expect; a destination you did not configure came from an `extends` base or a shared bundle. |
| `type-directory-disagreement` | `warn`: an indexed asset's resolved type differs from the type its directory declares. Each line gives the file, both types, and the classifier signal that won (`winner`). | Review the listed files. Intended overrides (for example a `knowledge/` file containing `$ARGUMENTS`) are marked `known-good override`. |
| `memory-cleanup-archive` | `pass` with size and file count when the working bundle has `.akm/memory-cleanup/archive` content and no git history (the purge does not run there). `warn` when a git-backed bundle has archived files the purge cannot remove (untracked, modified, or unverifiable in git). | Commit the archived files so the purge can remove them once they age out. |
| `data-dir-usage` | `warn`: the data directory is over 1 GB and either more than 3 times the size of `state.db`, `index.db`, and `logs.db` (with their WAL and SHM files), or one top-level subdirectory holds more than half of it. The message names that subdirectory and its size. | Inspect the named subdirectory. `backups/tasks/` holds task-file snapshots written by `akm migrate apply`. |
| `plugin-version` | One row per native `claude plugin list --json` AKM installation, with scope, enabled state and install path; cached versions are never used to choose an installation. `AKM_MIN_VERSION` takes precedence over legacy `AKM_VERSION_RANGE`. Disabled and other-project installations are inert. Missing metadata or multiple applicable paths/versions produce `unknown`, since the native list does not identify which conflicting installation a running session loaded. The newest version is read on the channel the marketplace clone follows: on the remote's default branch the newest stable tag, on any other branch (such as `next`) the release tag on that branch's head, and on a clone pinned to a tag that tag. The newest-tag lookup is `--probe`-gated: with `--no-probe` the row is `unknown` ("not probed") and only the local range check still runs. `warn`: the plugin is stale, or its range does not admit the running CLI. | Run the `claude plugin update <ref>` command in the message. |
| `opencode-plugin-version` | The same check for the OpenCode plugin's own bundled `akm-cli` (read from its `package.json`, never executed): it runs in-process and shares the host's databases, so its lag matters the same way. OpenCode 1 caches each spec in its own folder, so it reads the one folder of the spec the global OpenCode config names under `plugin` (`akm-opencode`, read as `akm-opencode@latest`, or `akm-opencode@next`), and for `akm-opencode@<version>` reports the plugin as pinned with no staleness verdict; with no entry, or no folder for it, it reads `packages/akm-opencode`, and it never scans the other cached specs. It reads local files only and is never `--probe`-gated. `warn`: the bundled version differs from the running CLI. Omitted when the OpenCode plugin is not installed. | Update the OpenCode plugin. |
| `state-db-readable` | `fail`: `state.db` cannot be read, or is missing in a read-only run (which does not create it). Every other check is skipped, because none of them can read it. | Check the owner and mode of the data directory (or point `AKM_DATA_DIR` / `XDG_DATA_HOME` at one you own); run any akm command that records state, such as `akm health`, to create it. |

## Connections, harnesses and the work on them

`connections-and-harnesses` is one check with one table. A connection row names the endpoint,
whether its key is held (never the key, nor the variable that holds it) and,
unless `--no-probe`, whether the endpoint answers; a harness row names its platform,
whether the binary is found and, unless `--no-probe`, what `--version` printed; a work row names
where that kind of work runs and with which model. `akm info` prints the same
rows without contacting anything: key held and binary found only.

The work rows are resolved by the resolvers the calls themselves use, so the
table never disagrees with a call. An unreachable endpoint is a `warn` like
every other finding here, never a `fail`.

The table's evidence names endpoints so an operator can tell which connection
was checked; it never includes credential values or the names of the variables
that hold them, and an endpoint's embedded credentials are masked.
