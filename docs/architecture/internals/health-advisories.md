# `akm health` advisory → action map

Run `akm health` (add `--json` for machine output). The authoritative result
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
| `task-log-backing` | task_history rows reference log files missing on disk. | Logs were pruned/moved out from under the DB; safe to ignore if intentional, else restore the log dir. |
| `active-runs` | A task run has exceeded the stale threshold (>15 min). | Inspect with `akm task history`; a lane is likely wedged — kill/re-run it. |
| `default-engine` | The configured general default agent, SDK, or LLM engine is missing or incomplete. | Correct `defaults.engine`; SDK operation requires the `opencode` binary on PATH (the npm SDK is an HTTP client and spawns `opencode serve`), while a fallback LLM is checked only when configured. |
| `model-map-files` | The installed or optional user `models.json` is missing, unreadable, or invalid. | Repair the installation for an installed-map failure; remove or correct the user overlay for a warning. |
| `selected-model-aliases` | A known selected alias lacks a mapping for its selected engine. Unknown model strings remain exact pass-through identifiers. | Add the missing alias/engine entry or select an exact model ID. |
| `default-llm-engine` | The independently configured LLM default is missing, incompatible, lacks a required credential, or (#914) its endpoint refuses the reachability probe. | Correct `defaults.llmEngine`, its connection, any symbolic credential binding, or the endpoint itself; an unreachable default is a hard `fail`. |
| `configured-engines` | Checks every explicitly configured engine and aggregates its deterministic availability, including (#914) reachability for `kind: "llm"` engines. | Repair engines whose safe status is `warn`; no configured engines yields `unknown`. |
| `active-improve-strategy` | An enabled process in the effective improve strategy cannot resolve its engine or required credential; evidence and the message name the resolved engine per process (#913), surfacing a strategy-level pin that shadows `defaults.llmEngine`. Derived from the same `resolveImprovePlan` credential check the real `improve` run uses (#957), so this reflects exactly what a run in this environment would skip. `warn` when some but not all enabled LLM-backed processes are unavailable; **`fail`** (#957) when EVERY enabled `capability: "llm"` process in the strategy is unavailable — the nightly run would be a total no-op, not a partial degradation. | Inspect the named unavailable process(es), then correct its process override, strategy triage engine, SDK fallback, or default LLM. A `fail` here means `akm improve --require-engines` would abort the same run outright; add that flag to the scheduled task once the credential is fixed to make future silent no-ops fail loudly instead. |
| `task-fail-rate` | ≥5% of scheduled task runs failed in the window (exit 143/70 recurring), or a single task_id fails at/above the same threshold. (#943) For `command`-kind (agent/LLM dispatch) failures specifically, `evidence.agentFailureReasonCounts` always carries a `detail.reason` breakdown (`timeout`, `non_zero_exit`, `spawn_failed`, …), and the warn message names the dominant reason — e.g. `(timeout-dominant: 9/12 command-task failures)` — when one reason is at least half of the counted command-task failures. | Triage as a bug: `akm task doctor`, inspect failing lane logs. For a native shell/script task, exit-143 = killed/timeout, exit-70 = internal error. For a `command`-kind (agent/LLM) task, read `detail.reason` from `akm task history` instead of the exit code — `timeout` means the dispatch's own deadline (not an outer process kill) expired; `non_zero_exit`/`spawn_failed`/`aborted`/etc. name the other failure shapes. |
| `data-dir-usage` | The data directory is more than 3× the live databases (`state.db` + `index.db` + `logs.db`), or one top-level subdirectory holds more than half of it; the message names that subdirectory with its size and share. | Look at the named subdirectory. `backups/task-v3` and `backups/task-v4` are capped at five snapshots per `akm migrate apply` (#897); anything else under `backups/` is yours to prune. |
| `stash-git-exposure` | `env/` or `secrets/` assets are git-tracked **and** a remote is set — `git push` can leak keys. | `git rm --cached` the files, add `env/`+`secrets/` to `.gitignore` (a rule alone does not untrack). |
| `semantic-search-runtime` | Semantic search is blocked; often a configured remote embedding endpoint is down. | Restore the endpoint, or set `semanticSearchMode` to `off`, or drop `embedding.endpoint` to use the local model. |
| `session-extraction` | (#914) Derived from the `extract_sessions_seen` ledger for the last 7 days — not `improve_runs`, which the hook-driven `akm proposal extract --session-id ...` never writes. `unknown` when nothing was recorded; `warn` when every session in the window was skipped for an infrastructure reason (`llm_unavailable`, `read_failed`, `exception`, `locked_concurrent`), naming the reason and engine; otherwise `pass` with per-outcome counts. | An `unknown` machine may be deliberately not configured for extraction, or may have stopped harvesting — check for recent sessions. A `warn` names the broken engine/reason directly. |
| `pool-saturation` | <2% of the session pool was new — possible discovery/dedup bug. | Verify `akm proposal extract` still finds new sessions; a healthy steady state sits above 10%. |
| `auto-accept-validation` | Proposals passed the confidence gate but failed validation (bad frontmatter, truncation). | Review the affected pending proposals via `akm proposal list`; they were held, not lost. |
| `outcome-proxy-adequacy` | Retrieval proxy is *inverted* (corr < −0.3): popular assets are the most-needing-improvement. | Known WS-2 limitation; no live action — see plan §WS-2 / CONTEXT before tuning. |
| `outcome-proxy-dead` | Retrieval proxy is *dead* (\|corr\| < 0.1 at n≥500): outcome_score is noise. | **Adjudicated/expected** during the minting-shutdown re-baseline (12-D1); no action. |
| `salience-uniformity-collapse` | Gini across all positive, resolvable retrieval-salience values is below 0.08 — ranking no longer discriminates among assets with retrieval evidence. | Inspect the reported sample size and salience freshness; run `akm index` to refresh retrieval timestamps, then let the improve schedule recompute salience before tuning weights. |
| `enrichment-lane-minting` | Enrichment lanes minted new assets above threshold (5% warn / higher = fail). | Adjudicated against the ratified minting rules; act only if the share keeps climbing post-shutdown. |
| `improve-churn-ratio` | Accepted proposals rewrote the same few refs (ratio > 1.5) instead of covering the corpus. | Expected while coverage is low; watch the trend, do not retune on a single window. |
| `collapse-churn-detector` | R5 detector fired collapse/churn alerts (or `unknown` = no cycle rows yet). | Inspect recent collapse/churn cycle rows and the detector's advisory output before acting. |
| `thinking-control` | (#949) For every configured `kind: "llm"` engine with `enableThinking: false`, checks the window's recorded `llm_usage` for reasoning tokens. Passive: never issues its own completion. `unknown` when no engine sets `enableThinking: false`, or when a configured one made no calls in the window. | A `warn` names the engine that returned reasoning tokens — its endpoint, or a gateway in front of it, is not honoring the thinking-off control. Check the gateway/endpoint config; behind a gateway that drops `chat_template_kwargs` (Bifrost), set `reasoningEffort: "none"` on the engine, which such gateways pass through. |
| `cli-version` | (#950) Compares the installed akm-cli version against the latest GitHub release (the same source `akm upgrade` trusts). `--probe`-gated: `unknown` "not probed" with `--no-probe`; offline/rate-limited also degrades to `unknown`, never a false `warn`. | Run `akm upgrade` when a newer release is reported. An `unknown` result carries no staleness claim either way — check manually if it matters. |
| `engine-last-used` | (#950) For every engine bound to an enabled process in the active improve strategy, checks `llm_usage` for a call in the last 30 days (independent of `--since`). `unknown` when no engine is bound, or when no improve run has been recorded (started) in that window at all (a fresh install). | A `warn` names the idle engine and the process it is bound to. Configured, reachable, and credentialed is not the same as actually used — investigate why the bound process is not invoking it (disabled downstream, misrouted, or genuinely unused). |
| `scheduler-binary` | (#953) Reads the scheduler's recorded akm invocation for the installed tasks (the same binding `task sync`/`task doctor` already read — no crontab/launchd/schtasks text parsing) and runs it with `--version`, compared against the running CLI's version. `--probe`-gated: `unknown` "not probed" with `--no-probe`. `unknown` when no scheduled task is installed or the recorded binary cannot be executed. | A `warn` names both versions — upgrading akm through a different installer than the one active at the last `task sync` left the schedule pointed at the old binary; run `akm task sync` to rebind it. |

> Adjudicated states (`outcome-proxy-dead`, `enrichment-lane-minting`)
> are the before/after instrument for the 12-D1 minting shutdown — do not "fix" them by retuning.
> When in doubt, prefer no action over panic-retuning (per the review-12 guard).

## Engine and model advisories

`selected-model-aliases` warns when a known selected alias is missing the selected engine mapping.
It checks explicit string model selections on sorted
configured engines against the merged installed/user model map. Unknown model
identifiers are exact pass-through values and are not reported as missing. An
invalid model map makes this check `unknown` with generic evidence rather than
copying parser text or authored values.

`configured-engines` covers every explicitly configured engine. It reuses the
same availability result as the default-engine projections and reports sorted
safe evidence containing only engine name and status. All available engines
pass; any unavailable engine warns; no explicitly configured engines is
`unknown`.

Agent checks inspect local binary availability; SDK checks inspect the
package/binary and any configured fallback. LLM checks (a `kind: "llm"`
runner, and an SDK runner's LLM fallback connection) additionally send a
real, bounded (3 s timeout) reachability probe (#914) — one `GET` against
the endpoint's `/models` route; any HTTP response counts, so a cold local
server is never asked to load a model — to `default-llm-engine`'s and
`configured-engines`' endpoints, one probe per distinct endpoint per
invocation (no cross-run cache, so a stale "reachable" verdict never lingers).
An unreachable endpoint is a hard `fail` for `default-llm-engine` (extraction
and improve depend on it directly) and a `warn` for every other engine that
resolves to it. Pass `--no-probe` to skip these probes entirely (offline or
air-gapped hosts) — every affected check then reports its prior,
credential-only verdict and notes that reachability was not probed.

Engine evidence names the endpoint and model of the probed connection so an
operator can tell which connection was checked; it never includes credential
values or provider output.

(#950) When a required `$VAR`-style credential is unavailable in the health
process's own shell, `default-llm-engine` and `configured-engines` also check
whether any `env/` asset defines a key by the same name. When one does, the
`warn` message and `evidence.suppliedByEnvAsset` name the env asset's ref
(e.g. `env/lab`) and point at `akm env run env/lab -- ...` — never the
variable name itself, which stays out of both the message and evidence (see
`tests/health-engine-probe.test.ts`). This is the common case where the
operator's real workflow already supplies the credential under an `env run`
wrapper; the check still `warn`s (the credential genuinely is unavailable in
*this* invocation's shell), just with an actionable next step instead of a
bare "unavailable".

`akm health` makes at most two network calls, both best-effort and silent on
failure: `plugin-version`'s `git ls-remote` (unconditional, predates
`--probe`) and `cli-version`'s GitHub-release lookup (gated behind
`--probe`/`--no-probe`, same flag as engine reachability). See
`src/commands/health/plugin-staleness.ts` and
`src/commands/health/version-drift.ts` for the discipline each follows.

The salience Gini guardrails are calibrated against distribution shape, not a
top-ranked quantile: near-uniform `0.49/0.51` scores produce about `0.01`, a
balanced `0.25/0.75` spread produces `0.25`, and one dominant score among nine
`0.01` scores produces about `0.82`. Read-only full-observation snapshots were
also stable inside the neutral `0.08..0.35` band: `0.2613` across 1,209 assets
on 2026-07-12 and `0.2506` across 1,454 non-missing assets on 2026-08-17.
