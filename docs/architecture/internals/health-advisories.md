# `akm health` checks

`akm health` emits the checks below. Each result has a `name`, and lands in
`hardChecks` (the state.db and engine checks) or `advisories` (the rest). The
list comes from `HEALTH_CHECKS` in `src/commands/health/checks.ts`, `akmHealth`
in `src/commands/health.ts`, and the collectors in `src/commands/health/`. The
checks from `index-state-generation` down to `opencode-plugin-version` appear
only when they have something to report; the others are always present.

## Status and exit code

Each check is `pass`, `warn`, `fail`, or `unknown`, and `deterministic` or
`heuristic`.

- Any `fail` in `hardChecks` makes the overall status `fail` and the exit code 1.
- Otherwise, any `warn` from a `deterministic` check (hard or advisory) makes it `warn` and the exit code 4.
- `heuristic` warns (`session-extraction`, `auto-accept-validation`) and `unknown` results do not change the overall status.

`--since` sets the window the task and improve checks read. The default is 24 hours.

## Network and processes

Probing is on by default; `--no-probe` turns it off. With probing on, health sends a
`GET` to `<endpoint>/models` of each configured LLM engine (3 second timeout; any HTTP
response counts as reachable), looks up the latest akm release on GitHub for `cli-version`
(5 second timeout, no retries), and runs the akm binary recorded by the scheduler with
`--version` for `scheduler-binary`. `plugin-version` runs `git ls-remote --tags origin`
against the Claude plugin marketplace clone whenever a Claude plugin is installed, with or
without `--no-probe`.

## Checks

