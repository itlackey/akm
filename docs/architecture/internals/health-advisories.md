# `akm health` advisory → action map

Run `akm health` (JSON by default; `--format text` for the table view). The authoritative result
combines hard failures with deterministic warnings across both output
channels:

- Deterministic hard-check and advisory warnings set the overall status to `warn` and exit code 4.
- A hard check `fail` sets the overall status to `fail` and exit code 1.
- A heuristic (non-deterministic) advisory `warn` does not change or gate the overall status.
- A heuristic (non-deterministic) advisory `warn` does not change or gate the exit code.

This table is the interpretive key for a second operator: what each named
advisory measures and whether to act. Some `warn`s below are *adjudicated,
expected* states — treat them as "no action" until the referenced condition
changes.

| Advisory (name in output) | What it means | Action |
|---|---|---|
| `state-db-schema` | state.db is missing required tables. | Re-run `akm bundle create`; a fresh/older DB was opened. |
| `state-db-round-trip` | Append/read probe against state.db failed. | Check disk/permissions on the state.db path; the store is unwritable. |
| `state-db-integrity` | state.db failed `PRAGMA integrity_check` (which, unlike `quick_check`, also compares every index with its table), or more than half its pages are free (reclaimable by VACUUM). | Back up state.db, then run `sqlite3 -readonly state.db ".dump" \| sqlite3 state.new.db`, verify `state.new.db` passes `integrity_check`, and swap it in; the freelist warning clears on its own on the next `akm improve` retention purge, which VACUUMs state.db above the same 50% threshold. |
| `state-db-readable` | `state.db` is missing or cannot be read, or is behind on migrations that a read-only run must not apply. Every other check is skipped, because none of them can read it. | Check the owner and mode of the data directory (or point `AKM_DATA_DIR` / `XDG_DATA_HOME` at one you own); run any akm command that records state, such as `akm health`, to create it. |
| `state-db-migrations` | Reports what `akm health`'s own open of `state.db` applied (`evidence.applied`, and the copy it made first in `evidence.backupPath`); `fail` only when a pending migration could not be applied. | Run `akm migrate apply` when it names a pending migration. |
| `task-history-read` | How many `task_history` rows were read for the window (informational; it passes). | None. |
| `active-runs` | A task run has exceeded the stale threshold (>15 min). | Inspect with `akm task history`; a lane is likely wedged — kill/re-run it. |
| `connections-and-harnesses` | One table of every configured connection (endpoint, whether its key is held — a `$VAR` set in this shell, a `credentials.json` entry, or none — and whether the endpoint answers) and harness (platform, whether its binary is on `PATH`, and with a probe its `--version`), then the work that runs on them: improve, judges, agents, extract, enrich, index, embedding and curate rerank, each naming the connection or harness and the model it resolves to through the same resolver the calls use (`evidence.rows`, typed `connection`, `harness` or `process`). `warn` when a key variable is unset, an endpoint does not answer, a harness is not installed, several connections (or harnesses) are configured and none is called `default` (said once, with the fix: name one `default`), or a work row cannot resolve because of the config; `unknown` when neither a connection nor a harness is configured; otherwise `pass`. Endpoint reachability is one bounded `GET /models` and the version is the harness's own `--version`; with `--no-probe` neither runs and the message says so. | Correct the named connection, key or harness; run `akm setup` when nothing is configured. A work row whose parts run somewhere other than the row's own target lists them in `overrides`, each with where it runs and on which model: that is a per-process pin, working as set. |
| `task-fail-rate` | ≥5% of scheduled task runs failed in the window (exit 143/70 recurring), or a single task_id fails at/above the same threshold. (#943) For `command`-kind (agent/LLM dispatch) failures specifically, `evidence.agentFailureReasonCounts` always carries a `detail.reason` breakdown (`timeout`, `non_zero_exit`, `spawn_failed`, …), and the warn message names the dominant reason — e.g. `(timeout-dominant: 9/12 command-task failures)` — when one reason is at least half of the counted command-task failures. | Triage as a bug: `akm task doctor`, inspect failing lane logs. For a native shell/script task, exit-143 = killed/timeout, exit-70 = internal error. For a `command`-kind (agent/LLM) task, read `detail.reason` from `akm task history` instead of the exit code — `timeout` means the dispatch's own deadline (not an outer process kill) expired; `non_zero_exit`/`spawn_failed`/`aborted`/etc. name the other failure shapes. |
| `data-dir-usage` | The data directory is more than 3× the live databases (`state.db` + `index.db` + `logs.db`), or one top-level subdirectory holds more than half of it; the message names that subdirectory with its size and share. | Look at the named subdirectory. `backups/tasks/` holds one snapshot per `akm migrate apply` run that rewrote a task file; everything under `backups/` is yours to prune. |
| `stash-git-exposure` | `env/` or `secrets/` assets are git-tracked **and** a remote is set — `git push` can leak keys. | `git rm --cached` the files, add `env/`+`secrets/` to `.gitignore` (a rule alone does not untrack). |
| `semantic-search-runtime` | Semantic search is blocked; often a configured remote embedding endpoint is down. | Restore the endpoint, or set `semanticSearchMode` to `off`, or drop `embedding.endpoint` to use the local model. |
| `session-extraction` | (#914) Derived from the `extract_sessions_seen` ledger for the last 7 days — not `improve_runs`, which the hook-driven `akm proposal extract --session-id ...` never writes. `unknown` when nothing was recorded; `warn` when every session in the window was skipped for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`), naming the reason and engine; otherwise `pass` with per-outcome counts. | An `unknown` machine may be deliberately not configured for extraction, or may have stopped harvesting — check for recent sessions. A `warn` names the broken engine/reason directly. |
| `auto-accept-validation` | Proposals passed the confidence gate but failed validation (bad frontmatter, truncation). | Review the affected pending proposals via `akm proposal list`; they were held, not lost. |
| `egress-endpoints` | Every remote destination in the effective config, as one informational entry: enabled registries, git and website bundles, each connection's endpoint and the embedding endpoint (credentials in a URL are masked). Silent when nothing remote is configured. | Eyeball it against what you expect; a destination you did not configure came from an `extends` base or a shared bundle. |
| `binary-config-skew` | `config.json` carries a `configVersion` newer than this binary knows. A newer akm wrote the shared config, so this install is stale. | Upgrade this install; do not keep a stale binary against the shared config and databases. |
| `memory-cleanup-archive` | Size of a bundle's memory-cleanup archive. `pass` for a bundle with no git history (the purge sweep never touches it); `warn` when part of a git-backed bundle's archive cannot be purged (untracked, modified or unverifiable in git). Silent when nothing needs saying. | Commit the named files so the purge sweep can remove them once they age out. |
| `type-directory-disagreement` | An indexed asset's resolved type disagrees with the type its directory declares. Always `warn`, never a gate; each row names the `winner` signal and marks the known-good overrides (a `knowledge/` file that is a command, an `agents/` file with an `agent:` key). | Check the unexplained rows; a deliberate override reads as such. |
| `index-state-generation` | Durable usage links in `state.db` disagree with the current searchable index generation, which an interrupted cross-database update leaves behind. | Stop concurrent writers, then run `akm index --full` to relink state to the current index. |
| `cli-version` | (#950) Compares the installed akm-cli version against the latest GitHub release (the same source `akm upgrade` trusts). `--probe`-gated: `unknown` "not probed" with `--no-probe`; offline/rate-limited also degrades to `unknown`, never a false `warn`. | Run `akm upgrade` when a newer release is reported. An `unknown` result carries no staleness claim either way — check manually if it matters. |
| `scheduler-binary` | (#953) Reads the scheduler's recorded akm invocation for the installed tasks (the same binding `task sync`/`task doctor` already read — no crontab/launchd/schtasks text parsing) and runs it with `--version`, compared against the running CLI's version. `--probe`-gated: `unknown` "not probed" with `--no-probe`. `unknown` when no scheduled task is installed or the recorded binary cannot be executed. | A `warn` names both versions — upgrading akm through a different installer than the one active at the last `task sync` left the schedule pointed at the old binary; run `akm task sync` to rebind it. |
| `plugin-version` / `opencode-plugin-version` | (itlackey/akm#832,) `plugin-version` reports each installed Claude Code harness plugin's version and its declared `AKM_VERSION_RANGE` admission of the running CLI. `opencode-plugin-version` does the same for the OpenCode plugin's own bundled `akm-cli` (read from its `package.json`, never executed) — it runs in-process and shares the host's databases, so its lag matters the same way. `plugin-version`'s newest-tag lookup is `--probe`-gated: with `--no-probe` its row is `unknown` ("not probed") and only the local range check still runs. `opencode-plugin-version` reads local files only and is never gated. | A `warn` names the stale/out-of-range plugin and the update command (`claude plugin update <ref>` for the Claude plugin; update the OpenCode plugin for the bundled copy). |

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

Reachability is a real, bounded (3 s) probe (#914) — one `GET` against the
endpoint's `/models` route; any HTTP response counts, so a cold local server is
never asked to load a model — made once per distinct endpoint per invocation
(no cross-run cache, so a stale "reachable" verdict never lingers). Pass
`--no-probe` to skip it (offline or air-gapped hosts): the rows then carry no
`reachable` field and the message notes that reachability was not probed.

The table's evidence names endpoints so an operator can tell which connection
was checked; it never includes credential values or the names of the variables
that hold them, and an endpoint's embedded credentials are masked.

`akm health` makes at most two network calls besides the endpoint probe, both
best-effort and silent on failure and both gated behind `--probe`/`--no-probe`,
the same flag as endpoint reachability: `plugin-version`'s `git ls-remote` and `cli-version`'s
GitHub-release lookup. See
`src/commands/health/plugin-staleness.ts` and
`src/commands/health/version-drift.ts` for the discipline each follows.
