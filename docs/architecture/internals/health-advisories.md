# `akm doctor` checks

`akm doctor` (formerly `akm health`, Deprecated, removed in 0.11) prints JSON by default (`--format text` for the table view) and
emits the checks below. Each result has a `name`, and lands in `hardChecks` (the
state.db, `task-history-read`, `active-runs`, connection and harness, and
semantic-search checks) or `advisories` (the rest). The list comes from
`HEALTH_CHECKS` in `src/commands/health/checks.ts`, `akmHealth` in
`src/commands/health.ts`, and the collectors in `src/commands/health/`. The
checks from `cli-usage-store` down to `opencode-plugin-version` (with `codex-plugin-version`) appear
only when they have something to report, and `state-db-readable` only in place
of every other check; the others are always present.

## Status and exit code

Each check is `pass`, `warn`, `fail`, or `unknown`, and `deterministic` or
`heuristic`.

- Any `fail` in `hardChecks` makes the overall status `fail` and the exit code 1. A `state.db` that cannot be
  opened at all (unreadable, not a SQLite database, or a migration that failed to apply) is one failing
  `state-db-readable` or `state-db-migrations` check in place of every other, with the same exit code.
- Otherwise, any `warn` (hard or advisory, `deterministic` or `heuristic`) makes it `warn` and the exit code 4, so
  the text header, AKM Desktop and the exit code count the same warnings.
- `unknown` results do not change the overall status.

`--since` sets the history window the task and improve checks read. The default is 24 hours.
The `active-runs` check always reads all still-active tasks, including those that started before this window.

## State access

By default, health creates `state.db` when missing, applies pending migrations and
runs the append/read/delete round-trip probe. `--read-only` reuses the same native
read-only implementation as AKM Desktop: it never creates, migrates or repairs
state, and the skipped round-trip is `unknown`. Missing, corrupt or unavailable
state, including pending migrations, produces a failing diagnostic with exit 1.
With `--report`, proposal queries also use a read-only connection; unavailable
state returns its diagnostic without attempting those extra queries.

Read-only state access and network probing are independent. Use
`akm doctor --read-only --no-probe` for offline inspection.

## Network and processes

Probing is on by default; `--no-probe` turns it off. With probing on, health sends a
`GET` to `<endpoint>/models` of each configured connection (3 second timeout; any HTTP
response counts as reachable, so a cold local server is never asked to load a model; one
request per distinct endpoint per invocation, with no cross-run cache), runs each configured
harness's `--version`, looks up the latest akm release on GitHub for `cli-version` (and
the npm `next` tag too for a prerelease install, requested by `akm upgrade --channel next`; 5
second timeout, no retries), and runs the akm binary recorded by the scheduler with
`--version` for `scheduler-binary`. `plugin-version` runs `git ls-remote --symref origin`
(it lists refs and fetches nothing) against the Claude plugin marketplace clone whenever a
Claude plugin is installed, and `codex-plugin-version` the same against the marketplace
remote whenever Codex's config registers it. With
`--no-probe` none of these runs: the connection rows carry no `reachable` field and the
message says reachability was not probed, and the plugin checks report `unknown`
(`plugin-version`'s comparison of the plugin's pinned `akm-cli` with the running CLI is local
and still runs). The plugin and `cli-version` lookups are best-effort: a lookup that fails
says so in the message (`remoteUnavailable` in the evidence) and is `unknown`, never a false
`pass` or `warn`; see `src/commands/health/plugin-staleness.ts` and
`src/commands/health/version-drift.ts`.

## Checks