| Check | Fires when | Remedy |
|---|---|---|
| `state-db-schema` | `fail`: state.db is missing one of `events`, `proposals`, `schema_migrations`, `task_history`. | The message lists the missing tables. |
| `state-db-round-trip` | `fail`: appending and reading back a probe event failed. The probe row is deleted again. | The message gives the error. |
| `state-db-integrity` | `fail`: `PRAGMA integrity_check` failed, or reading the freelist failed. `warn`: more than 50% of the pages are free. | For a failed check, follow the repair in the message: back up state.db, run `sqlite3 -readonly state.db ".recover" \| sqlite3 state.new.db`, confirm `state.new.db` passes `integrity_check`, stop every akm process, delete `state.db-wal` and `state.db-shm`, then swap `state.new.db` in as state.db. The free-page warning clears when `akm improve`'s retention purge VACUUMs state.db. |
| `state-db-migrations` | Always `pass` in a normal run; the message lists the migrations this open applied and the pre-migration copy. `fail` when the open could not apply a pending migration; this row is then the whole report. | Run `akm migrate apply`. |
| `task-history-read` | Always `pass`; reports the number of `task_history` rows read in the window. | None. |
| `active-runs` | `warn`: a task run has been active for more than 15 minutes. The message names the tasks and their age. | Inspect with `akm task history`. |
| `default-engine` | `unknown`: no default engine resolves (`defaults.engine` is unset and no opencode binary is found for the implicit fallback). `warn`: the engine's binary fails `--version`, an SDK engine lacks `@opencode-ai/sdk`, its binary, or its fallback LLM connection or credential, or an LLM engine's credential is unavailable. | Fix `defaults.engine` or install what the message names. When the credential is supplied by an `env/` asset, the message names its ref; run under `akm env run <ref> -- ...`. |
| `model-map-files` | `fail`: the installed `models.json` is invalid. `warn`: the user `models.json` overlay is invalid. | Reinstall akm for `fail`; fix or remove the user `models.json` for `warn`. |
| `selected-model-aliases` | `warn`: a configured engine selects a model alias that is known in the model map but has no mapping for that engine. `unknown`: no engine selects a model, or the model map is invalid. | Add the alias for that engine in `models.json`, or select an exact model ID. Unknown strings are passed through as exact model IDs. |
| `default-llm-engine` | `unknown`: `defaults.llmEngine` is unset. `warn`: its credential is unavailable. `fail`: its endpoint is unreachable. | Fix `defaults.llmEngine`, its credential, or the endpoint. `--no-probe` skips the reachability test. |
| `configured-engines` | `warn`: one or more engines under `engines` are unavailable (the message gives the count; evidence lists each engine's status). `unknown`: none configured. | Fix the engines listed as `warn` in the evidence. |
| `active-improve-strategy` | `warn`: some enabled processes in the active improve strategy have no usable engine or credential. `fail`: none of the model-calling processes can run, so a scheduled `akm improve` would do nothing. `warn` or `unknown` when the strategy itself cannot be resolved. | Fix the engine or credential for the processes the message names, or the strategy-level `engine`. Add `--require-engines` to the scheduled `akm improve` so it fails instead of silently skipping. |
| `task-fail-rate` | `warn`: at least 5% of task runs in the window failed, or one task with at least 5 runs fails at that rate. The message names the dominant `detail.reason` (`timeout`, `non_zero_exit`, `spawn_failed`, ...) when one reason is at least half of the command-task failures. | Inspect failed runs with `akm task history` and `akm task doctor`. `evidence.agentFailureReasonCounts` breaks command-task failures down by reason. |
| `session-extraction` | `heuristic`. Reads the last 7 days of the extract ledger. `unknown`: nothing recorded. `warn`: every session was skipped or failed for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`); the message names the reason and engine. | Fix the named engine. `unknown` is normal on a machine that does not extract sessions. |
| `auto-accept-validation` | `heuristic`. `warn`: proposals passed the confidence threshold but failed validation in the window (truncated description, invalid frontmatter); they stay pending. | Review them with `akm proposal list`. |
| `thinking-control` | `warn`: an engine with `enableThinking: false` recorded reasoning tokens in the window, so its endpoint or a gateway in front of it ignores the setting. `unknown`: no engine sets `enableThinking: false`, or none made calls. | Check the endpoint or gateway. akm sends `enableThinking: false` as both `chat_template_kwargs.enable_thinking` and `enable_thinking`; `reasoningEffort` on the engine sends `reasoning_effort` as a second control. |
| `cli-version` | `warn`: a newer akm release exists on GitHub. `unknown`: `--no-probe`, or the release lookup failed. | Run `akm upgrade`. |
| `engine-last-used` | `warn`: an engine bound to an enabled improve process has no `llm_usage` row in the last 30 days. `unknown`: no engine is bound, or no improve run started in those 30 days. | Find out why the bound process is not calling the engine (disabled, routed elsewhere, or unused). |
| `scheduler-binary` | `warn`: the akm binary recorded in the scheduler reports a different version than the running CLI. `unknown`: `--no-probe`, no scheduled task installed, or the recorded binary cannot be run. | Run `akm task sync` to rebind the schedule. |
| `index-state-generation` | `warn`: usage links in state.db point at index entries that no longer match (an index and state.db from different generations). | Stop concurrent writers and run `akm index --full`. |
| `stash-git-exposure` | `warn`: `env/` or `secrets/` files are tracked by git in the working bundle and the bundle has a remote. Skipped when the bundle has no `.git`. | Run `git rm --cached` on the listed files and add `env/` and `secrets/` to `.gitignore`. A `.gitignore` rule alone does not untrack files. |
| `binary-config-skew` | `warn`: `config.json` has a `configVersion` newer than this binary knows. | Upgrade this install. |
| `egress-endpoints` | `pass` with a list of the remote endpoints in the effective config: enabled registries, git and website bundles, LLM engine endpoints, and the embedding endpoint. Omitted when none are configured. | None. |
| `type-directory-disagreement` | `warn`: an indexed asset's resolved type differs from the type its directory declares. Each line gives the file, both types, and the classifier signal that won (`winner`). | Review the listed files. Intended overrides (for example a `knowledge/` file containing `$ARGUMENTS`) are marked `known-good override`. |
| `memory-cleanup-archive` | `pass` with size and file count when the working bundle has `.akm/memory-cleanup/archive` content and no git history (the purge does not run there). `warn` when a git-backed bundle has archived files the purge cannot remove (untracked, modified, or unverifiable in git). | Commit the archived files so the purge can remove them once they age out. |
| `data-dir-usage` | `warn`: the data directory is over 1 GB and either more than 3 times the size of `state.db`, `index.db`, and `logs.db` (with their WAL and SHM files), or one top-level subdirectory holds more than half of it. The message names that subdirectory and its size. | Inspect the named subdirectory. `backups/tasks/` holds task-file snapshots written by `akm migrate apply`. |
| `plugin-version` | One row per installed Claude Code `akm` plugin. `warn`: a newer tag exists on the plugin's remote, or the plugin's `AKM_VERSION_RANGE` does not admit the running CLI. | Run the `claude plugin update <ref>` command in the message. |
| `opencode-plugin-version` | `warn`: the `akm-cli` bundled in the OpenCode plugin has a different version than the running CLI. Omitted when the OpenCode plugin is not installed. | Update the OpenCode plugin. |
| `state-db-readable` | Replaces all other checks. `fail`: state.db exists but cannot be read. | Fix the owner and mode of the data directory, or point `AKM_DATA_DIR` or `XDG_DATA_HOME` at a location this user owns. |