| Check | Fires when | Remedy |
|---|---|---|
| `state-db-schema` | `fail`: state.db is missing one of `events`, `proposals`, `schema_migrations`, `task_history`. | The message lists the missing tables. |
| `state-db-round-trip` | `fail`: appending and reading back a probe event failed. The probe row is deleted again. `unknown` when `--read-only` or AKM Desktop skips this write probe. | The message gives the error. |
| `state-db-integrity` | `fail`: `PRAGMA integrity_check` failed, or reading the freelist failed. `warn`: more than 50% of the pages are free. | For a failed check, follow the repair in the message: back up state.db, run `sqlite3 -readonly state.db ".recover" \| sqlite3 state.new.db`, confirm `state.new.db` passes `integrity_check`, stop every akm process, delete `state.db-wal` and `state.db-shm`, then swap `state.new.db` in as state.db. The free-page warning clears when `akm improve`'s retention purge VACUUMs state.db. |
| `state-db-migrations` | Always `pass` in a normal run; the message lists the migrations this open applied and the pre-migration copy (`evidence.applied`, `evidence.backupPath`). `fail` when the open could not apply a pending migration, or a read-only run (`--read-only` or AKM Desktop) finds one pending, which it must not apply; this row is then the whole report. | Run `akm migrate apply`. |
| `metrics-db` | The long-lived history (`metrics.db`, not regenerable). `pass` with its size and the first and last day folded (`evidence.sizeBytes`, `firstFoldedDay`, `lastFoldedDay`, `foldedDays`), or that it is not created yet. `warn`: `state.db` holds closed UTC days that `metrics.db` does not cover, the oldest more than 7 days ago (`evidence.unfoldedDays`, `oldestUnfoldedDay`): the fold runs in `akm index` and `akm improve`, and until it does `state.db` keeps those rows past 90 days instead of purging them, so nothing is lost. `fail`: `PRAGMA integrity_check` failed or the file could not be read. | `warn`: run `akm index` (or `akm improve`); if it persists, the fold is failing and the one-line `[metrics.db]` warning on stderr says why. `fail`: restore `metrics.db` from your backup of the data directory, or move it aside (the next fold starts a new one; `state.db` holds only the last 90 days of raw rows). |
| `task-history-read` | Always `pass`; reports the number of `task_history` rows read in the window. | None. |
| `active-runs` | `warn`: a task run has been active for more than 15 minutes, regardless of `--since`. The message names the tasks and their age. | Inspect with `akm doctor log --task <id>`. |
| `improve-failures` | `warn`: a recorded run failed, ended with an exception or exhausted its budget, or contains processing failures (reflection, distillation LLM, generic action, consolidation chunk or memory-inference failure), even when its outer result is `ok: true`. Includes manual runs; excludes dry runs and runs outside the selected window. Signal-only interruptions (`SIGINT`, `SIGTERM`, `SIGHUP`) are `unknown`, not assumed cancellation or processing failure. Successful no-work runs, no-change decisions and quality rejections are not failures. | Inspect `akm doctor --since <same window> --group-by run` and the recorded result/log. |
| `connections-and-harnesses` | One table of every configured connection (endpoint, whether its key is held — a `$VAR` set in this shell, a `credentials.json` entry, or none — and whether the endpoint answers) and harness (platform, whether its binary is on `PATH`, and with a probe its `--version`), then the work that runs on them: improve, judges, agents, extract, enrich, index, and embedding, each naming the connection or harness and the model it resolves to through the same resolver the calls use (`evidence.rows`, typed `connection`, `harness` or `process`). `warn` when a key variable is unset, an endpoint does not answer, a harness is not installed, several connections (or harnesses) are configured and none is called `default` (said once, with the fix: name one `default`), or a work row cannot resolve because of the config; `unknown` when neither a connection nor a harness is configured; otherwise `pass`. Endpoint reachability is one bounded `GET /models` and the version is the harness's own `--version`; with `--no-probe` neither runs and the message says so. | Correct the named connection, key or harness; run `akm setup` when nothing is configured. A work row whose parts run somewhere other than the row's own target lists them in `overrides`, each with the kind (connection or harness), name and model it runs on: that is a per-process pin, working as set. |
| `semantic-search` | What the last `akm index` recorded about semantic search, with the index's entry and vector counts read now; no model load, no request. An unreadable index is always `fail`, even with semantic search off, because keyword search needs it too. Otherwise `pass` when every entry has a vector (local: on `onnxruntime-node`) or `semanticSearchMode` is `off`; `warn` when vectors lag entries, local embeddings ran on another runtime, or akm offers no local embeddings on this platform (`unavailable: platform`, where keyword search or an endpoint is the default); `fail` when the last index found it `blocked` (endpoint or model download failed) or `unavailable: load` (the runtime could not be downloaded or did not load), with the reason; `unknown` before the first index. | Fix the reason named; for an unreadable index, repair access or move the damaged index aside, then run `akm index`. `warn` for the platform: `akm setup --embedding off` for keyword search, or `akm setup --embedding <model> --embedding-endpoint <url>` for a remote endpoint. |
| `task-fail-rate` | `warn`: at least 5% of task runs in the window failed, or one task with at least 5 runs fails at that rate. The message names the dominant `detail.reason` (`timeout`, `non_zero_exit`, `spawn_failed`, ...) when one reason is at least half of the command-task failures. | Inspect failed runs with `akm doctor log --task <id>` and `akm task doctor`. `evidence.agentFailureReasonCounts` breaks command-task failures down by reason. |
| `session-extraction` | `heuristic`. Reads the last 7 days of the extract ledger. `unknown`: nothing recorded. `warn`: every session was skipped or failed for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`); the message names the reason and the connection or harness that ran extraction. Also `warn`: some sessions harvested but others had candidate writes fail (`proposal_write_failed`, including a session that queued only some of its candidates) and were not extracted again; a write only the validator refused does not count, and extracting the session again clears it. | Fix the named connection or harness; for write failures, run `akm proposal extract --session-id <id>` once the cause (a busy state.db, I/O, config) has cleared. `unknown` is normal on a machine that does not extract sessions. |
| `proposal-queue` | `deterministic`. Resolves the primary stash's proposal queue owner through the resolver extract calls before it spends model work. `unknown`: learning is off (the active strategy does not enable extract and no extraction ran in the last 7 days). `warn`: learning is on and no configured bundle owns the queue, or its owner is not writable; the message gives the resolver's reason. | Register the stash as a writable bundle (`akm bundle add`) or mark its owner writable. akm never picks a replacement. |
| `auto-accept-validation` | `heuristic`. Reads `triage.promoted` and `gateAutoAcceptFailedCount` (only rows an older release wrote carry it) from the improve runs in the window. `warn`: proposals passed the confidence gate but failed validation (truncated description, invalid frontmatter); they stay pending. | Review them with `akm proposal list`. |
| `cli-version` | `warn`: a newer akm release exists on the channel this install follows (GitHub's latest release; for a prerelease install also npm's `next` tag). `unknown`: `--no-probe`, or the release lookup failed. | Run the command in the message: `akm upgrade` for stable, `akm upgrade --channel next` for prerelease updates. |
| `scheduler-binary` | `warn`: the akm binary recorded in the scheduler entry reports a different version than the running CLI. `unknown`: `--no-probe`, no entry installed, no scheduler binary on this host (no `crontab`), an installation that does not own the OS scheduler, or the recorded binary cannot be run. | Run `akm doctor scheduler sync --rebind`. |
| `cli-usage-store` | `warn`: `metrics.db`, which holds the CLI usage tables (`cli_usage_meta`, `cli_usage_invocations`, `cli_usage_aggregates`), exists but cannot be read. Usage capture is fail-open, so an unreadable store stops collection without failing any command; this check is the only signal. Silent when the file is absent or readable. It never recreates the tables. | Move or delete `metrics.db` to restart collection. |
| `index-state-generation` | `warn`: usage links in state.db point at index entries that no longer match (an index and state.db from different generations). | Stop concurrent writers and run `akm index --full`. |
| `stash-git-exposure` | `warn`, one per bundle: `env/` or `secrets/` files are tracked by git in a configured bundle (the working stash included) and that bundle has a remote. Skipped for a bundle with no `.git` at its root. | Run `git rm --cached` on the listed files and add `env/` and `secrets/` to `.gitignore`. A `.gitignore` rule alone does not untrack files. To keep tracking them on purpose, add `# akm: intentionally track env and secrets` to the stash `.gitignore`; the advisory is then not reported. |
| `egress-endpoints` | Every remote destination in the effective config, as one informational entry: enabled registries, git and website bundles, each connection's endpoint and the embedding endpoint (credentials in a URL are masked). Silent when nothing remote is configured. | Eyeball it against what you expect; a destination you did not configure came from a shared bundle. |
| `type-directory-disagreement` | `warn`: an indexed asset's resolved type differs from the type its directory declares. Each line gives the file, both types, and the classifier signal that won (`winner`). | Review the listed files. Explicit frontmatter overrides (for example `agent:` declaring a command) are marked `known-good override`. A body mention of `$ARGUMENTS` is not command intent; run `akm index` to repair old classifications without editing the documents. |
| `memory-cleanup-archive` | `pass` with size and file count when the working bundle has `.akm/memory-cleanup/archive` content and no git history (the purge does not run there). `warn` when a git-backed bundle has archived files the purge cannot remove (untracked, modified, or unverifiable in git). | Commit the archived files so the purge can remove them once they age out. |
| `data-dir-usage` | `warn`: the data directory is over 1 GB and either more than 3 times the size of `state.db`, `index.db`, `logs.db`, and `metrics.db` (with their WAL and SHM files), or one top-level subdirectory holds more than half of it. The message names that subdirectory and its size. | Inspect the named subdirectory. `backups/tasks/` holds task-file snapshots an earlier `akm migrate apply` wrote. |
| `plugin-version` | One row per native `claude plugin list --json` AKM installation, with scope, enabled state and install path; cached versions are never used to choose an installation. Disabled and other-project installations are inert. Missing metadata or multiple applicable paths/versions produce `unknown`, since the native list does not identify which conflicting installation a running session loaded. The newest version is read on the channel the marketplace clone follows: on the remote's default branch the newest stable tag, on any other branch (such as `next`) the release tag on that branch's head, and on a clone pinned to a tag that tag. The newest-tag lookup is `--probe`-gated: with `--no-probe` the row is `unknown` ("not probed"); a lookup that fails (offline) is `unknown` and says the remote could not be read. The plugin runs the `akm-cli` its `package.json` pins (`dependencies["akm-cli"]`, an exact version), never an `akm` on `PATH`, and that copy shares the host's databases with the running CLI, so the pin is compared locally whatever `--probe` says: `pinnedCliVersion` and `cliMatches` in the evidence, `unknown` when the manifest has no exact pin. `warn`: the plugin is stale, or its pin differs from the running CLI — the message says which side is older. | A stale plugin: run the `claude plugin update <ref>` command in the message. A pin newer than the CLI: `akm upgrade`. A pin older than the CLI on a plugin that is current on its channel: nothing to update until that channel publishes a build for the running akm. |
| `codex-plugin-version` | The same for Codex, when its `config.toml` registers the `akm-plugins` marketplace: the installed version from `codex plugin list --marketplace akm-plugins --json`, and the newest release on the channel the marketplace entry's `ref` follows (none or `main`: the newest stable tag; `next`: the tag at that branch's head; a tag: that release), read with `git ls-remote` against `https://github.com/itlackey/akm-plugins` (`--probe`-gated; a failed read says so). `unknown` when `codex` is not on `PATH` or the listing fails; omitted when the marketplace is not registered or the plugin is not installed. Codex gives no path to the plugin's files, so its `akm-cli` pin is not compared. | Run `codex plugin marketplace upgrade akm-plugins`. |
| `opencode-plugin-version` | The OpenCode plugin's bundled `akm-cli`, read from its `package.json`, never executed. Both OpenCode checks require a configured plugin: cached files alone do not establish an installation. OpenCode 1 reads the configured `plugin` spec's cache (`akm-opencode` means `akm-opencode@latest`); only a configured bare name may fall back to the legacy `packages/akm-opencode` folder. A missing configured spec never selects another cache. OpenCode 1 exact version pins are reported as pinned with no staleness verdict. OpenCode 2 (`opencode-v2-plugin-version`) reads `npm/<spec>/<newest build>/node_modules` for the configured `plugins` or `plugin` spec (`akm-opencode-v2` means `@latest`), ignoring every other spec; its bundled CLI is compared with the host CLI even for exact pins. These local checks are not `--probe`-gated. `warn`: the bundled version differs from the running CLI; the message says which side is older. Omitted with no configured plugin or readable matching cache. | Bundled akm-cli newer than the CLI: `akm upgrade`. Older: update the plugin once its channel publishes a build for the running akm (`akm upgrade` checks and updates it). |
| `state-db-readable` | `fail`: `state.db` cannot be read, is not a SQLite database (garbage or a truncated copy), or is missing in a read-only run (which does not create it). Every other check is skipped, because none of them can read it. | Check the owner and mode of the data directory (or point `AKM_DATA_DIR` / `XDG_DATA_HOME` at one you own). Not a database: the message carries the `.recover` steps, or move the file aside for a fresh one. Missing: index the library (AKM Desktop: Settings → Bundles & index → Update / reindex; `akm index`) or run any akm command that records state, such as `akm doctor`. |

## Connections, harnesses and the work on them

`connections-and-harnesses` is one check with one table. A connection row names the endpoint,
whether its key is held (never the key, nor the variable that holds it) and,
unless `--no-probe`, whether the endpoint answers; a harness row names its platform,
whether the binary is found and, unless `--no-probe`, what `--version` printed; a work row names
where that kind of work runs and with which model. `akm doctor info` prints the same
rows without contacting anything: key held and binary found only.

An explicit harness launch failure or interrupted probe is a warning with the error in its row.
A harness that merely exits nonzero for an unsupported `--version` has no version to report, not a launch failure.

The work rows are resolved by the resolvers the calls themselves use, so the
table never disagrees with a call. An unreachable endpoint is a `warn` like
every other finding here, never a `fail`.

The table's evidence names endpoints so an operator can tell which connection
was checked; it never includes credential values or the names of the variables
that hold them, and an endpoint's embedded credentials are masked.
