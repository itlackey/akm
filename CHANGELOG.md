# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.9.15] - 2026-09-09

### Added

- **`akm workflow list`/`status --all-scopes` (#942).** Workflow runs are
  partitioned by `scope_key`, a hash of the working directory a run was started
  from, so a scheduled task and a human shell working in different directories
  can each believe a ref has no active run and start one, while `akm workflow
  list` from either scope shows only its own. `--all-scopes` searches every scope
  instead of only the current one, and both commands' JSON envelope now carries a
  top-level `scopeKey` naming the scope that was searched (`null` under
  `--all-scopes`), so an empty result is no longer indistinguishable from
  "nothing anywhere." Default output is unchanged.
- **`akm health`'s `task-fail-rate` advisory names the dominant command-task
  failure reason (#943).** Evidence now always includes
  `agentFailureReasonCounts`, a breakdown of `detail.reason` values (`timeout`,
  `non_zero_exit`, `spawn_failed`, …) across command-task failures in the window,
  and when the check is already `warn` and one reason covers at least half of
  those failures the message names it, e.g. `(timeout-dominant: 9/12 command-task
  failures)`. Investigating the reported issue found the underlying propagation
  was already correct on this branch — a command dispatch that times out, is
  killed, or returns a non-zero/`ok:false` result was already recorded `failed`
  with its reason, and `akm task run` already exited non-zero for it — so that
  contract is now pinned by a regression test instead of left implicit.
- **Every real `improve` run persists a `usageReport` field summarizing LLM usage
  by process, engine, and model (#944).** `usageReport: {byProcessEngineModel,
  noCalls}` folds a new process x engine x model cross-tab of the run's
  `llm_usage` events together with the resolved process routing table (#947); it
  is omitted from the result when both halves would be empty, matching the
  envelope's existing convention. `noCalls` lists every LLM-backed process the
  active strategy enabled but that made zero calls, each with a `reason` drawn
  from the existing skip-reason vocabulary (`"engine_unavailable"`,
  `"autonomy_gated"`, `"strategy_filtered_all_passes"`, a reflect/distill
  dominant skip reason, or `"no_signal"`) — never a fabricated category. The same
  table is printed to stderr after every real run.
- **`akm improve report [--run <id>] [--since <window>]` reads a run's LLM usage
  back without hand-written SQLite against `state.db` (#944).** With no flags it
  shows the most recent real run; `--run <id>` targets one specific
  `improve_runs` row; `--since <window>` sums `usageReport` across every real run
  started in the window. `"report"` is a reserved `improve` scope value matching
  zero real assets, so it dispatches to the report before any lock, log, or index
  side effect. A run recorded before 0.9.15 (or one whose result cannot be
  decoded) has no persisted `usageReport`: the command recomputes the cross-tab
  from that run's own `llm_usage` events and adds a `notes` entry explaining the
  degradation instead of erroring or fabricating eligibility reasons.
  `--run`/`--since` only mean anything with this scope, so passing either with
  any other scope (or none) is now rejected instead of being silently ignored.
- **The health `llm_usage` aggregate (`akm health --since <window>`'s `llmUsage`
  field) now tracks a `failures` count alongside calls and token totals (#944).**
  Every existing breakdown (`byStage`, `byProcess`, `byEngine`, and the window
  total) gains this count for free from the same aggregator; a call whose
  `llm_usage` event records an error outcome increments it.
- **A config file can inherit a shared base via `extends` (#945).** Setting
  `extends: <path|bundle//path>` deep-merges a base config underneath the local
  file — local keys always win. The base resolves without the search index: a
  filesystem path relative to the declaring file (`~` expanding), or an
  already-synced bundle-relative file (`bundle//<path>`, resolved against that
  bundle's content root, needing no asset type). It runs through its own version
  and legacy-shape shims independently and may itself set `extends` (chained); a
  cycle is a `ConfigError` naming the ref. A fleet of instances can now keep one
  shared `engines`/`improve.strategies` block instead of hand-syncing it across
  hosts.
- **`akm config get --show-source` and `akm config diff` inspect an effective,
  `extends`-merged config (#945).** `config get <key> --show-source` wraps the
  value as `{ value, source }`, reporting whether it came from `local`,
  `extends:<ref>`, or `default`. `config diff <path|bundle//path>` prints sorted
  `{ path, local, other }` rows for every leaf that differs between this
  instance's effective config and another config file or bundle-relative file
  (loaded through the same loader, so its own `extends` is honoured too),
  redacting secrets on both sides first. Both are additive: `config get`'s
  default bare-value shape is unchanged, and `config set`/`unset` still edit only
  the local file.
- **A model-map column can borrow its model from a configured engine (#946).** A
  `models.json` profile may now set `"engine": "<name>"` instead of a literal
  `model` string, e.g. `"fast": { "opencode": { "engine": "local-fast" } }`, to
  reuse `engines.local-fast`'s own `model` (and, for an `llm`-kind engine, its
  `temperature`/`maxTokens`/`enableThinking`/etc. as `inference` defaults) rather
  than hand-typing the value a second time. `model` and `engine` are mutually
  exclusive on one profile; a reference to a missing engine, or one with no
  usable model, fails with the same "a usable model is required after overlay"
  error, now checked at `akm health` as well as at dispatch. Engine selection
  itself is unchanged: `engine` is only an indirection for the model/inference
  *value* of one column, never an override of which engine
  `--engine`/`defaults.engine` actually dispatches to.
- **`akm models list` shows the effective model-alias table (#946).** It prints
  every resolved (alias, column) pair with its `model`, `source` (`default` vs
  `user`), and `via` (`literal` vs `engine`, naming the engine when applicable),
  so an operator can see at a glance which mappings a local `models.json`
  overrides and which fall through to AKM's installed defaults.
- **`akm improve --dry-run` reports the resolved process -> engine -> model
  routing before anything runs, in a new `plan.processes` field (#947).** One row
  per improve process (`reflect`, `distill`, `consolidate`, `memoryInference`,
  `graphExtraction`, `extract`, `validation`, `triage`, `proactiveMaintenance`),
  plus a `triage.judgment` row when configured: `enabled`, the resolved
  `engine`/`model` for llm-backed processes, this process's own lowering
  `notices`, an `unavailable: {configKey, reason}` when the engine or its
  credential could not be resolved, and — for reflect/distill/consolidate —
  `eligibleRefs`, the count of this run's effective refs the process would act
  on. None of this is new resolution: the plan already computes it,
  dispatch-free, before every invocation (dry or live); this only projects it
  into the result. `--strategy` overrides are honored for free, unlike `akm
  health`'s `active-improve-strategy` check, which still reads the configured
  default strategy (`defaults.improveStrategy`) and reports no model.
- **`--plan` is a new alias for `--dry-run`, for previewing `plan.processes`
  (#947).** It sets the exact same internal flag — no separate code path, no
  additional network reachability probe; pair with `akm health --probe` to check
  whether a named engine actually answers.
- **`akm workflow run --skip-if-locked` (#948).** Extends `improve
  --skip-if-locked`'s skip-gracefully-instead-of-failing semantics to `workflow
  run`: when another engine invocation already holds the run's lease
  (`RUN_LEASE_HELD`) or `state.db` is contended (`STATE_DB_CONTENDED`), the flag
  turns the failure into one warn line plus `{ ok: true, skipped: { reason:
  "lock-held" | "state-db-contended" } }` at exit 0 instead of exit 75. Every
  other failure — a bad flag, an unresolvable target — still fails loudly
  regardless of the flag. Use it on high-frequency scheduled workflow runs so
  they don't pile up failures while a longer-running invocation is in progress.
  Not extended to `task run`.
- **`akm health` reports engines whose thinking-off control was ignored (#949).**
  A new advisory, `thinking-control`, warns per configured LLM engine with
  `enableThinking: false` when the report window's recorded usage shows reasoning
  tokens anyway. It is passive — it re-reads the existing `llm_usage` window
  aggregate rather than issuing a completion of its own, so a cold local model is
  never woken just to run `akm health`. `unknown` when no engine sets
  `enableThinking: false`, or when a configured one made no calls in the window.
- **`akm health` reports version drift, idle-but-bound engines, and which env
  asset supplies a missing credential (#950).** Three new checks close a
  fleet-awareness gap where `akm health` could pass on a stale host running
  behind its peers, or on an engine that is configured and reachable but has not
  actually been invoked in weeks. The new `cli-version` advisory compares the
  installed akm-cli version against the latest GitHub release (the same source
  `akm upgrade` already trusts) and warns when a newer release exists; it is
  gated behind `--probe`/`--no-probe` like the engine-reachability checks, and
  degrades to `unknown` (never a false warn) when offline or rate-limited. The
  new `engine-last-used` advisory folds `llm_usage` events over a fixed 30-day
  lookback — independent of `--since` — against the active improve strategy's
  process-to-engine bindings, and warns when a bound engine has no recorded use
  in that window; it stays `unknown` rather than warning until at least one
  improve run has been recorded (started) in the same window, so a fresh install
  is not noisy. Finally, when `default-llm-engine` or `configured-engines`
  reports a required credential missing from the shell, the warn now names the
  env asset (never the variable name) that supplies the same key when one exists
  — for example `env asset env/lab supplies it — run under it (akm env run
  env/lab -- ...)` — instead of a bare "unavailable" that hides the real remedy
  for an operator whose normal workflow is `akm env run env/lab -- akm improve`.
- **`akm task list` is an alias for `akm search --type task` (#951).** 0.9.0
  removed the `task list` command as a redundant second implementation of task
  listing; this reintroduces only the spelling, not the logic. It delegates to
  the same `akmSearch`/`parseSearchSource` path `akm search --type task` uses,
  passing the query, `--limit`, and `--from` flags through unchanged and
  returning the exact same envelope, including the `results` alias. `task show`
  and `task remove` stay retired.
- **`akm info` exposes `dataDir`, `configDir`, `cacheDir`, and `stateDir`
  (#951).** These are akm's resolved data/config/cache/state directories, so a
  script can read `akm info --format json | jq -r .dataDir` instead of hardcoding
  a path that differs between a host install and a container.
- **`akm index --reembed` forces a full re-embed (#955).** Bypasses the
  compatibility check above entirely and purges + regenerates every stored
  embedding, for the rare case where the check's verdict should not be trusted. A
  targeted post-write embedding pass (after `akm remember`, `akm improve`, etc.)
  never forces a rebuild on its own.
- **`akm index --skip-if-locked` lets a scheduled or opportunistic run step aside
  instead of contending with one already in progress (#956).** Every explicit
  `akm index` run now acquires an opt-in, PID-liveness-only rebuild lock (no
  age-based stale reclaim — the same #872 lesson `akm improve`'s lock already
  applies) and releases it on exit. This is **not** the blocking index-rebuild
  lock #872 removed: a plain `akm index` with no flag is never gated by it — a
  held lock only warns and the run proceeds unlocked, exactly as before.
  `--skip-if-locked` mirrors `akm improve --skip-if-locked`: when the lock is
  already held by a live process it skips gracefully (exit 0, `{ ok: true,
  skipped: { reason: "lock-held", pid, launcherPid, startedAt } }` —
  `launcherPid` is the holder's launcher pid when known, `null` otherwise,
  #956) instead of piling up behind the other run. The shipped
  `index-refresh` scheduled task now passes it.
- **`akm improve` reports which processes it skipped for an unavailable engine,
  instead of dispatching with a doomed credential (#957).** A process whose
  engine was configured but whose credential could not be resolved in this
  process's own environment (a scheduler that strips `env/user.env` from the task
  environment, for example) used to keep its runner and proceed to an
  unauthenticated dispatch, with no run-level signal beyond a stderr warning. The
  plan builder now folds a resolved-but-uncredentialed engine (including the
  triage judgment engine) into the same `engineUnavailable` handling as "no
  engine selected," and the result carries a new `skippedProcesses: [{process,
  configKey, reason}]` field (omitted when nothing was skipped) naming which
  engine and which credential reference — never its value — is missing. `ok` and
  the exit code are unchanged, matching the `extract`/`skipReasons` contract
  (#912): a scheduler must not start failing because one LLM process's credential
  is temporarily missing while others still run. `--dry-run`/`--plan` never
  dispatches, so a preview no longer aborts when every enabled process is
  credential-unavailable either: it reports the affected processes in
  `skippedProcesses` and shows them as unavailable (with their structurally
  resolved engine and model) in `plan.processes`, the same as a run that does
  dispatch.
- **`--require-engines` opts a run out of that degrade-and-continue behavior, and
  is now set on all six shipped scheduled improve task templates (#957).** It
  aborts (exit 78) right after the plan resolves, before any lock, log, or index
  side effect, listing every unavailable process and its unresolved credential
  reference — recommended alongside `--skip-if-locked` for scheduled runs, since
  the operator's own shell can pass config validation while a scheduler's
  stripped-down environment cannot.
- **`embedding.timeoutMs` configures the per-request embedding timeout
  (#954).** The prior fixed 30s timeout cut off a slow local model server on
  a large token-budget-bounded batch mid-response. Default 120s, used by both
  the single-text and batch embedding request paths; it scales down for a
  smaller-than-budget request (`clamp(timeoutMs × requestTokens /
  tokenBudget, 30s, timeoutMs)`), so a dead endpoint is detected in seconds
  on the common case of small documents. A request timeout no longer drops
  its batch immediately: field confirmation showed the endpoint keeps
  computing an abandoned request regardless, so akm now backs off (5s,
  doubling, capped at 60s) and retries the SAME request once before ever
  splitting or skipping it; a second timeout splits the batch in half (like
  a context-size rejection) and retries each half the same way, down to
  individual documents, and a single document that times out twice is
  finally skipped.
- **`embedding.concurrency` overrides the fixed in-flight embedding request
  window (#954).** Bounded 1-16; unset behavior is unchanged (1 for a
  loopback endpoint, 2 for a remote one). 0.9.15-beta.1 shipped with no
  config override for this window; the final release adds one after field
  evidence that a multi-slot local server (llama.cpp `--parallel N`, vLLM)
  sat idle behind the fixed default. Request size — `embedding.batchSize`
  and `embedding.maxTokens` — remains the first throughput
  lever; set this only for an endpoint that genuinely serves parallel
  requests.
- **The embedding phase stops after 3 consecutive transport failures instead
  of grinding through every remaining batch (#954).** A dead or hung
  provider used to burn hours on a large stash, one request timeout at a
  time, with no signal until a single aggregate warning at the end and
  `ok: true`, exit 0. The pass now stops dispatching further requests and
  reports failure after 3 consecutive failures at single-document size
  (timeout or network error — a multi-document timeout is retried and split
  smaller before it can ever count, so it is not by itself evidence the
  endpoint is dead) or 3 consecutive network errors at any size (never
  retried, so trusted immediately); a `context-window-exceeded` skip never
  counts and resets both streaks. The failure message names how many
  embeddings were stored before it gave up. Batches already committed are
  kept.
- **`embedding.maxInputTokens` caps a single document's embedded text
  instead of letting it fail a whole batch (#956).** llama.cpp rejects a
  single sequence longer than its physical batch (`--ubatch-size`, default
  512) with HTTP 500 "input is too large to process," and the only
  per-entry cap before this was 1,000,000 characters. `akm index` now
  truncates a document's embedded text to `embedding.maxInputTokens`
  (default 512, head only, unicode-safe) before batching rather than
  skipping it; a document is skipped only when its truncated head is empty.
  `embedding.contextLength` is Ollama's `num_ctx` only now — it used to also
  silently set the per-request token budget (`embedding.maxTokens`), so
  setting it for the server's context window changed request batching too.
  The request budget is `embedding.maxTokens` (default 8000), so a request
  carries about 16 documents alongside the new per-document cap by default.
- **`akm index` reports where its embedding credential came from, before the
  first provider request (#953).** A field report suspected a gateway was
  receiving unauthenticated embedding requests despite `embedding.apiKey`
  being set to a `secret://` reference. Auditing and reproducing every path
  that reaches `RemoteEmbedder` — plain `akm index`, the CLI as a real child
  process, an `extends`-inherited config with adapter detection persisting
  mid-run (#945), `akm bundle update`'s post-commit embedding pass, and the
  `akm remember` write path's targeted re-embed — found every one already
  resolves `secret://` through the same store lookup, now pinned by
  integration and contract tests so a future config-flow change cannot drop
  `apiKey` unnoticed. `akm index` now prints one default-level line before
  its first provider request naming the endpoint, model, and credential
  SOURCE — `secret://lab-api-key (store)`, `$LAB_API_KEY (env)`, `literal
  apiKey`, or `none configured` — never the credential's value, so a field
  run can compare it directly against what the gateway actually logged.
  `--verbose` also names the config file the run loaded.

### Changed

- **BREAKING: `RUN_LEASE_HELD` now exits 75, not 2 (#948).** A held workflow
  run-lease refusal — `akm workflow run` or `akm workflow complete` racing
  another engine invocation on the same run — was a `UsageError` (exit 2), which
  schedulers and cron wrappers read as "fix the command line" rather than "try
  again shortly." It is now a `TransientError` (exit 75, sysexits `EX_TEMPFAIL`);
  the message, hint, and `RUN_LEASE_HELD` code are unchanged. A script or
  scheduler that special-cased exit 2 to detect a held lease must switch to exit
  75, or check the JSON envelope's `code` field instead.
- **Thinking-control wire forms no longer depend on `provider` (#949).**
  `chat_template_kwargs.enable_thinking` was previously sent only when `provider:
  "vllm"` was set; every other provider (including none) got a bare top-level
  `enable_thinking` that nothing was observed to honor. AKM now sends both wire
  forms whenever `enableThinking` resolves to a value, regardless of `provider`.
  An engine relying on `provider: "vllm"` purely for this side effect keeps
  working identically. An engine configured with `provider: "openai"`, another
  provider name, or no `provider` at all now also receives
  `chat_template_kwargs`, which it did not before — this is what lets the same
  engine block turn thinking off consistently behind a direct vhost, freellmapi,
  or Bifrost, without a gateway silently dropping the one wire form it happened
  to send.
- **`akm health --no-probe` now also skips the version-drift check (#950).**
  `--probe`/`--no-probe` previously gated only LLM engine reachability; it now
  also gates the `cli-version` advisory's GitHub release lookup, so an offline or
  air-gapped host's existing `--no-probe` habit suppresses both network calls.
  This is the second deliberate network exception in `akm health`, alongside the
  pre-existing `plugin-version` advisory's `git ls-remote`.
- **The direct-LLM reflect path sizes its asset-content budget from the target
  engine's `contextLength` instead of a flat 12,000-character cap (#952).** The
  flat cap only exists to keep the prompt under OS `ARG_MAX` when passed as CLI
  argv to an agent or SDK runner; the direct-LLM HTTP path never touches argv, so
  agent and SDK runners are unaffected. The budget reserves half of the usable
  window for the model's response, since a reflect rewrite returns a body roughly
  the size of the input. Configure `engines.<name>.contextLength` to raise the
  budget for a given engine; unconfigured engines keep today's effective
  ~12,000-character behavior.
- **`akm index` commits embeddings per provider batch instead of buffering the
  whole run for one final write (#954).** Earlier releases wrote every generated
  vector in a single `db.transaction()` after the entire embedding pass finished,
  so an interruption partway through (a competing indexer collision, a killed
  process, any thrown provider error) discarded every embedding already computed,
  not just the ones still in flight. Each request batch now commits inside its
  own short transaction as it lands. This holds on every path that embeds: plain
  `akm index`, the implicit reindex, the write path (`akm remember`/`import`/
  `proposal accept`/`source clone`), and `akm bundle update` (see below).
- **A batch rejected for exceeding the endpoint's context window is split and
  retried instead of skipped outright (#954).** `akm index`'s embedding pass now
  recognizes HTTP 413 and known context-size error bodies and halves the failing
  batch, retrying each half recursively down to individual documents. Only a
  single document that still fails this way is skipped, as
  `context-window-exceeded`; every other failure (network error, 5xx, malformed
  response) keeps the prior skip-the-whole-batch behavior.
- **Embedding requests are dispatched through a small in-flight window instead of
  strictly sequentially (#954).** The window defaults to 1 request at a time for
  a loopback endpoint and 2 for a remote one; the actual throughput knob is
  request size, via the existing `embedding.batchSize` (document cap) and
  `embedding.maxTokens` (token budget), since a larger batch
  takes about the same wall time as a single one. `embedding.concurrency`
  (see Added, above) overrides this default for a server that genuinely serves
  parallel requests.
- **`akm index` reports embedding progress and throughput in more detail as it
  runs (#954).** A default-level line reports each provider batch as it
  completes — document count, token count, elapsed time, and outcome
  (`stored`/`failed: <reason>`/`retrying after <n> s`) — and a final line
  reports total throughput (`entries/s`, `tokens/s`) plus every outcome: how
  many embeddings were stored (and reused from a prior generation, when
  salvage applied — see #955 below), oversized-skipped, timed out, and
  failed, with the affected refs listed (first 20 by default, all of them
  under `--verbose`).
- **A rename of `embedding.model` no longer forces a full re-embed by itself
  (#955).** `akm index` used to purge and rebuild the entire vector index on any
  change to the fingerprint it derives from `embedding.model`, including a pure
  config rename that still resolves to the same underlying model (for example a
  gateway prefixing `provider/model` onto an unchanged server). On a mismatch,
  `akm index` now re-embeds a small sample of already-stored entries and keeps
  the index when either the endpoint's reported model identity matches what it
  reported last time, or the median cosine similarity between stored and freshly
  re-embedded vectors is at least 0.999; otherwise it purges and rebuilds as
  before, logging why. A genuine dimension change bypasses this check entirely
  and still rebuilds unconditionally.
- **A canary that cannot reach the embedding endpoint leaves the index untouched
  instead of purging it (#955).** When the fingerprint-rename canary's re-embed
  attempt fails outright, `akm index` keeps the existing vectors and the old
  fingerprint and reports the run as `unverifiable`, rather than destroying a
  working index because the server happened to be down. The next `akm index` run
  retries the canary once the endpoint is reachable again.
- **A purge now writes the new fingerprint before any embedding request, so an
  interrupted rebuild resumes instead of restarting from zero (#955).**
  Previously the fingerprint was only written at the very end of a successful
  embedding pass, so an interruption partway through a fingerprint-triggered
  rebuild left the old fingerprint in place — the next `akm index` saw the same
  mismatch and purged again, discarding whatever had already been re-embedded.
  The new fingerprint (and the observed identity) are now written in the same
  transaction as the purge, before any vectors are requested; a restart then sees
  a matching fingerprint and only re-embeds the entries still missing a vector.
- **`akm index --full` and an index-generation bump no longer re-embed
  unchanged content (#955).** A full rebuild deleted every embedding
  unconditionally and re-inserted entries under new ids, and the v22→v23
  generation bump did the same on first open under a new binary — both
  forced a full re-embed of the whole corpus even when nothing changed, the
  likely cause of the multi-hour post-upgrade run reported against 0.9.14.
  Vectors about to be discarded are now copied into a transient
  `embedding_salvage` table (keyed by a hash of `search_text` plus the
  fingerprint they were generated under) in the same transaction as the
  discard — read back in bounded chunks rather than loaded wholesale, so a
  large corpus does not spike memory, and a run with nothing to reuse costs
  a single indexed lookup — and handed back to unchanged entries at the
  start of the next embedding pass with zero provider calls — a progress
  line reports the split (`Reused N embeddings from the previous
  generation; embedding M new.`). Content that changed by even one byte, or
  a fingerprint that no longer matches, still goes through the provider
  normally. `akm index --reembed` and a canary "rebuild" verdict purge the
  salvage table along with the stored embeddings; a canary "keep" verdict (a
  fingerprint-string rename resolving to the same model) relabels it instead
  so it stays reusable. An interrupted pass leaves the table intact for the
  next attempt.
- **A write-path index update (`akm remember`, `akm import`, `akm proposal
  accept`, `akm source clone`, extract session assets) never contends with a full
  rebuild in progress; it skips and lets the rebuild heal the entry instead
  (#956).** These commands make a just-written asset searchable immediately via a
  targeted index upsert that opens `index.db` under a 5-second busy timeout — far
  shorter than a full rebuild's single transaction. It now checks the new rebuild
  lock first: a live holder means the upsert and embedding are skipped outright
  (one log line naming the pid and the file that will be indexed by the next
  pass), and every caller — including `akm proposal accept`, which used to report
  a spurious "index finalization failed" — treats the skip as success, since the
  file write itself already completed. A rebuild lock left by a dead process is
  not treated as held here — reclaiming it stays `akm index`'s job.
- **A blocked `akm remember` (and other synchronous asset-mutation-lease writers)
  now prints a wait notice instead of hanging silently for up to ten minutes
  (#956).** The sync lease boundary (`withAssetMutationLeaseSync`) had no
  progress feedback at all; a contended lease looked identical to a hang until it
  either acquired or timed out. It now logs `waiting for <holder purpose> (pid N,
  started T) — Ns` every 15 seconds, naming who actually holds the lease — the
  same cadence the async path's `onWait` hook already had, but wired to an actual
  warning since nothing called that hook. The 10-minute wait bound is unchanged;
  this only makes an existing wait visible.
- **`akm health`'s `active-improve-strategy` check fails, not warns, when the
  active strategy's LLM-backed work would be a total no-op (#957).** Previously
  this check stayed `warn` regardless of how many of the strategy's enabled
  processes were unavailable, so a nightly `improve` job that could not run a
  single LLM-backed process still reported the same severity as one with a single
  missing credential and several working ones. It now escalates to `fail`
  specifically when every enabled `capability: "llm"` process in the strategy is
  unavailable; a partial failure with at least one working process stays `warn`.
  The check is also a direct projection of the same credential-aware plan
  `improve` itself now builds (see Added, above), rather than a separate
  re-derivation that could disagree with what a real run in the same environment
  would do.
- **A failed embedding batch and `akm index`'s progress are visible without
  `--verbose` (#954).** A failed provider batch used to log only under
  `--verbose`; it now logs at the default `warn` level, naming the batch size
  and reason. `akm index`'s `Embedded N/M entries.` line now fires after every
  committed batch instead of every 500 stored entries, and the heartbeat names
  the failed count too. In non-verbose JSON/yaml output mode, phase-start
  messages and the heartbeat now reach stderr (via `info()`); text mode keeps
  its spinner instead, and `--verbose` is unchanged. A silently grinding,
  hours-long `akm index` run against a dead provider — with no output until
  one aggregate warning at the very end — was the field report this fixes.
  Source-cache hydration (which runs before `index.db` is even opened) now
  reports its own progress the same way: `Hydrating source i/n: <name>` per
  source, plus a 15s heartbeat while a sync is in flight.

### Fixed

- **Starting a workflow ref that already has an active run in a different scope
  now warns instead of silently duplicating it (#942).** `akm workflow run
  <ref>`'s per-scope concurrency guard is unchanged by design — two unrelated
  projects sharing one `state.db` can still run the same-named workflow
  independently — but before starting a new run it now also checks for an active
  run of the same ref in any OTHER scope and, if one exists, warns with that
  run's id, scope, and start time, plus the same `akm workflow run <id>` / `akm
  workflow abandon <id>` remedy. The existing "already active" guard errors now
  also name the blocking run's scope, not just its id. `akm workflow
  status`/`resume`/`abandon <run-id>` already worked from any scope (#919) and
  are unchanged.
- **`akm workflow status <ref>` names the scope it searched when nothing is found
  there (#942).** When the ref lookup finds no runs in the current scope and
  `--all-scopes` was not passed, the not-found error now names the scope that was
  searched and suggests retrying with `--all-scopes`, instead of a bare "no runs
  found."
- **Concurrent akm commands writing `state.db` no longer crash with a bare
  "database is locked" (#948).** An unrelated `akm improve` run, `akm workflow
  run`, or scheduled task writing `state.db` at the same time used to exhaust the
  write retry window and throw the raw SQLite driver error, surfacing as
  `{"ok":false,"error":"database is locked"}` at exit 70 (internal/unclassified)
  instead of a retryable failure. On exhaustion the error is now reclassified
  into a `TransientError` with a dedicated `STATE_DB_CONTENDED` code (exit 75),
  modelled on `RUN_LEASE_HELD`'s precedent (#924), with the original driver text
  preserved as `cause`; a genuinely unrelated error (real corruption, a
  body-thrown failure) is never reclassified and still surfaces as itself. The
  improve run's own `improve_runs` ledger writes, previously bare
  single-statement writes with no retry, now go through the same retry path.
- **`akm show env/<name>` lists key names in plain-text output (#951).** The
  plain-text `show` renderer never read the response's `keys` field, so the
  default (non-`--format json`) output for an env asset gave no way to audit
  which keys a script depends on; `--format json` already carried them correctly.
- **The cron scheduler backend truncates its raw per-task log instead of
  appending forever (#951).** The crontab entry installed for each task
  redirected stdout/stderr with `>>` (append), so the log file grew without
  bound; it is only a bootstrap safety net, since akm's own per-run log already
  separates runs and keeps history in `logs.db`, so the redirect now truncates
  (`>`) and the file holds exactly the latest run's raw output. An
  already-installed `>>` row still parses correctly. `launchd`'s equivalent log
  path is OS-managed append-only with no truncate mode, so it is left unchanged —
  a wrapper-script rewrite is not justified by evidence that was Linux-only.
- **Removed the false `akm curate --rerank` / "curate reranks by intent" claims
  from the docs and the `curate` command's own description (#951).** `akm curate`
  never implemented reranking; a rerank engine kind is deferred to its own issue,
  and the referenced Discord health-report embed script is outside this
  repository.
- **Reflect no longer treats feedback lines as verified facts to insert into the
  rewrite (#952).** A harness run against the reflect prompt on two model quants
  showed the model inventing whole new sections — fabricated incident dates,
  ports, disk layouts — whenever a feedback line asserted a claim the source
  asset never made. Feedback is now framed as a signal to investigate, not a fact
  to insert, and missing information gets a `TODO: verify …` placeholder instead
  of an invented answer.
- **A leaked content-truncation marker can no longer end up in a proposal body
  (#952).** Asset content over the active budget is capped with a marker the
  model is told never to echo back; when a model echoes it anyway, the proposal
  is now deferred for human review (`reflect-truncation-leak`) instead of
  shipping silently. As a second layer, `proposal accept` — including drain
  promotion — now rejects any reflect-sourced proposal whose body still contains
  the marker, since a truncated body silently replacing a full asset is data
  loss; re-run reflect on the ref to clear it.
- **`secret://<name>` engine credentials now resolve on the `akm improve` /
  agent-dispatch and health-probe paths (#953).** 0.9.13's #917 CHANGELOG entry
  claimed engine credentials could resolve from the secret store, but that was
  only ever true for direct LLM calls (`llm/client.ts`) and, after a same-week
  follow-up fix, embedding calls — `engine-resolution.ts`, the sole path `akm
  improve`, workflow LLM steps, and `akm health`'s engine probes use, still threw
  `Engine "<name>" has an invalid symbolic apiKey reference.` for any `secret://`
  value and aborted the run. `secret://<name>` now resolves through the same
  store lookup as those other call sites, deferred to actual dispatch so frozen
  plans stay secret-free, and `akm health`'s credential check now probes the
  store instead of reporting a `secret://`-backed engine as available
  unconditionally.
- **An unset or empty `$VAR` referenced by an engine's `apiKey` now warns once,
  naming the variable (#953).** Previously it silently sent an empty
  `Authorization` header instead of surfacing the misconfiguration.
- **`akm bundle update` now commits its embedding pass durably instead of
  nesting it inside its own transaction (#954).** Its coordinator called
  `akm index` for its embedding phase too, INSIDE the same unified
  `BEGIN IMMEDIATE` that covers content/lock/index/state — so every per-batch
  commit (above) nested as an unobservable SAVEPOINT, and a SIGKILL mid-run
  lost every embedding of the run rather than just the one in flight.
  0.9.15-beta.1 shipped claiming per-batch commits held on this path; the
  final release makes it true: `generateEmbeddingsForDb` now refuses to run
  against a connection that already has a transaction open (an internal
  contract error, not a user-facing one), and `akm bundle update` runs its
  embedding phase on a fresh connection AFTER its own commit instead. A
  failing post-commit pass (provider down) still leaves the update itself
  successful — content, lock, and index generation are already durably
  committed — with the response's `index.semanticStatus` (new field) the
  only sign semantic search fell behind (`"blocked"`), exactly like a plain
  `akm index` run today.
- **A batch rejected by llama.cpp for exceeding its physical batch size is now
  recognized as a context-size rejection (#954).** llama.cpp reports this as
  an HTTP 500 with a body like "input is too large to process. increase the
  physical batch size", which the existing context-size pattern
  (`exceed_context_size_error`, "context size", …) did not match, so the
  whole batch was dropped instead of being split and retried like a 413.
- **A `kill <launcher-pid>` no longer orphans the running `akm` process
  (#956).** The published launcher (`scripts/node-runtime/akm`/
  `akm-migrate`) now forwards SIGTERM/SIGINT/SIGHUP to its bun/node child
  and exits alongside it, instead of leaving the child running — one field
  report found 40 orphaned `bun …/dist/cli.js` processes in a single day,
  some hours old, still hammering the embedding endpoint and holding the
  rebuild lock. Every command also polls for reparenting (a launcher that
  dies without delivering a signal — SIGKILL, an out-of-memory kill) and
  re-raises SIGTERM on itself the moment it notices, reusing the same abort
  path a real signal already takes. Lock messages ("another index run is
  active...", "akm improve is already running...") and `akm index
  --skip-if-locked`'s JSON result now name the launcher pid alongside the
  pid that actually holds the lock — `pid 4242 (launcher 4240)` — since
  every process listing and task log shows the launcher pid, not the
  child's.
- **An index run interrupted before its first embedding pass ever completes
  could force an unnecessary full re-embed on the next `akm index --full`
  (#956).** A fingerprint-rename rebuild already wrote `embeddingFingerprint`
  immediately, before any provider call, so an interruption right after that
  decision still left a consistent record — but the common
  first-pass/unchanged-fingerprint path deferred that write to a fully
  successful run. A per-batch commit is durable the instant it lands
  regardless, so an interrupted first-ever pass left real, already-embedded
  vectors with no recorded fingerprint to tag them by, and a later full
  rebuild's salvage-before-discard step (#955, above) treated the missing
  fingerprint as "nothing was ever verified" and re-embedded everything
  instead of reusing them. A plain `akm index` resume after an interruption
  now embeds only the entries still missing a vector, with no purge and no
  canary.

## [0.9.14] - 2026-09-04

### Added

- **Long Markdown bodies can return the matching lexical fragment (#937).**
  The derived index now keeps a separate, safe fragment population for lexical
  retrieval. Search can return an addressable `#akm-fragment-…` ref, and `akm
  show` resolves that ref to the exact indexed projection. Headingless and
  oversized documents split at paragraph or word boundaries, so a fact in the
  middle of a long body is no longer represented only by its parent document.

### Changed

- **Index generations are checked before use (#934).** A newer index is never
  queried or rebuilt by an older binary; it reports that akm must be upgraded.
  An older derived index is rebuilt from the materialized sources by the current
  binary. A current-generation stamp is accepted only when the canonical entry,
  parent FTS, and fragment surfaces all match, and the stamp is written only
  after schema creation succeeds. This release advances the derived index from
  v22 to v23 for fragment retrieval.
- **Lexical relevance remains stable through scoring and relaxed-query ties
  (#933, #940).** Lexical scores use a fixed monotone calibration rather than a
  result-set-relative scale, preserving score headroom. Relaxed matches retain
  body relevance as tie evidence, including when a belief-state ceiling also
  applies. This compound-safe implementation supersedes PR #941.
- **The frozen W0 lexical weight matrix remains the shipped policy (#930).**
  The W1 and W2 alternatives were measured and rejected; no unvalidated weight
  change is included in this release.

### Fixed

- **Fuzzy name matches require structural identity.** Short or opaque name
  fragments no longer create a false identity match merely because their text
  overlaps a stored name.
- **Full indexing honors canonical workflow-source ownership.** When peer `.md`
  and `.yml` sources map to one workflow ref, the index now persists the same
  deterministic `.md` winner used by lookup and execution instead of allowing
  filesystem enumeration order to select the stored row.

## [0.9.13] - 2026-09-04

### Added

- **A stable `results` alias on every list-returning command (#922).** `search`,
  `curate`, `proposal list`, `bundle list`, `env list`, `secret list`,
  `registry search`, `registry list`, `workflow list`, `task history` and
  `log list` each keep their existing semantic key (`hits`, `items`,
  `proposals`, …) and now also expose the same array as `results`, in every
  shape including `--shape agent`. It is the same array, not a copy. A caller
  reading `hits` from a `curate` response previously got nothing back and could
  reasonably read that as "no results" — there was no error and the `summary`
  alongside it still reported that results were selected. Commands carrying
  several heterogeneous collections (`health`, `task doctor`) are deliberately
  excluded.
- **Engine and embedding credentials can resolve from the secret store
  (#917).** `apiKey` accepts `secret://<name>` alongside `$VAR` / `${VAR}`,
  resolved through the existing store-backed resolver. A detached SessionEnd
  hook or a cron job — the two contexts least able to supply an environment
  variable and most likely to need extraction — no longer requires editing the
  login environment for a value akm already stores. Literal keys in
  `config.json` are still refused, and an unresolvable reference fails loudly,
  naming the reference and never the secret.
- **`akm proposal drain` reports what failed (#921).** The envelope carries a
  `failed[]` naming each proposal and why it was refused (stale target,
  validation), instead of reporting `failed: 0` while the same run printed five
  failures to stderr. `--dry-run` now applies the same stale-target check the
  real run does, so its prediction stops disagreeing with the outcome. The
  refusals themselves are correct and unchanged: declining to overwrite a target
  modified since the proposal was created is the desired behaviour. `akm
  improve`'s triage pre-pass reports the same count.
- **Workflow step output is checked against its declared schema (#923).** A step
  whose returned object does not match its `outputSchema` now says so, naming
  the step and the specific problem (a missing required field, say). This is a
  warning: the run continues and its status is unchanged, because a workflow is
  a guide rather than a contract. Previously an author got neither enforcement
  nor feedback — the only signal was a notice saying akm was not checking, which
  is a different fact from whether the output matched.

### Changed

- **A held run lease no longer reports as database corruption (#924).** `akm
  workflow run` surfaced raw SQLite text — `database is locked`, `database disk
  image is malformed`, `disk I/O error` — for what was simply another
  invocation holding the lease. `disk image is malformed` in particular reads as
  data loss and sent one reporter through integrity checks and a WAL review
  before finding the real cause. The lease message now appears at default
  verbosity and carries a dedicated `RUN_LEASE_HELD` code, so a wrapper can tell
  "retry shortly" from "you passed bad input". Genuine SQLite errors still
  report as themselves.
- **`akm lint` stops flagging templated output paths (#927).** A documented
  run-time filename such as `reports/review-<timestamp>.md` is no longer
  reported as a `stale-path` broken reference. Angle-bracket and brace
  placeholders, `${VAR}`, date-format runs like `YYYYMMDD`, and glob characters
  are all recognised as parameterised rather than missing. Genuinely broken
  literal paths are still reported.
- **The workflow level-2 heading rule is discoverable before you trip it
  (#926).** The `workflow create` template states that `##` headings are step
  ids and points at `###` for cross-cutting notes, and the compiler's rejection
  now carries the remedy rather than only the diagnosis.

## [0.9.12] - 2026-09-03

### Added

- **`akm health` probes LLM engine reachability (#914).** `default-llm-engine`
  and `configured-engines` now send one bounded `GET` to the endpoint's
  `/models` route (3 s timeout, one probe per distinct endpoint per
  invocation, no cross-run cache) instead of only checking that a credential is
  present. Any HTTP response counts as reachable, so a cold local server is
  never asked to load a model just to be checked. An unreachable default LLM engine is a hard `fail` naming the
  connection error; an unreachable non-default engine is a `warn`. Pass
  `--no-probe` on an offline or air-gapped host to keep the credential-only
  verdict; the message then says reachability was not probed.
- **`akm proposal extract` reports the engine it resolved (#913).** The
  envelope carries `engine` and `engineKind` (`llm`, `sdk`, or `agent`), every
  `sessions[]` entry carries `engine`, and the `extract_sessions_seen` ledger
  metadata records it, so "which engine did that run actually use" is one
  field instead of config archaeology. `akm health`'s `active-improve-strategy`
  check names the engine each improve process resolved to, which makes a
  strategy-level `engine` pin that shadows `defaults.llmEngine` visible.
- **`akm workflow run <ref>` says when it resumes, and `--new` starts fresh
  (#919).** Resolving a ref to an already-active run in the current scope is
  unchanged, but the `workflow-run` envelope now carries `resumed: true` and
  the text output leads with `resuming existing run <id> for <ref>; pass --new
  to start a fresh run`. `--new` starts a second run and leaves the active one
  untouched. `status`, `abandon`, `resume`, and `run <id>` all accept a unique
  run-id prefix of eight or more characters.

### Changed

- **A run that skipped every session for an infrastructure reason is visible
  in the extract envelope (#912).** `warnings[]` gains one aggregate line per
  infrastructure skip reason (`llm_unavailable`, `read_failed`, `exception`,
  `locked_concurrent`), for example `25 of 25 sessions skipped: llm_unavailable
  (engine "default")`, and a `skipReasons` count map is present whenever
  `sessionsSkipped > 0`. `ok` keeps meaning "the command ran" and the exit code
  does not change; that meaning is now written down on the type.
- **`akm health`'s `session-extraction` check reads the extraction ledger
  (#914).** It used to read only `improve_runs`, which the hook-driven
  `akm proposal extract --session-id` never writes, so a plugin-driven machine
  reported "not active" as `pass` forever. It now derives its verdict from the
  last seven days of `extract_sessions_seen`: `unknown` when nothing was
  recorded, `warn` naming the reason and engine when every session was skipped
  or failed for an infrastructure reason (`llm_unavailable`, `read_failed`,
  `exception`, `locked_concurrent`), otherwise `pass` with per-outcome counts.
- **Every passthrough success envelope carries `ok: true` (#918).**
  `akm config set` and `akm config unset` printed the resulting config with no
  `ok` field while their failure envelope had `ok: false`, so a caller
  branching on `.ok` read success as failure. The shared passthrough stamp now
  adds `ok: true` when a result has no `ok` of its own; commands whose exit
  code grades the outcome (`task sync`, `task sync --dry-run`, `task prune`,
  `workflow run`, `upgrade`, and the `migrate` subcommands) set `ok` and the
  exit code from the same value, so the two cannot disagree. `--silent` still
  prints nothing.
- **The unsupported-plan error names the real situation (#919).** A frozen
  workflow plan with an `irVersion` above the current one no longer reports
  "pre-irVersion-5 ... after the 0.9.2 upgrade"; it says the plan was probably
  written by a newer akm. The reported `irVersion 111` did not reproduce
  against this tree (the column is only ever written as `5` and no path
  rewrites it on a source edit); a regression test pins that editing a
  workflow source leaves its in-flight run executable.

### Fixed

- **`akm proposal accept` no longer rewrites your content.** Two "repairs" ran
  before validation: one deleted every body line matching `description:` or
  `when_to_use:`, the other deleted every `---` in a body that had
  frontmatter. Both fired inside fenced code blocks, so any asset documenting
  frontmatter — a note about akm, Claude Code skills, Jekyll, Hugo — was
  silently gutted on accept, and the rewritten bytes were saved back over the
  original in the proposals database. Nothing was printed. Both repairs are
  gone; the truncated-description repair, which only ever rewrote a
  frontmatter value, stays.
- **Prose-quality findings no longer block `proposal accept`.** A description
  that read like a heading, an odd number of backticks, or a reflect revision
  outside the size ratio refused the promotion and told the user to "fix the
  proposal payload and try again" — but there is no `akm proposal edit` and
  `accept` has no `--force`, so the only way out was hand-editing the
  proposals database. These findings are now reported as warnings on a
  command a human typed. Structural defects that genuinely cannot be written
  (empty content, an unparseable ref, malformed frontmatter, a broken
  workflow shape) still block.
- **akm no longer refuses to open a state database migrated by a newer akm.**
  Two akm versions sharing one data directory is a supported deployment — a
  bundled CLI beside a newer global install — and the old binary was bricked
  for every command that touches `state.db`, not degraded. It protected
  nothing: an older binary's entire migration registry is already applied, so
  it has no pending migration to run. It now opens, warns once naming the
  migrations it does not know, and reads and writes the tables it knows. A
  ledger that genuinely diverges (a migration this akm has was never applied
  and something else was applied in its place) is still refused.
- **`akm agent --prompt` no longer rejects prose that looks like a template.**
  A prompt was validated as if it were a portable command template, so any
  prompt containing `}}` from compact JSON, a `$VAR`, a `${...}`, a `$(...)`
  shell snippet, an `@path`, or a `` !` `` was rejected with "unsupported
  portable template construct" before the agent started. akm substitutes
  nothing into a prompt, so it is now sent verbatim. The template language is
  unchanged for stored command files, which are templates.

- **The 0.9.2 `claude-code` -> `claude` harness rename left the ledgers split
  (#915).** State migration `027-extract-sessions-seen-harness-rename` moves
  `extract_sessions_seen` and `workflow_runs.agent_harness` rows off the old
  key, keeping a session already recorded under `claude` as the authoritative
  row, and empties the old key space. `PERSISTED_HARNESS_IDS` in the harness
  registry is now pinned by a test so the next rename cannot ship without a
  migration. Scripts querying the ledger by `claude-code` will find it empty
  after upgrade; see the 0.9.1 -> 0.9.2 migration guide.

### Changed — refusals that now degrade

A repo-wide audit reviewed every defensive refusal in the codebase against
three tests: has it demonstrably helped a real user, does its failure mode cost
less than the hazard it guards, and is the hazard already gated behind a
deliberate human command. Refusals that failed those tests were removed or
downgraded to a warning, in that order of preference. Machinery that prevents
data loss or corruption — atomic writes, backups, write-path validation, path
containment — was explicitly out of scope and is unchanged.

The user-visible effect is that akm stops aborting on conditions it can
survive. Highlights:

- **Config load no longer bricks every command over one bad key.** Retired
  vocabulary (`profiles`, `llm`, `agent`, `features`, `stashes`,
  `modelAliases`, `bindings`, top-level `writable`) warns and passes through,
  and the pre-`bundles` `stashDir`/`sources[]`/`installed[]` shape folds into
  the current shape in memory. An unknown `config set` key warns and stores.
- **A newer or unfamiliar state.db migration ledger no longer refuses to
  open.** A ledger carrying migrations this binary does not know warns once and
  degrades; only a genuinely inconsistent ledger still aborts. This is what let
  a bundled older akm keep working against a newer host's data directory.
  A `plan_ir_version` of NULL (a row predating the column) decodes normally.
- **Free text is no longer validated as code.** `akm agent` accepts prompts
  containing `{{`/`}}`; inline workflow `akm/command` content and portable
  command templates accept `$HOME`, `@file`, `${...}` and the rest as the prose
  they are. Only `$ARGUMENTS[N]`, which merely looks like the one placeholder
  akm expands, still warns.
- **Version skew stops being treated as corruption.** A newer index is left
  alone rather than wiped, a stale indexed workflow identity falls back, and
  frozen-plan spine drift from a formatting change between releases warns
  instead of marking every in-flight run corrupt.
- **Deliberate commands stop being second-guessed.** `--since` bypasses
  `extract`'s per-run cap the way `--force` already did; `workflow create
  --force` no longer also demands `--reset`; scheduler writes, `setup --dir`
  and `bundle create --dir` under transient paths warn instead of refusing.
- **Symlinks are followed on read paths** (task sources, `models.json`, stash
  meta, `akm.include` entries) with realpath containment doing the actual
  safety work, rather than being refused outright.
- **Blocks that had no escape hatch got one, or got removed.** `env run` gained
  `--allow-insecure` for the third-party dangerous-key block that previously
  had no bypass; `registry add` accepts a credentialed URL with a warning that
  redacts the credential; promotion lint findings on `proposal accept` report
  instead of blocking, since there is no `proposal edit` and no `accept
  --force` to work around them.
- **Limits that bounded nothing real were deleted.** Workflow plan and embedded
  child-plan byte caps, step-evidence tombstoning, search-text truncation, and
  the JSON-schema node budget are gone; the akm.lock acquisition budget went
  from 300 ms to ~30 s with backoff and a "waiting for another akm process"
  notice.
- **A cron line too long for vixie-cron now spills into a wrapper script**
  instead of refusing the install. The length limit stays, because a truncated
  cron line would execute a partial command.

Guards that passed the three tests were kept and documented, including the
registry-URL credential inspection limit, the third-party dangerous-key block
itself, `MAX_SCHTASKS_TRIGGERS`, and every path-containment check.

## [0.9.11] - 2026-09-03

### Added

- **`akm task validate <path>` reports what `akm task sync` would say about one
  task file (#907).** It parses a single file by filesystem path, without a
  bundle, a concept ref, or a configured engine, and reports `valid`,
  `converts` (a v2/v3 source the migrator converts deterministically),
  `blocked` (needs a human decision), `invalid`, or `not-a-task`, with the
  reason sync would give. It runs the same two gates sync runs before
  installing a schedule, the defaults-applied schedule input contract and
  the cron dialect check, which are now shared with `compileTaskSources` so
  the two commands cannot drift. Exit 0 for valid/converts, 1 for the rest,
  2 for a missing or unreadable path. `resolved` on success is the compiled
  task shape (id, version, target, inputs, schedule), never an
  execution-lowered plan.
- **`engines.<name>.apiKeyFile` supplies an LLM engine credential from a file
  (#905).** A host that refuses secrets in the process environment can point
  an engine at a path instead of a `$VAR` reference: `~` expands, one
  trailing newline is trimmed, the file is read only at dispatch, and a
  missing or empty file is a config error naming the engine and path but
  never the value. Setting both `apiKey` and `apiKeyFile` is rejected;
  setting neither still falls through to the implicit
  `AKM_ENGINE_<NAME>_API_KEY` convention. The value is redacted from
  dispatch output the same way an env-backed credential is, and `akm health`
  checks the file is present and non-empty.

### Changed

- **`akm improve`'s machine-local writers moved out of `$STASH/.akm` into
  `$STATE` and `$CACHE` (#890).** `distill-rejected/`, `eval-cases/`,
  `measurement/verdicts/`, the synthetic `unresolved-sources/` placeholder,
  and the improve-pipeline lock files never met the "must travel with the
  content" rule; they now live under `$STATE/improve/…/<stash>/`,
  `$CACHE/index/unresolved-sources/<stash>/`, and `$STATE/locks/<stash>/`,
  namespaced by a short hash of the resolved stash path. `akm migrate
  status` and `apply` gain a relocation step that covers the default stash
  and every other filesystem-backed bundle (remote sources are skipped
  without a network call), moves files by rename or copy-then-delete, and
  deletes an old lock only when the same staleness check `akm improve` uses
  says its holder is dead; a live lock is left in place and reported. The
  step is idempotent and `--dry-run` moves nothing. Scripts that read the
  old paths should switch to the new locations named in
  `docs/architecture/internals/storage-locations.md`.

### Fixed

- **The dead-link check states its coverage and no longer lies about it
  (#892).** `akm improve`'s post-loop check scanned at most ten knowledge
  refs and fired every HEAD request at once with no timeout. It now scans
  every actionable ref, checks at a bounded concurrency, bounds each request
  at five seconds and reports a timeout as a dead entry, and counts a DNS or
  connection failure as skipped rather than as dead or as fine. The result
  carries `checked`, `total`, and `skipped`, threaded into the improve
  result, the `improve_completed` event, and `akm health`'s improve summary.
  The other constants the issue names (`MAX_URLS`, the per-entry slice,
  `MAX_BODY_CHARS`, the duplicated `MAX_CONTENT_CHARS`) were already removed
  in 0.9.8, and the curate score floors only decide whether a second search
  pass runs; they never filter returned results.

## [0.9.10] - 2026-09-02

### Fixed

- **`akm task history <id>` now filters to that task instead of silently
  ignoring the positional id (#911).** `task run <id>` and `task explain <ref>`
  take the id positionally, so `task history <id>` was the natural thing to
  write, and it answered with every task's newest rows while exiting 0. A
  positional id now means the same as `--id`; passing both with different
  values is a usage error (exit 2) rather than a silent pick.

## [0.9.9] - 2026-09-02

### Changed

- **`akm-migrate` is the one migration tool, and `akm upgrade` runs it**
  (#895 follow-up, #901). The standalone `akm-migrate` executable now runs
  every migration step in one plan — the legacy config `extraParams` lift,
  pending `state.db` migrations (historical-destructive ones included, with
  the verified safety copy), task v2 → v3, task v3 → task source v4, and the
  residue sweeps — as `akm-migrate status` / `apply [--dry-run]`; its
  per-generation verbs (`task-v4-status`, `task-v4-apply`) are gone.
  `akm migrate status|apply` is now a thin wrapper over that executable, and
  every historical shape (`scripts/akm-migrate/`) lives outside the CLI
  proper. `akm upgrade` runs `akm-migrate apply` **after** its install step —
  the migrator that shipped with whatever is now installed — on every run,
  install or no install, and reports the plan under `migration`; a blocked or
  failed migration exits 1. A package-manager install that fails (EACCES on a
  root-owned global directory) still runs the migrator and says so. An akm
  installed as a dependency of another package is now detected
  (`installMethod: "package-local"`) and never reinstalled — an
  `npm install -g` there "succeeded" while the parent kept executing its own
  copy — but its migrations still run. `akm upgrade --state-only` and the
  `stateUpgrade` response field are removed; `akm migrate apply` is the
  offline path. An ordinary managed open still refuses a historical-
  destructive migration, and its message names these two commands.
  A container that ships akm can put `akm upgrade` (or `akm migrate apply`)
  in its entrypoint: on a current installation it is a no-op.

### Fixed

- **`akm task sync` reports failed sources under `failures` on both the live
  and `--dry-run` shapes** (#906). Live sync used to report them under
  `failed` while `--dry-run` already used `failures`. No alias; both paths
  now agree.
- **`akm task sync` no longer misdiagnoses a supercronic-managed container as
  missing the `crontab` binary** (#910). `crontab -l` exiting non-zero with
  no output, or with stderr saying "no crontab", is cron's own way of saying
  "empty crontab" (BSD's `no crontab for <user>`, or a PATH shim like
  OpenPalm's before any spool exists). Only a spawn that cannot find the
  binary (ENOENT) is reported as missing; any other failure is reported as
  what it said.
- **`akm task sync --rebind` no longer warns on every run of an image-baked
  install** (#868 residue). The warning about binding scheduled tasks to a
  mutable, unproven binary fires only when a rebind actually changes an
  entry's bound invocation.
- **A mixed-layout bundle no longer auto-detects as a narrow tool-dir adapter
  and silently drops the rest** (#908). A root that a tool-dir-shaped adapter
  (`agent-skills`, `claude`, `opencode`) claims but that also carries ordinary
  akm content detects as `akm`, the superset. `akm bundle list` now reports
  each component's effective `adapter` and whether it was `detected`, and
  indexing under an explicitly narrow adapter warns once with the count of
  files and directories it skipped.
- **An unrecognised `components.*.adapter` is rejected** (#909) with
  `INVALID_CONFIG_FILE` listing the accepted names instead of silently
  falling back to `akm`. `akm bundle add --adapter <name>` overrides
  auto-detection for a local directory; its `--help` lists the registry.

## [0.9.8] - 2026-09-02

A cleanup and stabilization release: deletion of machinery that policed the
codebase's shape rather than its behaviour, and — because auditing for that
machinery meant reading the code closely — a run of real defects it had been
sitting on top of. Two security holes, two search-correctness bugs, a
locale-dependent hash, a deletion shield that failed open, and sixteen places
that answered a failure with a confident wrong answer instead of an error.

Then a second round, from verifying the release against a real 23,865-entry
environment: a no-op incremental index costing ~21 CPU-minutes, legacy proposal
rows that could not be repaired, an npm probe spawning on every scheduler tick,
a blocked task migration that named no remedy, and a data directory that could
reach 74 GB with nothing reporting it.

> **Upgrading is one-way for `state.db`.** This release adds two migrations,
> `025-task-history-vocabulary-backfill` and
> `026-proposals-strip-legacy-fragment-refs`. Once any 0.9.8 command opens
> `state.db`, its ledger contains IDs that 0.9.7 does not know, and 0.9.7
> refuses to open it: `Refusing to open a database with a newer migration
> ledger: unknown migration ID 025-task-history-vocabulary-backfill`.
>
> The refusal is deliberate — an older binary must not write a database whose
> schema it cannot reason about — but the practical effect is that
> **downgrading to 0.9.7 requires restoring a `state.db` backup.** Commands
> that only read the derived index (`akm info`, `akm search`) keep working on
> 0.9.7; everything that touches `state.db` (`akm health`, `akm task`,
> `akm improve`, proposals) does not.
>
> Snapshot `state.db` before upgrading if you may need to go back:
>
> ```sh
> akm info --format json    # confirm your data dir
> sqlite3 "$DATA_DIR/state.db" "VACUUM INTO 'state.db.pre-0.9.8.bak'"
> ```

> **`index.db` rescans once.** The per-directory freshness fingerprint changed
> shape, so the first `akm index` after upgrading re-reads every directory and
> then returns to the fast path. Nothing is lost; the index is derived.

### Added

- **`akm health` reports data-dir disk usage** (#896). A `data-dir-usage`
  advisory sums the data directory with a stat-only walk and warns when it is
  more than 3× the three live databases (state.db, index.db, logs.db) or when
  one top-level subdirectory holds more than half of it, naming that
  subdirectory with its size and share (for example `backups/ is 70G (94% of
  data dir)`). The walk stops after 100,000 entries and says so. Silent when
  nothing looks wrong.

### Changed

- **`akm workflow plan` returns JSON by default**, like every other command
  (#903). It was the one verb whose unmarked default was a human summary. That
  exception cost a bespoke branch which could not reliably distinguish "no
  format named" from "`--format json` named globally before the subcommand" —
  citty parses each command level against its own argv, so the leaf read
  `undefined` in both cases. Working around that meant reading the invocation
  singleton, folding in a persisted `output.format`, and finally leaving a
  resolved `"json"` on the text branch because it was indistinguishable from
  "nothing configured" — which meant an explicit `--format json` silently did
  nothing for anyone whose config already resolved to json. Deleted, along with
  ~60 lines of comment justifying it. `--format text` still renders the same
  summary through the same formatter; it is simply no longer the default.


- **Search no longer truncates long queries (#892).** `MAX_LEXICAL_QUERY_TOKENS
  = 16` silently dropped every token past the sixteenth, and tokens are
  collected in order, so the discarded half was the tail — for
  natural-language input, usually where the discriminating words are. It also
  fed ranking, so token-overlap scoring ran on the truncated set too. It was
  unexplained in the code and in the commit that introduced it, and unreachable
  from any flag, config key, or environment variable. Removed: the planner
  handles 10,000 tokens in 9ms, so no performance cliff was being protected.

- **Content and memory bodies are no longer silently truncated.**
  `MAX_CONTENT_CHARS` (100k, duplicated across 8 adapters) cut indexed content
  so the tail of a long document was unsearchable; `MAX_BODY_CHARS` (4000) cut
  the text sent for memory inference, so on a large-context engine the model
  saw a fraction of the input while the derived memory looked complete. Both
  removed.

- **GitHub Actions are pinned to commit SHAs (#768).** All 29 `uses:` steps
  across every workflow, with the tag preserved in a trailing comment.

- **Gated CI runs on schedule, dispatch, and candidate tags only.** The
  `detect-changes` job that selected suites by regex-matching a PR diff is
  gone — its path patterns had gone stale and still named test files this
  release moved or deleted, so it was silently under-selecting suites. Release
  evidence is unchanged; the checklist always required an exact-SHA dispatch.

- **`akm-eval` in CI is now a determinism check only.** Its score gates are
  removed. Measured before cutting: the baseline scored a perfect 1.0 against
  a 0.75 gate, and seven of nine case types never ran — CI has no LLM and no
  run history, so everything the eval exists to measure was skipped while the
  job reported green. The harness itself is unchanged and remains a genuine
  quality signal when run against a real bundle.

### Fixed

- **Historical state migrations are reachable where akm cannot reinstall
  itself** (#895). A migration flagged `historical-destructive` is refused
  during an ordinary open — it needs a verified safety copy, taken under the
  migration writer lock, so an unattended `akm index` can never quietly drop
  operator state. That guard is correct and unchanged. Its *remedy* was not:
  the only code path that admitted the migration ran as a post-install step of
  `akm upgrade`, behind an npm install. Where akm is installed globally by a
  container image and the runtime user is unprivileged, that install fails
  `EACCES` and throws long before the migration is reached, so `akm index
  --full` was blocked with no supported way out — and the two obvious
  workarounds are both wrong (upgrading as root installs a *newer* akm than the
  image ships, which `config-version-shim` then fails closed against; deleting
  `state.db` destroys task history, proposals, and lessons metadata, none of
  which is derived). New `akm upgrade --state-only` applies pending state
  migrations and installs nothing. Nothing about the migration needed the
  network, root, or a new binary; coupling it to one was the bug. The safety
  copy is still taken — this changes who may request the migration, not what it
  does.

- **Two security holes closed.** A failed `git ls-remote` made
  `verifyClonedRevision` a no-op, silently skipping the R-011 post-clone
  revision-integrity check — the guard against a compromised mirror — so any
  network blip disabled it without a word. And `scanExtractedFiles`, the
  post-extraction TOCTOU path-traversal rescan, returned silently when a
  directory could not be read: it passed clean in exactly the race it exists
  to catch. Both now fail loudly.

- **`akm curate --type` ignored the type filter.** A set `--type` bypassed
  `selectCuratedStashHits` entirely and did a raw slice of the hits as
  received, which neither filtered by type nor ranked by score — so
  `--type command` could return a skill, in arbitrary order. It now narrows
  the candidate pool and runs the full curation pipeline over it. The test
  that should have caught this passed by accident, because the off-type hit
  happened to sit past the result limit.

- **Curate silently dropped relevant results.** An undocumented floor excluded
  any hit scoring below `max(0.35, leader * 0.7)`. Measured against a real
  3,265-memory bundle, one query went from one result to four once it was
  removed — the suppressed hits were the ones actually matching. Ordering is
  unchanged: results were already sorted before the floor ran, so it could
  only ever hide the tail.

- **A bundle-audit hash depended on the machine's locale.** `canonicalJson`
  in `installed-stashes.ts` sorted keys with `localeCompare` — ICU-dependent —
  and fed the result to `sha256Hex`, so the same object could hash differently
  on two machines. Now codepoint order, matching the other implementations.

- **A deletion shield failed open.** `isHotCapturedMemory` returned false when
  it could not read or parse a memory, marking exactly the memories it failed
  to inspect as fair game for consolidate to merge or delete. It now fails
  closed.

- **Sixteen places returned a confident wrong answer instead of an error.**
  The pattern (#791) recurred across search, graph, indexing, and scheduling:
  a corrupt or locked index reported "no matches"; a failed inline rebuild
  surfaced as "Index is empty. Run 'akm index'" at exit 0; `akm show` reported
  "0 related files" for an unreadable index; a DB failure in
  `listProposalsReadOnly` returned `[]`, so dedup could not tell "no prior
  proposal" from "database unreadable" and could re-mint an already-rejected
  one; a permission fault on the bundle directory told the user to run
  `akm bundle create`; and `launchd`'s `list()` returned `[]` when the
  LaunchAgents directory could not be read, so task reconciliation concluded
  there was nothing to manage. In each case the failure now surfaces.

- **Drifted copies of shared helpers.** `asNonEmptyString` trimmed in two
  places and not in four others, so a whitespace-only session id decoded to
  `" "` in some subsystems and `undefined` in others. `isPlainObject` had two
  incompatible definitions under one name; the loose form would accept a
  `Date` or class instance as a plain record. Both consolidated, along with
  `toPosix` (15 copies, whose "avoid an import cycle" justification was false
  in every case), `isRecord` (11), `compareCodePoints` (8), and five more
  families.

- **Pruning a memory no longer leaves dangling belief edges (#885).**
  `writeContradictEdge` — the hardened, test-covered `contradictedBy` writer —
  had no production caller; its docstring named three that did not exist. The
  live pass used a private near-copy that had drifted on exactly the two
  behaviours the original was hardened for: it read the key with
  `Array.isArray` only, so a SCALAR edge (live data the indexer accepts and
  lint never flags) read as "no edges" and was overwritten out of existence;
  and it set `beliefState: "contradicted"` unconditionally, promoting an
  `archived` memory back up the ranking. The tests for both behaviours were
  guarding dead code. The copy is gone.

  `persistBeliefStateTransition` is deliberately NOT routed through the shared
  primitive: it is a state-transition writer that replaces the edge list
  wholesale and can clear it, which an append-only, never-weaken primitive
  cannot express.

- **`git worktree` operations no longer fail on a busy machine (#891).** The
  module's internal `GIT_TIMEOUT_MS` was a flat 30s with no margin, so a
  healthy `git worktree remove` on a loaded host returned
  `{ removed: false, error: "timed out after 30000ms" }`. Anyone running a
  workflow with `isolation: worktree` alongside other git activity could hit
  spurious create failures, or have a clean worktree wrongly retained as
  unremovable. Raised to 120s, matching the existing `GIT_PUSH_TIMEOUT_MS`
  precedent. Note `scripts/test-integration.sh` had already raised *bun's*
  per-test timeout for this reason, but that never touched the production
  subprocess timeout, which fires first.

- **`akm health`'s dead-link check no longer reports an unearned all-clear
  (#892).** `checkDeadUrls` capped at 20 URLs across the whole bundle, plus an
  undocumented `slice(0, 3)` per entry, then the caller logged "URL check
  complete (0 dead)". A bundle with thousands of links got a clean bill of
  health after twenty were examined. Both caps removed; every URL is checked
  and a failed request surfaces instead of being swallowed.

- **`akm lint --fix` no longer breaks on gitignored drafts (#887).** The doc
  linter walked `docs/` with no gitignore awareness, so unpublished drafts
  under `docs/.pending/` were held to the published-docs contract —
  `bun run lint` failed locally while CI, which never has those files, stayed
  green.


- **`akm task sync` no longer spawns `npm root --global` on every call** (#901).
  The npm-global-root probe behind `resolveAkmInvocation` is memoized for the
  process, so a `task sync --rebind` cycle spawns npm at most once instead of
  twice, and an installation that loops it every minute stops accumulating an
  npm debug log per spawn.
- **A blocked v2 task now says how to convert it** (#902, #899). The
  `argv-array-has-no-portable-shell-string` blocker printed by `akm migrate`
  and the `TASK_SCHEMA_VERSION_UNSUPPORTED` read error now state that manual
  conversion is required and name the rewrite (`command:` argv array →
  `run:` string plus `shell:`). The full v2 → v4 field mapping is documented in
  `docs/migration/v0.9.1-to-v0.9.2.md`.
- **Legacy `#fragment` proposal rows are repaired instead of warned about
  forever** (#898). State migration 026 strips the retired export-fragment
  selector from `proposals.ref` in place so the rows parse again, and an
  unparseable proposal row now warns once per process instead of once per
  read (`akm health --report` read the table seven times).

- **A no-op incremental `akm index` no longer costs minutes of CPU** (#900).
  Two causes: the per-directory freshness check ran two full scans of the
  `entries` table for every directory (O(directories × entries)), and every
  file was read, hashed, and parsed before the freshness check decided the
  directory was unchanged. The directory lookup now uses the existing
  `file_path` index, and a stat-based gate over each directory's walked file
  set skips unchanged directories before any file is read. On a synthetic
  800-directory, 4,000-entry corpus a no-op pass fell from ~37 s to under 1 s
  of CPU with identical entries and search results. The persisted directory
  fingerprint now covers every walked file and `index_dir_state` gains a
  `row_count` column; an existing index.db drains each directory once more
  after upgrading, then takes the fast path.

- **Task-migration snapshots are capped at the five most recent** (#897).
  `akm migrate apply` writes one snapshot directory per run under
  `backups/task-v3` and `backups/task-v4` and never pruned them; each apply
  now keeps the five newest and removes the rest, the same policy config
  backups already use. Nothing in the current code writes the legacy
  `backups/migrations`, `manual`, `releases`, or `operations` directories,
  so they are left alone; the new health advisory is what surfaces them.


- **The incremental index no longer misses an edit whose timestamp did not move
  forward.** The per-directory freshness check summarised a directory as its
  file-name set plus the single newest mtime, which lost two kinds of change.
  An edit to any file other than the newest one landed below that maximum and
  was invisible even though its own mtime changed — so a restore, checkout, or
  archive extraction that stamped a plausible older date left stale content in
  the index. And because mtime is writable by ordinary tooling (`touch -r`,
  `rsync --times`, `cp -p`), an edit with a restored timestamp was invisible
  outright. The directory is now digested per file over
  `(basename, size, mtime, ctime)` at nanosecond resolution. It is the same one
  `stat` call per file, so the incremental fast path costs what it did before.
  Both gaps predate 0.9.8 and applied to every earlier release.

  Trade-off worth knowing: `ctime` also moves on metadata-only changes such as
  `chmod`, and after copying a tree, so those now cost one extra rescan. That
  direction is deliberate — extra work, never stale content. Existing indexes
  rescan once as the digest changes shape, then return to the fast path.

- **`akm migrate apply` can now clear a legacy `extraParams` config.** A config
  still carrying a liftable key such as `extraParams.temperature` fails config
  load closed, and that error names `akm migrate apply` as the fix — but the
  migrate command resolved the stash directory and ran the task migrator, both
  of which load config, so it died on the very error it exists to clear. An
  operator hitting this had no reachable way forward. The config lift now runs
  before anything that loads config, and `akm migrate status` reports the
  pending lift as its blocker instead of re-raising the same error. A genuine
  conflict, where an `extraParams` key and its first-class field disagree, still
  hard-rejects and names both values rather than guessing.

- **`akm health` no longer warns about disk usage on a fresh install.** The
  `data-dir-usage` advisory added earlier in 0.9.8 counted SQLite's `-wal` and
  `-shm` sidecars toward the data directory's total but not toward the live
  databases they belong to. On an untouched install the write-ahead log is most
  of the directory, so the very first `akm health` reported a ~126x ratio and
  exited `warn` with no user data present. Sidecars now count as part of their
  database, and the advisory stays quiet below 1 GB, where a ratio says nothing
  useful about disk pressure.

### Removed

- **`akm health --clean-dead-residue` and every other compensating shim.**
  A special-purpose flag on `health` that deleted files existed because
  migrations had not finished their own job. Removing a superseded layout IS
  migration, so `akm migrate status` now reports it and `akm migrate apply`
  removes it. Four more of the same class went the same way: the D8
  `task_history` vocabulary is rewritten once by a state migration instead of
  re-decided at three read sites; the legacy `extraParams` config lift happens
  once in `migrate apply` instead of silently on every load forever (an
  unmigrated config now fails closed, naming the command to run); retired
  `type:slug` xrefs are rewritten by `lint --fix`; and stale transaction
  journals are recovered by `migrate apply` rather than reported by an
  advisory that pointed at documentation while the recovery function it needed
  sat with zero callers.

- **Dead code with no consumers.** An empty `{}` type threaded through two
  functions as a parameter neither read, with a `{}` placeholder at the call
  site; unused helpers, imports, and parameters throughout.

- **14 architecture ratchets, 15 golden/snapshot suites, 12 characterization
  suites.** Function-size and import-cycle ratchets that failed on refactors
  harming nothing; byte-for-byte snapshots "fixed" by regenerating; tests that
  pinned "what the code does today" by definition.
- **11 of 14 lint scripts (-3,988 lines).** `lint-tests-isolation` alone was
  717 lines standing in front of `src/core/paths.ts`, which already throws
  `TEST_ISOLATION_MISSING` at runtime. Also removed: the `gen-config-schema
  --check` gate (`build` regenerates the schema anyway, so what ships is always
  current), and `lint-devto-posts` (322 lines that were wired to nothing and
  duplicated checks `devto-cli` performs itself). The three kept catch
  user-visible problems: secrets must route through the resolver, no dead refs
  in shipped assets, no docs teaching commands that do not exist.
- **Both `MIN_TESTS` floors** — arbitrary numbers whose only job was to fail
  the suite when test count dropped.
- **`release-workflow-syntax.yml`** — a workflow that ran actionlint over the
  other workflows. A broken workflow file already fails at GitHub.
- **Dead `$STASH/.akm` residue is now reportable (#889).** `akm health` gains a
  read-only `stash-dead-residue` advisory naming each stale path and its size;
  deletion is gated behind an explicit `akm health --clean-dead-residue`. On a
  real bundle 82% of `.akm` (135 MB) was pre-0.9.0 leftovers no code reads.

### Testing

- Test isolation grandfather list drained 58 -> 2 (#785); the two retained
  entries are the helper-definitions file and a meta-test of the guard itself.
- The test tree now has a stated unit/integration rule and ~250 files were
  reclassified by evidence — real DB, network, or process spawn — rather than
  by filename (#786).
- 31 status-only `not.toBe(0)` assertions replaced with exact exit codes and
  machine-readable error codes, every value observed rather than inferred
  (#787).
- Near-duplicate clusters drained (#788); real-server timing flakes removed or
  made deterministic (#789).
- Kept deliberately: `registry-network-boundary.test.ts`, which enforces that
  only `pinned-transport.ts` may import `node:http`/`node:https` — the control
  that stops a raw request bypassing address-pinned fetching. No lint script
  covers that boundary.

## [0.9.7] - 2026-08-31

### Added

- **`akm curate --pack <tokens>` (#746).** Packs the ranked stash hits' full
  content into a single token-budgeted blob instead of returning refs the
  caller has to follow up on with N separate `akm show` calls. Content is
  resolved through the same path `akm show` uses, so a `ref#fragment` hit
  packs just that section. Drops whole assets from the tail of the ranked
  list first; only a single highest-rank hit that alone exceeds the budget
  is truncated. Registry hits are never packed — that separation stays
  opt-in and there is no flag to override it. Named `--pack` rather than
  `--budget` because the workflow asset schema already uses `budget` for
  run-cost caps.

- **`llms.txt`-aware website ingestion (#749).** `akm bundle add` against an
  origin root now probes `<origin>/llms.txt` first and, when present, uses
  that author-curated link list as the crawl frontier instead of discovering
  links by parsing HTML. Each linked page still flows through the same
  robots-compliant, host-guarded, content-extracting fetch as before, so
  ingested pages stay individually addressable. Off-origin manifest entries
  are dropped. The probe is restricted to origin-root URLs, so adding a
  specific page still fetches that page. Sites without the file fall through
  to the existing crawler unchanged. `llms-full.txt` is deliberately not
  read: its `## <path>` separators are ambiguous against real page content.

### Changed

- **The improve-strategy presets were reviewed as a set (#878).** The
  investigation first believed `thorough` silently ran without validation;
  that was wrong — every strategy deep-merges onto `default` before
  resolving, so the old asset behaved correctly. What was real: `thorough`
  was the only preset of ten relying on that invisible inheritance instead
  of an explicit process matrix, and its triage used `applyMode: "queue"`
  while its description promised to "drain the backlog" — queue mode never
  promotes, so nothing drained. `catchup` had the same inertness:
  `maxAcceptsPerRun: 100` under queue mode, a key the promote loop never
  reads.

  Both now use the same judged-promotion pattern as `reflect-distill` and
  `proactive-maintenance`: `applyMode: "promote"`, `judgment: true`, a
  per-run accept cap (`thorough` 25, `catchup` 100), and `maxDiffLines:
  200`. The autonomy gate demotes promote back to queue unless
  `experimental.improveAutonomy` is enabled, so by default both still
  review-only; with autonomy on, they actually drain. `thorough` now
  carries default's full explicit matrix, and a regression test pins
  "everything default enables, thorough enables identically, plus triage."

### Fixed

- **Pruning a memory no longer leaves dangling belief edges (#884).**
  `analyzeMemoryCleanup` archives a pruned memory rather than deleting it —
  the file moves under `.akm/memory-cleanup/archive/` beside a `cleanup.md`
  audit record naming its `ref` and `originalPath`. Ref resolution only ever
  looked at the memory's original location, so once #882 made
  `contradictedBy`/`supersededBy` validatable, every memory pointing at a
  pruned one began reporting `missing-ref`. `refExistsInAnyStash` now resolves
  the archive tombstone, so a belief edge to an archived memory is satisfied
  instead of dangling. Existence only: `resolveRefPathInStash` still ignores
  the archive, because it returns a path callers mutate (`--supersedes`
  demotion) and an archived file must never be written to. The contradiction
  an edge records is preserved rather than erased, which a bare edge-scrub
  would have destroyed.

  A ref whose target has neither a file nor a tombstone was removed by
  something other than prune — a hand `git rm`, or a pre-fix release — and is
  genuinely dangling. Clearing those deletes user assertions, so it is opt-in
  behind `akm lint --prune-dangling-edges` and is deliberately NOT folded into
  `--fix`: every other auto-fix repairs a malformed file, whereas this one
  edits well-formed files to drop a claim about the belief graph. The repair
  is scoped to the `supersededBy`/`contradictedBy` channels — a stale `xrefs`
  entry is an ordinary broken link that the author may want to re-target, not
  delete — and preserves comments, key order, and surviving list entries. It
  clears the same `writable: false` gate `--fix` does.

  Known limitation: if a memory's only edge on a channel is dropped, a
  `beliefState:` naming that channel is left without a supporting edge.
  Choosing a demotion target is a belief-semantics decision this fix does not
  make. No occurrences existed in the stash that surfaced #884.

- **A corrupt `index.db` now rebuilds instead of failing the command
  (#865).** `src/core/state-db.ts` documented that "a corrupt index is
  recovered by deleting it and re-running `akm index`" — that recovery was
  never implemented. Real on-disk corruption surfaced a raw `SQLITE_CORRUPT`
  and exited 70, and the existing inline-reindex fallback could not help
  because it reopened the same corrupt file. `openIndexDatabase` now detects
  corruption, removes the file and its `-wal`/`-shm` sidecars, and retries
  the open once. Scoped to `index.db`, which is fully regenerable from the
  stash; `state.db` is never touched.

- **`akm task sync` accepts an immutable package-local install (#868).** An
  image-baked akm pinned at a path outside the npm global root was refused
  outright, and `--rebind` then warned on every sync that the pinned binary
  was "mutable, unproven" — the opposite of true, training operators to
  ignore a recurring warning. The npm-global check was only ever a proxy for
  "this binary won't change out from under the scheduler"; that property is
  now tested directly, so a launcher this process cannot write to (a
  read-only mount) is eligible without `--rebind` and without the warning.
  Writable `npx`/project-`node_modules` installs remain ineligible, which is
  the case the original check existed for. No new config knob.

- **`TASK_SCHEMA_VERSION_UNSUPPORTED` names the actual blocker (#869).** For
  a v2/v3 file the message is only reached after the read-time shim has
  already tried and failed to convert it — meaning a human decision is
  required — yet it pointed at `akm migrate apply`, which would report the
  identical block for that same file. The blocked `reason`/`detail` were
  already computed and then discarded; they are now surfaced, so the error
  names the specific reason (e.g.
  `shell-command-resolution-changes-v2-literal-argv-semantics`) and says a
  decision is needed rather than sending the operator to a command that
  cannot help.

  Also verified as already fixed and left alone: cross-bundle scoping (a
  blocked file in one bundle does not prevent conversion in another —
  resolved by #866) and `env`-prefixed command conversion (resolved by
  #867).

- **`akm task sync` no longer dead-ends on pre-0.9.2 crontab rows (#881).**
  Rows written by v0.9.0/v0.9.1 carry no `--scheduler-context` marker, so
  `extractCronInvocation` could not parse them. Sync therefore saw the task
  as absent, tried to install it, and collided with the row that was still
  physically present — permanently blocking sync for every task on any
  install upgrading past v0.9.2. Such a row is now recognized and
  reconciled. The fallback fires only when the marker is entirely absent
  and only inside akm's own `# akm:task … BEGIN/END` sentinels, so a row
  carrying the marker that fails to parse for any other reason is never
  reinterpreted, and no ownership or cardinality assertion changed.

- **`akm lint` validates `type:slug` xrefs instead of silently skipping
  them (#882).** `typeNameFromConceptId` returns `undefined` for the colon
  grammar, so `classifyConceptRef` treated those refs as "not a local ref"
  and dropped them before validation — roughly half the xref channel on a
  real corpus. Zero `missing-ref` findings read as "every reference is
  healthy" when half had never been examined. akm still writes this
  grammar today (`memory-contradiction-detect.ts` emits `contradictedBy:`
  as `memory:<name>`), so it is a live channel, not legacy residue; it is
  now accepted as a fallback in lint only, leaving the parser and write
  paths on the single conceptId grammar.

- **Refs to derived memories resolve (#882).** `assetPathCandidatesForName`
  only ever offered `<name>.md`, so any ref to a memory stored as
  `<name>.derived.md` failed to resolve — affecting the conceptId grammar
  equally, and invisible until the above fix made these refs validatable.
  `.derived` is a provenance marker on the same identity, not part of the
  name, so `<name>.derived.md` is now a secondary candidate with plain
  `<name>.md` still taking precedence when both exist. Fixed at the
  resolution primitive, so write-time `--xref`/`--supersedes` validation
  benefits as well.

### Removed

- **The `frequent` and `memory-focus` improve strategies.** Zero recorded
  invocations, and both were mid-points of other presets (`frequent` ≈
  `reflect-distill` without distill or triage; `memory-focus` a subset of
  `frequent`). The shipped hourly task template now uses `reflect-distill`
  — matching what real deployments had already switched to by hand. Any
  removed combination remains expressible via `improve.strategies` in
  config. One caveat: a user-config strategy *named* `frequent` or
  `memory-focus` previously merged over the built-in of the same name; it
  now merges over `default` only, so a partial override that relied on the
  built-in's values will resolve differently and should be made explicit.

### Testing

- **The previous-release corpus covers more than task sources (#880).**
  Added fixtures for the synthesized `AKM_BUNDLE_DIR` duplicate-`stash`
  bundle shape that caused #870, the retired 0.8 `stashDir`/`sources[]`/
  `installed[]` config keys, and a downstream consumer's `config.json` plus
  four task-source-v4 files. The 0.8 fixture deliberately asserts the
  opposite of the others: those keys are hard-rejected by design, so it
  guards that the rejection stays loud and actionable rather than silently
  loading. Every fixture was proven to catch a regression by breaking the
  guarantee, observing the failure, and reverting.

- Pinned current handling of truncated LLM responses (`finishReason:
  "length"`) as a regression test (#865). No distinct classification or
  retry was added: the underlying truncation was already resolved by
  `reasoningEffort`, and threading the finish reason through four layers to
  earn one diagnostic label was not justified.

### Not shipped

- **Orphan-asset detection for `akm health` (#750)** was implemented and
  then backed out after measurement. Against a live 23,859-entry index it
  flagged 16,609 of 16,615 in-scope assets (99.96%) and took 135 s. The
  corpus is not densely cross-linked — 1,591 distinct xref tokens exist in
  total — so the check has no signal to give. The broken-ref half of #750
  had already shipped previously. Moved to Backlog; see #882 for the
  resolver defect the investigation exposed.

## [0.9.6] - 2026-08-31

The deletion release: **net −2,100 lines**, almost all of it machinery that
gated, refused, verified, or cached a judgment. Nearly every guard removed
here had **zero confirmed firings** across 38,341 production telemetry events,
while several had already broken real installs.

The standard applied is now written down in `AGENTS.md` (`## Defensive Code`):
a guard survives only if it has demonstrably helped a real user, its failure
mode costs less than the hazard it prevents, and the operation is not already
gated behind a deliberate human command. "This hazard is conceivable" is not a
justification.

### Fixed

- **Embedding no longer discards an entire index because one batch was too
  big (#874).** Remote embeddings batched by document count (100) against a
  fixed 30s timeout; a single oversized batch failed the whole phase, leaving
  `embeddings` at 0 rows on a real 23,857-entry bundle and silently disabling
  semantic search. Batching is now bounded by a token budget, failures are
  skipped-and-reported per batch, and an oversized single document is a named
  skip rather than a phase failure.
- **`akm lint` no longer silently skips user directories named `.cache` or
  `registry`.** Two name-based exclusion sites remained after the 0.9.5 fix, so
  a bundle's own `knowledge/registry/` was never linted and reported clean.
  Exclusion is now anchored to akm's resolved registry-cache path.
- **One directory can no longer register as two bundles (#870).** When
  `AKM_BUNDLE_DIR` pointed at a directory already configured under another id,
  akm minted a second bundle for it; `akm migrate` then enumerated every task
  file twice and failed with `duplicate task migration file path` (exit 70) —
  permanently, while health checks kept passing. Bundle identity is now the
  resolved content root (`path.resolve(entry.path, component.root ?? ".")`) at
  both registration sites, existing duplicates reconcile instead of throwing,
  and a genuinely irreconcilable pair reports both bundle ids and the shared
  path.

### Removed

- **The index writer lease (#872).** It guarded a *regenerable cache*, had zero
  lease events in telemetry, and a live-but-wedged holder stranded all indexing
  for 12 hours — `probeLock` only reclaims a dead PID. It blocked legitimate
  work twice in a single day of real use. `withAssetMutationLease` is **kept**
  (it guards authored, git-backed asset writes) but its identical 12h
  age-based stale reclaim is gone; only a verifiably-dead holder is reclaimed.
- **`semantic-status.ts` and its cached `blocked` verdict (#873).** A failed
  probe was persisted with a 24h TTL, and search consulted that verdict
  *before attempting semantic search at all* — so one failure silently
  disabled a working feature for a day. Semantic search now attempts per query
  and falls back to FTS with a live warning. The remaining pre-flight check is
  a real-time embedding count, not a stored judgment.
- **The improve-lock 4h stale reclaim.** Same hole: `--skip-if-locked`
  silently no-oped nightly `improve` for up to four hours and reported success.
- **The persisted `supportsJsonSchema` capability cache**, which was never
  invalidated by `akm config set`; a stale `true` sent `response_format:
  json_schema` to an incompatible endpoint with no fallback (`isRetryable`
  excludes 4xx). Replaced by attempt-then-fallback held in memory for the
  process only. The config field survives as an explicit user override.
- **Workflow authoring resource caps** — steps, params, route branches,
  inputs, outputs, gate loops, retries, JSON depth/node, composition depth,
  and exec argv/env caps. None ever fired; several duplicated OS limits.
- **`LIFETIME_UNIT_CAP` (10,000)**, which hard-aborted workflows mid-run. The
  maximum ever observed was 14 units.
- **`state.db` open-path identity re-verification**, which ran on *every*
  command and threw a bare `Error`.
- **The task-source 1 MiB cap** at four sites, restating the `guarded-source`
  cap already deleted in 0.9.5.
- **TOCTOU identity checks** — `assertGitPublicationIdentity` (git's
  `--force-with-lease` already covers it), `assertFrozenDirectoryIdentity`
  (replaced with a path-containment recheck: containment and resolved-path
  identity stay, device/inode comparison goes, so a remount or container
  rebuild no longer aborts a dispatch), `assertTaskSourceExpectation`'s stat
  fields (its content hash stays), and redundant repeat HEAD-generation
  compares in `write-source`.
- **`assertNotFlag`** on persona/system-prompt content; **`MAX_ENV_BYTES`**,
  **`MAX_SECRET_BYTES`**, **`MAX_FEEDBACK_TAGS`**, **`MAX_CONFIG_FILE_BYTES`**,
  model-map JSON budgets, memory-contradiction family caps, and two launchd /
  schtasks re-checks that duplicated an existing fallback. `map.concurrency`
  now clamps instead of rejecting a human-authored value.
- **17 dead symbols**, including several whose docstrings described behavior
  nothing implemented. Three "canonical" constants that call sites were
  ignoring in favour of hardcoded literals were **wired in** rather than
  deleted, closing the drift instead of removing the evidence of it.
- **Speculative flexibility** — `AKM_ABLATE_CONTRIBUTORS` ablation plumbing
  and the unexercised `graphBoost.confidenceMode` branches.

### Changed

- **Drifted duplicate implementations consolidated.** HTTP retry/backoff (the
  generic copy's `Retry-After` parsing was unbounded and numeric-only; the
  capped, date-aware one now applies everywhere), the child-process env
  allowlist (the opencode-sdk copy was missing `AKM_EVENT_SOURCE` and the
  Windows HOME equivalents), portable synchronous sleep (five call sites had
  been silently taking the Node fallback instead of the Bun fast path), a
  stacked LLM chunk retry, and a duplicate `isProcessAlive`.

### Kept, deliberately

Not everything unused is disposable. `isVecFastPathReady` stays: a partial
`entries_vec` table does not throw, it silently returns wrong neighbours, so
there is no error for a fallback to catch. `assertSupportedKind` stays: it has
a proven independent bypass path and is the real last-line check, not a
duplicate. The maintenance barrier and registry TTL cache stay. The four
improve strategies with zero recorded invocations stay — that measures one
install's cron schedule, not their worth.

## [0.9.5] - 2026-08-30

### Action required after upgrading

- **Run `akm index --full` once (#862).** Search ranking previously counted
  every search *hit* as a small win for that entry's utility score, whether
  or not you ever opened it — a plain impression, not a selection. Over
  enough repeat searches this compounded into a real feedback loop: appear
  in results -> score goes up -> rank higher next time -> appear again. On
  the install this was diagnosed against, one entry had been searched 19
  times, opened 0 times, and still carried a utility score of 0.83 — on par
  with entries a user had actually picked every time; the single
  highest-utility entry in the whole table had an 8% select rate. That bias
  is baked into every existing install's stored scores and does not go away
  on its own — the live bump has been removed (search impressions no longer
  write utility scores at all; only an actual `akm show`/select or explicit
  `akm feedback` feeds the offline recompute now), but the already-inflated
  numbers stay in `utility_scores`/`utility_scores_scoped` until you
  recompute them. Run `akm index --full` once after upgrading to rebuild
  scores purely from selection rate and feedback. **Search result order will
  change after that rebuild — that is intended**, not a regression.
- **The first `akm task sync` after upgrading may report a large number of
  updates.** This is a backlog of reconciles that were being silently
  refused, not new changes to your tasks. Two independent bugs combined to
  make `sync` refuse work it should have done: (1) an installed scheduler
  entry written by a pre-`--bundle` akm release couldn't prove ownership
  under the newer, stricter check and was reported `(unproven owner)`,
  which made `sync` refuse the *entire* run rather than reconcile everything
  else; (2) separately, one task or workflow source that failed to compile
  (e.g. a task still on schema v2 in a shape the shim can't convert) also
  blocked every other, unrelated task from reconciling. Both are fixed —
  ownership is now re-derived from the entry's own akm markers instead of
  requiring a literal `--bundle` token, and a source that fails to compile
  is now excluded and reported in `failed`/`failures` while every source
  that DID compile still reconciles. On the install this was diagnosed
  against, all 18 scheduled tasks showed up as updates on the first `sync`
  after the fix — that is the backlog, not a sign your tasks changed.

### Added

- **`akm task prune` reclaims orphaned scheduler entries `sync` cannot reach
  (#851).** `akm task sync` only ever reconciles entries that resolve to a
  desired task/workflow definition in a live bundle; an entry whose own
  `--scheduler-context` descriptor is corrupt/missing, or whose owning
  bundle directory has since been deleted, was permanently invisible to it
  and had to be removed by hand-editing the crontab/launchd plist/Task
  Scheduler. `akm task prune` finds those and nothing else: it never
  touches an entry that still resolves to a live bundle, and there is no
  `--force`/"remove everything silently" mode. Defaults to a dry-run
  preview that makes zero scheduler writes and exits non-zero when it finds
  removal candidates (usable as a CI/health-check guard, mirroring `task
  sync --dry-run`'s exit-code convention); `--yes` executes the printed
  plan; `--id a,b` narrows a run to specific binding ids and refuses (with
  no writes) any id that isn't a current orphan candidate — including a
  live entry, which cannot be pruned even if you name it explicitly.
- **`configVersion` read shim (#863).** Config loading now tolerates a
  known older `configVersion` by upgrading the parsed document in memory
  (never rewriting the file), with a one-line stderr warning naming the old
  and new versions. The upgrade is silenced the next time any command
  writes the config (`akm config set`, etc.), since every config write
  already stamps the current version. Anything else — unknown, newer, or
  malformed `configVersion` — still fails closed with the same actionable
  error as before. No current release needed this shim yet (akm has only
  ever shipped `configVersion: "0.9.0"`); it's in place now so the next
  real bump doesn't break every existing config on upgrade.
- **Truncated indexed content is no longer silent.** The two indexer caps
  that truncate an entry's content before it's written to the search index
  (a markdown-body cap and a search-text cap) previously truncated without
  any signal. Indexed entries now carry a `contentTruncated: true` flag
  when either cap fired, and truncation logs a `--verbose` diagnostic
  naming the entry, so an unexpectedly-worse search match on a very large
  file has a visible cause instead of a silent one. The cap sizes
  themselves are unchanged.

### Fixed

- **`akm health --report` and `akm proposal list --status accepted` no
  longer crash, and `improve`'s accepted-proposal counts are no longer
  silently zero, on proposals written before every optional envelope field
  existed (#859).** A prior fix already tolerated a missing `changes` key;
  this closes the same gap for `proposedTarget`, which was still hard-required
  at decode and — on the real archive this was checked against — absent
  from 93% of accepted rows. Decoding a proposal now tolerates a genuinely
  *absent* `proposedTarget` (accept-time resolution already had a
  ref-derived fallback for this case, previously unreachable because decode
  threw first); a *present but malformed* value still throws, so real
  corruption is never silently accepted. Writing a new (`pending`) proposal
  still requires the full envelope — this only widens what can be *read*,
  not what akm will *write*.
- **`akm task sync` no longer refuses to reconcile an entry it can't fully
  re-prove ownership of, and no longer lets one broken task/workflow source
  block every other source (#867, plus the scheduler-ownership fix
  described above).** The v2 task-source shim also no longer hard-fails a
  command wrapped in `env NAME=value... cmd`, a shape that's common for
  cron entries (e.g. `env AKM_BIN=/path/akm bash script.sh`) — the shim now
  looks past a leading `env` and its assignments to the real command before
  deciding whether the conversion to v3/v4 is safe, instead of checking
  `env` itself.
- **`akm task sync --dry-run` no longer crashes on a real install with a
  pre-`--bundle` cron entry.** The reconcile fix above made those entries
  reachable for the first time, and the dry-run preview's frozen result
  object was then mutated in place while stamping output metadata, throwing
  "Attempting to define property on object that is not extensible" (exit
  70). Output stamping now copies instead of mutating, so it tolerates a
  frozen (or any) result uniformly.
- **`akm migrate apply` no longer aborts an entire batch because one file in
  it is blocked (#866).** The task v2->v3 and v3->v4 migrators refused to
  write *any* file — including files with no problem at all — the moment a
  single file in the batch was classified `blocked`. Both migrators now
  skip and report the blocked file(s) and still migrate everything else;
  the run still exits non-zero whenever anything was skipped.
- Two flaky integration/unit tests fixed at the root cause rather than
  quarantined (#864): a `state.db` byte-identity assertion that raced
  SQLite's own WAL checkpoint timing (now forces a checkpoint before
  comparing, so the assertion reflects real durable mutations only), and a
  "resolveProjectContext when cwd is the home directory" test that did
  real, un-mocked filesystem walks against the actual `$HOME` (now isolates
  `os.homedir()` and the stash/XDG dirs like the rest of the suite).

### Changed

- **`test:integration` is green-by-default (#861).** Verified there is no
  CI mechanism silently swallowing a failing test (no `continue-on-error`,
  no lost exit codes, no allowlist of "expected" failures) — the fixes in
  this release were the actual cause of the prior red baseline. Raised the
  integration suite's minimum-test-count floor (`AKM_MIN_INTEGRATION_TESTS`,
  5500 -> 5700) so a large silent test loss is still caught with headroom
  for ordinary future deletions, and documented in `AGENTS.md` that `TMPDIR`
  must be a real `/tmp`-family path for the suite to pass — some guards
  (stash-path safety, `akm-eval`'s Docker twin) intentionally hardcode that
  assumption rather than reading `TMPDIR`.
- Simplified several areas flagged in the #866 complexity review without
  behavior changes: `improve_runs.result_json`'s `schemaVersion` decoding is
  now an explicit, extensible table instead of one large inline
  conditional, ready for a future schema bump to add a case rather than
  restructure the function.

### Removed

- **Three defensive checks that only ever refused work a human explicitly
  asked for, with no evidence (via telemetry) they ever caught a real
  problem, were removed:**
  - The 1 MiB hard cap on reading a bundle file (command/agent/script/task/
    workflow source, or a frozen workflow secret/env source) into memory.
    Reads remain exact and integrity-checked (hashed, CAS-verified, fail-
    closed on read-time mutation) — there is simply no longer a size ceiling
    that refuses to read a file you put in your own bundle.
  - The task migrator's inode/hard-link-count/change-time identity
    fencing on top of its existing lockfile + backup-before-write +
    byte-for-byte drift check. The extra fencing modeled a multi-tenant
    race that doesn't apply to a single-user CLI holding an exclusive lock,
    and its failure mode (refusing to migrate a file that's byte-identical
    to what was already previewed, or refusing to touch a file merely
    because it has a hard link elsewhere) was worse than the risk it
    guarded against. Symlink/path-escape rejection — a real hazard — is
    unchanged.
  - Dead anti-collapse "hard refusal" guard functions
    (`checkGenerationGuard`, `checkMergeInformationFloor`) that had zero
    production callers.

## [0.9.4] - 2026-08-30

### Changed

- **Node.js 22 support is restored for the npm package.** 0.9.3 raised the
  npm bootstrap floor to Node >= 24 as a policy simplification; no code in
  the package actually requires a Node-24-only API, and the pinned
  better-sqlite3 12.11.1 ships a prebuilt binary for Node 22 (ABI 127), so
  nothing compiles from source. The floor returns to Node >= 22 across the
  preinstall check, the CLI bootstrap guard, and the pinned-registry
  helper, and the CI node-smoke matrix again runs BOTH Node 22 and 24 so
  the supported floor is tested on every run, not merely declared.

### Added

- **`akm task sync --dry-run` previews the reconcile without touching the
  scheduler (#849).** Prints the planned adds/updates/removes — removals
  now carry their owning bundle — makes zero scheduler writes, and exits
  non-zero when removals are pending so scripts can gate on it. The plan
  renderer is shared, ready for the planned `task prune` (#851) to reuse.
- **Search hits now report which stage of the progressive AND->OR lexical
  ladder produced them (#856).** `akm search` already ran strict AND, then
  prefix AND, then an OR/prefix-OR recovery, stopping at the first stage
  that returned candidates — but callers had no way to tell a strict match
  from a heavily relaxed one. Local bundle hits now carry an optional
  `matchStage: "exact" | "prefix" | "relaxed"` field (omitted for hits with
  no FTS component, e.g. a pure-semantic hybrid contribution), surfaced at
  `--detail normal`, `--detail full`, and `--shape agent` across all output
  formats. Purely additive; no `schemaVersion` bump.
- **Previous-release corpus test.** New
  `tests/integration/previous-release-corpus.test.ts` holds fixtures of
  data shapes prior releases actually wrote (task v2/v3 sources, pre-#858
  proposal rows) and asserts the current CLI reads or auto-handles every
  one. Policy: every schema bump must add the old shape here — this suite
  failing means an upgrade break was about to ship.

### Fixed

- **`akm show`, `task run`/`explain`, `workflow run`/`plan`, and
  `command run` no longer fail on bundles past 16,384 files (#857).**
  Single-ref owner resolution walked the entire bundle tree on every
  lookup, aborting with `file limit 16384 exceeded` once a bundle grew past
  the cap — normal `improve` output accumulation was enough to get there.
  Path-to-conceptId derivation is deterministic, so its inverse is now
  computed in closed form: each adapter's `readCandidates` enumerates every
  physical spelling that could own a conceptId (canonical placement, loose
  off-canonical fallback, env `.env` duality) and the existing
  verification/collision pipeline runs over that fixed set. The tree walk,
  both scan caps, and `AdapterConceptScanError` are gone — no cap is needed
  when nothing walks. Collision guarantees are unchanged (the pinned
  loose-vs-canonical conformance case still throws), and symlinked
  off-canonical files are now reachable where the old scan skipped them.
- **`akm health --report` and `akm proposal list --status accepted` no
  longer crash on proposal rows written before the `changes` metadata
  envelope existed (#858), and `improve` outcome-score salience no longer
  silently computes from zero accepted-counts (#859).** ~89% of real
  archived accepted/rejected rows predate the field and can never recover
  it; `storedToChanges` now treats a fully-absent `changes` key as a
  documented legacy gap (empty change list — the rows still count toward
  accepted/rejected history), `listStateProposals` skips-and-warns on
  genuinely corrupt rows instead of aborting the whole list, and the write
  path still refuses to persist a new proposal without changes.
- **Task v2/v3 sources are auto-read as v4 instead of hard-failing with
  `TASK_SCHEMA_VERSION_UNSUPPORTED`.** The v4 source gate would have broken
  every pre-0.9.4 scheduled task headlessly on upgrade until the operator
  manually ran `akm migrate apply`. `parseTaskSource` now runs the same
  pure, deterministic migration planners the migrator uses (chained
  v2->v3->v4) entirely in memory, emits a one-line stderr deprecation
  warning, and never writes the file; the hard error survives only for
  sources the deterministic conversion genuinely cannot translate.
  `akm migrate apply` remains the way to rewrite files on disk and silence
  the warning. The planner core moved from `scripts/akm-migrate/` into
  `src/tasks/source/` so there is exactly one copy.

## [0.9.3] - 2026-08-29

### Fixed

- **A failing Windows `shell: powershell`/`pwsh` task could lose its exit
  code's fidelity through `-Command` (#845).** `-Command` derives its own
  process exit code from `$?`, so a genuinely failing command already
  produced a nonzero exit and `status: "failed"` — but any native exit code
  outside `{0, 1}` was collapsed to `1`, discarding the real value reported
  in task history. The inner shell invocation built by `shellCommand()` now
  appends a guard that reads `$?` first (reproducing `-Command`'s own
  completed/failed determination, immune to a stale `$LASTEXITCODE` from an
  earlier native call in the same command) and only then upgrades to the
  precise native exit code when the failing last statement actually set
  one — a bare `exit $LASTEXITCODE` was rejected because `$LASTEXITCODE`
  stays `$null` for a pure-PowerShell command, and `exit $null` is exit
  code `0`, which would have turned a failed cmdlet into a false
  `"completed"`. Verified via unit tests asserting the exact argv `-Command`
  string on `platform: "win32"`; the runtime exit-code behavior itself is
  unverified on a real Windows host pending the owner's manual run (see the
  PR body for the procedure) — Windows scheduler paths still have no
  automated coverage (#770).
- **A valid 0.9.1 config hard-failed to load after upgrading to 0.9.2
  (#852).** `reasoningEffort` became a first-class `engines.<name>` field in
  0.9.2 (#815), so `extraParams.reasoning_effort` — the documented 0.9.1
  workaround for LM Studio, where `enableThinking` is a no-op — started
  tripping the extraParams protected-key check and hard-failing every
  command that loads config, with no migration. Config load now lifts
  `extraParams.{reasoning_effort,temperature,maxtokens,enablethinking}`
  onto their first-class field automatically (in-memory only; the file is
  not rewritten, and a warning names each lifted key) unless the
  extraParams value and the first-class field disagree, in which case
  config load still fails, now naming both values and the field to keep.
  Any other protected `extraParams` key without a first-class equivalent
  still hard-fails, but the error now names the fix instead of only the
  rule.

## [0.9.2] - 2026-08-29

### Fixed

- **A blocked workflow run became permanently unresumable after `akm
  workflow abandon` (#847).** Abandon correctly moved the run to `failed`
  but left its current step `blocked`; the durable-spine validator then
  rejected that honest abandoned shape as corruption before `resume` could
  reopen the step. Failed-run validation now accepts the three legitimate
  current-step states — `pending` for an abandoned active run, `blocked` for
  an abandoned blocked run, and `failed` for an execution failure — and
  `resume` normalizes each back to `pending` as promised by the CLI help.

- **`akm task sync` could compute another bundle's real scheduler entries as
  drift and try to remove them (#846).** Removal was scoped by a bundle
  *display name* (`bundleName`/`--bundle` target) — a value derived from a
  directory basename that two unrelated bundles can legitimately share (an
  unconfigured bundle's name is deduped only against its own config's
  bundles, never against other bundles actually installed on the machine).
  A primary/unconfigured-bundle sync now additionally confirms a
  name-matching installed entry's *resolved bundle path*, recovered from
  that entry's own scheduler-context descriptor, before treating it as
  eligible for reconcile — and refuses (rather than assumes) when that path
  can't be established. **Backward compatibility:** every entry installed by
  this codebase already carries a scheduler-context descriptor (the
  `--scheduler-context` file used to restore the scheduled process's
  environment), so existing installations resolve correctly with no user
  action required. An entry whose descriptor is missing, unreadable, or
  owned by a different OS user is never assumed to belong to the invoking
  bundle; such an entry is simply left untouched by sync (it will not be
  auto-repaired or removed) until it is reinstalled or removed by hand.

- **Scheduled tasks on Windows ran but recorded no output.** A task fired by
  Task Scheduler logged `exit_code=0` with an empty log: the command really
  ran, but nothing it printed was captured. Captured runs asked for their own
  process group, which is what lets a timeout reap the whole descendant tree
  on macOS/Linux; on Windows that same flag instead means "start with no
  console", and a console host started that way (`powershell.exe`, `cmd.exe`)
  allocates its own console and thereby replaces the pipes it was handed, so
  its output went nowhere. Windows got no reaping benefit in exchange — the
  group kill it enables is a POSIX-only call — so captured Windows runs no
  longer ask for it. A run whose output capture is incomplete for any other
  reason now says so in the task log instead of leaving a silent gap.
- **A scheduled shell task could fail instantly with exit code 1 on Windows.**
  Two defects on the default Windows task shell (`powershell`): a
  scheduler-fired run restores the PATH captured at install time, which can be
  minimal, and `powershell.exe` is not on it (it lives in a `WindowsPowerShell`
  subdirectory, not `System32`), so the spawn failed outright; and rebinding a
  bare leading `akm` produced a quoted path, which PowerShell parses as a
  string rather than a command to run. Both shells are now resolved to
  absolute paths on Windows, and a rebound invocation carries PowerShell's
  call operator. `cmd`-shell tasks additionally pass their hand-quoted command
  line through verbatim, since `cmd /s /c` does not read a standard argv.
- **`state.db` could fail to open on macOS** with "this platform has no
  descriptor-backed path." The descriptor-alias optimization used to bind a
  SQLite open to its exact held inode isn't reliably available everywhere —
  Windows never has one, and macOS's `/dev/fd` is a small fixed-size table
  that a process holding higher file-descriptor numbers (as a bundled
  standalone binary routinely does) can miss. The surrounding identity checks
  (dev/ino/uid, re-verified immediately before and after every open) are the
  real protection; a missing alias now falls back to the plain path on any
  platform instead of throwing, matching the fallback Windows already used.
- The Windows build shipped no embedded template assets, because the
  build-time asset copy anchored its rewrites on forward slashes while the
  glob yields platform-native separators.

## [0.9.2-alpha.5] - 2026-08-28

### Breaking changes & migration

- **Durable workflow plans bump to `irVersion` 5.** A stored run frozen
  before this release (`irVersion` 4 or earlier) can no longer `resume`,
  `next`, `complete`, or `run` — those fail closed with `UsageError` code
  `WORKFLOW_IR_VERSION_UNSUPPORTED`, naming the run and pointing at
  `akm workflow abandon`. `akm workflow status`, `akm workflow list`, and
  `akm workflow abandon` keep working on those runs — no data is lost, and
  their step spine is untouched by abandoning. **Before upgrading**, run
  `akm workflow list --active` and either let in-flight runs finish or
  abandon them; after upgrading, recover a blocked run with
  `akm workflow abandon <id>` followed by `akm workflow run <ref>` to start
  fresh from the current authored source. There is no second executor and no
  compatibility replay layer for a pre-`irVersion`-5 plan. The unit and gate
  input-hash prefixes bump alongside it, from `hashVersion` 5 to
  `hashVersion` 7, so that a freshly frozen plan's units are never
  content-addressed the same way an old, no-longer-executable plan's were.
  (`hashVersion` 6 existed only inside this release's own development and
  never shipped in any version — the durable step a released install sees is
  5 → 7.) The unit preimage also gains one **conditional** field,
  `taskInputs`: the *resolved* values of a task-composing step's input
  bindings, present only for a unit whose frozen target carries
  `inputBindings` — a binding-free unit's preimage keeps exactly the shape it
  had. Hashing the resolved values, not just the frozen binding expression,
  is what makes a resumed run whose upstream step output changed under a
  `{from: "steps.<id>.output"}` binding fail loudly as a replay divergence
  instead of silently reusing the completed unit's stale result.
  See [Migrating from akm 0.9.1 to 0.9.2](docs/migration/v0.9.1-to-v0.9.2.md#workflow-cutover).
- A workflow step that passes `with:` to a `tasks/<ref>` target whose task
  declares **no** `inputs:` (a `version: 4` task with no `inputs:` key at
  all) is now **rejected** (`UsageError` code
  `COMPOSITION_INVALID`, exit 2) instead of having the authored mapping
  silently dropped at freeze — for any authored shape, including `with: {}`.
  When the target's task source **does** declare `inputs:`, `with:` now
  **binds** them instead: a literal value, or a `{from: "steps.<id>.output…"}`
  reference resolved just before the unit dispatches (the reference grammar
  also accepts `{from: "params.<name>"}`, but a composing step's own
  document can never declare `params:`, so that form is not reachable in
  this release). See [Task input bindings](docs/reference/tasks.md#typed-inputs-and-output)
  for the full grammar. `with:` on `uses: akm/command` is unaffected — it is
  still that builtin's own action-argument bag, never an input binding.
- **New rejection:** `with:` on a workflow step targeting `uses:
  commands/<ref>` or `uses: scripts/<ref>` is now **rejected**
  (`COMPOSITION_INVALID`, exit 2) instead of being silently discarded at
  freeze — neither target is a binding surface. Remove the `with:` block from
  any such step; a command/script-composing step never accepted its values
  in the first place, so this closes a defect rather than a feature.
- Composing a task source v4 document from a workflow step's `uses:
  tasks/<ref>`, where the task's own target is a workflow, is no longer
  deferred: it now **freezes and dispatches** normally, the same as a
  direct `uses: workflows/<ref>` step. The prior release's
  `TASK_SOURCE_INVALID` "arrives in a later 0.9.x release" rejection for this
  case is gone.
- Task-source validation errors raised through the shared `sourceError`
  funnel (field- and semantic-level checks: missing/invalid fields, schedule
  conflicts, and similar) now report code **`TASK_SOURCE_INVALID`** instead of
  `INVALID_FLAG_VALUE`. YAML syntax, size, structure, and expansion failures
  (malformed YAML, oversized source, unsupported YAML constructs, and
  alias/tag/depth/node-count limits) are raised earlier, before that funnel is
  reached — early in this release these still reported `INVALID_FLAG_VALUE`,
  but by 0.9.2's release they report `TASK_SOURCE_INVALID` too (the terminal
  diagnostics ratchet, see the Changed entry below): task-source failures no
  longer split across two codes, so **scripts that were branching on both
  `TASK_SOURCE_INVALID` and `INVALID_FLAG_VALUE` for a task-source error can
  drop the `INVALID_FLAG_VALUE` arm**. Every such error's message prefix is
  `Invalid task source at <path>[:<line>]: …` — not `Invalid task v3 source`,
  since the label no longer names a specific schema generation (task source
  v4 is the only version `src/` accepts by release; see the "Task v3 sources
  no longer parse" entry below). The envelope's `error` message text and exit
  code 2 are unchanged for every task-source error. The envelope's `hint`
  field and the `detail` text `akm lint` and the akm-task adapter report for
  the same failure change from `… Run \`akm <command> --help\` to see
  accepted values.` to `… Fix the task source at the reported path and line,
  then re-run.`
- **Task-history / JSON-output `target.kind` vocabulary changed.** A prepared
  command (agent/LLM) run now reports `"command"` (formerly the confusingly
  inverted `"prompt"`); the former shared `"command"` string for the native
  arm splits into `"shell"` and `"script"`, now distinguishable in history;
  `"workflow"` and `"unknown"` are unchanged. **Consumers branching on
  `"prompt"` must handle `"command"`** — this affects `akm task run`'s and
  `akm task history`'s JSON output (`result.target.kind` /
  `rows[].target.kind`) and any code reading `task_history.target_kind`
  directly. Rows written by earlier akm versions are read back **mapped** to
  the new vocabulary (legacy `"prompt"` → `{kind:"command", engine}`, legacy
  `"command"` → `{kind:"shell"}`), so `akm task history` output stays uniform
  across vintages. New rows carry a `targetVocab: 2` marker inside their
  `metadata_json`, which akm versions before this one reject as an unknown
  metadata field — a mixed-version fleet must upgrade every `akm` that writes
  task history before an older one reads it.
- **Task source v4 (`version: 4`) is the task source grammar.** By 0.9.2's
  release, `version: 4` is the *only* version `src/` accepts — see the
  "Task v3 sources no longer parse" entry below for the cutover, the
  `TASK_SCHEMA_VERSION_UNSUPPORTED` rejection, and the migration path. What
  follows describes the v4 grammar itself. Scheduling is **optional**: a
  task source v4 document with no `schedule:` parses, is runnable with
  `akm task run`, and is **skipped** by `akm task sync` (zero bindings, zero
  failures) instead of being rejected for missing a trigger — this is now
  the *only* scheduling grammar; the second syntax task v3 offered
  (`akm.schedule` / a document's top-level `on:`) is retired along with v3
  itself. Task source v4 removes the `akm:` options bag and the `on:`
  trigger block outright;
  every field they carried is a top-level key instead: `akm.description` →
  `description`, `akm.when_to_use` → `when_to_use`, `akm.tags` → `tags`,
  `akm.agent` → `agent`, `akm.engine` → `engine`, `akm.model` → `model`,
  `akm.inference` → `inference`, `akm.outputSchema` → `output`,
  `akm.tools` → `tools`, `akm.timeout` → `timeout`, `akm.redact` →
  `redact`, `akm.maxSteps` → `maxSteps`, `akm.maxRetries` → `maxRetries`,
  `akm.schedule` → top-level `schedule:`, and `akm.enabled` → each
  `schedule:` entry's own `enabled` (v3's single document-level flag
  becomes per-binding in task source v4, defaulting to `true`; the
  document-level `enabled` skip that read it is gone with v3, since a v4
  document has no document-level `enabled` key to read). The GitHub-action
  `uses:` target (`owner/repo@ref`) is removed outright — see the "GitHub
  Action locators are no longer recognized anywhere" entry below.
  `with:` is legal in task source v4 only alongside
  `uses: akm/command`; every other target uses the new typed `inputs:`
  declarations instead of `with:`. A declared `inputs:` name may not collide
  with a flag `akm task run` already declares for itself (`bundle`, `format`,
  `detail`, `shape`, `output`, `scheduled`, `quiet`, `verbose`, `help`,
  `no-quiet`, `no-verbose`) or with `target`, the spelling `akm task`
  retired in 0.9 and still answers with a rename hint in every spelling —
  such a document now fails `TASK_SOURCE_INVALID` at parse time, since the
  colliding name would otherwise route a caller's value into `akm task run`'s
  own flag, or into that rename hint, instead of the declared input. `akm
  task run <id>` now accepts exact-name input flags for a task source v4
  document's declared `inputs:` (an undeclared flag name fails
  `UNKNOWN_FLAG`; a bad value or an unsatisfied `required: true` declaration
  fails `INPUT_BINDING_INVALID`; both exit 2 with the usual JSON error
  envelope).
  Where those materialized values go depends on the task's own target: for
  `uses: workflows/<ref>` they become the child run's params (the existing
  `with:` → params path); for a `run:`, `scripts/<ref>`, or `commands/<ref>`
  target they are validated and then **discarded** — `akm task run`'s own
  flags never populate an `AKM_TASK_INPUTS` environment variable or a
  `## Task inputs` prompt block. Those two surfaces are a separate delivery
  path: they carry a **workflow step's** `with:` binding into a task it
  composes via `uses: tasks/<ref>` (see the `with:`-binding bullet above),
  not `akm task run`'s own CLI flags. `schedule[].inputs` on a `version: 4`
  task source are compiled the same way `akm task run`'s flags are: `akm
  task sync` builds them into the scheduler binding's own invocation tail
  instead of only validating and discarding them, so a scheduled run is
  subject to the identical workflow-target-only delivery rule. `akm task
  add` now authors task source v4 (see the "Task v3 sources no longer
  parse" entry below for the `--params` → typed `inputs:` change). A
  `version: 4` task source is now a valid workflow-step target (see above).
  The published [task schema](schemas/akm-task.json) now publishes only the
  single `version: 4` shape — the `version: 3` arm and its `githubActionRef`
  definition are removed; a `version: 2` or `version: 3` document validates
  against nothing in this schema and is converted by `akm migrate apply`
  instead. **Binding a task's inputs adds nothing to the hash preimage of a
  step that binds none**: a unit whose frozen target carries no
  `inputBindings` has exactly the preimage *shape* it had before this
  feature — no `taskInputs` key at all. Its hash *value* still moves, because
  every unit and gate hash in this release re-versions once (`hashVersion`
  5 → 7, see the `irVersion` 5 entry above), and no pre-`irVersion`-5 plan can
  execute here to be compared against.
- **A task's `output:` is legal only with a command target.** `output:`
  alongside `run:`, `uses: scripts/<ref>`, or `uses: workflows/<ref>` now
  fails `TASK_SOURCE_INVALID` (exit 2) at parse instead of being accepted and
  never enforced: those runtimes decide success from the process exit code or
  from a child run's own status and consume no task-level response schema, so
  an authored contract there was silently unenforced. `uses: commands/<ref>`
  and `uses: akm/command` — the targets that forward it as the model's
  response schema — are unchanged. The published
  [task schema](schemas/akm-task.json) enforces the same rule, so an editor
  validating against it no longer green-lights a document `akm task run`
  refuses to load. Migration handles this for you: `akm migrate apply` drops
  an `akm.outputSchema` that sat on one of those three targets (it was inert
  in v3 as well — nothing ever read it there) and reports the drop as a
  notice on that file's plan entry rather than blocking the file.
- **A `schedule:` entry must be able to satisfy the task's declared
  `inputs:`.** A scheduled firing supplies no input flags, so a task
  declaring a `required: true` input — which may not also carry a
  `default:` — and a `schedule:` entry that names no value for it could only
  ever install a binding that fails at every firing. Such a document now
  fails `TASK_SOURCE_INVALID` (exit 2) at parse, naming the unsatisfied
  input, instead of syncing cleanly and failing once per fire. This covers
  every entry shape: the `schedule: "<cron>"` string shorthand and a list
  entry with no `inputs:` key are held to the same contract as one that
  authors `inputs:`. Give the entry an `inputs:` value for each named input,
  or declare a `default:` on the input instead. Manual-only tasks are
  unaffected — a `required: true` input with no `schedule:` is still valid
  and is supplied per run with `akm task run <id> --<name> <value>`.
- **`akm workflow create --json` renames its `stashDir` envelope field to
  `bundleDir`.** The success envelope now reads
  `{ok, ref, path, bundleDir}`; the value (the owning bundle's directory) is
  unchanged. Scripts reading `stashDir` off `akm workflow create --json`
  must read `bundleDir`. This was the last `stash`-vocabulary field on a
  0.9.2 command envelope; the indexer's internal `IndexOptions.stashDir` is
  not a CLI surface and is unchanged.
- **Task v3 sources no longer parse.** A task document with `version: 3`
  (or `version: 2`) fails with `UsageError` code
  `TASK_SCHEMA_VERSION_UNSUPPORTED` (exit 2) instead of executing — the v3
  parser is gone from `src/`; it survives only vendored inside the
  `akm-migrate` executable, which is how the migrator still reads what it
  converts. Run `akm migrate apply --dry-run`, review every `changed` /
  `skipped` / `blocked` result, then `akm migrate apply` — the command now
  runs **both** generations in one pass: task-v2 → task-v3, then
  task-v3 → task source v4, against the same tree. `akm task add` authors
  task source v4 directly; a task's `--params` becomes typed `inputs:` with
  defaults instead of a `with:` bag. A task's enabled state is now per
  schedule binding (`schedule[].enabled`) rather than a document-level
  `akm.enabled` flag — `akm task add --disabled` writes
  `schedule: [{cron: …, enabled: false}]` instead of a document-level
  `akm.enabled: false`. See
  [Migrating task v3 to task source v4](docs/migration/v0.9.1-to-v0.9.2.md#migrating-task-v3-to-task-source-v4).
- **GitHub Action locators are no longer recognized anywhere.** A task's
  `uses: owner/repo[/path]@rev` is now a source error at parse
  (`TASK_SOURCE_INVALID`); a workflow step's `uses: owner/repo[/path]@rev`
  now fails with reason `unsupported-uses-target` instead of
  `remote-action-acquisition-out-of-scope`. Nothing acquired or executed a
  remote action in any akm release — this deletes the *recognition* of the
  shape, not a capability that ever worked. The migrator still names the
  target explicitly when it blocks a file
  (`github-action-target-removed`).
- **Multi-job YAML is rejected at the adapter boundary.** A GitHub-shaped
  workflow document whose `jobs:` map does not contain exactly one job now
  fails at the source adapter with reason `multi-job-unsupported`, surfaced
  from `akm workflow run` (and `akm workflow plan`) as `UsageError` code
  `COMPOSITION_INVALID` (exit 2). Previously such a document parsed and
  ordered its jobs cleanly and was refused only later, in two different
  places, with two different shapes (one thrown error, one `ok: false`
  compile result). Split a multi-job document into separate single-job
  workflows and compose them with a child-workflow step
  (`uses: workflows/<ref>`). Every other workflow-source compile failure now
  reports `UsageError` code `WORKFLOW_SOURCE_INVALID` rather than
  `INVALID_FLAG_VALUE`.
- **The second task scheduling syntax is removed.** `akm.schedule` and a
  task document's top-level `on:` are gone along with task v3 (see "Task v3
  sources no longer parse" above); task source v4's optional top-level
  `schedule:` is the one canonical scheduling form, and a task with no
  `schedule:` is manual-only and fully composable as a workflow-step
  target.

### Changed

- **`INVALID_FLAG_VALUE` is now rare in task or workflow domain failures,
  with two named exceptions.** Every task-source, workflow-source,
  target-classification, and composition failure now reports a
  phase-specific code — `TASK_SOURCE_INVALID`, `TARGET_REF_INVALID`,
  `COMPOSITION_INVALID`, `WORKFLOW_SOURCE_INVALID`, `INPUT_BINDING_INVALID`,
  `TASK_SCHEMA_VERSION_UNSUPPORTED`, or `TASK_TARGET_UNSUPPORTED` — **except**
  a task's workflow-target `env:` composition rejection (a `uses:
  workflows/<ref>` task that also authors `env:`) and a workflow child-ref
  asset-resolution failure (`Workflow source target <ref> was not found.`),
  both deliberately preserved as `INVALID_FLAG_VALUE` so an existing pinned
  test's code and message stay byte-unchanged. The remaining
  `INVALID_FLAG_VALUE` sites in the task/workflow domains (38 total, across
  `src/tasks/**` and `src/workflows/**`) are these two preserved exceptions
  plus scalar CLI-argument parsing (a cron expression, a task id, a workflow
  parameter flag) and one code-allowlist membership entry — genuine
  flag-value validation or a pinned exception, not a re-codable
  task/workflow source or composition failure. **Scripts branching on
  `code` for a task/workflow domain error should switch on the specific
  code above rather than assuming `INVALID_FLAG_VALUE` — except for the two
  named exceptions, which still report `INVALID_FLAG_VALUE`.** Exit codes
  are unchanged (2 for every one of these).
- **A typed task-input or workflow-param flag no longer echoes the supplied
  value in a validation error.** `akm task run <ref> --<input> <value>`
  against a `type:`-declared input used to report
  `must be <types>; received "<value>"` on a coercion failure, and a value
  that failed its declared `enum:`/`minimum:`/`maximum:` constraint reported
  the value in that message too — both are closed now, since a typed flag
  can carry a credential and this detail lands in stderr envelopes that get
  pasted into CI logs and issue reports. The declared constraint (the
  allowed list or the bound) is still named, since it comes from the
  author's own schema rather than the caller's data. Error and exit codes
  are unchanged.

### Added

- **Child workflows.** A workflow step can now compose another workflow —
  directly (`uses: workflows/<ref>`) or through a task source v4 document
  whose own target is a workflow (`uses: tasks/<ref>`) — instead of
  failing to freeze. `with:` on the composing step binds the child's
  declared `params:`. Composition is bounded: depth (8 levels), a
  composition cycle, and aggregate embedded plan bytes (1 MiB total across
  one root freeze) are all checked at **freeze**, before the parent run is
  published, and fail with `UsageError` code `COMPOSITION_INVALID`. The
  child workflow is compiled, validated, and frozen **completely** — its own
  complete plan embedded inside the parent's — before the parent run exists,
  so editing the child's source afterward cannot affect an already-frozen
  parent, and the child's transitive sources join the parent's guarded
  source read set. A composing step's own `env:` is rejected at freeze
  (`UsageError` code `COMPOSITION_INVALID`) rather than silently dropped —
  a child run carries its own frozen environment inside its own plan, so a
  parent-level `env:` on the composing step has nothing to apply to.
  Running a step that composes a child workflow now drives
  the child to completion — see **Child workflows now execute** and
  **Workflow `outputs:`** below. (Correction: an earlier development
  increment of this same 0.9.2 release briefly made an unexecuted composing
  step fail closed with `UsageError` code
  `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`. That code never reached a release
  and is gone from the shipped 0.9.2 — it is listed here only because a
  0.9.2 pre-release snapshot may otherwise be the sole place it was seen.)
  See
  [Workflow Schema: Child workflows](docs/reference/workflow-schema.md#child-workflows).
- **Child workflows now execute.** Running a step whose target is a child
  workflow drives that child inline, in the parent's own process, with the
  same engine `akm workflow run` uses — publication is idempotent, so a
  retried or resumed composing step reuses the same child rather than
  starting a new one. The child's final status maps onto the composing
  step and the parent run: `completed` promotes the child's exported result
  as the step's output and the parent continues; `failed` fails the step
  and the run; `blocked` blocks the step and the run, with recovery notes
  naming the exact sequence — `akm workflow resume <childRunId>`, then
  `akm workflow resume <parentRunId>` and `akm workflow run <parentRunId>`.
  `akm workflow status` on a run that composes children now renders a
  `children:` tree; `akm workflow list` excludes child runs by default
  (`--children` includes them), and a child run id always works directly
  with `status`/`resume`/`abandon`/`run`. See
  [Workflow Schema: Child execution](docs/reference/workflow-schema.md#child-execution)
  and [Running Workflows: Child runs](https://github.com/itlackey/akm/blob/main/docs/guides/run-workflows.md#child-runs).
- **Workflow `outputs:`.** A workflow may declare a run-level export in its
  Markdown frontmatter — `outputs: {<name>: {from: steps.<id>.output(.<seg>)*,
  schema?}}`, up to 64 entries — resolved once, from persisted step
  evidence, at run completion. An unresolvable reference, a truncated
  step artifact, or a schema violation rolls the completion back
  (`UsageError` code `WORKFLOW_OUTPUT_INVALID`): the run stays `active` and
  its final step stays `pending` rather than completing with missing
  exports. A run with no `outputs:` declaration exports `{runId, status}`
  instead. This is a Markdown-frontmatter-only key — a GitHub-shaped
  workflow's closed root key set has no extension surface for it, the same
  reason it cannot declare `params:` either. See
  [Workflow Schema: Workflow outputs](docs/reference/workflow-schema.md#workflow-outputs).
- **`akm workflow plan <ref>`** (Evolving) — compiles, resolves, and freezes
  a workflow exactly as starting a run would, then stops: zero durable
  writes, no published run, no event, no lease. Prints the canonical step
  graph, per-step frozen target kinds, task/child expansion, input
  bindings, the source read set, and freeze-time lowering notices —
  secret-free by construction (no resolved reference value, request
  content, script bytes, or credential is ever printed). Defaults to a
  human-readable summary; `--format json` returns the full envelope. See
  [CLI reference: workflow plan](docs/reference/cli.md#workflow-plan).
- **`akm task explain <ref> [input flags]`** — read-only task introspection.
  Prints the task's source path and version, its declared `inputs:` (with
  defaults — a secret-shaped default prints as `<redacted>`), the supplied
  values with provenance (`default` | `flag` | `schedule-binding`, likewise
  redacted when secret-shaped), the resolved target kind/ref, effective
  execution settings with field-level provenance, and schedule bindings.
  Never spawns anything, writes history, or touches the scheduler; never
  prints an `env:` value, a credential, a prompt body, a `run:` string, or
  `with.content`. It accepts the task's own declared input flags and nothing
  else: `--scheduled` — which `explain` neither declares nor implements —
  fails `UNKNOWN_FLAG` (exit 2) rather than being silently discarded, in
  every spelling (`--scheduled`, `--scheduled=false`, …). See
  [CLI reference: task](docs/reference/cli.md#task).
- **`AKM_TASK_INPUTS`** — the exec-context environment variable a
  task-composed step's shell/script target receives: canonical JSON of its
  resolved, schema-validated `inputs:` bindings. Present only when the
  bindings are non-empty; subject to the same per-platform size ceiling as
  `AKM_INPUTS` / `AKM_PARAMS`. See
  [Context reaching the command](docs/reference/workflow-schema.md#context-reaching-the-command).
- **A v3 → task source v4 migrator**: the separate `akm-migrate` executable
  (installed alongside `akm`) gains `task-v4-status` / `task-v4-apply
  [--dry-run]`, a second, independent generation of the same dry-run-first,
  `changed | skipped | blocked` migration planner — options bag flattened to
  top-level keys. A `with:` authored on any target other than
  `uses: akm/command` is `blocked` for manual review, alongside a
  github-action-targeted `uses:` (blocked reason
  `github-action-target-removed`) and anything else ambiguous: the migrator
  translates structure, never intent, so `inputs:` is never invented on a
  file's behalf — declaring it is an authoring decision left to the person
  editing the migrated file. Nothing is overwritten without a backup. A
  `changed` file can carry an informational **notice** for a translation that
  is faithful but not one-to-one — a manual-dispatch-only trigger that v4
  expresses as "no `schedule:`", and an `akm.outputSchema` dropped because v4
  accepts `output:` only with a command target — so read the notices on a
  dry-run plan, not just the outcomes. A v3 document that was never valid in
  the first place (an empty `on:`, or a `workflow_dispatch:` carrying
  `inputs:`) is `blocked` as `invalid-v3-task` rather than being converted
  into runnable v4 bytes. By
  0.9.2's release this generation runs automatically as the second half of
  `akm migrate status` / `akm migrate apply [--dry-run]` (see "Task v3
  sources no longer parse" above) — `task-v4-status`/`task-v4-apply` remain
  as the standalone, single-generation entry points the frozen migrator
  always exposes. See the
  [0.9.1 to 0.9.2 migration guide](docs/migration/v0.9.1-to-v0.9.2.md#migrating-task-v3-to-task-source-v4).

### Fixed

- **A flag value for a parameter or input declaring both `array` and a
  scalar type is no longer forced into an array.** `akm workflow run <ref>
  --<param> <value>` (and, new in this release, `akm task run <id>
  --<input> <value>`) unconditionally grouped a supplied value into an array
  whenever the declaration mentioned `array` at all, so
  `type: ["array", "string"]` with `--x hello` delivered `["hello"]` instead
  of the permitted string, and `type: ["array", "null"]` could never produce
  `null` — silently, since the altered value still satisfied the array
  branch. A single, non-bracketed value now tries the union's scalar
  alternatives first. An `array`-only declaration, the JSON-array shorthand
  (`--x '["a","b"]'`), and grouping a repeated flag are all unchanged.
- **`akm task <subcommand> --target=<value>` now answers with the 0.9 rename
  hint instead of ignoring the flag.** The retired-spelling check compared
  whole argv tokens, so it caught a bare `--target` but not `--target=team`;
  because `target` is exempt from the generic unknown-flag gate on `task`
  subcommands precisely so that check can answer, the `=`-spelling was
  rejected by nothing at all and the bundle the caller named was silently
  dropped. It now fails with `UsageError` code `INVALID_FLAG_VALUE` (exit 2)
  naming `--bundle`, in every spelling.
- **The embedded `akm` hint sheet no longer teaches a task format this
  release rejects.** Its "Scheduled Tasks" section still told readers to
  author `version: 3` with `akm.enabled` and `akm.timeout`; it now describes
  task source v4 (`version: 4`, per-entry `schedule[].enabled`, top-level
  `timeout`, typed `inputs:`/`output:`) and points at `akm migrate apply`.
  The `stash`-terminology doc lint now scans the shipped hint assets too, so
  the embedded help cannot drift out of the active-docs vocabulary again.
- **The macOS native scheduler backend no longer refuses a real
  `launchctl` inventory.** Its loaded-service reader enforced a narrow,
  hand-written grammar over `launchctl print`'s full output and rejected
  the entire read — surfacing as `INVALID_CONFIG_FILE` from every akm
  scheduler command — the moment any line fell outside it, which real
  `launchctl` output on a real Mac routinely does. It now scans for akm's
  own `com.akm.task.*` labels and ignores everything else, which is what
  every caller actually needed. Caught by the gated native-scheduler
  suite's first run against macOS.
- **The Windows-built package no longer ships without its embedded
  template assets.** The build's asset-copy step matched paths against a
  forward-slash pattern, but path separators on Windows are backslashes,
  so the match silently failed and `dist/assets/` was never populated —
  the packaged npm tarball built on Windows carried no templates at all,
  and any command rendering one (for example `akm health --format html`)
  crashed with `ERR_MODULE_NOT_FOUND`. Also caught by the gated
  native-scheduler suite's first run, this time against Windows.

## [0.9.2-alpha.4] - 2026-08-26

### Added

- **`akm health`: flag assets whose resolved type disagrees with their
  directory** (#837). Adds a `type-directory-disagreement` advisory that
  compares every indexed asset's resolved type against the type its
  `DIR_TYPE_MAP` directory declares (`memories/`, `knowledge/`, `commands/`,
  `agents/`, `workflows/`, `facts/`, `lessons/`, `sessions/`,
  `instructions/`, `scripts/`, `env/`, `secrets/`, `tasks/`). This is the
  diagnostic that would have caught #824 (three `memories/` files silently
  indexed as commands) the day it was introduced. Since `knowledge/` +
  `$ARGUMENTS` and `agents/` + `agent:` frontmatter are deliberate command
  overrides, the check never hard-fails: every disagreement is reported as a
  warning naming the winning classifier signal, with a `knownGoodOverride`
  flag so a sanctioned override reads differently from an unexplained one.
- **`akm health`: report the Claude harness plugin's version and warn when
  it's stale or out of range** (#838). Adds a `plugin-version` advisory that
  reports each installed Claude Code `akm` plugin's version, warns when a
  newer tag is published upstream (naming the update command), and warns
  when the plugin's own declared `AKM_VERSION_RANGE` no longer admits the
  running CLI — meaning the plugin has silently disabled itself. Makes an
  outbound `git ls-remote` when network is available to check for a newer
  tag; per owner decision, this is read-only and degrades to a benign pass
  (no plugin, no marketplace clone, unreadable manifest, malformed range, or
  a failed remote lookup) rather than crashing or blocking offline use.

### Changed

- **Extract: LLM prompt is now built from parent-origin events only —
  "harvest-without-prompting hybrid" (#840).** #830 folds a session's
  subagent transcripts into its event stream for hashing and inline-ref
  harvesting; the prompt sent to the extraction LLM previously included that
  folded subagent content too, competing with the parent's own transcript
  for the 80,000-char pre-filter budget. #840's design-determination doc
  (`docs/plans/subagent-extraction-design.md`) measured that this "fold"
  approach evicts up to 28.6% of parent-origin content on real sessions to
  make room for subagent noise that mostly gets evicted anyway, while a
  "harvest-without-prompting hybrid" — keep folding for hashing/inline-ref
  purposes, but filter the prompt down to `data.events` whose `filePath`
  matches the session's own (`data.ref.filePath`) — matches or beats the
  folded prompt's size with zero eviction on every session measured, and
  recovers the exact same inline refs (`akm remember`/`akm feedback` calls
  the agent made inside a subagent), because that harvesting already runs on
  the raw stream independent of what reaches the prompt. Only
  `runPreLlmSessionGates`'s call into `preFilterSession` changed; folding
  (`session-log.ts`) and `buildExtractPrompt` are untouched.
  - **No forced re-extraction wave.** `hashSessionContent` still hashes the
    full folded `data` (parent + subagents), computed before the
    parent-origin view is built — no previously-computed session hash
    changes, so no session already extracted under the fold prompt shape is
    automatically re-processed. Use `--force` to re-process a specific
    session under the new, parent-only prompt shape.
  - **`processes.extract.maxTotalChars` is unchanged in meaning and default**
    — it still caps the single-call prompt built from parent-origin events;
    it simply no longer has to compete against subagent-origin noise for
    that budget.
  - **`minContentChars`** (the raw-size skip gate, #595/#596) is still
    measured on the FULL folded `data.events` (parent + subagents),
    deliberately left unchanged: narrowing it to parent-origin chars would
    newly skip delegation-heavy sessions with a thin parent transcript
    before extraction runs at all, even though their subagent-origin work is
    still fully harvested via inline refs. The full-stream measurement is
    today's existing behavior; the worst case it preserves is an LLM call
    over a small parent-only prompt, not a missed extraction.
  - #839's task-notification dedupe (which stubs a parent's
    `<task-notification>` only when the matching subagent's own event ALSO
    survives into the same kept prompt set) composes safely with this
    change without modification: subagent-origin events never reach
    `preFilterSession` on this path, so the dedupe's own scoping check
    naturally makes it a no-op — the parent's notification (the only
    remaining trace of delegated work in the prompt) survives untouched.

### Fixed

- **`akm remember` synthesizes a description when the caller doesn't supply
  one** (#835). Both the zero-flag hot path and the structured-args path
  (e.g. `--tag`-only, with no `--description`/`--enrich`) previously wrote
  memories with no `description:` and no `tags:`. akm's indexer covers only
  synthesized frontmatter/headings, never body prose, so those memories were
  retrievable only by whatever words survived into the auto-generated
  filename — effectively write-only. Verified on a real stash: 272/3169
  memories lacked a description, 100% of those written via `akm remember`.
  The new `synthesizeMemoryDescription` (ported from akm-eval's
  `firstSentencesCapped` rule, which independently arrived at the same fix)
  is deterministic and makes no LLM call: it accumulates whole sentences
  from the body up to `DESCRIPTION_MAX_CHARS`, skipping a leading markdown
  heading so the description doesn't just repeat the title. Wired into both
  write paths as a fallback only — a caller-supplied `--description` (or one
  derived by `--enrich`) is never overwritten. Closes the write-only-memories
  gap on 0.9.1 indexes.
- **Extract: deduped the doubled subagent conclusion in the extraction prompt**
  (#839). After #830 folded a session's subagent transcripts into its event
  stream, a completed subagent's final report could appear twice in the same
  extraction prompt: once as the subagent's own folded final message, once as
  the parent's `<task-notification>` record of that same call (#836 measured
  ~92-99% textual overlap on a real pair; reproduced here as a byte-identical
  match after decoding the XML entities Claude Code escapes into `<result>`).
  The parent's notification copy is now stubbed to `[subagent <agentId>
  completed: <description>]` when its `<result>` is a near-duplicate
  (Dice-bigram similarity ≥ 0.9) of a folded subagent transcript's own text;
  the subagent's original is untouched, per #839's owner-decided direction
  (the inverse — dropping the subagent's own terminal event — was evaluated
  and rejected in #836 because some subagent transcripts consist only of
  that one event). Matching is scoped by `<task-id>` to the one subagent
  transcript it names and still requires content similarity, so an earlier
  notification for a *resumed* agent (Claude Code re-notifies the same
  task-id on each stop) that carries a genuinely different, intermediate
  result is left alone.
  **Scoped to the final, post-budget kept set — not the raw stream** (#840's
  design-determination doc flagged this as a hazard while this PR was in
  flight): the dedupe only fires when the subagent's own event ALSO survives
  into the same kept set as the notification. #840 measured that today's
  recency-biased 80k budget already evicts one side of nearly every raw
  duplicate pair before dedupe would matter (0 of 89 raw pairs across four
  real sessions had both sides survive); an unconditional raw-stream stub
  would, under that same eviction pattern, sometimes delete a parent's
  notification whose subagent copy never made the cut in the first place —
  and would unconditionally delete the *only* surviving trace of delegated
  work under #840's recommended future design (prompting from parent-origin
  events only). Verified against the real session #836 and #839 both cite
  (`4a0d9e9b…`): under the actual 80,000-char budget, 0 notifications are
  stubbed today (consistent with #840's finding) because the cited pair's
  subagent copy doesn't survive the budget; with the budget cap lifted,
  1 of 10 raw duplicate pairs in that session both survive AND still exceed
  the 0.9 similarity bar after the pre-filter's independent per-event
  2000-char truncation (the other 9 exceed that per-event cap and truncate
  down far enough to fall below the bar — a conservative miss, never a wrong
  stub). The fix is real and correct for sessions/pairs small enough to avoid
  both eviction and truncation, and is structurally inert wherever it would
  be unsafe to fire.
  Implemented in the pre-filter (`preFilterSession`), which runs AFTER
  `hashSessionContent` — so **no `contentHash` moves and no re-extraction
  wave is triggered** (unlike #830's own folding change, which changed the
  raw event stream #602's hash covers).
- **Extract: regression-tested the no-double-extraction guarantee** (#839).
  Discovery-mode extraction over a project with a parent + subagent
  transcripts now has an explicit end-to-end test proving exactly one
  session is processed, that `--session-id agent-<hash>` resolves to the
  not-found result rather than an extraction, and that folded subagent
  content is attributed only to the parent's session/contentHash. Pins
  behavior already true since #830 (`listSessions()` excludes `subagents/`
  dirs for both discovery and `--session-id` lookup); nothing tested it
  end-to-end before.

### Documentation

- **Measured whether subagent-transcript folding (#830) duplicates the
  parent's own summary, and disclosed the one-time re-extraction cost
  (#833).** Using the actual reader/pre-filter/prompt-builder code against 3
  real sessions on this machine — no LLM calls; `contentHash`,
  `preFilterSession`, and `buildExtractPrompt` are deterministic:
  - Raw event counts grow 2x-12x once subagent transcripts are folded in
    (measured: 1209 -> 14224; 1583 -> 6738, the exact session cited in
    #829/#833's "1583 -> 6738" figure; 155 -> 2408). `contentHash` is
    computed over that stream, so every previously-extracted session's hash
    changes and the next `--since` run re-extracts all of them once, each
    with a larger prompt (+1.2% to +5.2% prompt chars across the 3 sessions,
    since the 80,000-char pre-filter budget caps how much of the growth
    actually reaches the LLM).
  - The result is a genuine tradeoff, not a clean win or loss. **Benefit:**
    inline `akm remember`/`akm feedback` calls made *by subagents* are
    recovered regardless of the budget cap (inline-ref extraction runs on
    the raw event stream, not the pre-filtered one) — up to 162 refs
    recovered on the largest session measured (was 2 without folding),
    fixing #829's "delegated work is never harvested" defect. **Cost:** on
    sessions whose raw content is near or under the pre-filter's character
    budget, folding evicts a large share of the parent's own kept content to
    make room for subagent tool-call trace — parent-origin kept events
    dropped 27% and 71% respectively on the two smaller sessions measured.
    On the largest session the budget was already saturated by the parent's
    own tail, so folding changed nothing there. Duplication is real, not
    hypothetical: on the smallest session, one subagent's conclusion appears
    twice in the same prompt sent to the extraction LLM — once via its own
    folded final message, once via the parent's own record of that
    delegated call's result, which independently already captured ~92% of
    the same text verbatim.
  - A narrowing that drops a subagent transcript's terminal event (its
    apparent "final report") to avoid this specific duplication was
    considered and rejected: the existing #830 regression fixture has a
    subagent transcript whose *only* event is that terminal turn (a single
    delegated `akm remember` call) — the same rule would drop the only
    content in short single-step delegations, undoing the harvesting #830
    added.
  - **Decision: keep folding as shipped.** The data does not cleanly favor
    removing or narrowing it, and the one narrowing considered would cost
    more than it fixes. #829's phantom-session exclusion is unaffected
    either way.
- Recorded the fold-vs-link subagent-extraction design determination in
  `docs/plans/subagent-extraction-design.md` (#840). Measured four candidates
  (fold+dedupe as shipped, link-only, a harvest-without-prompting hybrid, and
  chunked map-reduce extraction) on the same real sessions #836 used plus one
  added for scale. Headline: the hybrid recovers 100% of #830's inline-ref
  harvesting (162/162, 38/38, 1/1, 8/8 across the four sessions) with zero
  parent-content eviction (vs 27.5%/28.6% evicted under fold on two of the
  four), and #839's dedupe was measured to have zero effect on the actual
  LLM prompt on all four sessions (the flagged duplicate content is already
  evicted by the recency-biased budget before dedupe would matter). Chunked
  extraction was measured at 9x-229x more LLM calls per session on real
  data and is not recommended. No behavior changes shipped in this PR.

## [0.9.2-alpha.3] - 2026-08-26

### Fixed

- **Currency in prose no longer retypes an asset as a command** (#824). The
  smart-Markdown classifier matched `$1`/`$2`/`$3` with a trailing word
  boundary, and that boundary sits between the `2` and the comma in `$2,000` —
  so any note quoting a price was indexed as a `command`, its ref moved to
  `commands/<dir>/<slug>`, and it left its own namespace. Measured on a real
  corpus, 3 of 51 memory documents were affected, and those 3 were exactly the
  3 whose bodies matched. `$ARGUMENTS` is unambiguous and keeps its existing
  precedence over a directory hint; the numeric placeholders now exclude a
  following digit (or a `.`/`,` followed by one), and where they still
  disagree with a directory that declares a type, the declaration wins. The
  defect is present identically in 0.9.1 — it only became visible once the
  0.9.2-alpha.2 retrieval work let mistyped assets surface in results.

### Documentation

- Recorded the 0.9.2 retrieval measurement in
  `docs/plans/benchmark-tuning-findings.md` §2e (#825). Retrieval-only probes
  with no model in the loop, identical corpora, only the CLI version differing:
  LoCoMo zero-hit 75.0% -> 0.0% and evidence recall@5 0.154 -> 0.590;
  LongMemEval zero-hit 100% -> 0.0% and recall@5 0.000 -> 1.000.

## [0.9.2-alpha.2] - 2026-08-25

### Fixed

- **Retrieval:** relaxed zero-hit lexical queries centrally, stabilized
  relaxed-retrieval quality, and preserved name quality through relaxed
  ranking. This is the change measured in §2e above — it is what lifted the
  retrieval ceiling that had floored memory-backed evaluation.
- **Indexing:** verify vec completeness before promotion; compare vec IDs as
  exact sets; materialize vectors for targeted writes; make nested entry
  mutation atomic; reconcile clean before final verification; restore static
  embedding imports.
- **Markdown projection:** parse nested links safely, parse destination
  phases, and project with stateful delimiters.
- **Sources:** reconcile local bundle updates and report incomplete filesystem
  reconciliation.
- **Extract:** keep malformed model output retryable.

### Performance

- Keep targeted embedding selection narrow and preserve targeted vec
  degradation.

## [0.9.2-alpha.1] - 2026-08-24

### Breaking changes & migration

- **Node.js 22 is no longer supported by the npm package.** `akm-cli` now
  requires Node.js >= 24 to bootstrap its command. A working Bun >= 1.0 remains
  optional and preferred for execution after that bootstrap; the standalone
  binary remains runtime-free. Upgrade Node before installing or running the
  npm package.
- The `inherit_env` option is a breaking removal: new durable-v4 workflow starts reject it.
  Replace ambient whole-process inheritance with exact named environment bindings and
  `exec.pass_env` names. Pre-v4 stored workflow plans are not executable in
  0.9.2; start a new run from current source.
- `improve.strategies.*.processes.triage.judgment` now accepts `true`/`false`
  and honors `enabled` on object values; existing `{}` and configured objects
  remain enabled. Unknown object keys are now rejected instead of ignored, so
  correct typos such as `egnine`, `judgement`, or other unrecognized fields
  before upgrading. Use `judgment: false` to disable the tier explicitly.

### Added

- **WP0 — characterization and release contracts:** pinned direct-agent,
  command, task, workflow-freeze, model-alias, and harness-lowering behavior;
  added cross-entry-point equivalence fixtures and immutable release-surface
  gates.
- **WP1 — shared execution contracts:** introduced adapter-rendered source
  identity and one resolved-request representation carrying final content,
  engine/model/inference selection, authorization, runtime settings, source
  hashes, and structured lowering notices.
- **WP2 — layered model maps:** ship a versioned installed `models.json`, merge
  an optional user overlay from the config directory, expand known aliases by
  engine, pass unknown identifiers through exactly, and provide guarded model
  map initialization.
- **WP3 — common cascade and authorization:** resolve far-to-near defaults once,
  preserve explicit false/zero/empty values, authorize selected tools before
  dispatch, and expose stable field-level provenance without resolved values.
- **WP4 — portable command execution:** added canonical
  `akm command run <ref>`, implemented one-pass `$ARGUMENTS` substitution, and
  reject unsupported native template constructs before dispatch. Stored
  commands have one execution surface; `akm agent --command` is not retained.
- **WP6 — task v3:** added the strict shipped task schema, command/workflow/script
  targets, closed shell and working-directory rules, portable schedules, and a
  fail-closed task-v2 migrator with no-write preview, per-file status, backups,
  validation, and blocked argv-array handling.
- **WP7 — peer workflow sources and durable v4:** compile Markdown and the
  approved GitHub-shaped `.yml` subset through source IR v1; new runs atomically
  persist immutable v4 targets, guarded source reads, symbolic environments,
  and durable dispatch attempts. Pre-v4 stored plans are rejected rather than
  maintaining a second runtime.
- **WP8 — release diagnostics:** added zero-write, secret-safe command dry-run
  output, stderr-only verbose provenance, offline `selected-model-aliases` and
  `configured-engines` health advisories, self-contained migration guidance,
  and npm tar/install/link release gates.

### Changed

- **WP5 — engine lowering convergence:** direct command/agent execution,
  improve/proposal dispatch, tasks, and workflows now share the resolved-request
  boundary and implementation-derived lowerers. Exact model and inference
  settings reach registered harnesses; unsupported fields produce safe notices,
  while provider capability rejection remains a runtime result.
- Scheduled workflow fires re-read the current peer source and create a fresh
  durable-v4 freeze. Resume remains journaled replay, and crash recovery uses
  at-least-once attempt semantics with stable reclaim identities.
- Task scheduler synchronization is transactional across supported adapters and
  preserves exact ownership, rollback evidence, enabled state, parameters,
  timeouts, redaction metadata, and resolver overrides.

### Fixed

- Ordinary managed database opens no longer silently apply released migration
  `018-drop-dead-lane-schema`, which drops retired tables and a column. Every
  state migration now has an explicit safety classification; migration 002's
  row-preserving table rebuild remains automatic, while migration 018 requires
  a successful `akm upgrade` and a verified sibling SQLite snapshot created
  immediately before its immutable SQL runs. The ledger recheck, WAL-inclusive
  snapshot, and 018 transaction now share one writer-exclusion window; fresh
  files and randomized backup paths are atomically reserved and inode-verified.
  Pre-existing unversioned files—including an absent or empty migration
  ledger—are rejected without writes by ordinary opens and snapshotted before
  migration 001 by explicit upgrade. That snapshot, ledger initialization, and
  migrations 001–002 share one writer-exclusion transaction, preventing an old
  schema writer from landing data between the snapshot and the 002 rebuild.
  Migration locks now reject phantom `BEGIN IMMEDIATE` results before running
  SQL and fail clearly if the transaction disappears after a body. Snapshot
  source and target handles are inode-bound, and failed reserved paths are
  retained rather than removed by raced cleanup.

## [0.9.1] - 2026-08-18

### Fixed

- Preserve multiline frontmatter descriptions when `akm lint --fix` quotes
  colons, recover already-malformed quoted descriptions, and report a fix only
  when the file actually changes.
- Skip consolidation promotion proposals whose body already exists in a live
  knowledge asset, preventing exact-content duplicates from recurring in the
  proposal backlog.
- Derive utility `last_used_at` values only from real user retrieval events
  (`search`, `show`, and `curate`) instead of stamping assets with index time.
- Compute the salience-distribution health metric over every positive,
  non-missing salience value rather than a top-ranked 100-row slice, and report
  the evaluated sample size.

## [0.9.1-beta.2] - 2026-08-17

### Breaking changes & migration

The 0.9.x series carries breaking changes as it works toward the 0.10.x
stabilization line. Every item here is detailed further down; this section is
what an upgrader reads first.

- **A data directory akm cannot READ is now an error, not an empty result.**
  Commands that previously returned `hits: []` / `entryCount: 0` / "nothing
  eligible" at exit 0 for an index, lockfile or database they lacked permission
  on now raise `DATA_DIR_UNREADABLE` (exit 78) naming the path, errno, mode,
  owner and running uid. *Affected:* anyone whose data dir is partly unreadable
  — most often a `$XDG_DATA_HOME` shared across uids. *Remedy:* fix the
  ownership or mode the error names, or point `AKM_DATA_DIR` somewhere this
  user owns. The old behaviour was a false success, so a script that treated
  exit 0 as "no results" was already being lied to.

- **Lockfile writes refuse to run against an unreadable `akm.lock`.**
  `akm bundle add` / `remove` / `update` now fail closed instead of reading the
  lock as empty and writing the single incoming entry over the whole record.
  *Remedy:* as above. This one prevented real data loss — see Fixed.

- **`akm workflow run` exits 1 when a run ends `blocked`.** Previously 0.
  *Affected:* CI steps and scheduled wrappers that branched only on `failed`.
  *Remedy:* treat nonzero as "not verified"; resume with
  `akm workflow resume <id>`.

- **`akm index --clean` no longer deletes entries whose file it cannot read.**
  It keeps and names them. *Affected:* anyone relying on `--clean` to prune
  aggressively; it is now conservative where it cannot see.

- **Workflow documents are bounds-checked at authoring time.** `engine:` name
  grammar, `retry.max` 0–100, `gate.max_loops` 1–100, `map.concurrency` and
  `engines.<name>.concurrency` 1–64, and any `timeout:` ≤ 2 147 483 647 ms are
  now enforced by the parser. *Affected:* documents that parsed at 0.9.0 but
  could never actually run — the frozen-plan decoder already refused them.
  *Remedy:* edit the offending field; the error is now line-anchored.

- **`akm health` no longer emits `secret-file-perms`, and no longer exits 4 for
  it.** The check is gone. *Affected:* anything parsing health output for that
  check name.

- **Command-target task logs are now redacted.** Output that previously
  persisted verbatim may now contain `[REDACTED]`. *Affected:* anything
  grepping task logs for values that are now recognised as secrets.

- **Leftover `isolation: worktree` trees are garbage-collected after 7 days.**
  *Remedy:* copy anything you want to keep out of a retained worktree within a
  week.

### Added

- **`exec` workflow units — run a shell command as a workflow step.** A step
  whose `unit:` block declares `exec:` runs a command directly instead of
  dispatching to an LLM or an agent, so deterministic work (test suites,
  builds, lint, scripts) no longer costs a model dispatch, its latency, its
  tokens, or its nondeterminism.

  ```yaml
  - id: test
    unit:
      exec:
        command: ["bun", "run", "test:unit"]
        pass_env: [CARGO_HOME]   # optional: widen the default env allowlist
      timeout: "10m"
      retry: { max: 1, on: [timeout] }
  ```

  - **`command:` is an argv array; there is no shell-string spelling.** The
    child is spawned directly, so `;`, `|`, `&&`, `$(…)` and `*` inside an
    argument are inert literal bytes — the quoting/injection class is
    structurally absent, not defended against. Write `["bash", "-lc", "…"]`
    when a pipeline is genuinely wanted, and own that choice in the diff.
  - **An exec unit names no engine.** It rejects `engine`/`model`/`llm`, spends
    no tokens, and a workflow made only of exec steps runs on an install with
    no engine configured at all.
  - **Everything else about a unit still applies:** `timeout`, `retry`,
    `on_error`, `output`, `env`, `isolation: worktree`, `map` fan-out and its
    concurrency limits, the unit journal, budget accounting, and replay/reuse
    (a completed exec unit is never re-run on resume).
  - **Output rule:** stdout is the promoted artifact with trailing newlines
    stripped (like shell `$(…)`); with an `output:` schema on the unit, stdout
    must be exactly one JSON value, strictly parsed and validated. stderr is a
    diagnostic channel only. A schema miss is *not* re-prompted — a fixed argv
    cannot answer feedback, but re-running it could deploy twice.
  - **Exit codes:** non-zero → `non_zero_exit`, wall-clock expiry → `timeout`,
    cancellation → `aborted`, failure to start → `spawn_failed`. Those are
    pre-existing `retry.on` reasons. With the default `on_error: fail`, a
    non-zero exit fails the step and the run, which is what makes a `test` step
    a gate.
  - **A partial capture is never promoted as the artifact.** Exiting 0 does not
    prove stdout was read to the end: a pipe can error, and a background
    descendant holding the stdout handle open after the command leader exits
    keeps the pipe alive past the drain deadline. Both leave a *prefix* of the
    real output, so the unit fails — with its own reason,
    `exec_capture_incomplete`, which is deliberately **not** a `retry.on` value.
    The command already ran; re-dispatching identical argv to fix a capture
    problem would run its side effects a second time.
  - **Everything the command can spend is bounded — without inventing failures.**
    Alongside the wall-clock timeout, akm bounds the memory it spends on the
    command's behalf and the environment it can hand the command. Both bounds are
    built so that they only ever *explain* a failure that was going to happen
    anyway; neither fails a run that would otherwise have succeeded.

    **Retained output: 8 MiB per stream, drain-and-discard.** akm keeps at most
    8 MiB of stdout and 8 MiB of stderr. Past the cap it keeps *reading* the pipe
    and throws the extra bytes away, so the child never blocks on backpressure:
    the command runs to completion and its real exit code decides the unit. A
    verbose-but-passing test suite is not failed over its log volume. What
    overflow costs is completeness of the artifact, and that is never hidden —
    a step with **no** `output:` schema succeeds and its artifact is the retained
    head with a `__akm_exec_output_truncated__` block appended (naming bytes
    written vs bytes retained), so truncated data can never be mistaken for
    complete data by `steps.<id>.output`, a gate judge, or a human. A step **with**
    an `output:` schema still fails `exec_output_limit`: stdout must parse as
    exactly one JSON value, a truncated prefix cannot, and promoting it would
    corrupt every downstream reference to the typed artifact.

    **Context environment: this platform's ceiling, not the smallest one.** The
    engine-authored `AKM_*` context is capped at **96 KiB per variable / 128 KiB
    total** on Linux, macOS and BSD, and at **32 767 bytes per variable / 64 000
    bytes total** on Windows. The numbers cite their sources: Linux's
    `MAX_ARG_STRLEN` (`32 * PAGE_SIZE` = 131 072 bytes per `argv`/`environ`
    string), macOS's 256 KiB `ARG_MAX` over argv + environ combined, and Win32
    `SetEnvironmentVariable`'s 32 767-character per-variable limit. Crossing the
    bound fails `exec_context_too_large` *before* the spawn, with an error naming
    the variable, its size, this platform's limit and where that limit comes from
    — replacing a bare `E2BIG` from the spawn syscall that named neither the
    variable nor the data behind it. Converting that inevitable failure into an
    actionable one is the check's *only* job, so it uses the ceiling of the
    platform the run is on: previously it applied Windows' limit everywhere and
    refused spawns Linux and macOS would have accepted. Workflows that must also
    run on Windows should stay under the smaller bound — that is documented
    guidance now, not something a Linux host enforces.

    `exec_output_limit` and `exec_context_too_large` keep their meanings and
    their place outside the `retry.on` vocabulary, alongside `exec_cwd_escape`:
    each is deterministic, so re-dispatching could only spend the budget again.
    `PROGRAM_RETRY_REASONS` is unchanged.
  - **A failing command's stderr survives to a durable surface.** The unit
    journal now keeps each failed unit's redacted diagnostic (clipped to 2000
    characters), and the step summary carries the first failure's. For an exec
    unit that is the difference between `akm workflow status --units` saying
    `non_zero_exit` and it saying *why* — a command that explains itself only on
    stderr with empty stdout previously left no diagnostic anywhere durable.
    This is an output surface only: the unit input hash is computed from
    plan-frozen inputs, so no completed unit re-dispatches because of it.
  - **The child's environment is an ALLOWLIST, not an inheritance.** The
    command starts from an empty environment and receives `PATH`, `HOME`, the
    identity/locale/temp/terminal variables, the Windows process-creation
    essentials (`SystemRoot`, `SystemDrive`, `WINDIR`, `COMSPEC`, `PATHEXT`)
    and the Windows home/config roots, plus `AKM_EVENT_SOURCE` — then the
    unit's `env:` bindings, then the `AKM_*` context. `exec.pass_env: [NAME…]`
    adds a few more names (for a per-machine toolchain variable like
    `CARGO_HOME`, which a committed `env:` asset cannot express);
    `exec.inherit_env: true` opts all the way back into akm's whole
    environment. Both keys live inside `exec:` because the unit-level `env:`
    key already means "env asset binding refs", and both are dispatch-
    significant, so both are in the input hash.

    This is not a claim to stop a determined attacker — a command that runs at
    all can read the same credentials off disk. It bounds **accidental**
    exposure (the invoking shell or CI job routinely exports tokens for
    unrelated services), makes the environment surface **explicit and
    reviewable**, and **matches the convention akm already applies** to
    agent-harness children (`profile.envPassthrough`), which now share one
    mechanism with exec units instead of two.
  - **Security:** commands run inside the existing workflow trust model.
    Secrets come from `env:` bindings by NAME — the frozen plan and the replay
    hash carry only ref names, and resolved values are scrubbed from stdout,
    stderr, and failure diagnostics by the same redaction contract every other
    dispatch uses, before anything is journaled. `cwd:` is relative and
    `..`-free, re-checked against the resolved base (symlinks included) before
    spawning.
  - **Cancellation is real:** the child is spawned in its own process group and
    gets a SIGTERM→SIGKILL ladder on timeout or abort, so `--timeout` / Ctrl-C
    stop a running command without orphaning its children.
  - **No replay churn:** the exec spec was added to the unit input-hash preimage
    as a key present only on exec units, so `hashVersion` stays 4 and every
    previously-frozen llm/agent/sdk unit hashes byte-identically — runs already
    in flight neither re-dispatch nor diverge. The env-scope keys are inside
    that same spec and are frozen only in their non-default form (`inherit_env`
    only when `true`, `pass_env` only when non-empty), so an exec unit that says
    nothing about its environment hashes byte-identically too.

  See [Workflow Schema: Exec (shell) units](docs/reference/workflow-schema.md#exec-shell-units)
  and the worked example in
  [Author's Guide](https://github.com/itlackey/akm/blob/main/docs/guides/author-workflows.md#deterministic-steps-run-a-command-gate-on-it).

### Changed

- **`akm workflow run` now exits non-zero when the run ends `blocked`.** A
  verification judge that throws, cannot be resolved, or returns a malformed
  verdict stops the run `blocked` — unverified, and resumable with `akm
  workflow resume <id>`. That previously exited 0, so a CI step or scheduled
  wrapper read an unverified run as a passing one. It now exits 1, matching
  `failed` and gate rejections, and matching how the scheduled-task path
  already reported it.

- **Workflow dispatch bounds are enforced at authoring time, not only by the
  frozen-plan decoder.** `engine:` names must match the decoder's own grammar
  (lowercase dash-separated letters/digits, starting with a letter, ≤63
  chars); `retry.max` is 0–100; `gate.max_loops` is 1–100; `map.concurrency`
  and `engines.<name>.concurrency` are 1–64; any `timeout:` must resolve to at
  most 2 147 483 647 ms (~24.8 days, `setTimeout`'s 32-bit ceiling). Every one
  of these was already refused by the frozen-plan decoder, so such a document
  could never actually run — but it *parsed*, so `akm lint`, `akm workflow
  show` and `akm workflow create` all reported it clean and the failure arrived
  at `workflow run` as an unlocated "Invalid frozen workflow plan". The error is
  now line-anchored at parse time. Nothing changes for a document already
  inside the bounds.

- **`akm lint` gained an advisory channel.** The result envelope carries
  `warnings: LintIssue[]` alongside `fixed`/`flagged`, `summary` gains a
  `warnings` count, and text output prints a `warnings` section. Advisories
  never route into `flagged`, so `--fail-on-flagged` cannot fail a run over
  one. Workflow compile advisories (`workflow-warning`) are surfaced for the
  first time — a step with no `output:` schema, a `params.<name>` reference to
  an undeclared param, a `gate.max_loops` above 1 on an `exec` step — so a
  bundle that linted clean at 0.9.0 may now report warnings without becoming a
  failure. Findings that know a location carry `line` in `--format json` and
  render as `file:line` in text. A new `lint-failed` code reports a file the
  sweep reached but could not finish.

- **Leftover `isolation: worktree` trees are now garbage-collected.** A run
  that crashed, or one whose worktree was retained after a dirty unit, used to
  leave its tree under the worktrees root forever. akm now opportunistically
  removes such trees once they are 7 days old, confined to the worktrees root,
  symlinks skipped, containment re-checked. A worktree still in use is never
  collected: every live tree carries a liveness marker (pid, host, resolved
  path) in git's administrative directory for it, and the sweep skips a
  candidate whose holder is still running here.

- **The workflow JSON Schema subset now enforces `allOf`/`anyOf`/`oneOf`/`not`.**
  A step `output:` or `params:` schema may use the combinators, and the runtime
  now evaluates them. Previously it ignored them: a schema using one was
  accepted and simply constrained less than it appeared to. Evaluation stays
  bounded — nesting is capped at 64 levels and one validation at 100 000 checks,
  and exhausting either is reported as an error rather than a truncated pass.

  **This one reaches runs already in flight.** The combinators live in the
  frozen plan, which the decoder still accepts unchanged, so a run frozen before
  the upgrade is resumed against the *new* evaluation: an artifact that passed
  when the combinators were ignored can fail validation now. There is no
  `irVersion` bump to gate it, because the plan bytes did not change — only what
  they mean. Runs whose schemas use no combinators are unaffected, as is every
  step already completed.

  `pattern` is **not** part of the subset. It is a recognized-but-unsupported
  keyword like `format` or `const`: using one is a loud, line-anchored authoring
  error naming the keyword, so no schema silently fails to constrain what it
  looks like it constrains. Enforcing it would mean screening every author
  regex for catastrophic backtracking before the match — and any such screen
  also refuses regexes authors legitimately write (the usual hand-rolled email
  pattern among them), which is authoring friction with no workflow asking for
  it. Where a string's shape matters, `enum` lists the allowed values,
  `minLength`/`maxLength` bound the size, and a step's `### gate` rubric can
  check a shape and explain a mismatch. The `format` hint now points at `enum`
  rather than at `pattern`.

  **Existing workflows that use one of these keywords must be edited before
  they load again.** They previously parsed — the keyword was silently
  non-constraining — so a workflow carrying `format: date-time` or `pattern:`
  ran fine and now fails to parse for every caller: `workflow run`, `workflow
  show`, `workflow create`, and `akm lint`. The quietest surface is `akm index`,
  which skips an asset it cannot parse with a scan warning, so the workflow
  simply stops appearing in the stash index. A run already frozen from such an
  asset still resumes — the frozen-plan decoder does not re-screen keywords —
  so resuming works while re-creating the same workflow errors until it is
  edited.

- **A document-level `defaults.llm` is now rejected at freeze when any step
  resolves onto an agent engine**, naming the step and the engine. The guard
  existed before but was unreachable: overrides were computed only for `llm`
  engines, so `defaults.llm` on a document with an agent step was silently
  DROPPED for that step — the run proceeded with the author's sampling settings
  quietly discarded. Failing loudly is the point, but it means a document that
  mixes `defaults.llm` with any agent-engine step no longer freezes.

  There is no per-step opt-out: `llm: {}` is a no-op, `llm: null` is a parse
  error, and the layer merge is additive. Move the `llm:` block from
  `defaults:` onto the `unit:` of each LLM step that wants it.

- **A scheduled workflow task now gets a 6-hour whole-run timeout by default.**
  This applies to task files that declare no `timeoutMs:` — which is every task
  file written before this release, since the key was previously rejected on
  workflow targets. An unattended run that legitimately takes longer will be
  aborted and the attempt reported failed on every firing until the task is
  edited. `timeoutMs: null` opts out entirely, and any number overrides the
  default. The abort itself is graceful: it lands at a step boundary, the
  journal and lease are kept, and the run stays resumable with
  `akm workflow resume <id>` — which the failure message names.

- **Workflow `map` steps now fan out in parallel by default.** A `map` step
  that declares no `concurrency:` freezes a width of **4** instead of 1, and an
  LLM engine that declares no `engines.<name>.concurrency` freezes **4** for a
  remote endpoint (loopback endpoints stay at **1** — a local model server holds
  one loaded model and returns HTTP 500 under concurrent inference). Both
  defaults previously froze 1, which made every fan-out serial unless the author
  opted in at two independent layers, and left `workflow.maxConcurrency` and the
  host CPU cap binding on nothing.

  This is a behavior change on a patch release, so every escape hatch is
  explicit:
  - `map.concurrency: 1` on a step is honored exactly as before — an authored
    `1` is kept distinct from an unset field and always wins.
  - New config key **`workflow.defaultMapConcurrency`** sets the default for
    every workflow on the machine. `akm config set workflow.defaultMapConcurrency 1`
    restores the pre-0.9.1 serial default wholesale.
  - `engines.<name>.concurrency` pins any engine's own limit (and is now clamped
    to `1..64` at freeze time instead of freezing a plan the decoder would then
    refuse to load).
  - **Runs already in flight are unaffected.** Both values are frozen into
    `plan_json` when a run starts and the frozen-plan decoder requires them, so
    a resumed run keeps the widths it began with. The new defaults apply only to
    runs started after the upgrade.

  The effective width remains the minimum of the step's `concurrency`, the run's
  frozen `workflow.maxConcurrency`, the selected engine's concurrency, and the
  current host's CPU cap.

- **`--max-steps` now counts steps, not engine-loop iterations.** The budget is
  spent by the DISTINCT spine steps that finished — completed, failed, or
  gate-rejected with the loop budget spent. It was previously spent by entries
  in the `executed` report,
  which gains one per gate-loop iteration and one per route-skip, so
  `--max-steps 3` against a step with `gate.max_loops: 3` could stop after a
  single step had finished, and an unselected branch target consumed budget for
  work that was never dispatched. Three steps now means three steps, which is
  what the flag has always said (`Stop after executing this many steps`). A step
  the invocation left unfinished — an abort, a judge outage — still consumes
  nothing, because the work is still owed. The same accounting is what a
  `--max-retries` reopen subtracts, so loops and skips no longer shrink a
  retry's remaining budget either, and `maxSteps:` in a workflow task file is
  the same knob and moves with it. The count is now reported: `akm workflow run`
  carries a `stepsProcessed` field alongside `executed`, so the number the
  budget is spent on is visible rather than inferred from a list that counts
  something else.

  **This loosens the dispatch exposure of one invocation, and the loosening is
  cumulative across steps.** A step's whole bounded gate loop now costs one step
  instead of one per iteration, so the rounds a single `akm workflow run` can
  dispatch go from roughly `N + max_loops` to `N × max_loops`.

  What did **not** change is what the flag bounds within one step. `--max-steps`
  was never a cap on total dispatch rounds on either version: the budget is
  tested only BETWEEN steps, so a single step's gate loop could always run out
  its full `gate.max_loops` no matter how little budget was left. The per-step
  ceiling is `gate.max_loops` (1–100); the whole-run ceilings are
  `budget.max_units` and `budget.max_tokens`, which are seeded from the unit
  journal and hold across resumes.

### Fixed

- **Upgrading Node after installing akm now explains itself.** A native binding
  is built for the Node ABI present at install time, so upgrading Node major
  versions afterwards leaves akm reporting a bare Node internals message —
  *"The module … was compiled against a different Node.js version"*, or on a
  second attempt the even less helpful *"Module did not self-register"*. akm now
  recognises that failure and answers with the one command that fixes it
  (`npm rebuild better-sqlite3`), names the ABI actually running, and says
  plainly that this is not a broken install.

  The diagnostic had to move to do this. It wrapped the `require`, but
  `require("better-sqlite3")` **succeeds** against a mismatched binding — the
  package resolves its `.node` file lazily — so the error lands at
  `new Database(...)` and the loader's handler never saw it. The previous text
  telling the user to look for a version mismatch "in the error below" was
  unreachable. Found by installing the published build under Node 22 and running
  it under Node 24.

- **akm's Node fallback no longer aborts at teardown on Node 24.** On Node
  24.19.0 and later, any command that opened a database could intermittently
  die with `node::RemoveEnvironmentCleanupHook … Assertion (env) != nullptr`
  and exit 134 — after its work was done, so the failure looked random and
  depended on garbage-collection timing.

  The cause was upstream and nothing to do with akm's own code.
  `better-sqlite3` ships one prebuilt binary per Node ABI and falls back to
  `node-gyp rebuild` when none matches, and the 11.x line publishes no prebuild
  for Node 24 — so installing it there silently compiled the driver from source.
  Node 24.19.0 had just changed the public `node_object_wrap.h` so that
  `ObjectWrap`'s constructor and destructor register and unregister an
  environment cleanup hook; a binding compiled against those headers
  unregisters the hook after the environment is already gone, and aborts from
  V8's teardown path. Only the Node 24 line was affected, and only from that
  release on.

  akm now pins `better-sqlite3` to `12.11.1`, which publishes prebuilt binaries
  for Node 22, 24, 25 and 26 — so no Node version akm supports compiles the
  driver at all. This affected real installs, not just CI: an npm user on Node
  24 LTS was getting the same crash-prone from-source build.

  The Node-fallback CI job now installs the exact spec `package.json` declares
  instead of carrying a range of its own, and both that job and the smoke
  script fail loudly on a native crash banner — previously an abort was
  reported only as missing output, and the one step that tolerates a non-zero
  exit would not have failed at all.

- **A website source interrupted mid-refresh no longer loses the snapshot it
  already had.** A refresh deleted the whole mirror and then rebuilt it page by
  page, so a process killed inside that loop left an empty or partial directory
  with the old content already gone — and the freshness marker still looked
  recent, so the next `sync()` served the wreckage instead of rebuilding. The
  new snapshot is built in a dot-prefixed sibling directory and swapped in with
  renames: an interrupted refresh leaves the PREVIOUS complete snapshot
  untouched. Abandoned staging directories are dot-prefixed so the indexer's
  walk skips them, and are swept by the next refresh once an hour old.

- **A resumed workflow run no longer re-dispatches work that already ran.** The
  single-driver guard was checked at the run level, so a run whose lease had
  been stolen left its still-owned unit row `running` and discarded the real
  outcome — the resume then re-dispatched a unit that had already executed its
  side effects and already spent its tokens. The guard now lives on the row, so
  a stale driver's finish matches nothing and a live outcome is never dropped.

- **Lowering `retry.max` no longer re-runs finished work.** The completed-attempt
  scan matched only attempts the *current* retry policy could have produced, so
  reducing `retry.max` between invocations hid a journaled `~rN` row and the
  unit was dispatched again. It now matches any journaled attempt of the unit.

- **A scheduled `command` task no longer writes your secrets into its log.**
  Task logs were scrubbed for credential *shapes* — `Bearer …`, `sk-…`, webhook
  URLs — but only prompt- and workflow-target runs also scrubbed exact secret
  *values*. A command that echoed a configured secret shaped like nothing in
  particular persisted it verbatim into both the run `.log` and `logs.db`, for
  the whole retention window. Exact-value redaction now runs in the one sink all
  three target kinds share, so every task kind is covered.

  akm treats a value as secret when your config declares it
  (`engines.<name>.apiKey`, `embedding.apiKey`, and the
  `AKM_ENGINE_<NAME>_API_KEY` / `AKM_LLM_API_KEY` / `AKM_EMBED_API_KEY`
  recipes), and infers others from the variable name (`*_TOKEN`, `*_SECRET`,
  `*_API_KEY`, `*_PASSWORD`, …) when the value is at least 8 characters. The
  floor applies only to the *guesses*: a declared secret is redacted at any
  length. Redaction replaces substrings, so an over-eager rule does real damage
  — treating every non-allowlisted variable in the inherited environment as a
  secret classified 127 of 132 variables as credentials, 25 of them one
  character long, and turned `3 tests passed, 0 failed` into `[REDACTED] tests
  passed, [REDACTED] failed`.

  For a secret exported under a name none of those rules recognise, any task may
  name it:

  ```yaml
  command: ./deploy.sh
  redact: [ACME_DEPLOY_TOKEN]   # NAMES, never values — max 32
  ```

  Names only, and a name that is unset at run time contributes nothing. A
  literal secret in a task file would leak far more widely than the redaction
  closes: task files are indexed into the search database, can be sent to an
  embedding provider, are printed verbatim by `akm show`, and ship inside
  bundles over git and npm — the same rule exec units' `pass_env:` follows.

- **Redacting a log can no longer explode it.** Exact-value redaction took a
  fast path that rewrote the text once per secret, over an accumulator it had
  already rewritten — so a secret containing any of the letters in `[REDACTED]`
  matched the tokens it had just inserted, and the output grew geometrically.
  Fifty characters against six single-letter values produced 32,450 characters,
  a 649x blowup reachable from ordinary command output. Matches are now found
  against the original text and the result emitted once. Overlapping matches
  merge into a single `[REDACTED]`, and the two redaction paths no longer
  disagree about output shape depending on whether the text happened to contain
  a `%`.

- **Redacting a structured value no longer drops fields.** When two distinct
  object keys redacted to the same string, the rebuilt object silently kept only
  the last — `{a, b, ab}` came back with two entries, one of them simply gone
  rather than redacted. Colliding keys are now suffixed, so the value survives
  with its key still hidden. This affected persisted improve results and
  journaled workflow outcomes.

- **`akm improve` auto-sync now commits exactly the files the run wrote.**
  Every akm write path records the file it mutated into a run-scoped
  write-provenance journal, and the end-of-run (and crash-path) commit stages
  precisely those paths. A managed-directory file someone else edits while a
  long run is in flight is left dirty for its author instead of being swept into
  akm's commit, and a file that was already dirty when the run started and was
  then rewritten by the run is now committed instead of being silently skipped.
  Deletions are journaled like writes, so a path written and then reverted or
  purged stages its final on-disk state — or produces no commit at all. The run
  reports its journal as `writtenPaths` on the improve result, and the
  `stash_synced` event gains `attributed` / `unattributed` counts. `akm sync` /
  `akm push`, which supply no explicit path list, keep the managed-pathspec
  fallback unchanged. (#652)

- **`akm lint` no longer reports a clean scan for a task file that cannot run.**
  A `tasks/*.yml` whose YAML does not parse (bad indentation, an unterminated
  quote, tab characters) produced `flagged: 0`: every task reader collapsed a
  parse failure onto an empty mapping, and every task rule short-circuits on
  one — so a CI gate on `--fail-on-flagged` passed a task that would die at
  schedule time. The parse failure is now its own `invalid-task-yaml` finding.
  A `tasks/*.yaml` file — a spelling akm never indexes and never schedules —
  used to be skipped by the directory walk entirely; it is now collected and
  flagged for the extension, with the rename in the message. Fixed on all three
  task-lint surfaces (the CLI sweep, the `akm` adapter's `validate`, and the
  `akm-task` format adapter) from one shared parse, so they cannot disagree.

- **`akm lint --fix` refuses a bundle configured `writable: false`.** Every
  other mutating command checks the flag before touching disk; `--fix` wrote
  directly and never consulted it, so it rewrote frontmatter in a bundle
  explicitly marked read-only. It is now a usage error raised before any file
  is modified.

- **A `--fix` write failure no longer aborts the run and hides the fixes that
  already landed.** One unwritable file (read-only file, full disk) threw
  straight out of `akm lint`, so the caller got an exception instead of a
  result — with no way to tell which earlier files in the same sweep had
  already been rewritten. A failed fix is now reported in-band on its own file
  as `fixed: "failed"`, and the sweep continues through the rest of the bundle.

- **`akm lint --type` says so when it does nothing.** For a non-akm bundle the
  adapter validates the whole bundle regardless of `--type`, so scoping a run
  silently had no effect. It now warns, naming the flag and the adapter.
  Findings are unchanged (full-bundle validation was already a superset), and
  it is deliberately a warning, not an error, so scripts passing one `--type`
  across mixed-adapter bundle sets keep working.

- **`missing-skill-md` fires again for an `agent-skills` package with no
  manifest.** The check iterated pending CHANGES, and a change is always a
  file — so a package directory holding resources but no `SKILL.md`
  contributed nothing it could see, and a skills pack with a broken package
  linted clean. It is now a real directory pass over the bundle root. Related:
  under opencode's supported singular `skill/` alias the same package went
  unflagged while an identical one under `skills/` was caught; both spellings
  are now checked.

- **An index akm cannot read no longer reports as an index that does not
  exist.** `fs.existsSync()` answers `false` for a permission error exactly as
  it does for a missing file, and the read path used it as its "is there an
  index?" gate — so `akm search` and `akm curate` returned no hits at **exit 0**
  with the tip *"No search index available. Run 'akm index' to build one."* for
  a populated index sitting right there on disk, and `akm info` reported
  `entryCount: 0, vecAvailable: false` for the same index. Nothing said
  "permission". A consuming agent had no way to tell that from a genuine empty
  result, so it relayed the false answer to its user with an explanation it had
  invented.

  Absent and inaccessible are now distinct everywhere it matters:

  - `search` / `curate` / the index openers raise a `ConfigError`
    (`DATA_DIR_UNREADABLE`, exit 78) naming the path, the errno, the mode and
    owner, and the uid actually running — instead of an empty success.
  - `akm info` reports an `indexStats.unreadable` diagnostic rather than zeros
    that look healthy. The field is absent on every healthy run.
  - `akm health` now *diagnoses* an unreadable `state.db` as a failing
    `state-db-readable` check instead of dying on the open before it could
    report anything — it is the command you reach for when this happens.
  - `probeLock` returns a distinct `inaccessible` state instead of classifying a
    permission error as a stale lock. "I cannot read this lock" and "the holder
    is dead" are opposite facts, and `akm improve` now stops rather than
    reclaiming a lease that may be genuinely held.

  The same conflation existed on the write paths, where the consequence was
  worse than a wrong answer:

  - **An unreadable `akm.lock` could destroy every bundle record in it.** The
    lockfile read that exists specifically so a write path never sees `[]`
    returned `[]` for *any* read failure, permission errors included — and
    every lockfile write is read-modify-write, so the next atomic write
    replaced the operator's whole lock record with the single entry being
    added. Verified by probe: the symlink was replaced by a regular file
    holding one entry. Lockfile writes now refuse to run against a lock they
    cannot read.
  - **The migration recovery gate failed open.** "I cannot tell whether a
    recovery is pending" cleared the gate exactly as "no recovery is pending"
    did, so akm would open the canonical databases on top of a half-applied
    migration. It now fails closed.
  - **`akm index --clean` deleted rows for files it merely could not look at**,
    and reported the deletions as a clean success. Unreadable entries are now
    kept and named.
  - `indexWrittenAssets` returned `true` — "the index is as you expect" — for
    an index it could not open, on the strength of which `acceptProposal`
    advanced its journal to `index-finalized`.
  - `akm improve` eligibility, `akm feedback`, `akm bundle list` and the graph
    loaders each turned a permission fault into an empty result, a zero count,
    or the advice to "Run `akm index` first".

- **akm no longer manages permissions on your data directory, its databases, or
  your task logs — and no longer reports on them either.** Those take your
  process umask; their mode is yours to set, and `chmod`/`umask` are your
  levers.

  This is scoped, not blanket: akm still creates a handful of files at
  restrictive modes *at creation time*, as it always has — `env` and `secret`
  assets and config backups at `0600`, their directories at `0700`, and the
  scheduler invocation files it writes for cron/launchd/schtasks. Those are
  files akm authors itself and whose contents are credentials; setting their
  mode when creating them is not the same as re-permissioning a directory you
  already owned.

  Two 0.9.1 pre-release changes are gone. The first chmodded akm's databases
  and task logs to `0600`/`0700` on every open — reverted because
  re-permissioning a directory akm did not create silently broke installs that
  share `$XDG_DATA_HOME` between two uids (agent sandboxes, containers, service
  accounts). If a pre-release tightened your data directory, `chmod` it back.
  The second was an `akm health` advisory (`secret-file-perms`) that reported
  group/other-readable `env`, `secrets` and `config-backups` paths — removed
  too: it is meaningless on Windows, and nagging about modes akm does not set
  is not health reporting. `akm health` no longer emits this check, and no
  longer exits `4` on account of it.

- **`timeout: none` on an exec unit is genuinely unbounded again.** The
  stream-drain safety net — a one-hour bound on a pipe still being read after
  the child is gone — was armed when capture STARTED, so a command that ran
  past an hour had its output reader cancelled mid-run and was then failed for
  an incomplete capture even though it exited 0. It is now armed from the
  child's exit, which is the only window it was ever meant to bound.

- **A bounded exec unit no longer waits out its whole `timeout` after the
  command has already exited.** The drain deadline for a unit WITH a wall budget
  ran from the moment capture started — budget plus a 2 s grace — so a command
  that exited in milliseconds while a background descendant held a pipe open
  kept the unit, and with it a fan-out slot, occupied for the entire declared
  timeout before reporting. It now runs from the moment nothing living owns the
  pipe: the child's exit, or (for a child that outlived its own kill ladder) the
  budget's expiry, plus the same 2 s grace. A command that really does spend its
  whole budget sees the identical ceiling it saw before; only the case that used
  to stall stopped stalling.

- **A stderr drain that never finished no longer fails an exec unit whose
  command succeeded.** `exec_capture_incomplete` was raised when EITHER pipe
  failed to drain, so a command that exited 0 with its stdout captured whole was
  failed — and a valid artifact thrown away — because a background descendant
  was still holding STDERR open. stderr is a diagnostic channel that never
  contributes to the artifact, so only an incomplete STDOUT capture fails the
  unit now; an incomplete stderr drain is reported on the warn stream instead,
  naming the unit and warning that any stderr shown for it may be missing its
  tail.

- **A step artifact larger than 1 MiB no longer breaks the next step of the run
  that produced it.** Step evidence is clipped to bound one SQLite row, and the
  engine rebuilt each downstream `steps.<id>.output` scope by re-reading those
  rows — so a large artifact (an exec unit's stdout retains up to 8 MiB) reached
  the very next step as a truncation marker: a path reference failed with a
  missing-property error that never mentioned truncation, and a whole-value
  reference silently handed the marker to the unit as its input. The run now
  carries its own complete values forward; the row stays clipped for resume,
  where a reference into a clipped artifact fails by name.

- **A workflow run that completed is no longer reported as timed out.** The
  deadline is observed between steps, so one landing during a run's final
  bookkeeping set the timed-out flag on a run that then finished. On a scheduled
  workflow task that recorded the attempt as failed, with a hint to resume a run
  that had nothing left to resume; under `akm workflow run --timeout` it
  rendered a `timedOut` marker on a `completed` run and exited nonzero. Both
  surfaces now drop the marker once the run reached `completed` — a deadline
  that lands with nothing left to abort has nothing to report.

- **A rejected gate on an `exec` step no longer re-runs the command.** A gate
  loop earns its re-dispatch by handing the judge's feedback to a unit that can
  answer it. An exec unit cannot: its argv is frozen and never interpolated, and
  the exec context environment carries no feedback variable — so the loop could
  only re-run the byte-identical command, performing a deploy, a publish, or a
  migration a second time for a verdict that could not change. The gate still
  EVALUATES on an exec step and can still fail it: a rejection is final on the
  first evaluation, carrying the judge's missing criteria and feedback exactly
  as in the one-shot case. What an author sees is
  that `gate.max_loops` is capped at 1 on a step whose unit is `exec:` — not an
  authoring error, and no change at all to an engine step, where a declared
  `max_loops` is still honored in full. This is the same reasoning that already
  makes an exec unit's `output:` schema miss fail without a corrective
  re-dispatch.

- **The stale-worktree sweep no longer collects a worktree that is still in
  use.** The opportunistic age-based GC of leftover `isolation: worktree` trees
  judged staleness from the worktree root's mtime, which a unit writing only
  inside subdirectories never touches — so another akm process minting a
  worktree could delete the tree a long-running unit was working in. Every live
  worktree now carries a liveness marker (pid, host, resolved path) in git's own
  administrative directory for it, and the sweep skips a candidate whose holder
  is still running here. A marker from a dead pid, from another host, or for a
  different path is not liveness: crashed runs and retained dirty trees stay
  collectible, which is what the sweep exists for.

- On Windows, an agent CLI, gate judge, or prompt task was spawned into an
  environment the loader cannot start from: the shared passthrough allowlist
  named no `SystemRoot`/`SystemDrive`/`WINDIR`, and without `PATHEXT` a
  `bin: "bun"` profile was unresolvable — while an exec unit on the same host
  worked, because its own allowlist names them. Those variables are now added
  when any allowlisted child environment is built.

- Scheduler PATH repair skipped itself in the environments it exists for. It
  decided a PATH was "interactive" by testing whether any entry began with the
  user's home directory as a *string*, so a home of `/` — system crontab,
  launchd, service accounts — matched every absolute entry, and a sibling home
  (`/home/alice/bin` against `/home/al`) matched too.

- A directory whose name merely begins with two dots (`..data`) was treated as
  a path escape. For a workflow exec `cwd` that meant the parser and the frozen
  plan accepted a spelling the executor then failed as tampering, with a reason
  no retry can clear.

- `appendEvent` resolved the state.db path outside its own error handling, and
  did so even when the caller supplied an open connection — so a caller holding
  a perfectly good handle could take a configuration error from a function whose
  contract is that it never propagates one.

- Workflow freeze attributed per-step `engine`/`model`/`timeout`/`llm` overrides
  by matching the compiled draft step list against the source document
  **positionally**. That was correct only because compilation happens to be 1:1
  and order-preserving; a compile pass that filtered or reordered steps would
  have silently applied one step's overrides to another. Attribution is now
  keyed by `stepId`.

### Security

- **A gate judge's response is now scrubbed before it is journaled.** The judge
  verdict is written into the gate row's `result_json`, and a judge failure's
  message becomes the blocked step's notes — but the judge dispatch bypassed
  the redaction contract every unit dispatch goes through, so a judge that
  echoed a credential out of the promoted artifact persisted it unredacted into
  the workflow journal. Both judge paths (agent and llm) now wrap their
  dispatch in the same scrub, with the sensitive-value set collected per
  dispatch rather than at build time, so a credential rotated between the two
  reads is still caught. The dispatch also carries the real run/step/gate ids
  instead of a synthetic `"gate"` placeholder, so a gate row and its telemetry
  describe the same thing.

- **Command-target task logs are scrubbed of exact secret values**, closing the
  last redaction lane — see the `### Fixed` entry above for the full account.

## [0.9.0] - 2026-08-06

0.9.0 is the format-neutral **bundle / adapter** refactor: it replaces the flat
asset-type registry with per-format adapters, adopts one canonical ref grammar,
and consolidates the durable databases and config. This section consolidates and
supersedes the `0.9.0-rc.*` / `0.9.0-beta.*` development entries below.

### Breaking changes & migration

- **Installed non-akm bundles reclassify on your next `akm index`.** The
  indexer now dispatches each installed bundle's *detected* adapter (Claude
  tool dirs, LLM wikis, website snapshots, agent-skills packs, …) instead of
  recognizing everything with the akm-stash adapter. Entries in such bundles
  change type and ref spelling to the owning adapter's own scheme the first
  time you reindex. No action needed — the index is a regenerable cache and
  rebuilds itself — but searches/saved refs into those bundles may resolve to
  the new spellings afterwards.
- **Ref grammar cutover — `type:name` → `[bundle//]conceptId`.** Every ref is
  now a subdir-qualified concept id inside its bundle (`skills/code-review`,
  `memories/vpn-note`, `env/prod`), optionally prefixed with a `bundle//`
  installation slug and suffixed with `#fragment`. Durable state stores the
  fully-qualified `bundle//conceptId`; the short bundle-omitted form is accepted
  input only (resolved against `defaultBundle`, then installation-priority
  order). The pre-0.9.0 `[origin//]type:name` grammar is removed — there is no
  compatibility parser; the frozen migrator in `scripts/akm-migrate/migrate/`
  is the only place it survives.
- **Explicit, crash-resumable cutover (`akm migrate apply`).** The
  migrator re-keys all durable state to the new spelling, folds the former
  `workflow.db` into `state.db` (four databases down to three: `state.db` /
  `index.db` / a separate `logs.db`), and migrates config from the flat
  `stashDir` / `sources` / `installed` / `wikiName` keys to `bundles` /
  `defaultBundle`. A semantically verified, installation-scoped **backup manifest v4**
  (covering the pre-rescue `index.db`) is taken before mutation. One phase-free
  incomplete sentinel retains that backup and target; expected orphans are
  quarantined, integrity failures fail closed, and the whole cutover reruns
  idempotently after a crash. Normal commands refuse an
  un-migrated or divergent durable schema rather than migrating as a side effect.
  The retired `stashDir` / `sources` / `installed` keys are **hard-rejected** by
  the 0.9.0 config schema whenever present (the error names `akm migrate apply`);
  registry-installed bundles keep only their desired locator (`git`/`npm` +
  `registryId`) in config, with resolved cache state living exclusively in the
  lockfile.
- **`index.md` / `log.md` are reserved structural files.** Per the Open
  Knowledge Format, `index.md` (directory listing) and `log.md` (update history)
  are never indexed as concepts and are never valid write / `mv` targets at any
  bundle depth. Existing stash files with those names are excluded from the
  index (and renamed by the content migration when they hold a real concept).
- **`vault` asset type removed.** Use `env` (a whole `.env` group; key names
  surfaced, values never) and `secret` (a single sensitive value), addressed as
  `env/<name>` and `secrets/<name>`. `akm-migrate storage` performs the
  non-destructive `vaults/` → `env/` copy for older stashes.
- **0.8-era CLI aliases removed.** The flat proposal verbs (`akm proposals`,
  `akm accept`, `akm reject`, `akm diff`, `akm revert`, `akm show proposal`),
  `akm save`, top-level `akm enable` / `akm disable`, `akm events`,
  `--detail summary|agent`, `--for-agent`, `--note`, and `--source` (on
  accept/reject/history) are gone — use the canonical spellings documented in
  `STABILITY.md`.

See `docs/migration/v0.8-to-v0.9.md` and
`docs/migration/release-notes/0.9.0.md` for the full upgrade procedure.

### Removed

- **The experimental `akm workflow brief` / `akm workflow report`
  external-driver protocol is removed**, along with the
  `experimental.workflowEngine` config key that gated it, its
  `WORKFLOW_ENGINE_NOT_ENABLED` error code, and the `workflowEngine` block in
  `akm task doctor`. `akm workflow run` is now the single execution surface.

  The protocol let a calling agent session execute a run's units itself
  instead of akm dispatching them. Its stated justification was harness
  neutrality, which measurement did not support: native dispatch already
  covers **ten** harnesses (opencode, claude, opencode-sdk, codex, copilot,
  pi, gemini, aider, amazonq, openhands) in 2,214 LOC total, while the
  protocol cost 2,690 LOC on its own — more than supporting every harness
  natively — and an eleventh harness is ~220 lines, not a protocol. Removing
  it also drops the second consumer of `workflow_run_units` and the
  cross-surface parity obligation on `step-work.ts`, both of which
  constrained every future engine change. The analysis is recorded in
  `docs/architecture/specs/driver-protocol-keep-or-cut.md`.

  Legacy configs setting `experimental.workflowEngine` remain valid — the
  config schema is `.passthrough()`, so the key is accepted and ignored.

### Added

- **`akm workflow run` and prompt tasks fall back to `opencode-sdk` instead of
  refusing when no engine is configured.** A clean install that never ran
  `akm setup` — a bare container, a CI image, an agent-operated session — used
  to fail closed with `INVALID_CONFIG_FILE` (exit 78). When the `opencode`
  binary is on PATH, akm now synthesizes a **config-free** `opencode-sdk`
  engine: it carries no model, endpoint, or credential, so provider, model,
  and auth all resolve from opencode's own configuration and akm never mirrors
  or validates it. With `opencode` absent the failure is unchanged, and its
  remedy now names both routes. An operator-configured `opencode-sdk` engine
  always wins over the synthesized one.

  The requirement is the **binary**, not the npm package: `@opencode-ai/sdk`
  is an HTTP client that declares no dependencies and whose own
  `createOpencodeServer` spawns `opencode serve`, so a host with the package
  and no binary has no server to reach. Install it with `npm i -g opencode-ai`
  or opencode's own installer.

  The fallback is **announced, never silent** on every surface that applies
  it: a workflow run surfaces it once at run creation in the result's
  `warnings`, a prompt task writes it to the task run log, `akm agent`
  carries it in its result `warnings` and on stderr, and `propose` and
  `improve` reflect warn on stderr. The frozen plan records the engine
  actually used, so a resume never re-announces a decision it did not make.

- **RSS, Bluesky, and X sources.** `akm bundle add` now recognizes three new
  kinds of URL and snapshots them as knowledge assets instead of crawling
  them as ordinary web pages:

  ```sh
  akm bundle add https://blog.example/feed          # RSS 2.0 / Atom / RDF
  akm bundle add https://bsky.app/profile/<handle>  # public, no auth
  akm bundle add https://x.com/<user>               # see token note below
  ```

  Any of these falling through — a `/feed` URL that actually serves HTML, an
  unresolvable Bluesky handle — degrades to the normal website crawl rather
  than failing the command.

  X needs credentials: set `X_BEARER_TOKEN` for the X API v2, or
  `X_RSS_TEMPLATE` to an RSS bridge URL containing `{username}`. To keep the
  token out of your shell history, store it as an akm secret and inject it
  per-invocation:

  ```sh
  akm secret set x-bearer-token
  akm secret run secrets/x-bearer-token X_BEARER_TOKEN -- akm bundle add https://x.com/<user>
  ```

  With neither set, the X fetcher emits one warning and falls through.

- **`akm-migrate` derives the 0.9 config from your 0.8 keys instead of
  demanding one.** Upgrading used to require hand-authoring a complete 0.9
  config before `migrate apply` would act. The first `apply` with no
  `--config` now writes a validated starter config — `bundles`/`defaultBundle`
  derived from the 0.8 `stashDir` / `sources` / `installed` keys — to a
  predictable path under the backup root and stops, with config and durable
  state byte-for-byte untouched; a second `apply` picks it up and performs the
  cutover. Engine settings are never guessed: `profiles.*` and
  `defaults.llm|agent|improve` are stripped and reported individually in
  `droppedKeys` by their exact 0.8 dotted path. `status` and `apply --dry-run`
  preview the same plan, and an explicit `--config` always wins and is never
  overwritten. `akm migrate --format` now renders text/md/html/yaml through
  the normal output pipeline instead of warning and printing JSON anyway.

- **Local downstream value attribution for memory inference and graph
  extraction.** Private search-hit sidecars now write versioned, source-qualified
  per-entry `usage_events.metadata` for emitted MI direct/surface value and the
  active graph contributor's positive applied/capped contribution. Current plain
  traffic is marked as control, brief/replaced MI surfaces and graph ablations do
  not claim attribution, and nested curate reads avoid duplicate show rows. The
  read-only `akm-eval-attribution-rollup` separates user-only exposure,
  selection/show consumption, current controls, and historical unattributed rows
  without emitting bodies, query text, or provenance content. Graph contribution
  is an input attribution signal, not a causal claim that rank changed. No table,
  migration, dashboard, or health schema was added.
- **Explicit, crash-resumable 0.9 migration coordination.** `akm migrate
  status` classifies config, `state.db`, and `workflow.db` independently;
  `akm migrate apply [--config <prepared>]` creates a semantically verified,
  installation-scoped config/database backup before applying pending migrations.
  Apply and restore use one phase-free incomplete sentinel, bounded control-file
  reads, SQLite integrity and ordered-ledger checks, active-writer barriers,
  WAL/SHM-safe publication, and idempotent replay. Legacy checksum columns are
  inert. Routine reads and current database opens no longer depend on a
  historical cutover bundle. See `docs/migration/release-notes/0.9.0.md`.
- **Workflow orchestration engine (experimental).** akm can now execute
  multi-step workflows through a native engine or any agent session. Workflow
  assets use the unified markdown format described above; the stable manual
  CLI contract (`start`/`next`/`complete`/`status`/`list`) and the experimental
  engine consume the same asset. What ships:
  - **Authoring.** A workflow is a markdown asset whose frontmatter graph is
    validated against `schemas/akm-workflow.json` and whose `## <step-id>` body
    sections carry instructions and gate rubrics. `akm workflow create`
    scaffolds that format; `akm lint --type workflows` parses and compiles it.
    Bare references (`params.<name>` and `steps.<id>.output.<path>`) wire
    `map.over`, `route.input`, and `inputs`; prose is never interpolated.
  - **Compilation + frozen plans.** `akm workflow start` compiles the workflow
    into a backend-agnostic Workflow Plan Graph IR (`src/workflows/ir/`) and
    freezes it on the run row (`plan_json` + `plan_hash`); a run executes the
    plan compiled at start, and edits to the source file require a new run.
  - **Per-step orchestration.** A step can declare an engine, model, timeout,
    fan-out (`map`/`over` with a `concurrency` cap and a `collect` | `vote`
    reducer), a typed `output` JSON Schema (validated via a `runStructured`
    retry-with-feedback loop), `env` bindings (resolved through the existing
    `akm env run` machinery — secret tokens, dangerous-key policy, keys-only
    audit events), and classify-and-dispatch `route` steps.
  - **Determinism + replay.** Journaled unit identity is content-derived
    (`<step>:<sha256(item)[:12]>`, `:solo` for a single unit), so cached
    results survive item-list reordering; a completed unit whose recorded
    inputs differ on replan is a hard **replay-divergence** failure naming the
    unit, never a silent re-dispatch. Every unit is recorded in the new
    `workflow_run_units` table behind a serialized writer queue.
  - **Execution (`akm workflow run`).** A semaphore-bounded scheduler fans a
    step's units out (concurrency defaults to 1 per the local-model
    LLM-defaults rule and is the minimum of the map request, frozen workflow
    limit, selected frozen LLM engine limit, and current host safety limit),
    enforces per-unit
    timeouts (default 10 m) and run **budget ceilings** (`budget.max_tokens` /
    `budget.max_units`, seeded from the journal so they span resumes), and
    advances the run **strictly through `completeWorkflowStep`** so completion
    gates are never bypassed. Every dispatched unit gets a standard akm
    preamble (run/unit ids, knowledge + env/secret + reporting contract).
  - **Typed artifacts + honest gates.** A step's promoted artifact is
    validated against its declared `output` schema before completion; a
    criteria-bearing gate judges that **artifact** (canonical JSON, clipped)
    rather than machine prose, and each engine-driven evaluation is journaled
    as a gate unit row. `gate.max_loops` bounds an evaluator-optimizer retry
    loop (feedback threaded into re-dispatched unit prompts). Gates are
    optional validation: omitted/empty rubrics and unavailable or malformed
    judges skip validation.
  - **Failure policy.** Per-unit `on_error: fail | continue` (fail-fast
    default) plus bounded `retry: { max, on: [<failure_reason>…] }` keyed on
    the persisted failure taxonomy.
  - **Isolation + leases.** `isolation: worktree` runs each file-mutating unit
    in a fresh detached git worktree (journaled path; clean trees
    auto-removed, dirty ones retained). A run **lease** (`engine_lease_*`)
    ensures a run is driven by exactly one engine or one external driver at a
    time; manual `complete` is refused while a live engine lease is held.
  - **Harness-neutral driver protocol.** An orchestrated run can be driven by
    ANY agent session (Claude Code, opencode, Codex, a human at a shell), not
    only the native engine. **`akm workflow brief <run>`** is read-only (takes
    no lease, mutates nothing) and emits the active step's expected work-list —
    per-unit content-derived id, resolved instructions + input hash
    (byte-identical to the engine's dispatch), output schema, env binding
    NAMES only, and the exact `report` command lines. **`akm workflow report
    <run> --unit <id> --status completed|failed|running`** is the one mutating
    verb, ingesting a unit's result through the SAME shared step semantics the
    engine uses (idempotent same-hash re-report, replay-divergence on a
    differing hash, budget enforcement, schema validation, and the
    artifact-judged gate/`max_loops` completion path). `--status running`
    claims/heartbeats a unit for stale-driver detection without advancing the
    spine; `--rerun` records a fresh attempt for a failed unit (carrying its
    prior token total forward). Every report command carries `--expect-step`
    (refused if the spine has moved since the brief), and `report --settle`
    (no `--unit`) advances a step that dispatches no reportable units — a
    params-only route, an empty fan-out, or an all-unresolvable work-list — so
    a driver is never wedged. The engine and the brief/report surfaces are
    proven to produce **identical unit graphs**
    (`tests/workflows/conformance/driver-parity.test.ts`).
  - **Observability.** `akm workflow watch <run>` tails the run's `workflow_*`
    / `workflow_unit_*` events as NDJSON (`--stream` foreground-polls to a
    terminal status, no daemon); `akm workflow status --units` lists per-unit
    diagnostics (failure reason + result/error text) without feeding them into
    the deterministic artifact graph; unit lifecycle emits
    `workflow_unit_started` / `workflow_unit_finished` events carrying
    ids/status/enums only. `akm show workflow:<name>` summarizes each step's
    orchestration.
  - **Harness adapters.** Seven local coding-agent CLIs are first-class
    dispatch targets — Codex, Copilot CLI, Pi, Gemini, Aider, Amazon Q, and
    OpenHands — each registered in `HARNESS_REGISTRY` with a command builder +
    result extractor; agent-identity detection and the session-log provider
    list are derived from the registry, and harness-native session ids are
    journaled opportunistically for future session reuse.
  - **Storage.** Additive `workflow.db` migrations 004–010 (unit journal,
    harness session ids, frozen plans + run leases, check-in heartbeats,
    attempt counter, unit claims); migrations 001–003 are untouched and linear
    workflows behave exactly as before.

  See "Orchestrated steps" and "Driving a run from any agent" in
  `docs/features/workflows.md`, the redesign addendum in
  `docs/archive/akm-workflows-orchestration-plan.md`, and `STABILITY.md`
  (Experimental).
- **`fable` built-in model alias** — resolves to `claude-fable-5`
  (`opencode/claude-fable-5` on opencode); recommended resolution target for
  the `deep` workflow model tier.
- **`akm lint` now checks the frontmatter xref channels for broken refs.**
  The existing `missing-ref` check additionally scans the `xrefs:`,
  `supersededBy:`, and `contradictedBy:` frontmatter keys of non-wiki markdown
  assets (memories, knowledge, lessons, facts, agents, commands, skills,
  workflows) — the channels the stash back-linking conventions route
  provenance and correction links through, and previously the only ref channel
  with zero checking. Dangling refs are flagged with a detail naming the key
  (`missing ref: <ref> (frontmatter <key>; resolved to <relPath>)`). The
  `refs: []` body-scan carve-out does not suppress the new pass; `lint_skip:
  [missing-ref]` suppresses both; non-ref values (URLs, `raw/<slug>`,
  `<placeholder>` templates, shell vars) are ignored; refs resolving in a
  configured extra stash root stay clean. **Note for `--fail-on-flagged` CI
  users:** stashes with already-dangling xrefs (e.g. from past renames) will
  gain new `missing-ref` findings on upgrade — fix the refs or add
  `lint_skip: [missing-ref]` per file. `sources:`, `source_refs:`, and
  `evidenceSources:` are deliberately not checked (wiki `sources:` is covered
  by `akm wiki lint`; the latter two legitimately point at merged-away
  assets).
- **`--xref <ref>` on `akm remember` and `akm import` — write-time
  cross-references with validation.** The stash back-linking conventions route
  provenance and associative links through `xrefs:` frontmatter, but neither
  CLI write flow could express them (remember always generated its own
  frontmatter block; import wrote content verbatim). The new repeatable flag
  records refs in the written asset's `xrefs:` frontmatter list, which the
  indexer folds into search hints — the new asset becomes findable from
  searches for its source. `remember` merges the refs into its generated
  frontmatter (composes with `--tag`/scope flags; does not trigger the
  tags-required check); `import` dedupe-appends into the document's existing
  frontmatter, or adds a block when the document has none — never a nested
  second block. A document whose existing frontmatter is not a parseable YAML
  mapping aborts the import (exit 2, nothing written) rather than being
  rewritten lossily; importing it without `--xref` still preserves it
  verbatim. Every ref is validated before anything is written, against the
  write target plus all configured sources (read-only cross-stash sources
  count): an unresolvable ref fails with the standard usage envelope (exit 2)
  and leaves the stash untouched. The conventions' ~5-xref cap stays soft —
  exceeding it warns on stderr but still writes. Additionally, a type-root
  write (no `--path`, flat name) into a stash carrying convention facts now
  returns an additive `hint` output key pointing at the stash's placement
  conventions (`facts/conventions/organization` when that fact exists), so CLI
  writers see the conventions that LLM flows already receive by injection.
- **`--supersedes <ref>` on `akm remember` and `akm import` — atomic
  correction + demotion of the superseded asset.** The stash conventions'
  corrections pattern needs TWO writes (the new correction asset with an xref
  to what it corrects, plus a metadata edit demoting the old asset), which
  previously meant hand-editing the old file's frontmatter and remembering to
  reindex it. The new repeatable flag does both: the correction is written
  with the old ref folded into its `xrefs:` (correction provenance), and the
  old asset gains `beliefState: superseded` +
  `supersededBy: [<new ref>]` via the shared `writeSupersededEdge` primitive
  (sibling of `writeContradictEdge`) — a metadata-only frontmatter edit that
  preserves every other key and the body byte-for-byte, sorted-set-appended
  and idempotent across re-runs. The mutated old file is reindexed by the
  write path, so `--belief current` hides it and ranking demotes it
  immediately. An unresolvable ref is input validation: exit 2 with the
  standard `{ok:false,error,code}` envelope and NOTHING written or demoted
  (no partial correction); a ref resolving to the asset being written itself
  (self-supersede via `--force` overwrite) is rejected the same way instead
  of letting a correction demote itself. An old asset that resolves only
  outside the write target and the working stash (in a read-only source, or
  in a writable source that is not this write's target) is not mutated: the
  correction still writes, stderr warns, and the JSON output reports the
  additive `superseded: [{ref, applied: false, reason}]` key (`applied: true`
  on success) — the reason names the `--target` remedy when one exists. An
  old asset whose existing frontmatter is not parseable YAML is likewise
  skipped (`applied: false`) rather than rewritten through the lossy lenient
  parser. On a git write target the demotion is ordered before the
  batch-at-boundary commit, so the correction and the demoted old asset land
  in one commit.
- **Ref-prefix search queries — `akm search "<subdir>/<prefix>/"` now enumerates
  that subtree.** A query shaped like a ref prefix (trailing slash required:
  `memories/projectA/`; a bare `memories/` lists the whole type) translates to a
  typed index enumeration narrowed to entry names under the prefix, instead of
  degenerating into the AND-token FTS query its sanitized form used to produce
  (`"memory projectA"` — noise, since `entry_type` is not an FTS column). The
  listing is recursive and `/`-boundary exact (`projectA/` cannot leak a
  sibling `projectAlpha/…` scope), matches names case-insensitively (the CLI
  lowercases queries; on-disk scope directories may carry mixed case), and
  composes with `--limit`, `--belief`, `--filter`, and named `--source`
  narrowing exactly like the existing empty-query enumeration — hits carry the
  fixed browse score `1` in deterministic listing order, not a relevance
  ranking. The parsed type is explicit intent: a bare `sessions/` enumerates
  sessions just like `--type session` (the default session exclusion is an
  untyped-path policy), while an explicit `--type` flag always wins over the
  type parsed from the query (the branch fires only on untyped searches). A
  full ref without the trailing slash (`memories/projectA/auth-tip`) stays an
  ordinary keyword search — resolving a single ref is `akm show`'s job.
  **Stable-surface note:** `akm search` is Stable; this changes results for a
  query shape that previously returned noise or nothing. A user literally
  keyword-searching for the string `memories/x/` loses the old fuzzy token
  behavior — accepted as negligible.
- **The `category:` frontmatter key is now captured into the index** as
  `entry.category` (entry_json only — no schema migration). The key already
  drives convention-fact prompt injection (`resolveStashStandards`) and the
  fact linter, but the indexer never captured it, so no category-keyed search
  or ranking policy was implementable. Captured for all markdown asset types
  alongside `beliefState` (trimmed; blank/non-string values ignored; no
  default invented), captured directly onto the index entry. Search results
  and ranking are unchanged — this is capture
  only (a unit test pins that `category` never enters the FTS search
  fields). **Requires a reindex to take effect** for existing entries. The
  companion rank-time demotion of `category: convention` facts on untyped
  queries was NOT shipped: the prescribed measurement (full skeleton
  convention facts plus a real `knowledge/auth` asset, untyped `auth` query,
  semantic off) shows no crowding — FTS is exact-first, so prefix expansion
  onto the facts' tokens only happens when nothing matches the query exactly,
  and a real domain asset always outranks the facts. That invariant is pinned
  by `tests/search-convention-fact-demotion.test.ts`, which becomes the
  regression guard if a demotion contributor is ever revisited.
- **One progressive lexical retrieval path and searchable Markdown prose.**
  FTS now tokenizes Unicode letters/numbers, deduplicates and caps the query,
  then runs strict AND, prefix-AND, and a single OR/prefix-OR recovery only
  after both conjunctive forms miss. Every stage keeps the existing BM25 field
  weights and downstream ranker; callers do not maintain stopword lists or
  parallel result collections. AKM-native Markdown contributes a normalized,
  16,384-character body projection through the existing lowest-weight
  `content` field. Frontmatter, comments, fenced code, and link destinations
  are removed; secret/env values and raw session/checkpoint bodies never enter
  the projection. Structured fields remain first in the bounded embedding
  input, so exact names and metadata continue to dominate body-only matches.
- **`akm mv <ref> <new-name>` — rename with inbound-xref rewrite and
  utility-history preservation (Experimental).** The stash conventions'
  forced-rename procedure ("grep and fix inbound xrefs in the same pass") was
  agent-executable except for the part only the CLI can do: a rename used to
  mint a new index row, orphaning the `utility_scores` /
  `utility_scores_scoped` / embeddings / salience rows keyed by entry id —
  the "rename resets learned ranking" cost the conventions warn about. The
  new verb does the whole pass: it moves the file (a memory's `.derived.md`
  twin moves together, keeping the `entry_key + ".derived"` belief-inheritance
  coupling), rewrites inbound refs across the writable stash's markdown files
  — body prose, frontmatter ref-list keys (`xrefs:`/`refs:`/`supersededBy:`/
  …), and fenced code blocks — with complete-ref boundary matching (a longer
  ref sharing the old ref as a prefix is untouched), and re-keys the index
  row **in place** so the row id and every id-keyed ranking table survive;
  the moved row and rewritten citers are FTS-refreshed so search reflects the
  new name immediately. Scope v1: flat-markdown asset types (`memory`,
  `knowledge`, `command`, `agent`, `workflow`, `lesson`, `session`, `fact`)
  in the primary writable stash only, and the source ref must be the
  canonical spelling — a ref that resolves only through one of lint's
  fallback resolutions (knowledge-subdir alias, direct-path) is rejected
  naming the canonical ref, since a fallback-keyed move would strand the
  index row and dangle canonical citers. Wiki refs, cross-type targets,
  existing targets, unresolvable refs, type-root escapes, `.derived` twin
  refs as the source (rename the base — the twin follows), and target names
  ending in `.derived` (reserved twin suffix) are rejected with the
  standard envelope (exit 2, nothing moved). Read-only sources are scanned
  but never written — their citing files are reported in `readOnlyCiters` as
  manual follow-ups. Output:
  `{ok, from, to, rewrote: [{file, count}], readOnlyCiters, utilityPreserved}`;
  a successful move appends an exactly-once `mv` event. A durable mutation
  journal stages citer rewrites and the asset publication, preserves
  source-qualified utility/salience history, and resumes index/state
  finalization after interruption. Divergent citers and late-created targets
  fail closed instead of being overwritten. Added to the v1 §9.4 command
  surface as an Experimental-tier additive entry (see `STABILITY.md`).

### Changed

- **X source tokens now resolve from the secret store during bundle update.**
  The `secrets/x-bearer-token` akm secret is honored on the provider
  `sync()` / bundle-update path, not just when adding or importing a URL —
  closing a gap where a refresh saw only the `X_BEARER_TOKEN` environment
  variable. Implemented as a `SecretResolver` capability injected from above
  the source-provider import cycle; internals are documented in
  `docs/architecture/reviews/env-secret-access.md`.

- **`website` crawls now have a hard time limit.** `crawlTimeoutMs` (default
  600000 — 10 minutes) bounds the entire crawl, and unlike the previous
  between-page check it aborts work already in flight: a `Retry-After` sleep
  could previously park `akm bundle add` for as long as a rate-limiting server
  asked, well past the advertised cap. Raise it for a large site, or set
  `"crawlTimeoutMs": 0` to disable the cap. Relatedly, `fetchWithRetry` now
  honors its caller's `AbortSignal` during retry backoff, so any operation that
  passes a signal can actually interrupt a long wait.

- **Website snapshots now extract the page's main content.** Conversion moved
  from a hand-rolled regex converter to a DOM parse plus Turndown, scoped to
  the page's content region (`<main>`, `<article>`, `[role=main]`, then common
  content ids/classes, falling back to `<body>` minus nav/header/footer/aside).
  Navigation, ads, and boilerplate no longer land in snapshots, and tables,
  nested lists, and fenced code blocks with language hints now survive
  conversion. **Existing website snapshots will change on their next refresh**
  — expect them to get shorter and cleaner. Link discovery still scans the
  whole page, so crawl coverage is unchanged.


- **`website` sources now respect `robots.txt` by default.** Before crawling
  an origin, akm fetches and parses that origin's `/robots.txt` and skips
  paths disallowed for the `akm`/`akm-cli` product tokens (or `*`), honoring
  `Crawl-delay` (clamped to 10s) between page fetches. This is a deliberate
  behavior change: **existing website sources may return fewer pages, or
  fail with an error if the start URL itself is disallowed, after
  upgrading.** Re-running `akm bundle update` on a website source is what
  surfaces it. Opt out with `"respectRobots": false` on the website
  descriptor to restore the exact pre-upgrade behavior (no `/robots.txt`
  request at all):

  ```json
  { "bundles": { "docs": { "website": { "url": "https://docs.example.com", "respectRobots": false } } } }
  ```

- **`akm lint` now routes through each bundle adapter's own `validate()`.**
  `validate()` was a required member of the adapter interface that nothing
  called: `akm lint` branched on adapter id and re-implemented OKF's checks
  inline (with drifted semantics for `missing-type`), OKF's `missing-ref`
  never ran at all (a bundle with a dangling link reported nothing), and
  llm-wiki's `uncited-raw` / `broken-xref` / `broken-source` /
  `missing-description` checks were unreachable dead code. **Existing OKF and
  llm-wiki bundles may surface new lint findings after upgrading.** akm-bundle
  lint output is byte-identical. Proposal promotion also runs the adapter
  check immediately before the write — advisory-only: it warns and never
  rejects, because the adapter resolver and the legacy promotion gate still
  disagree on foreign-typed cross-bundle refs.

- **Improve-stage extraction and proactive maintenance now ship opt-in.** The
  built-in `default` and `frequent` strategies resolve extract off, while
  `default` and `reflect-distill` resolve `proactiveMaintenance` off. The
  dedicated `proactive-maintenance` strategy remains enabled. Built-ins such as
  `thorough` that omit these fields inherit the new `default` off values; user
  overrides are merged last, so explicit `enabled: true` values still win.
  Standalone extraction remains independent of the improve-stage toggle but
  still requires `--type <harness>` or `--auto`. The bundled, unselected
  `core/extract` task now uses `akm extract --auto`; existing scheduled tasks
  with invalid bare `akm extract` commands must be updated explicitly.
- **Indexing dispatches each bundle's detected adapter.** The indexer's per-
  directory scan now resolves the component's adapter (`adapterForId`) and runs
  THAT adapter's `recognize`, instead of always using the `akm` adapter. A
  component whose adapter id is unknown is skipped with a warning. Adapter-owned
  filtering moves the AKM-stash sensitive/infra exclusions (env/secret
  `.sensitive`-marker skips, the legacy `vaults/` skip, wiki infra files) out of
  the core scan and into the `akm` adapter's own recognition, so each adapter
  owns its bundle's filtering. **Reindex note:** any non-`akm` bundle that was
  previously probed as one adapter id but still recognized by `akm` will
  re-index under its own adapter on the next `akm index` — the index is a
  regenerable cache, so no migration is required.
- **Improve target identity is now end-to-end and source-qualified.** Explicit
  targets govern reads, generated proposals, triage promotion, consolidation,
  retrieval signals, cooldowns, and replay state. Duplicate bare refs in other
  sources no longer affect the selected corpus. Generated lessons and
  provenance follow stash placement conventions and canonical `xrefs`.
- **Writable Git boundaries commit only operation-owned paths.** Improve,
  proposal, supersedes, and direct write flows preserve unrelated staged or
  dirty work, including files beside generated assets in `content/` layouts.

- **Directory (scope/domain) tokens now always merge into `tags` at index
  time**, even when an asset sets explicit `tags:` frontmatter. Previously
  explicit tags suppressed all path-derived tags, so a nested asset like
  `memories/projectA/auth-tip` with `tags: [auth]` silently lost the exact
  tag-match ranking boost for its scope token unless the author restated it.
  The merged tokens come from the canonical ref subpath
  (`extractDirTagsFromName`), which also fixes the flat-walk indexing path
  losing directory segments in the empty-tags fallback. Filename tokens are
  still auto-derived only when `tags` is empty (they already live in the FTS
  name column and aliases), and the empty-tags fallback itself is unchanged.
  **Operator notes:** the change takes effect on the next reindex and alters
  indexed tag text for nested assets with explicit tags, so collapse-detector
  canary recall baselines may shift — re-mint them with `akm improve canary
  --refresh`. Embeddings are not regenerated when indexed text changes; the
  drift here is small (the merged tokens already appear in the name field),
  but a purge/re-embed picks up the new text exactly.
- **Demoting belief states now cap an entry's final search score**
  (superseded ≤ 0.25, contradicted ≤ 0.2, archived ≤ 0.15, deprecated ≤
  0.28). The existing additive belief penalties are applied inside the
  multiplicative boost sum on a min-max-normalized FTS base (rank-1 vs rank-2
  base can differ by up to 0.7), so a superseded incumbent that was the best
  keyword match stayed clamp-pinned at 1.0 above its own correction — the
  demotion was invisible exactly when the corrections pattern needs it. The
  ceiling is applied once at the end of the single scoring pipeline (sort
  order and displayed scores stay consistent); demoted entries remain listed
  under the default `--belief all`, keep their relative ordering, and the
  `--belief` filter axis is unchanged. Semantic-only hits are judged against
  the `search.minScore` floor by their pre-ceiling score, so a ceiling below
  the floor (archived 0.15 < default 0.2) ranks the hit last instead of
  silently dropping it. Ordering changes only for stashes containing
  belief-flagged assets.
- **`mutateFrontmatter` (belief-edge writers: supersede/contradict edges,
  belief refresh) now preserves the body bytes verbatim** when the file
  already has a frontmatter block, instead of re-normalizing the
  fence-to-body separator through `assembleAsset`. A metadata edit is no
  longer a (whitespace-level) content edit; files gaining their first
  frontmatter block still use the canonical shape.

### Fixed

- **Fresh 0.8 installs can actually upgrade.** A config that 0.8.x wrote
  itself carries no `configVersion` key at all (0.8 stamped it only when a
  0.7-era migration did substantive work), and the migrator read the absent
  key as `inconsistent` — an unconditional blocker. `migrate status` reported
  `blocked` and `migrate apply` refused with exit 78 for every fresh 0.8
  install; reproduced end to end against the published `akm-cli@0.8.14`. An
  absent `configVersion` on a positively pre-cutover-shaped config now
  classifies as `old`; a present-but-unparseable version still fails closed.
  Relatedly, `migrate` reports `not-applicable` (exit 0) instead of `blocked`
  when there is no akm installation to migrate at all, and `apply` warns when
  an active workflow run targets an asset that fails 0.9 structural
  validation, naming the asset and `akm workflow abandon <run-id>`.

- **`akm lint` fails closed on mistyped invocations.** A nonexistent `--dir`,
  or an unknown `--type` on an akm bundle (the classic singular/plural typo,
  `--type workflow`), used to scan nothing and report a clean
  `ok:true, flagged:0` — silently passing scripted `--fail-on-flagged`
  gates. Both are now usage errors (exit 2), the `--type` error listing the
  valid values.
- **Registry search survives a briefly unreachable registry.** Once the
  cached registry index aged past its refresh TTL, a failed fetch
  hard-failed the command even though a serviceable index sat in the cache.
  A failed fetch now serves the last cached index — past its TTL — with a
  warning naming the fetch error.
- **`akm upgrade` verifies the package manager actually delivered the new
  version.** A lagging `@latest` dist-tag (partial publish, registry mirror
  lag) exits 0 while leaving the old version on PATH; upgrade used to report
  success anyway — and then run `migrate apply` against the old binary. It
  now re-reads `akm --version` after the install: a confirmed mismatch
  reports `upgraded: false` with an exact-version pin command, and a
  verified match is named in the success message.
- **`akm info` no longer overstates semantic-search health.** After a run
  with partial sqlite-vec fast-path insert failures, the verification
  reported `ready-vec` ("sqlite-vec active") even though search had already
  routed to the slower JS-cosine fallback. The status now reflects the path
  search actually takes, with an `akm index --full` hint when the fast path
  is degraded. Relatedly, `embedding.dimension` is now bounded to the
  vec table's own 1–4096 limit at config validation, so an out-of-range
  value fails at `akm config set` with a clear message instead of crashing
  `akm index` mid-run.
- **Standalone `akm remember --enrich` actually enriches.** With no other
  metadata flag, `--enrich` fell through to the zero-flag raw-write hot path
  and never attempted the LLM call — an unenriched memory with no warning.
  `--enrich` now routes to the enrichment dispatch exactly like `--auto`;
  the fail-soft contract is unchanged (no configured LLM still warns and
  writes without enrichment).
- **Read paths no longer plant a broken `index.db` on a fresh install.**
  The fire-and-forget usage telemetry behind `search` / `show` / `curate`
  opened `index.db` with create-on-open: with no index built yet, the open
  itself left an empty, schema-less `index.db` behind, and every later
  command then saw an existing-but-broken index ("no such table: entries") —
  hard-failing proposal acceptance among others. `openExistingDatabase` now
  refuses to create the file (a missing index throws, naming `akm index` as
  the remedy) and the telemetry paths skip cleanly instead.

- **Improve RC stabilization.** Restored one ownership-safe whole-run lock from
  triage through final sync; `--skip-if-locked` is a true no-op; the run deadline
  now starts before indexing and reaches index waits, generation, reindexing, and
  quality judges; reflect judges the sanitized final candidate with bounded
  changed-region context; write-target selectors no longer replace durable source
  identity; and vLLM thinking controls cannot be overridden through `extraParams`.
- **Proposal promotion, reversion, and rejection are durable and recoverable.**
  Acceptance and reversion persist target ownership and content fingerprints,
  publish atomically across filesystem layouts, index immediately, commit exact
  Git paths, and emit idempotent lifecycle events. Crash recovery and legacy
  accepted proposals fail closed on ambiguous targets instead of clobbering
  another source.
- **Engine/setup/health behavior now matches the effective improve plan.**
  Built-in strategies compose over one baseline, setup preserves independent
  general and LLM defaults, native OpenCode SDK execution does not require an
  unused fallback, and health checks each enabled process and credential.
- **Check-in directives now survive plain-text output and `workflow
  status`** (check-in review C2/M1): `formatWorkflowNextPlain` and
  `formatWorkflowStatusPlain` render the `CONTINUE` directive, and every
  run-detail response (status/start/complete) evaluates the check-in instead
  of only `workflow next`.
- Workflow frontmatter validator error message now lists the actually-allowed
  keys (`name`, `updated` were missing); removed the documented-but-nonexistent
  `akm workflow step` alias from `docs/features/workflows.md`.

## [0.9.0-rc.13] - 2026-07-31

### Security

- **`akm update` no longer deletes a previous install directory without
  confirmation.** When a managed source's resolved content location moves,
  `update` removed the old directory outright, while `akm remove` had always
  required `--yes` in non-interactive mode. Only that destructive branch is
  gated — a normal refresh, where the location does not move, still needs no
  prompt and no flag, so existing CI invocations are unaffected. Pass
  `-y`/`--yes` to allow the deletion non-interactively. A cleanup that fails
  now warns instead of failing silently.

- **The dangerous-env-key install gate now scans `env/` recursively.** It
  previously read only the top level, so a stash carrying `LD_PRELOAD` in
  `env/nested/inner.env` installed cleanly with no warning. Files without a
  `.env` suffix are still not scanned — no akm code path loads them as
  environment variables.

### Added

- **The `okf` adapter reads OKF v0.2's trust/provenance and lifecycle
  frontmatter families.** `generated: {by, at}` (with `generated.at` taking
  precedence over the legacy `timestamp` field, which remains a valid
  fallback), `verified` (a list, or v0.2's permitted single-mapping
  shorthand), `sources` (an object list — `resource` required; `id`/`title`/
  `author`/`usage_count`/`last_modified` optional), `status`
  (`draft`/`stable`/`deprecated`), and `stale_after` are now parsed leniently
  from any OKF concept's frontmatter and surfaced on new, namespaced
  `IndexDocument` fields (`provenance`, `lifecycleStatus`, `staleAfter`,
  `okfVersion`) that never overload the pre-existing AKM-native `sources`
  (wiki citation strings), `generation` (consolidation depth), or `quality`
  fields. As with every other optional OKF field, a missing or malformed
  value never rejects the document. The `okf` adapter remains consumer-only.

- **Accepting a proposal now stamps OKF v0.2 provenance onto the written
  asset's frontmatter**, for AKM-native writes only (never through the `okf`
  adapter, which stays consumer-only and unaffected by this). `promoteProposal`
  projects the proposal system's own `source`/`sourceRun`/`gateDecision`/
  `review` bookkeeping — already tracked in `state.db` but previously never
  written to disk. `generated: {by, at}` and `verified: [{by, at}]` are written
  **bare at the top level**, exactly as OKF v0.2 spells them, so a third-party
  OKF v0.2 reader pointed at an AKM stash sees conformant trust metadata;
  `sources` alone is namespaced as `provenance: {sources}`, because a bare
  `sources:` collides with the pre-existing wiki citation-string convention.
  `generated.by` records whether the content came from an automated pipeline
  (`akm/<version>`) or a human-initiated source (`human:<id>`); `verified`
  records whether the promotion itself was an automated gate decision or a
  direct human accept, and accumulates rather than overwriting across
  re-promotions; `evidenceSources`, when present, projects as
  `provenance.sources`. AKM's own adapter rereads what it wrote, so `akm show`
  surfaces it. Every AKM-native markdown type is stamped, `workflow` included.

  Two consequences worth knowing: promotion re-serializes the whole frontmatter
  block, so YAML **comments** in a hand-written proposal's frontmatter are not
  preserved (values and body bytes are); and for a human-attributed promotion
  with no configured actor id, `by` falls back to `human:<OS username>`, which
  puts that username into content you may later commit and share.

- **Internal: a `capturedAtHead` integrity guard**
  (`scripts/lint-golden-captured-at-head.ts`, wired into `bun run lint`) now
  checks every golden fixture's recorded `capturedAtHead` commit SHA — it must
  exist in the local object database and be reachable from at least one known
  branch. Post-hoc review of this PR found all four new OKF format-family
  goldens pointed at a commit that existed locally but was unreachable from
  any ref (a pre-amend duplicate left behind by an interrupted git operation),
  which would have 404'd on GitHub and vanished under a local `git gc`; a
  human fixed that one by hand because nothing caught it. This guard is that
  catch, going forward. In CI's shallow (`fetch-depth: 1`) checkout, a merely
  *absent* commit object is inconclusive (indistinguishable from "just not
  fetched") and only warns; a commit that *exists but is unreachable from any
  branch* — the actual bug class above — still fails there too, since a
  shallow clone can tell presence apart from absence just fine.

- **`akm log list --limit <n>`** returns the most recent N events. The flag was
  documented but silently ignored, and there was no limiting mechanism at all
  in the read path — the command returned the entire events table regardless of
  history size. The default remains unlimited.

- **`--track-usage` (default on) on `akm search`, `akm curate`, and `akm show`.**
  Pass `--no-track-usage` for a read-only lookup that does not feed usage
  telemetry or the utility-score ranking signal. Previously a bare `akm search`
  silently wrote a `utility_scores` row that influenced future ranking, with no
  disclosure and no way to opt out.

- **`akm show` returns the canonical `ref` in every shape.** It was present only
  under `--shape agent`, so a `--shape summary` consumer had to make a second
  call at a different shape just to learn which asset it was looking at.

- **`akm info` gained `stashDir`, `defaultBundle`, and `indexStats.byType`.**
  Answering "which stash is primary" previously required a separate
  `akm sources list`.

- **`instruction` is a stash-resident asset type.** It was already in
  `KNOWN_TYPES` and had a presentation entry, but had no placement spec — so
  there was nowhere to put one and the indexer never recognized one. `akm bundle create`
  now creates an `instructions/` directory, `.md` files under it index as
  `instruction`, and `--type instruction` is accepted and tab-completable
  everywhere `--type` is. A compile-time assertion now pins
  `placementTypes() ⊆ KnownType`, so the half-registered state this fixes
  cannot recur silently.

- **Schedule tasks from any configured bundle via `--bundle <bundle>`** (#711).
  `akm task add`, `run`, `sync`, and `history` accept `--bundle` to
  operate on a non-default bundle instead of only the primary stash. `add`
  resolves through the normal writable-target rules; `run --bundle X` resolves
  the task file and relative asset refs from bundle X. A non-default bundle is
  recorded in the scheduler entry as `--bundle <bundle>`, so scheduled
  `akm task run` resolves the right bundle. Scheduler ids stay bare and a
  collision with another bundle is a hard error rather than a silent clobber.

- **Orphan-GC pass for unresolvable `asset_salience` / `asset_outcome` state
  rows** (#733). A new improve maintenance pass (`runOrphanStateGcPass`, run
  next to the existing orphan-proposal purge) stamps `missing_since` on any
  state row whose ref no longer resolves against `entries.item_ref`, clears
  the stamp the moment the ref resolves again, and — only when
  `improve.stateGc.collect` is set to `true` (**default `false`**) — deletes
  rows whose stamp is older than a fixed 7-day grace window
  (`STATE_GC_GRACE_MS`). The pass always runs and always reports counts via
  the new `asset_state_gc` event (`{pending, collected, byTable}`), emitted
  only when there is something to report, so live data can prove the report
  clean before `collect` is ever turned on. Additive migration
  `021-asset-state-missing-since` adds the `missing_since` column to both
  tables. Deliberately lean by design (Workstream C): no quarantine archive,
  no circuit breaker, no health-advisory plumbing, no new tables — "ref not
  present in `entries.item_ref`" is trusted as the authoritative-deletion
  predicate because the indexer already preserves a source's last-known-good
  rows when its scan is incomplete, so a temporarily unreachable source never
  contributes false candidates. `usage_events` is out of scope (already
  covered by cascade-on-delete plus its own 90-day retention purge).

### Changed

- **Workflow execution is consolidated on stable `akm workflow run`.** The
  public `workflow start`, `next`, and `complete` commands are removed with
  explicit `UNKNOWN_COMMAND` migration hints; `run <ref|run-id>` now owns
  creation, active-run continuation, native dispatch, completion, and durable
  replay. It is no longer gated by `experimental.workflowEngine`; only the
  experimental `brief`/`report` external-driver protocol retains that opt-in.
  Workflow parameters move from the opaque `--params '<json>'` bag to exact
  declared flags (`--version 1.2.3`, repeated array flags, JSON object/array
  values) coerced through the frozen parameter schemas. New invocation controls
  add bounded failed-step retries (`--max-retries`) and a whole-run timeout
  (`--timeout N|Nms|Ns|Nm`); failures, gate rejection, timeout, and signals now
  produce non-zero process statuses while leaving interrupted work resumable.

  Criteria-bearing gates now require `workflow.judgeEngine`, which may name a
  configured LLM or agent engine and is frozen into the run. Verification is
  fail-closed: a missing/failing verifier or malformed verdict rejects instead
  of silently advancing. Scheduled workflow tasks now execute through the same
  native orchestrator rather than stopping after run creation. Migration:
  replace `workflow start/next/complete` loops with `workflow run`, replace
  `--params` with exact declared flags, and configure `workflow.judgeEngine`
  before running a workflow with a non-empty `### gate` rubric.

- **The two workflow authoring formats — markdown documents and YAML
  orchestration programs — are unified into one format**, per
  `docs/architecture/specs/workflow-format-unification.md`. A workflow is
  now always a single markdown asset: the standard AKM frontmatter envelope
  carries the whole orchestration graph (`params`, `steps` with
  `unit`/`map`/`route`, `inputs`, `output`, `gate`, `defaults`, `budget`),
  and the body carries each step's instructions under a bare `## <step-id>`
  heading, joined to the frontmatter by step id. `.yaml`/`.yml` workflow
  files, the `# Workflow:` / `## Step:` / `Step ID:` markdown headings, and
  `akm workflow create <name>.yaml` are all gone; `akm workflow create`
  always writes the one unified template
  (`src/assets/workflows/workflow-template.md`).

  **Prose is never interpolated.** The YAML program's `${{ … }}` template
  language, and the markdown format's decorative — and never
  substituted — `{{ … }}` moustaches, are both removed. Data reaches a
  dispatched unit as *attached context* instead: the run's params, its
  item and index for a map unit, and the artifacts its step's new
  `inputs:` key declares. Instructions refer to that context in plain
  language ("clone the repository named by the `repo` parameter") rather
  than splicing a value into the instruction string. Bare reference
  strings (two roots, `params.<name>` and `steps.<id>.output…`) now appear
  only in three frontmatter positions: `map.over`, `route.input`, and
  `inputs:`.

  **Gate rubrics move to the body.** A step's completion criteria are no
  longer a frontmatter `gate.criteria` list or a `### Completion Criteria`
  bullet section — they live under a step's `### gate` sub-heading, the
  format's one reserved marker, as full prose a judge receives byte-exact.
  Frontmatter `gate:` now carries only optional `max_loops` configuration.
  Omitted or empty rubric text skips validation; a non-empty rubric requires
  the frozen `workflow.judgeEngine`, and unavailable or malformed judges reject
  the gate.

  This is a **pre-1.0 format change**. The ten example workflows under
  `scripts/akm-eval/example-stash/workflows/` are rewritten to the unified
  format in this change; existing user-authored workflow assets must be updated
  manually before execution.

- **akm is described as a knowledge toolkit, not a package manager** (R-048).
  The npm one-liner, the README lede, and the `concepts.md` opener all led with
  "a package manager for AI agent capabilities", which misstates the product to
  its distribution channel and sets package-manager expectations for verbs
  (`update` / `upgrade` / `sync`) that don't mean what a package manager's do.

- **BREAKING: a command group invoked with no subcommand is now always a usage
  error, exit 2** (owner ruling 12). The eleven `akm <group>` groups did three
  different things when invoked bare: `graph`, `config`, `env`, `secret`,
  `task`, `workflow`, and `proposal` ran an implicit default action and exited
  0 (bare `akm graph` silently rendered `graph summary`); `registry`, `log`, and
  `lessons` printed citty's human usage banner to stdout; only `migrate` raised
  a structured error. All eleven now emit the same
  `MISSING_REQUIRED_ARGUMENT` envelope on stderr, naming the available
  subcommands, and exit 2 — matching STABILITY.md's exit-code table (2 =
  usage) and the exit code already used for unknown commands. Matching exit
  codes alone was not enough: a script could not parse the failure uniformly
  while three groups answered on stdout in prose.

  Migration: name the subcommand. `akm graph` → `akm graph summary`,
  `akm config` → `akm config list`, `akm env` → `akm env list`, `akm secret` →
  `akm secret list`, `akm task` → `akm task doctor`, `akm workflow` →
  `akm workflow list --active`, `akm proposal` → `akm proposal list` (which
  takes the same `--status`/`--queue`/`--ref`/`--type` flags the bare form did).

- **BREAKING: `akm sync` persists `eventType: "sync"`, not the legacy
  `"save"`.** The event name now matches the command name. Historical
  `state.db` rows are left as-is — `akm log` and `akm log tail` treat `"save"`
  and `"sync"` as synonyms on **read**, so `akm log --type save` keeps
  returning both old and new rows. Only newly written events use `"sync"`.

  Migration: none for `akm log --type save`. A script matching raw event rows
  by `eventType === "save"` — reading state.db directly, bypassing `akm log` —
  should also match `"sync"` to see new syncs.

- **BREAKING: dropped the dead `installedKitCount` field from the `add`,
  `remove`, and `update` JSON envelopes.** It was a raw lockfile-entry count
  that nothing — internal code or test — ever read.

  Migration: a script parsing `.config.installedKitCount` should stop; the
  field is gone, not renamed. `config.sourceCount` remains and is unaffected.

- **BREAKING: dropped the dead `graphPath` field from every `akm graph *` JSON
  envelope** (`summary`, `entities`, `relations`, `export`, `related`, `entity`,
  `orphans`). It always resolved to the shared state.db path, never a
  per-graph artifact, and carried nothing `stashPath` did not already provide.

  Migration: a script reading `.graphPath` from any `akm graph` subcommand
  should stop; `stashPath` remains.

- **BREAKING: `semanticSearchMode` now defaults to `"off"`.** A bare or
  headless install (`akm init`, `akm setup --yes`, `akm setup --config`) was
  silently downloading the ~130 MB local embedding model on its first `akm
  index`, because the fallback used when the key is absent was `"auto"`. The
  interactive `akm setup` wizard still pre-selects semantic search **on** — a
  human is present to decide — and now shows the asset/download warning
  *before* the prompt rather than after, so the pre-checked box is an informed
  choice. When a remote `embedding.endpoint` is configured, enabling semantic
  search downloads nothing.

  Migration: existing saved configs are unaffected — the flip only changes the
  fallback used when the key is absent. To keep semantic search on for a
  headless or CI install, set `semanticSearchMode: "auto"` explicitly, or point
  `embedding.endpoint` at a remote embedder.

- **BREAKING: `akm workflow run|brief|report` refuse to run until
  `experimental.workflowEngine` is set** (0.9.0 decision Q-05). The native
  workflow executor — including fan-out scheduling and worktree isolation —
  is experimental, and shipping it enabled by default would have made an
  unreviewed execution engine reachable from a plain `akm workflow run`. The
  gated surfaces now exit `78` with a `ConfigError` naming the exact key, and
  `akm task doctor` reports the gate's state. Authoring and linting the unified
  markdown format, along with every other `akm workflow` subcommand, remain
  ungated.

  Migration: `akm config set experimental.workflowEngine true`.

- **BREAKING: the `env:<name>` / `secret:<name>` colon ref spelling is
  rejected** (0.9.0 decision Q-08). Refs are slash conceptIds only — `env/foo`,
  `secrets/deploy-key`. The colon form previously resolved as an undocumented
  alias in some places and fell through as a literal filename in others. It now
  fails with a usage error naming the slash replacement, rather than silently
  doing the wrong thing.

  Migration: rewrite `env:<name>` as `env/<name>` and `secret:<name>` as
  `secrets/<name>`. The error message prints the exact replacement.

- **`akm improve` is review-first by default; autonomy is opt-in** (0.9.0
  decision D8). The command stays ON — schedules, reflect/distill proposals, and
  graph extraction are unchanged — but the lanes that mutate assets *without*
  review now require `akm config set experimental.improveAutonomy true`:
  memory-inference writes, the memory-cleanup pass, and triage
  `applyMode: "promote"` (which downgrades to `queue` rather than disabling
  triage). Consolidation remains review-oriented and is not gated.

  A gated lane is never a silent no-op: it warns on stderr naming the lane and
  the key, appends an `improve_skipped` event with `reason: "autonomy_gated"`,
  and is counted in `akm health`'s improve skip-reason summary.

  Migration: set `experimental.improveAutonomy: true` to restore the previous
  behavior. `sync.push` is **not** affected — it keeps its `true` default and its
  own `sync.push: false` / `--no-push` controls. Two other direct writes stay
  ungated by design: `extract`'s additive session indexing and distill's
  encoding-salience frontmatter stamp. Because the gate is applied before the LLM
  preflight, a review-first workspace may now need fewer engines configured than
  before.

  Also: `akm improve` no longer rejects the global `--format`. It emits an
  envelope through `output()` (always under `--dry-run`, otherwise under
  `--json-to-stdout`), so `--format` applies to that envelope; progress output
  stays on stderr. Previously it exited 2 with `INVALID_FLAG_VALUE`, which made
  it the one command that rejected a valid global flag.

- **`akm health --report` replaces the html-only full report** (D7
  follow-through). The full health report — per-run rows, trend deltas vs the
  prior window, and the pending proposal queue — is now a **data** flag, not a
  side effect of asking for html: `akm health --report --format html` renders
  the rich report, and the identical dataset comes back under `--format json`
  (previously that data was reachable only as html). The registered md/html
  renderers fire on the shape of the result, and `akm health` no longer reads
  `--format` at all.

  Migration: `akm health --format html` → `akm health --report --format html`
  (the bare form now renders the plain check generically); the html-only
  `--compare` flag is removed — use `--window-compare`, which with `--report`
  defaults to the `--since` window so trend deltas stay like-for-like.

- **Global output flags parse correctly next to positionals.** citty parses
  each command level against only its own declared args, so a root-declared
  global flag was unknown at the leaf and its space-separated value fell
  through as a positional — `akm sync --format json` synced a bundle named
  "json", and `akm env unset env:x KEY --format json` tried to unset a key
  named "json". The global output flags (`--format`, `--detail`, `--shape`,
  `--output`) are now declared on every leaf command so their values are
  consumed by the parser; the two bespoke argv-inspection workarounds this
  replaces are deleted. Three more non-exempt commands (`akm health`, `akm
  index`, `akm lint`) now declare these flags too, purely for `--help`
  visibility — all three already parsed `--format`/`--detail`/`--shape`/
  `--output` correctly, since none of them has a positional a stray value
  could fall into.

- **BREAKING: unknown commands and missing required arguments now exit `2`
  (usage), not `1`.** citty's own command-dispatch wrapper unconditionally
  called `process.exit(1)` for any error it raised before a command's own
  body ever ran — `akm totally-bogus` (unknown command), bare `akm log` /
  `akm lessons` (a subcommand group invoked with no subcommand), and a
  command missing a required positional (e.g. bare `akm import`) all exited
  `1`, contradicting the documented exit-code table (`1` = general error /
  not found, `2` = usage / bad input). The CLI now drives command dispatch
  directly instead of going through that wrapper, so it can reclassify this
  one error family as `2` while leaving `--help`, `--version`, and every
  other exit code unchanged.

  Migration: a script that treated exit `1` as "something went wrong" for a
  mistyped command or missing argument should check for `2` instead (or
  keep treating any non-zero exit as failure, which was already correct).

- **BREAKING: `akm completions --shell <unsupported>` now exits `2` with the
  standard JSON error envelope, not `1` with a raw stack trace.**
  `completions` stays format-exempt (its own output is shell-script source,
  not a result envelope — see STABILITY.md), but its body is now wrapped in
  the same error-classification path every other command uses.

  Migration: a script parsing this failure should now expect
  `{"ok":false,"error":"...","code":"INVALID_FLAG_VALUE","hint":...}` on
  stderr and exit code `2` in place of a stack trace and exit code `1`.

- **BREAKING: `akm index --dry-run` without `--clean` now exits `2` instead
  of running a real index.** The flag only ever gated the `--clean`
  stale-entry removal pass — every other phase (walk, LLM enrichment,
  embeddings, FTS, the adapter-detection config write) ran for real
  regardless, so `akm index --dry-run` alone silently performed a full index
  despite its name. The combination is now rejected with the standard usage
  envelope instead of quietly doing something other than what "dry run"
  promised.

  Migration: a script or cron invoking bare `akm index --dry-run` was
  already getting a real index, so nothing there needs to change in effect —
  but it will now fail loudly instead. Pass `akm index --clean --dry-run` to
  preview the stale-entry removal pass, or `akm index --clean` to apply it;
  drop `--dry-run` entirely to keep running a plain real index.

- **BREAKING: a corrupt or unparseable `akm.lock` now makes lockfile WRITES
  throw, instead of silently destroying every entry.** The previous lenient
  reader returned `[]` on unparseable JSON; a write path that upserted a
  single entry onto that `[]` then overwrote the file, permanently deleting
  every other tracked bundle's lock entry. Install/update/remove write paths
  now use a strict reader that throws on the same corruption instead of
  reaching the destructive overwrite.

  Migration: if a write now fails with a lockfile-parse error, `akm.lock` is
  genuinely corrupt — inspect and repair it by hand, or restore it from a
  backup (e.g. git history), before retrying the write. Reads elsewhere are
  unaffected; the lenient read contract is unchanged.

- **BREAKING: `AKM_NPM_REGISTRY` now redirects npm package METADATA lookups,
  not just the trusted-tarball allowlist.** Previously the override only
  widened which tarball hosts were trusted for download while metadata
  queries stayed hardcoded to `registry.npmjs.org`, so a configured private
  mirror was never actually consulted for package info — the error hint that
  points users at this variable was false. The override now also replaces
  the metadata registry base, matching how a private npm registry is meant
  to work (like npm's own `--registry` flag: wholesale replacement, not a
  merge with the public registry).

  Migration: an operator who set `AKM_NPM_REGISTRY` expecting only tarball
  downloads to be redirected, with metadata still served from the public
  registry, should confirm the mirror actually serves equivalent package
  metadata — `akm add`/`akm update` for npm-sourced bundles now resolve
  entirely against the configured mirror when it is set.

- **`akm remember --show-similar` and `akm migrate apply --dry-run` are the
  documented, canonical spellings** (previously `--showSimilar` /
  `--dryRun`), matching every other multi-word flag in the CLI. Not a
  breaking change: citty registers both the camelCase and kebab-case
  spelling of any declared flag name automatically, so `--showSimilar` /
  `--dryRun` keep working — they're now explicit, documented aliases instead
  of an undocumented accident.

- **`--detail` and `--shape` help text is scoped honestly.** The per-command
  `--detail` description now names `info`, `list`, and `remember` as the
  commands where it has no effect (verified byte-identical output at every
  level — `akm show` is not one of these; it has three distinct
  brief/normal/full payloads). `--shape`'s per-command help now repeats the
  "`summary` is only valid on `akm show`" caveat the root help already
  documented.

- **All six `--format` values work on every command** (0.9.0 decision D7).
  `json|jsonl|yaml|text|md|html` are now universal. Previously there were three
  inconsistent behaviours: `md` silently emitted the JSON envelope everywhere
  except `akm health`, `html` was rejected with exit 2 everywhere except
  `akm health`, and `akm health` reached neither because it intercepted the
  format itself. Rendering is now registry-driven — a command may register a
  renderer for a document format, and anything unregistered falls back to a real
  rendering of its own envelope (headings, tables for arrays of uniform objects,
  lists otherwise). `akm health` keeps its per-run/window-compare tables and its
  full HTML report by registering them; the output is unchanged.

  Migration: none required for `json|jsonl|yaml|text`. `--format md` on a
  non-health command previously returned JSON and now returns Markdown; a script
  that parsed that JSON should ask for `--format json` explicitly. `--format
  html` previously exited 2 on non-health commands and now succeeds.

  Also: `akm graph export --format` is **removed** — it declared `--format`
  locally as well as globally (one token, two parsers). The artifact payload
  now follows the `--out` extension (`--out g.jsonl` writes JSONL, anything
  else JSON); the global flag only renders the command's own envelope. A dead
  local `--format` declaration on `akm history` was removed too (it was never
  read). Commands
  whose output is not an envelope (`completions`, `setup`, `env run`,
  `secret run`, `agent`, `workflow template`, `help migrate`) are declared
  format-exempt in `src/output/format-exempt.ts` and now warn when given
  `--format` instead of ignoring it silently. `output.format` in config accepts
  all six values.

- **Subtree browse is a conceptId prefix, not `<type>:`** (0.9.0 decision D4).
  `akm search` enumerates on `memories/`, `memories/projecta/`, `bundle//`, and
  `bundle//skills/`; a trailing `/` is still required. The prefix now matches the
  **conceptId** rather than the item name, so a ref copied out of search output
  can be truncated to a prefix and pasted straight back in — previously that
  round-trip degraded silently into a keyword search. Enumeration no longer
  validates against the `akm` adapter's placement types, so items from every
  adapter browse the same way, and `bundle//` lists a whole bundle (the
  replacement for the removed `akm bundle items`).

  Migration: `akm search "memory:"` → `akm search "memories/"`;
  `akm search "memory:projectA/"` → `akm search "memories/projectA/"`;
  `akm search "session:"` → `akm search "sessions/"`. The retired spelling is
  now an ordinary keyword search; when it returns nothing, the tip names the
  conceptId spelling that replaces it. `scripts/lint-shipped-assets.ts` no
  longer exempts the old spelling, so it is an offense in agent-facing assets.

- **`akm task sync [--bundle <bundle>]` reconciles a single bundle.** Sync now
  attributes each installed scheduler entry to its bundle (parsed from the
  `--bundle` token; absent ⇒ primary) and reconciles only the entries for the
  bundle being synced. A plain (primary) sync never installs from, updates, or
  removes another bundle's entries, and sync never scans all bundles — task
  activation stays explicit (`add --bundle` or `sync --bundle`), so registering a bundle
  still never activates code. When the target is the default bundle (or omitted),
  installed scheduler entries are byte-identical to before, so upgrading shows no
  spurious drift.

- **The R2 salience ranking boost no longer applies to default `search`/`curate`
  ranking** (#692). `asset_salience.rank_score` (an encoding + outcome +
  retrieval projection, recomputed every `improve` run) previously composed
  into every default search as a bounded multiplicative boost
  (`salience-ranking`, ×[1.0–1.2]), loaded best-effort from `state.db` on the
  hot path. On live data it measured as noise (max observed multiplier
  ×1.071, mean ×1.016): the boost was retrieval-dominated with no source
  filter — double-counting the same `usage_events` the utility-score
  contributor already reinforces — warm-started non-zero with no outcome
  evidence, and had zero pack coverage, so it could only ever favor
  self-generated personal assets over an equally-relevant pack asset.
  Removing the default `state.db` load also fixes a confirmed hot-path
  defect: whenever `state.db` already existed, every default search
  synchronously waited on the maintenance-activity barrier before ranking
  could even start — up to a 5-second stall on a blocking wait loop, plus a
  lock-file create, before the load's own 250ms SQLite `busy_timeout` ever
  applied. No config gate was added: a key for a term being removed would be
  dead surface for the upcoming 1.0 contract freeze to carry forever.
  `rank_score` itself, and everything `improve` computes and does with it
  internally, are unchanged — only its promotion into user-facing ranking is
  removed. The contributor stays in the codebase (unwired) for a future
  gated, outcome-backed experiment.

- **Internal: `asset_salience` / `asset_outcome` state.db access moved behind
  `src/storage/repositories/{salience,outcome}-repository.ts`** (#672 part 2).
  Mirrors the existing state.db repository precedents
  (`proposals-repository.ts`, `improve-runs-repository.ts`,
  `events-repository.ts`): the raw SQL, row-mapping, and the #644
  encoding-provenance CASE guards are extracted verbatim, only relocated —
  `commands/improve/salience.ts` and `outcome-loop.ts` re-export the moved
  functions, so no importer or test churns. A new `state-table-sql` rule in
  `scripts/lint-repository-sql.ts` now fails the build if raw
  `asset_salience`/`asset_outcome` SQL reappears outside the repository
  directory (or `core/state/migrations.ts`). Not a user-visible behavior
  change: `rank_score`, `outcome_score`, and everything `improve`/`health`
  compute from them are identical.

### Fixed

- **The compiled standalone binary can run `akm migrate`.** Release binaries
  compiled only `src/cli.ts`, and the migrator was resolved as a sibling file
  and spawned — neither candidate exists inside a compiled executable, so the
  documented `./akm-0.9 migrate status/apply` upgrade path always failed with
  `FILE_NOT_FOUND`. Standalone builds now compile `scripts/akm-standalone.ts`,
  a wrapper that embeds both the CLI and the migrator (src never imports
  scripts/ — the dist build's tsc forbids it); `akm migrate` re-execs the
  binary with an `AKM_MIGRATE_ENTRY` marker the wrapper dispatches on. The
  repo and npm layouts keep the subprocess path.

- **Quarantined migration rows are retained in full, not reduced to a count.**
  When the 0.8→0.9 cutover met a durable ref it could not map, it recorded
  surface/ref/count in `legacy_state` and then deleted the rows — destroying
  proposal payloads, event and task history, fingerprints, and canary anchors,
  contrary to the migration guide's "quarantined, not dropped". Complete rows
  are now preserved as JSON in `legacy_state_rows` before leaving the live
  tables.

- **A failed content migration fails the apply instead of reporting success.**
  Root discovery, sidecar folding, or the legacy-proposal import throwing was
  swallowed and logged; the apply then advanced and cleared its journal, and —
  because 0.9 removed the live `.stash.json` and filesystem-proposal readers —
  the affected metadata and pending proposals became permanently inaccessible
  behind an apparently successful upgrade. The step now fails the apply with
  the journal intact; the committed cutover is untouched and the next apply
  retries.

- **Sidecar provenance survives the fold.** Folding a `.stash.json` into
  frontmatter dropped `xrefs` and `sources` entirely and mapped legacy
  `sourceRefs` to a `source_refs` key that could never fire (the validator
  stopped copying the field) and that 0.9 never reads — then deleted the only
  copy. `xrefs`/`sources` now fold through, and legacy `sourceRefs` merge into
  `xrefs`.

- **A reserved-filename rename re-keys durable state.** The D-R6 rename of a
  mis-named `index.md`/`log.md` concept ran after the cutover had keyed usage,
  salience, and proposal rows to the old conceptId, stranding that learned
  state. The rename now feeds the same re-key engine the cutover uses, with
  the pairs persisted before re-keying so a crash between the two stays
  retryable.

- **v1 tasks in a read-only bundle are surfaced with a remedy instead of being
  silently skipped.** The 0.9 runtime removed the v1 task parser, so silently
  skipping a `writable: false` bundle left tasks that would start failing after
  an upgrade that reported current. The preflight now warns per bundle and
  lists the stranded files in the plan (`readOnlyLegacyTasks`). It does not
  block the apply: the migration deliberately never rewrites a read-only
  bundle, and the fix for a lock-materialized git/npm bundle belongs upstream.

- **Lock resolution metadata survives migration.** Merging the migrator's
  sparse lock entries replaced whole rows by id, discarding
  `resolvedVersion`/`resolvedRevision`/`integrity`/`installedAt` recorded by a
  real install. Merge now preserves existing fields the incoming entry does
  not define.

- **Migrating a pre-0.9 config no longer silently changes source policy.**
  Three settings were dropped by the config-shape migration: an explicit
  `writable: false` (an omitted filesystem `writable` reads as `true` in the
  new shape, so a source the user deliberately protected became writable), an
  explicit `enabled: false` (resuming refreshes and indexing for content the
  operator had turned off), and a website source's `maxDepth` (silently
  resetting crawl depth). All three now round-trip to the runtime source entry;
  `bundles.<id>.enabled` is a supported key.

- **`akm mv` refuses a bundle marked `writable: false`.** It renamed the file
  and rewrote citers anyway, because its preflight checked adapter
  compatibility rather than writability — every other write command already
  refused.

- **Memory belief edges written by `--supersedes` are no longer ignored.**
  `writeSupersededEdge` persists a fully-qualified conceptId, but the belief
  analyzer accepted only the internal `memory:<name>` spelling, so every edge
  from `akm remember --supersedes` / `akm import --supersedes` was dropped and
  a superseded memory read back as active.

- **`akm env run <ref> -- <cmd> --help` runs the command.** The builtin
  help-flag scan read the child tail after `--` and printed akm's own usage
  instead.

- **`akm mv` works under an `AKM_STASH_DIR` override again.** A valid override
  not owned by a configured bundle failed with `No configured bundle owns move
  source`.

- **An unexpected internal error exits 70 with the JSON failure envelope.** The
  residual dispatch boundary exited 1 with an unstructured message, so
  automation could not tell an internal defect from an ordinary failure.

- **Concurrent `akm config set` processes no longer give up prematurely.** The
  contended-lock wait budget was 500ms total, so several concurrent writers on
  a loaded machine could exhaust it and fail with "Timed out waiting for config
  lock" against a healthy but busy lock. Abandoned locks are still reclaimed by
  the stale probe, which this budget does not gate.

- **Config keys named in indexer output and comments now exist.** Four sites
  pointed at a top-level `llm.*` namespace that the config schema has no such
  key for — including the user-facing "Increase llm.timeoutMs" warning on an
  exceeded enrichment budget. The enrichment budget lives at
  `index.enrichment.timeoutMs` (or `index.defaults.timeoutMs`). Indexing
  concurrency is auto-derived (2 remote / 1 local) and currently has no config
  override on that path: `engines.<name>.concurrency` is a valid schema field
  but the engine resolver does not forward it (documented in
  `docs/architecture/internals/indexing.md`).

- **The bundle-identity-drift warning stops naming a command that doesn't
  exist.** It told users to "rekey it atomically via the bundle-rename
  command"; 0.9.0 ships no such command. It now gives the two remedies that
  work: restore the previous bundle id in `config.json`, or keep the new id and
  `akm index --full` to re-mint, accepting the loss of learned state keyed to
  the old id.

- **The scaffolded `organization.md` convention no longer contradicts `akm
  mv`.** It told authoring agents "there is no command that preserves an
  asset's identity or learned state" across a rename and showed a raw `mv`.
  `akm mv` does exactly that — it rewrites inbound refs and re-keys the index
  row, usage history, and state.db salience/outcome rows. The convention now
  points at it, flagged Experimental.

- **`setup.taskSchedules` is no longer documented.** The key was removed from
  the schema in 0.9.0 (nothing ever read or wrote it), but
  `docs/reference/configuration.md` still described its two sub-keys.

- **A freshly scaffolded stash passes its own `akm lint`.** All 12 shipped
  `facts/conventions/**` convention templates carry frontmatter but none
  carried an `updated` field, so the first `akm lint` after `akm init` flagged
  12 `missing-updated` issues on files the user never wrote. The templates now
  ship the field, and a regression test lints a freshly scaffolded stash and
  requires nothing flagged.

- **`akm show akm//meta` is the documented spelling for the primary stash.**
  `docs/reference/cli.md` and `docs/guides/concepts.md` showed
  `akm show local//meta`, which errors with `ASSET_NOT_FOUND` — `local//` is no
  longer a scoping prefix, so it reads as a bundle named `local`.

- **`akm sync` emits `shape: "sync"`.** The envelope kept the `"save"` shape
  from the command's pre-rename name even after the persisted `eventType` was
  renamed. Unlike the event log, the shape is per-invocation and never
  persisted, so it needs no read-side synonym.

- **`akm add <pkg> --provider npm` adds an npm source instead of a broken
  filesystem bundle.** `--provider` was only read inside the remote-URL branch,
  so any non-URL target fell through to the filesystem path with the flag
  ignored, producing a bundle pointed at `<cwd>/<pkg>`. A URL target with
  `--provider npm` is now rejected at add time rather than storing the URL as a
  package spec and failing much later at first sync.

- **`akm add --provider` no longer prints `Installed undefined`.** Two
  incompatible result shapes reached one text formatter; each is now rendered
  honestly, including whether a follow-up `akm update` or `akm index` is needed.

- **`akm update --all` accounts for every configured source.** It previously
  considered only registry-managed installs and reported `nothing to update`
  for a stash full of plain sources — nothing was updated because nothing was
  looked at. Plain git and npm sources are now synced (npm is promoted to a
  lock-backed install on first sync) and website/filesystem sources are
  reported through a new `skipped` field with the reason. A successful update of
  a plain source no longer renders as `nothing to update` either.

- **`akm search` with no query browses**, as `--help` has always documented,
  instead of exiting 2.

- **`akm curate --type <t>` curates within the type instead of bypassing
  curation.** The filter skipped ranking, intent nudges, the score floor, and
  family collapse entirely — and could return a hit of the *wrong* type while
  dropping a higher-scoring correct one.

- **`akm curate` respects `--limit` for registry hits**, which were capped at a
  hard-coded 2 regardless.

- **`akm search --no-project-context` works.** citty strips a leading `--no-`
  before consulting declared args, so a flag *declared* as `no-project-context`
  could never be set — the ranking boost was identical with and without it. The
  flag users type is unchanged.

- **`akm env run`, `akm secret run`, `akm migrate`, `akm agent`, `akm proposal new`,
  `akm task run`, and `akm improve` no longer skip cleanup on exit.** They
  called `process.exit()` directly — in two cases even on success — bypassing
  teardown of spawned subprocesses. Exit codes, including forwarded non-zero
  child codes, are unchanged.

- **The `blocked` semantic-search warning names the cause.** It emitted one
  fixed string for every failure and discarded the status ledger's reason, so
  "no embedding provider configured" and "the configured endpoint is failing"
  read identically.

- **Shell completion for `--source` no longer suggests `stash|registry|both`
  on commands where that enum doesn't apply.** `--source` means a closed
  `stash|registry|both` enum on `akm search`/`akm curate`, but a free-form
  stash name/path on every `akm graph` subcommand and a free-form URL/ref/
  path on `akm remember`. The generated completion script keyed its value
  list by flag name only, so the search/curate enum leaked onto `akm graph
  --source <TAB>` and `akm remember --source <TAB>`. Value completion is now
  scoped per command path; commands without a fixed value set get no
  suggestion instead of the wrong one.

- **`akm setup --config <file>` / `--from <file>` no longer silently drops
  six valid config keys** (`index`, `search`, `feedback`,
  `archiveRetentionDays`, `workflow`, `experimental`). The allowlist was a
  hand-copied set that had drifted out of sync with the config schema; a
  user handing setup a config containing any of these keys got a different,
  silently truncated config written back, with only a warning and exit `0`.
  The allowlist is now derived from the schema's own key list so it cannot
  drift again. Keys that remain genuinely retired (`profiles`, `llm`,
  `agent`, `features`, `stashes`, `bindings`, `writable`) still warn-and-drop
  as before.

  Note: a config that previously relied on one of these six keys being
  ignored (because the drop was silent) will now have it applied — re-check
  `--config`/`--from` inputs if you were unknowingly depending on that gap.

- **`akm index` no longer persists adapter auto-detection to `config.json`
  with zero disclosure.** Detecting and writing a bundle component's adapter
  (`bundles.<id>.components.<component>.adapter`) previously happened
  silently on every index run. It is now reported in the result envelope as
  an additive `configUpdated.detectedAdapters` map and on stderr, and only
  when a write actually happened.

- **`akm add owner/repo` now resolves as GitHub shorthand instead of failing
  with "Local path not found".** Any ref containing a `/` was treated as an
  explicit local path, so the local-ref resolver threw before the
  GitHub-shorthand fallback ever ran, making the advertised `owner/repo` form
  unreachable. A bare two-segment `owner/repo` (or `owner/repo#ref`) now
  falls through to the registry resolver when no such directory exists on
  disk; `./`, `../`, absolute, and three-or-more-segment paths still resolve
  as explicit local paths exactly as before.

- **Internal output-shape command keys renamed `events-list`/`events-tail` →
  `log-list`/`log-tail`**, matching the `akm log` command they back (the
  command group used to be `akm events`, removed in 0.9.0). Internal-only:
  the shape name is a registry lookup key that never reaches the wire (no
  output field, no schema change), so this is not a user-visible behavior
  change and carries no `schemaVersion` bump. The documented `[events-tail]`
  stderr trailer text is deliberately left as-is pending a separate ruling.

### Removed

- **BREAKING: `akm upgrade --skip-checksum` is removed.** STABILITY.md has
  always said checksum verification is not optional and that the recovery hatch
  is an environment variable — but the flag shipped anyway, tab-completable,
  while the documented variable existed nowhere in the source. The code now
  matches the spec: set `AKM_UPGRADE_SKIP_CHECKSUM=1` if you must bypass a
  genuinely broken `checksums.txt`. It is deliberately undiscoverable.

- **BREAKING: `akm config enable|disable` is removed.** It was a hard-coded
  toggle for one target, the skills.sh registry, and the bare `akm enable` /
  `akm disable` aliases were already removed in 0.9.0. Use
  `akm registry add|remove`.

- **BREAKING: `akm mv` is removed.** No alias, no stub — `akm mv …` fails with
  the standard unknown-command error. It claimed to preserve identity across a
  rename, but its inbound-ref rewrite matched bare conceptIds rather than the
  anchored `bundle//conceptId` prose form, so it could rewrite ordinary prose
  while leaving real refs dangling. Renames are delete + create per
  `STABILITY.md`: move the file, `akm index`, `akm lint`. The one capability
  nothing else covered — carrying an asset's earned signal across the rename —
  moves to `bun scripts/rekey-asset-ref.ts <old-ref> <new-ref>` (maintainer
  tooling, `--dry-run` supported, idempotent), which re-keys the index
  `entries` row in place plus the `asset_salience` / `asset_outcome` /
  `usage_events` rows. The `mv` event type and output shape are gone; the
  script emits a `rekey` event instead. A leftover `kind:"mv"` transaction
  journal from an rc build is now swept by the recovery scanner rather than
  failing it — an unregistered journal kind no longer bricks index refresh or
  proposal accept/reject.

- **The CHURN alert class is removed from the collapse detector.** Its input was
  a hard-coded `0` from the 0.9.0 confidence-gate deletion onward, so the alert
  could never fire. The other three alert classes are unaffected. The
  `improve_cycle_metrics.accepted_actions` column stays and is written as `0`
  because deployed 0.8 `state.db` files already contain it.

- **`IndexResponse.graphQuality` is removed** from the `akm index` envelope — it
  was declared but never assigned in any code path, so it was always absent.

- **`akm secret path` and `akm secret remove` are removed.** The two resolved a
  secret ref through *different* stash-selection logic — `path` through the
  read-side, all-sources resolver and `remove` through the write-target
  resolver — so for a ref present in more than one stash they could name
  different files: you could inspect one secret and delete another. Rather than
  reconcile the resolvers, both subcommands are gone; `akm secret` now exposes
  only `list`, `run`, and `set`. Both spellings exit 2 with `Unknown command`.

  Migration: a ref's file lives at `<stash>/secrets/<name>` (run `akm sources
  list` for stash roots) — locate or delete it directly, or use `akm secret run
  <ref> <VAR> -- <command>` to consume the value without it touching disk. `akm
  env path` and `akm env remove` are unaffected.

- Removed the dead `"backup"` output-shape registration left over from the
  removed `akm backup` command (superseded by `akm-migrate backup`). Already
  unreachable; no user-visible effect.

- **`akm task list`, `akm task show`, and `akm task remove` are removed** as
  redundant with the generic asset commands. List and inspect tasks with `akm
  search` / `akm show <bundle//tasks/id>` (both already cross-bundle); to remove a
  scheduled task, delete its file in the owning bundle and run `akm task sync`
  (sync uninstalls the orphaned scheduler entry). Run `akm task doctor` for
  scheduler diagnostics — bare `akm task` is a usage error, see the canonical
  bare-group change above.

- **The `akm show <ref> toc|section|lines|frontmatter|full` view-mode grammar is
  removed** (0.9.0 decision D2). `#fragment` is now the only section selector,
  and a positional after the ref is a usage error that names it. Migration:

  | Old | New |
  | --- | --- |
  | `akm show knowledge/guide section "Auth"` | `akm show knowledge/guide#auth` |
  | `akm show knowledge/guide full` | `akm show knowledge/guide` |
  | `akm show knowledge/guide toc` | `akm show knowledge/guide#<unmatched>` — the error lists the available fragment slugs |
  | `akm show knowledge/guide lines 10 30` | no replacement — every response carries `path`, so slice the file yourself |
  | `akm show knowledge/guide frontmatter` | no replacement — if a raw-YAML projection proves necessary it returns as a `--shape` value |

  The undocumented `--akmView` / `--akmHeading` / `--akmStart` / `--akmEnd`
  flags the grammar injected into argv are gone with it.

## [0.9.0-rc.1] - 2026-06-30

### Fixed

- **improve/recombine: cap-aware decay — the `maxClustersPerRun` cap no longer
  traps recurring hypotheses below `confirmThreshold` (#658).** Recombine is a
  two-pass design: a cluster must be re-induced on `confirmThreshold` (=2) runs
  before its `type:hypothesis` proposal promotes to an auto-accepted
  `type:lesson`. But only the top-`maxClustersPerRun` (=5) clusters are
  processed per run, and `decayUnseenRecombineHypotheses` hard-reset the
  confirmation streak of every hypothesis not processed that run. A cluster that
  genuinely re-forms every run but is displaced out of the top-5 (slots are tied
  on member-count and broken by an arbitrary alphabetical tiebreak) had its
  streak zeroed — it could never win two consecutive slots, so its proposal sat
  pending forever (6 such proposals were stuck in one production stash).
  `decayUnseenRecombineHypotheses` is now **cap-aware**: `recombine.ts` passes
  the FULL pre-cap cluster set, and a hypothesis is spared from reset when its
  cluster still Jaccard-matches a present cluster (same signature, overlap ≥ 0.7
  — the same rule used for re-induction). Only hypotheses with no matching
  current cluster (the corpus stopped supporting them) decay. This does **not**
  lower the recurrence bar: the confirmation count is still advanced only by
  genuine re-induction in the processed slice (`recordRecombineInduction`);
  sparing merely avoids an artificial reset, so a genuinely non-recurring
  hypothesis still decays to 0 and never confirms (no new bland-hypothesis churn,
  cf. #632/#633). No schema change. The cap now lives in a new `capClusters`
  helper split out of `buildRelatednessClusters` so the full ranked set stays
  available for the decay sweep.
- **`improve` reflect no longer emits proposals doomed to fail the
  `invalid-description` gate when the source asset has no frontmatter
  `description` (#636).** Reflect echoed the source frontmatter, so for assets
  that carry other keys but no `description` (notably scraped docs:
  `source`/`title`/`scraped`) the proposal inherited the missing/empty
  description and the promote-time validator (`isValidDescription`, 20–400
  chars) rejected it — observed as ~14/16 rejects in one triage pass, blocking
  the whole scraped-doc/knowledge cluster from reflect improvement. The fix is
  **generation-time only**: (1) `buildReflectPrompt` now injects an explicit
  "synthesize a `description`" instruction whenever the source lacks a non-empty
  `description` and the asset type requires one (per `authoring-rules.ts`
  `DESCRIPTION_TYPES`), telling the model it MUST author a valid 20–400-char
  plain-prose description from the asset's `title:`/first `# Heading`/opening
  body; and (2) a deterministic reflect-side belt-and-suspenders in
  `sanitizeReflectPayload` — if a source that already had frontmatter still ends
  up with a missing/empty description after generation, reflect derives one
  deterministically from `title:`/first heading (validated against
  `isValidDescription`, never free-form invention) **before** the proposal is
  created. The validator, `authoring-rules.ts` bounds, `repairProposalContent`,
  and the drain are unchanged — nothing in the validator/promote path fabricates
  content to pass itself.
- **The high-salience improve admission lane (#608) now requires a
  content-derived encoding score, not the per-type weight stub (#655,
  #608/#644 follow-up).** The lane previously admitted any zero-feedback ref
  whose `asset_salience.encoding_salience >= salienceThreshold` (default 0.75).
  But for assets distill has not content-scored, `encoding_salience` is just the
  per-type WEIGHT STUB (skill/agent 0.9, command/workflow 0.8, lesson 0.75), so
  "high-salience" degenerated into "is a skill/agent/command/lesson" — which
  selected the type-stub `lore-writer` agent on every run (prod: 1 content-scored
  / 37 type-stub / 1826 NULL-legacy rows). The gate now also requires
  `isContentEncodingRow(row, parseAssetRef(ref).type)` (the #644 provenance
  helper), so only genuinely content-scored assets qualify. This preserves
  #608's intent — distilled assets, the lane's real targets, keep their real
  content score and still qualify — while cutting the type-stub waste; type-stub
  rows must earn retrieval/feedback signal via the other lanes. NULL-legacy rows
  follow `isContentEncodingRow`'s differs-from-stub heuristic. An aggregated log
  line now reports how many refs the lane admitted so lane composition is
  observable. The threshold, type-weight table, 10% cap, and `isContentEncodingRow`
  are unchanged.

- **Auto-sync no longer refuses to commit akm's own changes when unrelated
  non-akm files are present in the stash working tree.** When a stash root is
  shared with a project repo, stray files written into the stash root (e.g. a
  `tasks.bak-…` backup dir or report artifacts like `data.js`,
  `akm-health-report.html`, `reports/`) previously tripped the #476 safety
  guard, which threw `refusing to push: … has uncommitted non-akm changes` on
  **every** `akm improve` end-of-run auto-sync, `akm sync`, and `akm push`. In
  one production incident this silently blocked all commits for ~1.5 days while
  akm kept accepting proposals it never persisted. `saveGitStash` now **scopes
  what it stages** instead of refusing: (1) an explicit modified-file list when
  the caller passes `opts.paths`, else (2) the akm-managed pathspecs
  (`TYPE_DIRS` values + `.akm`) that exist on disk — which by construction never
  stages non-akm WIP, preserving the #476 protection without an all-or-nothing
  refusal — and only as a last resort (3) `git add -A` when no managed pathspec
  can be resolved. If nothing akm-managed is staged the run returns
  `nothing to commit` (no empty commit, no throw). Unrelated non-akm files are
  left untouched and uncommitted.

### Changed

- **BEHAVIOR CHANGE — `akm init --dir <path>` no longer silently repoints your
  default stash.** Previously, `akm init --dir X` unconditionally wrote
  `stashDir: X` to `config.json` whenever `X` differed from the configured
  default — so initializing a throwaway or secondary stash (e.g.
  `akm init --dir /tmp/scratch`) would hijack the user's real default stash
  pointer (the footgun documented in `memory:akm-init-persists-stashdir-warning`).
  Now `init` persists `stashDir` to config **only** when one of the following
  holds: (a) **no `--dir`** was provided (the default `~/akm` setup flow —
  unchanged), (b) `--dir` was provided and **no `stashDir` exists in config yet**
  (first-time bootstrap), or (c) `--dir` was provided **with the new
  `--set-default` flag** (explicit opt-in). Otherwise `init` still scaffolds and
  backfills the target dir exactly as before, but **leaves your default stash
  pointer untouched** and prints:
  `Your default stash is unchanged (<existing>). Re-run with --set-default to make <dir> the default.`
  The `InitResponse` JSON gains `defaultStashUpdated: boolean` and an optional
  `previousStashDir`. To make a `--dir` target your default, pass
  `akm init --dir <path> --set-default`. (`akm setup` is unaffected — it remains
  the explicit configuration flow and always sets the default.)

### Added

- **Per-type SOFT authoring conventions are now user-editable stash facts.** A
  third authoring-guidance layer joins the hard rules (#645) and general stash
  standards (#642): a stash owner can author
  `facts/conventions/assets/<type>.md` (e.g. `…/skill.md`, `…/command.md`) to
  capture soft, type-specific guidance — voice, structure, length *preference*,
  naming style. When an agent authors a `skill:x`, the body of
  `fact:conventions/assets/skill` is injected (type-scoped — authoring
  `command:y` pulls the `command` convention, never the `skill` one), labeled
  as soft guidance and kept separate from the validator-enforced hard rules.
  The basename must be a `getAssetTypes()`-validated asset type; facts are read
  straight from disk (no index rebuild) and degrade to empty safely. When no
  per-type fact exists, the built-in `TYPE_HINTS` fallback is unchanged (no
  regression). These facts carry soft conventions only and can never weaken the
  authoring contract the gate enforces (`authoringRulesForType` remains the sole
  source of validator-rejecting rules). The general convention/meta resolver now
  excludes `facts/conventions/assets/*` so per-type guidance never leaks
  un-type-scoped into other authoring flows. (#646)
- **`akm init` now seeds default per-type SOFT convention templates.** Starter
  `facts/conventions/assets/<type>.md` templates ship in the stash skeleton for
  the authored types (`lesson, skill, command, agent, knowledge, memory,
  workflow, script, fact`; `wiki`/`env`/`secret` excluded) so a stash owner has
  an editable starting point. Each expands the matching built-in `TYPE_HINTS`
  one-liner into soft starter guidance, carries `category: convention`
  frontmatter, and states in-body that it is advice, not enforced — it carries
  **no** validator-rejecting rules, so editing or deleting one cannot weaken the
  gate (#645). The stash-skeleton copy is now recursive (preserving nested
  subpaths), and `akm init` seeds **unconditionally** rather than only on first
  create: re-running it on an existing stash backfills any missing skeleton,
  convention, or `.meta/index.md` files. Seeding stays absent-only and never
  overwrites a user-edited file. (#646)

## [0.9.0-beta.36] - 2026-06-22

### Added

- **Stash standards + wiki schemas are surfaced to authoring agents at write
  time.** When an agent edits a page under `wikis/<name>/`, that wiki's
  `schema.md` body is injected into the prompt; when it creates/edits a non-wiki
  asset, the bodies of `category: convention`/`meta` `fact` assets are injected.
  Two mutually-exclusive features selected by target type, sharing one
  `standardsContext` prompt seam. Wired into reflect, propose, and every
  improve authoring pass (distill, consolidate, recombine, procedural, extract,
  schema-repair). (#642)
- **Unified, validator-sourced authoring-rules seam.** A new
  `authoringRulesForType(type)` injects the hard authoring rules (no
  pseudo-frontmatter in body, exactly two `---` fences, description/`when_to_use`
  length + shape) into every authoring prompt. The numeric bounds live in one
  module that the validators import, so the prompt can no longer drift from what
  the gate enforces. (#645)

### Fixed

- **High-salience reflect lane now reflects each asset at most once.** The
  `#608` admission gate lacked the cooldown its sibling high-retrieval gate has,
  so zero-feedback assets were re-selected on every run (auto-accept emits
  `promoted`, not `feedback`), burning LLM calls and churning assets. (#643)
- **Stuck validation-failing proposals no longer dead-end.** The triage drain no
  longer overwrites an `auto-rejected` gate stamp with a misleading
  `auto-accepted` (the failure stays truthful and visible). A bounded,
  content-preserving auto-repair (strip pseudo-frontmatter / stray `---`, repair
  truncated descriptions) runs at the promote boundary and re-validates — fixable
  proposals promote; genuinely unrepairable ones stay `pending` for manual
  review, with nothing fabricated and validation never bypassed. (#645)
- Corrected a prompt/validator drift where the distill system prompt asked for an
  80–200 char description while the gate enforced 20–400. (#645)

## [0.9.0-beta.35] - 2026-06-21

### Fixed

- **Default extract discovery window is now "since the last run" (floored at 48h),
  not a fixed 24h.** An intermittently-online host that was off for longer than
  the old 24h window could permanently miss sessions that ended during the gap.
  Discovery now looks back to the last recorded extract run for the harness, never
  less than 48h. Widening is free of redundant LLM cost — the content-hash ledger
  skips unchanged sessions with zero LLM calls. An explicit `--since`/`defaultSince`
  still wins.
- **Per-session lock prevents concurrent double-extraction.** A session-end hook
  firing `extract --session-id` while the periodic `akm improve` extract pass runs
  discovery could both LLM-process the SAME session (duplicate spend + near-dup
  proposals). A per-(harness, session) advisory lock (co-located with state.db,
  PID + age staleness recovery) now makes the second run skip without any LLM call.
- **`minNewSessions` is read from the ACTIVE improve profile, not always `default`.**
  A non-default profile (e.g. `frequent`) setting `minNewSessions` was silently
  ignored because the gate (and its candidate-count discovery window) read
  `profiles.improve.default`. They now read the resolved active profile, matching
  how `extract.enabled` already resolves.

### Docs

- Documented that `processes.extract.indexSessions` (default on) makes a second
  LLM call per processed session (the session summary); set it to `false` to halve
  per-session extract cost. Unchanged/skipped sessions still cost zero.

## [0.9.0-beta.34] - 2026-06-21

### Fixed

- **`akm extract --type opencode` reads opencode's SQLite session store.** opencode
  migrated session storage from per-file JSON (`storage/session/<projectId>/<id>.json`
  + `storage/message/<id>/*.json`) to a single Drizzle-managed database at
  `<base>/opencode.db` (tables `session`/`message`/`part`; message text lives in
  `part` rows with `data` JSON `type:"text"`). The legacy JSON layout went stale
  ~2026-02, so extract discovered 0 sessions on current opencode and the
  `session.idle` extract hook had nothing to read. `OpenCodeProvider` now prefers
  `opencode.db` when present (read-only, via the cross-driver `openDatabase` seam)
  and falls back to the JSON layout. Verified end-to-end through the plugin's
  `session.idle` hook.

## [0.9.0-beta.33] - 2026-06-21

### Fixed

- **`akm extract` decoupled from the improve-stage toggle.** `processes.extract.enabled`
  now gates extract only as a STAGE of `akm improve` (the active improve profile, per
  #593/#594); an explicit `akm extract` command always runs. Previously dropping extract
  from the daily improve profile silently disabled the standalone command (and its LLM
  calls, via the shared `session_extraction` feature gate).
- **`extract --session-id` now respects the content-hash ledger; `--force` overrides.**
  Explicit single-session extraction previously bypassed the #602 already-extracted skip
  unconditionally — re-paying the LLM on every call and risking double-extraction against
  the cron. Now a targeted `extract --session-id <id>` is idempotent (skips an unchanged,
  already-extracted session with zero LLM calls) and only `--force` re-extracts. This
  makes a session-end hook firing `extract --session-id <id>` precise AND idempotent.

## [0.9.0-beta.32] - 2026-06-21

### Added

- **Recombine acceptance path — confirmed lessons now auto-accept.** Recombine
  hypotheses that reach the confirmation threshold (promoted to `type: lesson`,
  #625/#633) now flow to ACCEPTED by reusing the existing drain mechanism instead
  of piling up pending forever: the `personal-stash` drain policy gains a
  `{ generator: "recombine", requireType: "lesson", maxDiffLines: 200 }` rule, via
  a new optional `requireType` frontmatter filter on `DrainAcceptRule`. Only
  confirmed `type: lesson` proposals auto-accept; unconfirmed `type: hypothesis`
  proposals stay pending; the existing proposal quality gate still applies.
- **`processes.reflect.lowValueFilter` (opt-in, default OFF)** — deterministic
  semantic value-floor that defers trivial reflect rewrites (#639A).
- **`processes.extract.triage.proceduralAwareFloor` (opt-in, default OFF)** —
  triage floor requiring markers/edits so real lessons always pass (#641).

### Fixed

- **Select-time proactive cooldown leak.** `selectProactiveMaintenanceRefs` plans
  the due set BEFORE acquiring `reflect-distill.lock`, so overlapping/back-to-back
  improve runs reused stale due-state and re-reflected the same asset repeatedly
  (observed up to ~16× in a day). The orchestrator now re-applies the dueDays gate
  with freshly-read timestamp maps INSIDE the lock (`filterProactiveDue`), dropping
  refs a concurrent run already reflected.

## [0.9.0-beta.31] - 2026-06-20

### Changed

- **#632 — recombine now filters junk tags structurally.** Frontmatter tags that
  are pure numbers, dates (`20260529`), short hex hashes (`002c624c`), version
  strings (`0.8.0`, `v2`), single chars, or common English stopwords (`is`, `the`,
  `for`, `when`, …) carry no topical signal and never form a recombine cluster.
  Unlike `excludeTags` (a fixed project list), this catches the OPEN-ENDED junk —
  every new date or commit hash — with no config upkeep. Exposed as `isJunkTag`.
  On the live stash this turns the recombine cluster set from generic 66–171-member
  buckets into tight topical clusters (`auth`, `architecture`, `patterns`, …).

## [0.9.0-beta.30] - 2026-06-20

### Changed / Fixed

- **#632 — recombine cluster tuning (opt-in, default-preserving).** Recombine
  clustered memories by frontmatter tag and preferred the LARGEST buckets, so it
  always picked the coarsest whole-stash tags (`session`/`claude`/`akm`, 63–171
  members) and produced bland generalizations. Two new `processes.recombine` knobs:
  `maxClusterSize` (skip clusters larger than N, so over-broad buckets no longer
  reach/starve the largest-first slice) and `excludeTags` (tags that may never form
  a tag cluster). Both UNSET = byte-identical to prior behavior.
- **#633 — recombine confirmation loop fixed.** The hypothesis confirmation streak
  was keyed on a hash of the EXACT member set, so a growing stash drifted the key
  every run → a fresh row at count 1 → `confirmThreshold` never reached → no
  hypothesis ever promoted to a lesson (a dead two-pass loop). A freshly-induced
  cluster now matches an existing pending row by signature + Jaccard
  membership-overlap (≥ 0.7) and reuses its stable ref, so the streak accumulates
  through membership drift. First/non-overlapping induction is unchanged.

## [0.9.0-beta.29] - 2026-06-20

### Reverted

- **#630 — `fact` asset type phase 2 reverted (#631).** The pinned-core assembly +
  `akm fact` CLI shipped in beta.28 was reverted pending rework. Phase 1 (#629, the
  `fact` asset type itself) remains in place.

## [0.9.0-beta.27] - 2026-06-20

All new behavior is **opt-in / default-preserving** — default runs are byte-identical.

### Added

- **#624 P2 — priority-ranked graph extraction.** `processes.graphExtraction.topN`:
  when set, the graph-extraction pass ranks eligible files by asset utility
  (`utility_scores`, read-only join) and processes only the top-N per run, so
  high-value assets get graphed first instead of a ~55h full-corpus sweep. Unset
  (default) = no ranking, byte-identical.
- **#624 P3 — lazy on-demand graph extraction.** New `graph_extraction_queue` table
  + `enqueueGraphExtraction`/`drainExtractionQueue`/`extractGraphForSingleFile`.
  `akm curate` enqueues an ungraphed hit (non-blocking); `akm show` can extract a
  missing graph inline — gated on `index.graph.lazyGraphExtraction: true`
  (**default off**: `show` makes no LLM call by default), model-guarded, and bounded
  by a 30s timeout so it never hangs. The pass drains the queue before the ranked
  sweep. This **closes #624** (all three layers shipped).
- **#616 — bounded multi-cycle phasing.** `profiles.improve.<name>.maxCycles`
  (default 1): when > 1, the improve passes run in an N-cycle loop so gate-accepted
  output of cycle N feeds cycle N+1 within the same run (re-running ensureIndex +
  ref selection each cycle), stopping at a fixed point and respecting the run budget.
  `maxCycles: 1` = byte-identical to today.

### Fixed

- **Release CI unblocked.** `runCliCapture` (test harness) restored `process.exitCode`
  to a captured `undefined`, which under `bun test` does not clear a previously-set
  non-zero exit code — so the unit suite exited 1 with 0 failures at `TEST_PARALLEL=1`
  (exactly how `release.yml` runs), silently blocking every npm publish since beta.11.
  Fixed to restore to `0`. (This is why beta.26 was the first successful workflow publish.)

### Changed

- **CI/release tests sharded across runner jobs (~15 min → ~2 min).** Bun 1.3.x
  in-process test parallelism (`--parallel=N`, N>1) hits an intermittent
  `epoll_ctl EEXIST` race / busy-spin hang on the `--isolate` workers, which had
  forced fully-sequential (`TEST_PARALLEL=1`) runs. Tests now shard across separate
  runner jobs (each a separate process tree, so no cross-shard fd/epoll collisions)
  with `--parallel=1` within each shard; the matrix runs shards concurrently. The
  release gate runs the identical set of tests. Local `bun run check` defaults to
  sequential too (the only safe mode on this Bun version). Coverage unchanged.
  Each shard runs through `scripts/run-test-shard.sh`, which retries **only on a
  hang/timeout** (the busy-spin can rarely fire even at `--parallel=1`) and never
  on a real test failure, so genuine red tests still fail fast and are never masked.

## [0.9.0-beta.26] - 2026-06-20

### Added

- **#628 — configurable SQLite journal mode (`AKM_SQLITE_JOURNAL_MODE`) for network
  filesystems.** AKM previously opened every database with `PRAGMA journal_mode = WAL`
  unconditionally, which cannot run on a network filesystem (NFS/SMB/Azure Files) —
  WAL's `-shm` shared-memory wal-index can't be `mmap`'d over a network mount. You can
  now set `AKM_SQLITE_JOURNAL_MODE` to `WAL` (default), `DELETE`, or `TRUNCATE`, applied
  at **all five** db openers (`state.db`, `index.db` ×2 paths, `workflow.db`, `logs.db`).
  At the `WAL` default AKM auto-detects a network mount for the data dir and transparently
  falls back to `DELETE` (rollback journal + `synchronous = FULL`) with a one-line warning;
  invalid values warn once and fall back to `WAL`. **Default behavior is byte-identical.**
  This lets the AKM database subtree live on a shared volume (e.g. Azure Files under
  Azure Container Apps). New docs section "Hosting AKM databases on a network share
  (NFS/SMB)" in `docs/configuration.md`.

## [0.9.0-beta.25] - 2026-06-19

Completes the recombine / extract-efficiency / graph thread. All new improve
passes are **opt-in (default off)**, so default behavior is unchanged.

### Added

- **#606 — event-driven extract (`akm extract --watch`).** Opt-in watch mode: an
  injectable, debounced watcher triggers extraction shortly after a session file
  appears, with a clean `stop()` handle. The `8,28,48` cron remains the fallback;
  no daemon is auto-launched.
- **#625 — recombine second pass (hypothesis → lesson).** The opt-in `recombine`
  process (#609) now consumes `confirmThreshold` (default 2): a generalization
  re-induced that many consecutive runs is promoted from a `type: hypothesis`
  proposal to a `type: lesson` proposal through the normal queue + quality gate
  (never a direct stash write). Hypotheses that stop recurring decay. Backed by a
  new `recombine_hypotheses` table in `state.db`.

### Changed

- **#624 (P1) — graph storage decoupled from `entries.id`.** `graph_files` is
  re-keyed on `(stash_root, file_path, body_hash)`, so extracted graph data now
  **survives a reindex** of unchanged files instead of being cascade-wiped. The
  upgrade is migrated in a **targeted, graph-only path** that preserves existing
  graph data and leaves the entry index, embeddings, FTS, and LLM-enrichment cache
  untouched — **no full index rebuild and no re-embed** on upgrade. (P2 priority-
  ranked extraction and P3 lazy/on-demand extraction remain deferred.)

### Fixed

- Graph re-key migration no longer triggers a destructive full-index rebuild: it
  is a graph-scoped table migration (no `DB_VERSION` bump), and it **copies** the
  existing graph rows into the new schema rather than dropping them.
- Test-suite `/tmp` hygiene: sandbox teardown now fires on `SIGINT`/`SIGTERM`/
  `SIGHUP` (not just clean exit), and a `sweep:tmp` step reclaims stale `akm-*`
  sandbox dirs left by force-killed workers — eliminating the tmpfs accumulation
  that caused intermittent `EEXIST: epoll_ctl` test flakes.

## [0.9.0-beta.20] - 2026-06-18

### Fixed

- **`akm update --all` no longer fails for writable `github:` entries stored as `source:"git"`**. `updateRegistryEntry` was using `synced.source` (re-derived from the ref scheme as `"github"`) instead of the existing `entry.source`, causing the config validator to reject `writable:true` on every update cycle.

## [0.9.0-beta.19] - 2026-06-17

### Fixed

- **`akm feedback` now completes in ~0.3s** (was 3+ minutes). Root cause: the command was calling `ensureIndex` with `mode: "blocking"` inside `withIndexWriterLease`, triggering a full reindex on every feedback call. Fix: removed the `ensureIndex` call entirely (feedback only needs the index to exist, not be current — a stale index is fine for ref lookup); removed the application-level writer lock (SQLite WAL + `busy_timeout=30s` handles concurrent access with `akm improve`); added a fast DB-exists guard with a clear error for first-time users.
- **`akm health --format html` now completes in ~11s** (was ~18s). Root cause: `akmHealth()` was called twice — once for the main result and once to get `deltas`. Fix: merged into a single call passing both `groupBy: "run"` and `windowCompare` together.

## [0.9.0-beta.18] - 2026-06-17

### Changed

- **Health report: Recent Runs table now shows all filtered runs in descending order** (newest first) instead of capping at the last 10.
- **Health report: Removed "Command Set Used" section.**
- **Health report: All timestamps now display in the viewer's local timezone** (chart axis labels, runs table, freshness line, executive summary, footer). Server-rendered ISO strings are wrapped in `<time data-iso>` elements and converted to local time by client-side JS on page load.

### Changed (migration required)

- **WS-2 outcome loop (#613) — default-off weight change (state.db migration 010).**
  Every `akm improve` run now writes an `asset_outcome` row per processed asset
  (state.db migration `010`) and computes a differential usefulness signal
  (`outcome_score`) per ref. The outcome signal is persisted and visible in the
  health report, but the **weight change is gated behind a config flag** (see
  below). Ranking is unchanged from WS-1 by default.

  **Opt-in weight change.** The WS-2 projection weights (`w_e=0.25, w_o=0.15,
  w_r=0.60`) affect ranking only when you explicitly set
  `improve.salience.outcomeWeightEnabled: true` in your `akm.yaml`. The default
  (`false`) keeps WS-1 parity weights (`w_e=0.30, w_r=0.70`, `w_o=0`), so
  existing users see no ranking change on upgrade.

  **Part-V measurement gate.** Before enabling the weight change, run the Part-V
  T0 baseline (`scripts/akm-eval` + `akm health`; confirm proactive accept
  ≥ 0.9× reactive; reversion ≤ 0.15; retrieval-delta ≥ 0; coverage not
  regressed). That gate requires a running production stash and cannot be
  exercised in CI. Once confirmed, set
  `improve.salience.outcomeWeightEnabled: true` to activate the three-way split.

  **Outcome loop mechanics.** `outcome_score` is a differential prediction-error
  signal: `(retrieval_delta − expected_delta) − PENALTY × retrieval_delta × (1 −
  accepted_change_rate) + valence`, tracked via an EMA (α=0.3). New rows are
  warm-started from the utility EMA score (clipped to 0.3) so the signal is
  non-zero from launch. A stash-wide diversity floor (10% of the max score) prevents
  rare-but-correct assets from being permanently outcompeted. An inverted-proxy
  tripwire (`corr(outcome_score, accepted_change_rate) < −0.3`) emits an
  `outcome_proxy_inverted` health event when the signal degrades.

  `review_pressure` is computed and persisted per asset but is **not yet wired into
  the admission policy** — that is deferred to a later work stream per plan §Part-VI
  #613. The column is present and populated; routing it into the consolidation-
  selection filter is the next step.

- **WS-1 salience vector (#618) — default-on ranking change.** The eligibility sort
  for all `akm improve` runs (whole-stash, type, and ref scope) has changed from
  `combinedEligibilityScore = utility·0.7 + negativeOnlyRatio·0.3` to
  `rankScore = (0.3·encodingSalience + 0.7·retrievalSalience) × sizePenalty`
  (feedback valence and utility EMA dropped from ordering until WS-2 re-introduces
  outcome salience). Assets are now ranked by retrieval frequency × recency × type
  importance rather than by feedback magnitude. Because the old
  `combinedEligibilityScore` ordering was never persisted, a forgetting comparison is
  not possible on the first run; instead a one-time `improve_salience_first_run` marker
  event is emitted to record the transition. On every subsequent run a stash-wide
  `improve_salience_rank_change` drift report (including `stashSize`) is emitted so
  rank movement under the new scoring can be tracked over time.
  The Part-V measurement protocol (T0 baseline via `scripts/akm-eval` + health report,
  throughput/quality gate) is deferred to the WS-2 milestone, when outcome salience
  re-joins the projection and re-tuning is triggered.

## [0.9.0-beta.12] - 2026-06-15

Improve-tuning work streams (all **default-off / parity-preserving** — no behavior
change until explicitly enabled).

### Added

- **#617 — deterministic near-duplicate memory dedup** (`processes.consolidate.dedup`,
  default off). A cheap no-LLM pre-pass in front of consolidation collapses obvious
  duplicates — `.derived`+origin pairs and content twins (normalized content-hash
  equality, or embedding cosine ≥ `cosineThreshold`, default 0.97). Each dropped
  variant is archived + backed up before deletion; hot memories are never
  collapsed; distinct-but-related memories fall through to the LLM.
- **#581 — judged-state cache for consolidation** (`processes.consolidate.judgedCache`,
  default off). New state.db table (`consolidation_judged`) records each memory's
  content hash + outcome when the LLM judges it; subsequent runs skip
  judged-unchanged memories, converting coverage from O(time-window) to
  O(changed/new) so a run can sweep the full corpus. Fails open; failed chunks
  and dry-runs never poison the cache. (state.db migration `007`.)
- **#612 — auto-accept gate calibration** (`improve.calibration`, auto-tune default
  off). Joins predicted gate confidence to realized accept/reject outcomes into a
  reliability table + calibration gap, surfaced in `akm health` (+ summary rows in
  the HTML report). Opt-in bounded threshold auto-tune nudges the accept threshold
  within a configured band toward a target accept rate, logged via a
  `calibration_autotune` event. (Replay-prioritization from prediction error is
  deferred — it depends on the #610 replay budget, a 0.10 item.)

### Fixed

- **#614 — symmetric valence weighting** (`profiles.improve.*.symmetricValence`,
  default off). The eligibility sort weighted feedback negative-only; when enabled
  it uses a symmetric `|valence|` magnitude so strong positive and strong negative
  feedback both drive attention (utility stays the dominant factor), routing
  high-negative → fix and high-positive → reinforce lanes.

## [0.9.0-beta.11] - 2026-06-15

### Added

- **`extract.maxSessionsPerRun`** (default 25) — caps the NEW sessions the
  extract pass LLM-processes in a single run so a backlog (e.g. after downtime)
  can't push one run past its scheduled-task timeout. Overflow sessions stay
  unseen and are picked up by later runs, so coverage is preserved. `0` disables.

### Fixed

- **Auto-accept validation failures are no longer a blind leak.** When a
  confidence-passing proposal fails promotion validation, the gate now captures
  the reason (the `validateProposal` finding kind, e.g. `validation:description-quality`),
  records it on the proposal (`akm proposal show` explains the rejection), logs
  it, and exposes `failedByReason` on the gate result — so the ~5% leak is
  diagnosable instead of silently warned-and-dropped.
- **Inflated skip-reason aggregates in `akm health`.** `no_new_signal` /
  `profile_filtered_all_passes` are per-run snapshots of a stable set; the
  window aggregator summed their per-run counts (≈2.7M / 3M). It now uses the
  most recent run's count for these aggregated-snapshot reasons while still
  summing genuine per-occurrence skips.

## [0.9.0-beta.10] - 2026-06-15

### Added

- **#603** — `akm health` pool-saturation advisory. Instead of alerting on the
  raw `sessionsScanned` count (which false-alarmed on normal cadence changes),
  a new `pool-saturation` advisory reports the ratio of new (unseen) sessions
  to the total session pool: informational below 10% (expected steady state),
  warning below 2% (possible discovery/dedup bug). Heuristic, never gates
  overall status.
- **#576** — the `akm health` HTML report now renders the real per-stage LLM
  token/time aggregate (a "🧠 LLM Work" KPI card + LLM token/call/wall-time
  summary rows) from the captured `llm_usage` events, replacing the GPU-time
  proxy.
- **Built-in `akm health --format html` report overhaul** — the report is now a
  strict superset of (and supersedes) the external `akm-health-report` stash
  skill. Restored the interactive filter bar (time-slice 1d–21d, task, status)
  with client-side chart/table re-render and the Last-10 "Task" column;
  reordered sections to a decision-first flow (verdict → action items → KPIs →
  table → charts); added a synthesized one-sentence **Verdict** (status + 2–3
  drivers) and a freshness line; merged the duplicate Advisories / What-to-Watch
  into one prioritized, de-duplicated **Action Items** list (P1/P2/P3 +
  remediation command); added a per-stage **LLM token** stacked-bar chart and
  `dataZoom` sliders on dense charts; fixed the failed-run scatter x-alignment
  (now shape-encoded); KPI-card colors are now health signals (not decoration);
  added metric-glossary tooltips, chart `aria-label`s, contrast fixes, and
  empty-state overlays. Deterministic output preserved.

### Fixed

- **Health report accuracy** (follow-ups to the overhaul): the per-run **Task**
  column/filter now show the real scheduled task (`akm-improve-frequent`, …) via
  a ±5min `task_history` join instead of the run's scope (which is `all` for
  every scheduled run); the time-**slice** filter options are now derived from
  the report's `--since` window (e.g. All/3d/1d/12h/6h for a 7d report) and
  default to "All" — replacing the hard-coded 1d–21d list that didn't match the
  window; and the trend **deltas** now default their compare window to `--since`
  (like-for-like, e.g. last 7d vs prior 7d) instead of a fixed 24h, which had
  produced nonsensical period-over-period percentages on multi-day reports.
- **Inflated stash-snapshot metrics in `akm health`.** `memorySummary`
  (derived/eligible) and `profileFilteredRefs` are whole-stash snapshots recorded
  on every run, but the window aggregator was **summing** them across all runs —
  e.g. "915,258 of 1,226,025 eligible" and a 2.4M filtered-ref count. They now
  take the most recent run's snapshot (the current state). Per-run *work* metrics
  (promoted, MI written, graph entities, …) remain genuine window sums.
- **Health report polish:** the akm version is stamped in the header (under the
  AKM logo) and footer; the steady-state `no new signal since last proposal`
  distill reason is excluded from the skip-reason chart (it drowned out the
  actionable reasons); and the Consolidation Output chart now draws Promoted as a
  line on a secondary right-hand axis (it dwarfs merged/deleted) with merged and
  deleted as bars on the left axis.

- **#598** — process-level tuning fields (`consolidate.incrementalSince`,
  `minPoolSize`, `neighborsPerChanged`, `extract.minContentChars`, per-process
  `enabled` flags) now survive an `akm config` rewrite. They are first-class
  typed `ImproveProcessConfigSchema` fields, so the load→save round trip no
  longer silently drops them. Unknown process sub-keys hard-error at load
  (`ConfigError`) rather than being silently discarded — the deliberate,
  documented resolution. Regression-guarded by
  `tests/config-process-roundtrip.test.ts`.

## [0.9.0-beta.9] - 2026-06-14

Restore and instrument `akm improve` steady-state output. The reflect/distill
self-improvement lanes had been near-zero in steady state because the
signal-delta eligibility gate was the only lane (cache "no-access = no-work"
pathology) and the high-retrieval fallback was structurally dead. This release
revives proactive improvement, adds attribution + a measurement/kill-criterion
system so the lane must prove its value, and right-sizes reflect budgets to
their task timeouts.

### Added

- **Proactive maintenance selector** (`proactiveMaintenance` improve process):
  due-gated, composite-priority (`importance × log(1+retrievalFreq) ×
  recencyDecay / log(size)`), bounded rotating top-N reflect/distill over
  stale/never-reflected assets. **Disabled by default**; enable per profile.
- **Eligibility attribution**: every reflect/distill proposal is stamped
  `eligibilitySource ∈ {signal-delta, high-retrieval, proactive, scope,
  unknown}` on `reflect_invoked`/`distill_invoked`/`promoted` events and the
  proposal record, so outcomes are sliceable by lane.
- **Measurement system** under `scripts/akm-eval/`: a real-query retrieval suite
  generated from `usage_events`, and `akm-eval-proactive-verdict` — a read-only
  kill-criterion runner comparing the proactive lane (treatment) vs due-but-
  untouched assets (control). Emits PASS/FAIL/INCONCLUSIVE and recommends
  disabling the lane on FAIL. New `proactive_selected` event +
  `proactiveSelected`/`proactiveDueTotal`/`proactiveNeverReflected` fields on
  `improve_completed`.

### Fixed

- Revived the P0-A high-retrieval fallback: genuinely zero-feedback assets were
  routed to the fully-skipped branch one phase before the fallback could see
  them, so frequently-retrieved-but-never-rated assets were never improved.
- `getRetrievalCounts` now normalizes bare vs `origin//`-prefixed refs (it was
  dropping ~half the retrieval signal) and counts `curate` events
  (`akm curate` now records per-item `entry_ref`).
- The fully-skipped `no_new_signal` branch emitted one `improve_skipped` event
  per ref (~11K writes/run, ~400K rows/day) — a contributor to 900s improve
  timeouts and state.db bloat. Collapsed into one aggregated counted event.

## [0.9.0-beta.8] - 2026-06-13

Fix multi-process SQLite contention in `index.db` and harden concurrent proposal
queue mutations.

### Changed

- Added a global `index.db` writer lease used by foreground indexing,
  background auto-index, improve maintenance index writers, graph updates, and
  feedback writes.
- Replaced the racy background index PID-file dedup flow with lease-based
  coordination and explicit handoff to the spawned worker.
- `akm feedback` now uses blocking index preparation and writes under the same
  `index.db` lease, avoiding self-inflicted `database is locked` failures.
- Proposal queue create/archive/gate-decision mutations now run under
  `BEGIN IMMEDIATE` state.db transactions so concurrent processes serialize on
  live queue state.

## [0.9.0-beta.7] - 2026-06-13

Fix the `akm improve` regression introduced by background `ensureIndex`.

### Changed

- Added an explicit `ensureIndex` mode so callers choose `background` or
  `blocking` behavior directly instead of relying on hidden environment state.
- `akm improve` now uses blocking index preparation before collecting eligible
  refs, restoring the post-upgrade empty-index recovery path.
- Removed the `AKM_INDEX_INLINE` test-only override so tests exercise the same
  index behavior model as production.

## [0.9.0-beta.6] - 2026-06-12

Pipeline optimization: new per-process config fields wire up the consolidation
and improve pipeline knobs exposed by the optimization report — incremental
consolidation, pool caps, distill gating, and memory inference throttling.

### Added

- **`consolidate.incrementalSince`** — profile config field that narrows the
  consolidation candidate pool to memories modified within the given window
  (e.g. `"1h"`, `"4h"`) plus their graph neighbours. Enables frequent
  consolidation passes (e.g. `quick-shredder` every 15 min) without full-pool
  sweeps. Absent = full-pool sweep (correct for nightly runs).
- **`consolidate.limit`** — hard cap on memories processed per consolidation
  pass, applied after incremental narrowing. Prevents runaway full-pool sweeps
  in the nightly default profile.
- **`consolidate.neighborsPerChanged`** — configurable graph-neighbour count
  per changed memory during incremental consolidation (was hardcoded to 5).
  `quick-shredder` sets this to 3 for a 40% candidate reduction per burst.
- **`distill.requirePlannedRefs`** — when `true`, the distill process is
  skipped entirely for distill-only refs when the reflect phase produced zero
  planned refs. Eliminates hundreds of `distill-skipped` events on quiet passes
  where all refs are on reflect cooldown.
- **`memoryInference.minPendingCount`** — minimum pending split-parent memory
  count below which the inference pass is skipped entirely (zero LLM calls).
  Prevents lock acquisition on passes where there is nothing to infer.
- **`reflect.limit`** — per-process ref limit for the reflect/distill loop,
  applied as the improve run limit when no CLI `--limit` is given.
- **New `reflect-distill` improve profile** — dedicated reflect + distill + 
  memoryInference + triage profile for the every-4h `akm-improve-frequent`
  task. `reflect.limit: 25` bounds LLM cost per pass.

### Changed

- **`quick-shredder` profile tuned**: `incrementalSince` `4h` → `1h`,
  `maxChunkSize` 25 → 35, added `minPoolSize: 10`, `neighborsPerChanged: 3`,
  `memoryInference.minPendingCount: 5`. All `profile: "qwen-9b-shredder"`
  process references removed — falls back to default LLM.
- **`default` improve profile** (nightly): extract disabled (dedicated
  `akm-extract` task runs at 01:48), consolidate gets `limit: 500`,
  reflect gets `limit: 100` and `allowedTypes`, distill gets
  `requirePlannedRefs: true`, triage enabled at 50 accepts/run,
  graphExtraction explicitly enabled.
- **Cron schedule optimised**: extract reverted to `8,28,48 * * * *` (3×/hr),
  quick-shredder shifted to `4,19,34,49` (4-min extract gap), health-report
  shifted to `:03` (avoids `:00` collision), `akm-improve-frequent` re-enabled
  at `45 */4` with `reflect-distill` profile.

## [0.9.0-beta.3] - 2026-06-12

Stabilization batch closing the remaining 0.9.0 milestone: DB-locking and
improve-pipeline perf backports, extract/reflect gate fixes, SQLite-first
proposal and log storage, `--format html` output, and per-stage LLM telemetry.

### Added

- **`--format html` output with per-command templates** (#582). `akm health
  --format html` renders the full interactive health report (ECharts inlined by
  default, or via CDN with `AKM_ECHARTS=cdn`); every other command falls back to
  a dark-mode default template that pretty-prints its JSON. A global `--output
  <path>` flag writes the rendered HTML to a file instead of stdout. Token
  replacement only — no template engine. The standalone health-report skill is
  now folded into core.
- **Per-stage LLM telemetry** (#576). Every `chatCompletion` call now records
  tokens (prompt/completion/total/reasoning), wall-time, model, and
  finish_reason as an `llm_usage` event, attributed to the pipeline stage via an
  ambient `AsyncLocalStorage` context (`withLlmStage`) set once per phase — no
  `stage` parameter threaded through call sites. `akm health` exposes per-stage
  token and time aggregates. Telemetry is best-effort and can never fail a run;
  capture is forward-only.
- **Per-proposal gate decision + confidence** (#577). When a proposal passes
  through the auto-accept/triage gate, its outcome (`auto-accepted` /
  `deferred` / `auto-rejected`), reason, confidence, measured value, and the
  thresholds in effect are persisted on the proposal (in the SQLite metadata).
  `akm proposal show`/`list` surface them with reconstructable comparisons
  (e.g. `0.72 < 0.90`), so tooling can explain *why* each proposal is pending
  instead of relying on a run-level aggregate. Forward-only; legacy proposals
  render `unknown`.

### Fixed

- **`SQLITE_BUSY` / "database is locked" under concurrent runs** (#584, #585,
  #589). `busy_timeout` raised from 5 s to 30 s on every SQLite open path
  (index.db and state.db); the improve maintenance pass now closes its index.db
  handle before each reindex (which opens its own writer to the same WAL file);
  and the post-loop purge reuses the long-lived events connection instead of
  opening a second state.db writer. Together these eliminate all observed
  lock failures from overlapping cron improve runs. (Backports of 0.8.8.)
- **Extract gate ignored the active profile's `extract.enabled: false`** (#593,
  #594). The session-extraction gate hardcoded the `default` profile, so a
  non-default profile (e.g. a quick pass) ran extract anyway — 300–600 s of
  redundant work per run when a dedicated extract task also exists. The gate
  now resolves `extract` against the active improve profile. (Backport of
  0.8.11.)
- **Memory inference burned LLM calls on already-derived parents** (#588). The
  primary pass now checks for the `<parent>.derived.md` child on disk *before*
  the LLM/cache call, and opportunistically marks the parent processed so it
  never re-pends. Previously ~55 % of the inference budget was spent
  rediscovering children that already existed.
- **Reflect no longer queues empty-diff or cosmetic-only proposals** (#580).
  A deterministic, LLM-free noise gate diffs each candidate against the current
  asset; byte-identical edits are dropped and changes that are pure formatting
  (whitespace reflow, hard-wrap changes, code-fence language hints, YAML scalar
  re-folding) are suppressed, each recorded via summary events so suppression
  rates are visible in `akm health`.

### Added

- **`minContentChars` pre-LLM extract gate** (#595, #596). Sessions whose raw
  size is below `profiles.improve.<name>.processes.extract.minContentChars`
  (default 10 — only truly empty sessions/journal files) skip the extract LLM
  call entirely. Gates on raw input size, not post-noise-filter size.
  (Backports of 0.8.12–0.8.14.)
- **Structured logs database** (#579). Task and run log lines now land in a
  dedicated `logs.db` (WAL, 30 s busy_timeout) keyed by task, run, stream, and
  time, with retention/purge wired into the existing purge pass and `ATTACH`
  support for joining log lines to `state.db` rows (e.g. a failed
  `task_history` row to its log output). The scattered-log audit and per-source
  keep/move/drop decisions are documented in `docs/technical/logs-audit.md`.

### Changed

- **Proposals are now stored canonically in SQLite** (#578). The previously
  bypassed `proposals` table in state.db is the single source of truth; all
  proposal commands (`list`/`show`/`diff`/`accept`/`reject`/`revert`/`drain`),
  the improve auto-accept gate, and health metrics read and write it through
  one storage layer. Pending file-based proposals are imported on first read;
  `akm proposal *` UX is unchanged. Design and migration notes live in
  `docs/technical/proposal-storage.md`.
- **Improve planning no longer does per-ref DB lookups or per-ref skip events**
  (#591, #592). Eligible refs carry a pre-resolved `filePath`, removing a
  serial async lookup per ref (~500 s on 9 k-ref stashes), and the
  profile-filtered skip loop emits one summary event with a count instead of
  thousands of rows. (Backports of 0.8.9–0.8.10.)

## [0.9.0-beta.2] - 2026-06-09

### Fixed

- **Consolidation starved merge recall; the memory pool grew unbounded.** Commit
  `633ece41` made the `incrementalSince` narrowing unconditional, so every
  consolidation run only judged memories changed since the last run plus their
  immediate vector-neighbors. Stale-but-unmerged duplicate clusters were never
  re-examined, so the eligible pool grew monotonically and never shrank, and
  contradiction detection (which rides on the consolidation pass) went dark.
  Consolidation only runs on the nightly default-profile pass (`quick`/`frequent`
  disable it), so a full-pool sweep is correct and affordable; the override is
  removed. `lastConsolidateTs` still gates whether the pass runs. (Forward-port
  of the 0.8.5 fix.)
- **`akm tasks sync` ignored schedule changes** — forward-ported from 0.8.4.
  Sync classified any task already present in the OS scheduler as "unchanged"
  without comparing its installed entry, so editing a task's `schedule:` in the
  `.yml` never reached the crontab; the same gap affected `tasks enable`/`disable`
  (toggled the comment, re-enabling a stale schedule). Sync now compares the
  backend's installed signature against the signature the current definition
  renders to and reinstalls on drift (new `updated[]` field); `enable`/`disable`
  reinstall from the current `.yml`. The cron backend gains `expectedSignature()`
  and a per-entry signature on `list()`; other backends fall back to an
  idempotent reinstall.

### Added

- **`akm improve --skip-if-locked`** — forward-ported from 0.8.4. When another
  improve run already holds the lock, the run logs and exits 0 with a no-op
  result (`skipped.reason: "lock-held"`) instead of failing with the "already
  running" config error (exit 78). Intended for high-frequency scheduled runs
  (e.g. an every-30-min `quick` pass) that overlap a longer run. Default off.

### Removed

- **`akm config edit`** — the interactive menu-based editor was removed. A
  prompt-driven drill-down was clunkier than just editing the file. Edit the
  config directly (the path is shown by `akm config path`), use
  `akm config set/get/unset` for scripted changes, and `akm config validate` to
  check it.

## [0.9.0-beta.1] - 2026-06-08

### Fixed

- **`improve.lock` leaked on signal death (cron timeout)** — forward-ported from
  0.8.3. The improve SIGTERM/SIGINT/SIGHUP handler calls `process.exit()`, which
  skips `finally` blocks, so the `finally` releasing `improve.lock` never ran and
  every timed-out cron run leaked the lock. It is now released from a
  `process.on("exit", …)` handler registered at acquire time, via a new
  ownership-checked `releaseLockIfOwned(path, pid)`.
- **`quick` profile was not quick** — forward-ported from 0.8.3. It did not
  disable the default-ON session-`extract` process, so a `quick` run processed
  the entire session backlog (~40 min). `quick` now sets
  `processes.extract.enabled: false`.
- **`akm-eval` smoke suite adapted to the 0.9.0 CLI** (CI/tooling only). The
  eval harness called `akm search --detail agent`, but 0.9.0 moved the
  agent/summary projections to `--shape`; it now uses `--shape agent`.
  Additionally, the improve-run history readers (`listRecentImproveRunIds` /
  `resolveImproveRunId`) treated a missing `state.db` as an error rather than
  "no runs", which broke the read-only smoke + replay-determinism gates on a
  fresh checkout; a missing `state.db` is now handled as an empty history.

## [0.9.0-beta.0] - 2026-06-08

### Added

- **Cross-runtime: akm now runs on Node.js >= 22 in addition to Bun** (#560,
  #465). A two-file runtime boundary (`src/storage/database.ts` owns SQLite via
  `bun:sqlite` on Bun / `better-sqlite3` on Node; `src/runtime.ts` owns every
  `Bun.*` API) contains all runtime-specific code, enforced by a lint guard so it
  cannot leak back out. A CI `node-smoke` matrix runs the built CLI under Node
  20 and 22. The prompts dependency (`@clack/core`) uses `node:util.styleText`,
  added in Node 20.12; Node 18 is EOL and unsupported. The npm package uses Node
  as its bootstrap and prefers a working Bun >= 1.0 for execution when both are
  available. Old, unusable, or absent Bun installations fall back to Node.js;
  standalone binaries remain runtime-free.
- **`session` asset type — agent sessions are now searchable** (#561). The
  `extract` pass, after distilling memory proposals from a session, additionally
  writes the session itself as a first-class `session` asset
  (`sessions/<harness>/<id>.md`) with an LLM-generated `## Summary` /
  `## Key topics` body plus `harness` / `session_id` / `started_at` / `ended_at`
  / `project` / `log_path` / `access` frontmatter. Sessions become discoverable
  via `akm search --type session` and `akm curate`, and the `access` + `log_path`
  fields tell any agent how to open the raw session log. The behaviour is
  ADDITIVE, FAIL-OPEN, and config-gated via
  `profiles.improve.default.processes.extract.indexSessions` (default on when an
  LLM is configured; set `false` for byte-identical legacy extract behaviour) and
  `…extract.minSessionDuration` (default 5 minutes). Session assets are not
  graph-extracted. No new LLM call is made when no provider is configured.

- **`akm env set` / `akm env unset` — single-key `.env` management.** `akm env
  set <ref> <KEY>` sets/updates one key (value from stdin by default, or
  `--from-env <VAR>` / `--from-file <path>` — never argv, never echoed); `akm env
  unset <ref> <KEY...>` removes one or more keys. Both do a minimal edit that
  preserves existing comments and key order, and use `dotenv` as the
  serialisation oracle: a value is only written if `dotenv.parse` reads it back
  exactly, and the whole edit is re-verified so no sibling key is disturbed. This
  reintroduces key-level management (the deprecated `vault set`/`vault unset`
  pointed here); `akm env remove` still removes the whole file.

- **`--path` for subdirectory asset creation** (#503) — a consistent `--path
  <relative-dir>` flag across the asset-creating command surface: `akm remember`,
  `akm import`, `akm propose`, `akm workflow create`, `akm env create`, and
  `akm secret set`. `--path` is a directory applied rooted at the asset's type
  directory (e.g. `akm remember "buy milk" --path personal --name grocery-list`
  → `memories/personal/grocery-list.md`; `akm workflow create ship --path
  release` → `workflows/release/ship.md`). The filename/name still comes from the
  `--name`/name positional (or, for `remember`/`import`, the content/source slug).
  The explicit name is now a **flat** name everywhere: a `/` in it is rejected
  with guidance to use `--path`. System-derived names (e.g. a URL-path-derived
  knowledge name from `akm import <url>`) may still nest. Shared semantics live in
  `src/core/asset-create.ts`. (Replaces #503's earlier nested-`--name` approach.)
- **Workflow runs record agent harness + session identity** — `akm workflow start`
  now persists the agent harness (e.g. `claude-code`, `opencode`) and the
  platform-native session id that owns each run. Identity is resolved best-effort
  from the environment (`AKM_AGENT_HARNESS` / `AKM_SESSION_ID`, falling back to the
  harness-native session env var) or can be passed explicitly to `startWorkflowRun`.
  Stored via additive migration `002-add-agent-identity` and surfaced on
  `WorkflowRunSummary.agentHarness` / `.agentSessionId`. This is the first concrete,
  scoped slice toward workflow session monitoring (#501).
- **Workflow agent check-in + step-summary validation** (#506) — workflow runs now
  use a file-signal / command-loop check-in model (no resident background thread, per
  the ADR in `docs/technical/workflow-agent-checkin-adr.md`). `akm workflow start`
  arms a durable check-in timestamp; `akm workflow complete --summary` now **requires**
  a per-step summary and runs it through an LLM completion-criteria validation gate —
  on failure the step stays pending and structured corrective feedback is returned
  (`workflow-complete-rejected`). A pure `evaluateCheckin` surfaces a strong `continue`
  directive through `getNextWorkflowStep` when an active run looks stalled. Migration
  `002` adds `agent_harness`, `agent_session_id`, `checkin_armed_at` on
  `workflow_runs` and `summary` on `workflow_run_steps`.
- **Default improve profiles + scheduled task set** (#552) — three new bundled
  profiles in `src/assets/profiles/` — `frequent` (extract + inference; distill /
  consolidate excluded), `consolidate` (consolidation-only), and `catchup` (manual
  recovery: consolidate + triage drain) — alongside the existing `default` / `quick` /
  `thorough` / `memory-focus` / `graph-refresh`. `akm setup` and the new `akm tasks
  init` register a multi-cadence task set **idempotently**: `akm-improve-frequent`
  (60 min), `akm-improve-consolidate` (4 h), `akm-improve-nightly` (`thorough`, daily
  2 am, server-gated), `akm-improve-catchup` (registered but unscheduled), and
  `akm-graph-refresh-weekly` (Sun 3 am). Registration is CI-aware (skips when
  `CI=true`) and asks a single "Is this a server install?" prompt to gate the nightly
  task (default yes on Linux-without-battery, no on macOS/laptop).

### Design notes

- **#501 narrowed; superseded by #506 for the monitoring design.** Issue #501
  ("Add background thread for workflow command session monitoring and agent
  prompting") was an epic. Per #506's stated preference to avoid always-on
  background threads/daemons, the background-thread requirement is **not**
  implemented here. #501 is narrowed to the one tractable, prerequisite sub-feature
  — persisting harness + session identity on each workflow run — which any future
  monitor needs regardless of design. The session-monitoring/agent-steering loop is
  deferred to #506 and requires a separately approved design.

### Changed

- **`improve`: consolidation runs before extract + smarter pool-delta gate**
  (#551). The consolidation phase now runs **before** the session-extract pass
  in the improve pipeline. Extract auto-accept writes new memory `.md` files on
  every run, which previously made the consolidation pool-delta gate
  (`memoryUpdatedAfterLastConsolidate`) fire unconditionally — consolidation
  never skipped and wastefully re-judged freshly-promoted single-source
  memories with no merge/contradiction candidates yet. Running consolidation
  first means it only ever sees memories from **prior** runs; current-run
  extract promotions are not on disk yet. The pool-delta gate is additionally
  narrowed: a memory whose only mtime bump since the last consolidate came from
  its **own** auto-accept promotion (tracked via the `promoted` event's
  `assetPath`) is excluded from the "work to do" check, so adjacent-run
  promotions get a full improve cycle to settle before consolidation considers
  them. When the gate now correctly skips, the existing
  `improve_skipped` / `consolidation_no_memory_updates` event is emitted so
  health reflects it. No event-shape changes; emitted-event order changes only
  because consolidation moved earlier.

- **Unified git commit model — single batch-at-boundary commit** (#507). Writing
  or deleting an asset on a git-backed source no longer commits (and optionally
  pushes) **per asset**. `writeAssetToSource` / `deleteAssetFromSource` now
  perform a plain filesystem write/unlink for every kind, and git-backed targets
  are committed **once** at the operation boundary (`akm remember --target`,
  proposal accept/revert, consolidate) as a single complete commit — `git add -A`
  stages `.akm/` state + sibling assets together — pushed under the same
  `writable + remote` gate as `akm save`/`akm sync`. This removes the noisy,
  incomplete per-asset commits (~25 per improve run) and leaves no dirty
  working-tree residue.

- **`improve/consolidate`: `minPoolSize` guard** (#553). Consolidation now skips
  itself when the eligible memory pool is below `processes.consolidate.minPoolSize`
  (default **500**), emitting a `consolidation_skipped` event with
  `reason: pool_below_min_size` and making **zero** LLM calls — so the always-enabled
  consolidate task self-activates only once a stash is large enough to have real
  merge/contradiction candidates. `minPoolSize: 0` disables the guard. The skip
  surfaces in `akm health` improve output. The bundled `consolidate` profile sets
  `500`, `catchup` sets `0`.

- **`improve/extract`: `minNewSessions` gate** (#554). The extract phase now counts
  in-window, not-yet-seen candidate sessions **before** any LLM call and skips the
  pass (emitting `extract_skipped` / `reason: below_min_new_sessions`, visible in
  `akm health`) when the count is below `processes.extract.minNewSessions`. The
  in-code default is **0 (disabled)**, so existing profiles keep always-run behaviour;
  only the new `frequent` profile opts in with `3`. This removes the ~22% of improve
  runs that previously ran the full `ensureIndex` + extract pipeline for zero new
  sessions.

### Deprecated

- **`options.pushOnCommit`** (#507). The per-asset push-on-commit knob is retired.
  Existing configs still parse — its push intent is mapped onto the batch push
  gate and a one-time deprecation warning is emitted when the option is
  encountered. Remove it and rely on `writable: true` + a configured remote.

### Fixed

- **Memory inference re-queued `hot` parents forever** (#550). `markParentProcessed`
  was only called when a derived child was newly written; when the child already
  existed (`written = 0`), the parent never got `inferenceProcessed: true` and was
  re-queued on every `akm improve` run (~37 wasted LLM calls/run on one production
  stash). The child-exists path now marks the parent done (a genuine write failure
  still leaves it unmarked for retry), while `skippedChildExists` accounting is
  unchanged.
- **Auto-accept rejected truncated LLM descriptions** (#556). ~9.3% of proposals
  failed auto-accept validation because the LLM cut the description mid-clause (ending
  in `to`/`for`/`and`/a comma/etc.) or lost a YAML continuation line. A deterministic
  post-generation repair pass (`repairTruncatedDescription` in
  `src/core/text-truncation.ts`) now trims the truncated fragment to the last complete
  clause or swaps in the first complete sentence from the body — never fabricating
  text — wired into the extract and distill proposal-write paths before validation.
  Already-valid descriptions pass through byte-identical. (Plus a one-line prompt
  tightening requiring a complete sentence.)
- **Semantic index verification stuck on stashes with vault entries** (#502).
  Verification compared the stored embedding count against the *full* entry count, but
  the embedding phase intentionally excludes vault rows — so any index with vault
  entries reported `embeddingCount < totalEntries` forever and stayed in
  semantic-blocked / verification-failed state. A new `getEmbeddableEntryCount`
  (`entry_type != 'vault'`) now feeds the zero-entry short-circuit, the readiness gate,
  the "Semantic search ready (X/Y)" message, and the persisted `entryCount`; a
  genuinely missing embedding on an embeddable entry still reports `ok:false`.

### Internal

- **#490 architecture refactor.** Decomposed `src/cli.ts` from **4,589 → 620 LOC**
  across 16 per-family command modules under `src/commands/*-cli.ts` (adopting a
  `defineJsonCommand` factory for byte-identical JSON envelopes); converted `akm
  health` checks to an ordered `HealthCheck` registry; and turned the
  `migrate-storage` bin's 54 hand-rolled `recordStep` sites into a `MigrationStep`
  registry with 3 recursive copy helpers unified into one `copyTree`. Shipped as
  serialized local merges with a zero-behaviour-change contract (byte-identical CLI
  surface + JSON envelopes), each gated and reviewed; the secret-migrating
  `migrate-storage` change is pinned by a sha256 + file-mode fixture-stash
  differential test.

## [0.8.14] - 2026-06-11

### Fixed

- **`akm extract` minContentChars default lowered from 500 to 10.** The 500-char
  threshold used inputCount (raw session size) but analysis showed 209 of 218
  candidate-producing sessions had inputCount < 500 — tiny agent sessions (22–368
  chars) regularly yield 1–5 candidates. The only reliably skippable sessions are
  empty ones (0 chars, journal files). Default lowered to 10 to catch only
  truly empty sessions while preserving all signal-bearing content. Closes #597.

## [0.8.13] - 2026-06-11

### Fixed

- **`akm extract` minContentChars gate filtered all sessions.** The threshold was
  checked against `filtered.stats.outputCount` (post-noise-filter chars), but the
  pre-filter strips so much boilerplate that even signal-bearing sessions end up
  below 500 chars of output. All 75 sessions in the first post-deploy run were
  filtered, dropping candidates from 4–13 to 0. Fix: gate on `inputCount` (raw
  session size) instead — a session with < 500 raw chars has nothing worth
  extracting regardless of what the pre-filter produces. Closes #596.

## [0.8.12] - 2026-06-11

### Fixed

- **`akm extract` calling the LLM for noise sessions that never yield candidates.**
  96% of processed sessions (72/75 measured) produced zero candidates, consuming
  ~330 s of LLM time per run. The pre-filter had no minimum content threshold —
  sessions as short as 50 chars were sent to the LLM regardless. A new
  `minContentChars` gate (default 500) skips the LLM call when post-filter
  content falls below threshold, cutting extract LLM calls by ~95% on typical
  stashes. Configurable via `profiles.improve.<name>.processes.extract.minContentChars`.
  Closes #595.

## [0.8.11] - 2026-06-11

### Fixed

- **`akm improve --profile <name>` ignored profile's `extract.enabled: false` setting.**
  The session-extraction gate in the preparation stage called
  `isLlmFeatureEnabled(config, "session_extraction")`, which hardcodes a lookup
  against `profiles.improve.default.processes.extract.enabled`. Any non-default
  profile that set `extract.enabled: false` (e.g. `quick-shredder`) was silently
  ignored, causing the extract pass to run regardless. The fix adds a
  `resolveProcessEnabled("extract", improveProfile)` check so the active
  resolved profile gates the pass correctly. Closes #593.

## [0.8.10] - 2026-06-11

### Fixed

- **`akm improve` taking 8–10 minutes per run due to O(n) DB writes for
  profile-filtered refs.** When a profile disables reflect and distill for
  certain asset types, `collectEligibleRefs` marks those refs as
  `profile_filtered_all_passes`. The caller then emitted one `improve_skipped`
  event per ref — a sequential DB write for each. On a ~9 000-ref stash this
  was ~500 s of SQLite writes before any consolidation or memory inference
  began. The fix collapses the per-ref loop into a single summary event
  carrying a `count` field, eliminating ~9 000 sequential writes per run.
  Closes #590.

## [0.8.9] - 2026-06-11

### Fixed

- **`akm improve` validation pass was O(n) in stash size, causing ~510 s overhead
  on large stashes.** For every indexed ref, the preparation phase called
  `findAssetFilePath()` — an async round-trip to the index DB followed by a
  filesystem probe — serially inside a `for…await` loop. With ~9 000 indexed
  refs at ~55 ms each, this loop consumed the entire 600–900 s run budget before
  any reflect, triage, or memory-inference work began. The fix threads
  `filePath` from the planning stage (`collectEligibleRefs`) through
  `ImproveEligibleRef` so the validation pass and the disk-existence guard can
  use the pre-resolved path directly. The async lookup is retained only as a
  fallback for refs that enter via a narrow scope (e.g. `--scope ref:foo`).
  Closes #587.

## [0.8.8] - 2026-06-11

### Fixed

- **SQLite `SQLITE_BUSY` errors under concurrent improve runs.** `busy_timeout`
  was set to 5 000 ms in all three database open paths (`openDatabase`,
  `openExistingDatabase`, `openStateDatabase`). Under a busy cron schedule — or
  when a reindex triggered by memory inference ran concurrently with an event
  write — the 5 s window was routinely exhausted, producing "database is locked"
  failures. Raised to 30 000 ms across all three paths so transient lock
  contention is retried for up to 30 s before surfacing as an error.

## [0.8.7] - 2026-06-09

### Fixed

- **`incrementalSince` duration strings were silently ignored.** Values like
  `"30m"`, `"24h"`, `"7d"` were passed raw to `narrowToIncrementalCandidates`,
  which compared them against ISO timestamps via string sort. All `2026-...`
  timestamps are lexicographically less than `"30m"` (`'2' < '3'`) and `"24h"`
  (`"20" < "24"`), so `isChanged()` always returned `false` and the candidate
  pool was silently emptied rather than filtered to the window. The fix adds
  `parseSinceToIso()`, which resolves human duration strings to absolute ISO
  timestamps before comparison. Values that already look like ISO timestamps
  are passed through unchanged.

## [0.8.6] - 2026-06-09

### Added

- **`consolidate.incrementalSince` profile config field.** Setting
  `incrementalSince: "7d"` (or any duration string) in the `consolidate` block
  of an improve profile narrows the candidate pool to memories modified within
  that window plus their top-5 graph neighbours, keeping each pass focused on
  recent changes. This makes it practical to run consolidation more often than
  once per day (e.g. via `akm-improve-consolidate` every 4 h) without
  re-scanning the full pool every time. The nightly default profile leaves this
  unset (full-pool sweep, same as before). The `incrementalSince` option already
  existed in `akmConsolidate()` but was hardcoded off at the call site; the
  field is now surfaced in the config schema and read from the profile.

## [0.8.5] - 2026-06-09

### Fixed

- **Consolidation starved merge recall; the memory pool grew unbounded.** Commit
  `633ece41` made the `incrementalSince` narrowing unconditional, so every
  consolidation run only judged memories changed since the last run plus their
  immediate vector-neighbors. Stale-but-unmerged duplicate clusters were never
  re-examined, so the eligible pool grew monotonically and never shrank, and
  contradiction detection (which rides on the consolidation pass) went dark.
  Consolidation only runs on the nightly default-profile pass (`quick`/`frequent`
  disable it), so a full-pool sweep is correct and affordable; the override is
  removed. `lastConsolidateTs` still gates whether the pass runs.

## [0.8.4] - 2026-06-08

### Fixed

- **`akm tasks sync` ignored schedule changes.** Sync classified any task already
  present in the OS scheduler as "unchanged" without comparing its installed
  entry, so editing a task's `schedule:` in the `.yml` never reached the crontab —
  the only way to apply a new schedule was to `remove` and re-`add` the task. The
  same gap affected `tasks enable`/`disable`, which merely toggled the existing
  cron line's comment and so re-enabled a stale schedule. Sync now compares the
  backend's installed signature against the signature the current definition would
  produce and reinstalls on drift (reported in a new `updated[]` field);
  `enable`/`disable` reinstall from the current `.yml` instead of toggling in
  place. Backends that can't cheaply read their installed form fall back to an
  idempotent reinstall, so the fix is correct on launchd/schtasks too. The cron
  backend gains `expectedSignature()` and a signature on each `list()` entry.

### Added

- **`akm improve --skip-if-locked`.** When another improve run already holds the
  lock, the run logs and exits 0 with a no-op result (`skipped.reason:
  "lock-held"`) instead of failing with the "already running" config error
  (exit 78). Intended for high-frequency scheduled runs (e.g. an every-30-min
  `quick` pass) that would otherwise pile up exit-78 failures whenever a longer
  run overlaps them. Default off — the hard error is preserved for interactive
  use. The result is still recorded so the skip is auditable.

## [0.8.3] - 2026-06-08

### Fixed

- **`improve.lock` leaked on signal death (cron timeout).** The improve
  SIGTERM/SIGINT/SIGHUP handler calls `process.exit()`, which skips `finally`
  blocks — so the `finally` that releases `improve.lock` never ran, and every
  timed-out cron run leaked the lock sentinel. (It wasn't a permanent deadlock
  only because the next run reclaims a dead-PID lock, a path that PID reuse can
  defeat.) The lock is now released from a `process.on("exit", …)` handler
  registered at acquire time (exit handlers DO run on `process.exit()`), via a
  new ownership-checked `releaseLockIfOwned(path, pid)` so a backstop release can
  never delete a different run's lock. This generalizes to the budget watchdog
  and any future exit path.
- **`quick` profile was not quick.** It was documented "Reflect-only" but did
  not disable the session-`extract` process (which is default-ON), so a `quick`
  run processed the entire unindexed-session backlog (~40 min) — guaranteeing a
  5-minute cron timeout → SIGTERM → the lock leak above, every run. `quick` now
  explicitly sets `processes.extract.enabled: false`.

## [0.8.2] - 2026-06-05

### Added

- **LM Studio auto-detection in setup wizard** — `akm setup` now probes
  `localhost:1234/v1/models` at startup and, when the server is running, pre-fills
  the LLM backend with the active model list, mirroring the existing Ollama detection
  flow (#522).
- **Agent harness config import** — `akm setup` detects installed AI coding harnesses
  (currently Claude Code and OpenCode) and pre-populates LLM provider, model, and
  base-URL fields from the harness configuration. The importer registry
  (`HARNESS_CONFIG_IMPORTERS`) makes adding future harnesses a single append (#523).
  API key *values* are never read or stored — only the environment variable name is
  imported.
- **Registry-driven stash selection** — the "Add Sources" step now fetches available
  stashes from the official AKM registry at startup. `DEFAULT_SELECTED_STASH_IDS`
  in `src/setup/registry-stash-loader.ts` is the single edit point for changing
  which stashes are pre-checked. Falls back to a hardcoded list on network error (#520).
- **`improve.autoAccept.{promoted,validationFailed}` health metrics** — auto-accepted
  proposals that pass the confidence threshold but fail validation (truncated
  description, invalid frontmatter) are now counted as `gateAutoAcceptFailedCount`
  in the improve result envelope and surfaced as `improve.autoAccept.validationFailed`
  in `akm health` reports.
- **`auto-accept-validation` health advisory** — heuristic advisory that warns when
  `validationFailed > 0` so malformed proposals are visible before they pile up in
  the queue.

### Fixed

- **`akm-improve` tasks recorded as failed on budget exhaustion** — the budget
  exhaustion timer called `process.exit(1)`, causing every budget-limited run to be
  recorded as a task failure. Changed to `process.exit(0)`; budget exhaustion is a
  normal exit condition.
- **`improve_runs.started_at` always equal to `completed_at`** — `writeImproveResultFile`
  was called at end-of-run, so `new Date()` captured the completion time and both
  columns held the same value (649/661 real runs affected, regressed ~May 26).
  `started_at` now uses the timestamp captured at process launch, passed in from the
  CLI entry point. A regex-based fallback decodes the timestamp embedded in the run ID
  for any call site that does not supply an explicit value (#524).
- **`akm-health-report` task fails on transient DNS errors** — the Discord webhook
  script caught `HTTPError` but not the parent `URLError`, so DNS blips caused the
  task runner to record the health report as failed. `URLError` is now caught and
  logged as a warning with a clean exit.

### Added

- **Stash `.meta/` convention** — a stash may carry an optional, human-authored
  `.meta/` directory at its root for orientation: purpose, key assets, conventions,
  and maintainer info. Surface it on demand with `akm show meta` (the working
  stash's `.meta/index.md`), `akm show meta:<name>` (e.g. `.meta/about.md`), or
  scope it to a specific stash with `akm show <origin>//meta[:<name>]`. Because
  `.meta/` is a dot-directory, the indexer already skips it, so these docs never
  pollute search results — they are direct-read on demand. Owners extend the
  convention by dropping new files (`.meta/about.md`, `.meta/conventions.md`,
  `.meta/license`) with no code changes. `akm init` scaffolds a `.meta/index.md`
  template into newly created stashes.
- **Default stash skeleton** — `akm init` (and `akm setup`) now copies
  `src/assets/stash-skeleton/` into every newly created stash. Currently ships
  a `README.md` covering what the stash contains and how agents use `akm` to
  access assets. Existing files are never overwritten. Add files to
  `src/assets/stash-skeleton/` to extend what ships with a fresh install.

### Improved

- **Setup wizard pre-populates from existing config** — on re-run, `akm setup`
  initialises every prompt default from the current saved configuration so users
  only need to change what has actually changed (#519).
- **Config backup before every setup write** — `backupExistingConfig()` is now called
  before each `saveConfig` in the setup wizard, ensuring the previous config is always
  recoverable if a wizard run is interrupted (#521).

## [0.8.1] - 2026-06-05

### Added

- **`graph-refresh` improve profile** — new built-in profile that runs a full-corpus
  graph extraction pass across all stash files (all other improve processes disabled).
  Use `akm improve --profile graph-refresh` for a weekly relationship rebuild.
  Pairs with the new `graph-refresh-weekly` task template (`akm tasks add --template graph-refresh-weekly`).
- **`session-extraction` health advisory** — new heuristic advisory backed by real
  `akmExtract` outcomes: warns when the session-extraction process ran but produced
  zero proposals across ≥ 5 sessions, or recorded warnings. Replaces the vestigial
  `session-log-failures` warn signal.
- **`improve.sessionExtraction` health metrics** — `sessionsScanned`, `sessionsExtracted`,
  `sessionsSkipped`, `proposalsCreated`, `warnings`, `durationMs` now tracked and
  visible in `akm health` reports.

### Fixed

- **`akm info` indexStats** — `readIndexStats` errors are now surfaced and the resolved
  DB path is passed correctly; `entryCount`, `hasEmbeddings`, and related fields are
  no longer silently empty (#510).
- **Indexer timing fields** — `embedMs` and `ftsMs` in timing output had their
  operands swapped, producing negative durations. Fixed (#516).
- **Incremental consolidation gate** — the `volumeTriggered` path bypassed the
  incremental gate introduced in 0.8.0, causing consolidation to run on chunks it
  had already processed in the same run. Fixed.
- **Improve budget exhaustion** — `improve.lock` was not released after budget
  exhaustion, blocking subsequent runs until the lock TTL expired.
- **Consolidation chunk retry** — failed chunks are now retried once with a 2 s
  backoff before being recorded as lost, reducing transient LLM errors from
  propagating to `chunksFailed`.
- **`yieldRate` health metric** — `skippedAborted` refs were incorrectly counted in
  `freshAttempts`, inflating the denominator and underreporting yield rate.
- **`session-log-failures` advisory** — demoted from `warn` to always `pass`
  (informational only); the advisory was a raw regex counter with no LLM signal,
  producing false positives on normal session content.

### Refactored

- All runtime assets consolidated under `src/assets/` with `dist/assets/` mirroring
  the layout exactly. Built-in improve profiles moved from in-source object literals
  to embedded JSON files (`src/assets/profiles/*.json`). The `copy-assets.ts` build
  step now uses a precise `src/assets/**/*` glob instead of a broad catch-all.
- Vestigial Phase 0 (`getExecutionLogCandidates` / `ERROR_PATTERNS`) removed from
  the improve pipeline. This regex scan collected a metric count but never fed an
  LLM; `akmExtract` (Phase 0.4) is the real session extraction pipeline.

## [0.8.0] - 2026-05-28

### Performance

- **`akm consolidate`**: all-hot chunk early-exit. When every memory in a chunk
  is `captureMode: hot` (user-explicit), the only operations the LLM could ever
  propose are deletes — all refused unconditionally by the downstream guard.
  Such chunks now skip the model entirely and are counted as `judgedNoAction`
  up front, instead of relying on a prompt-level hint and spending a wasted
  request. Mixed chunks are unaffected.

### Breaking changes (deprecation aliases, removed 0.9.0)

The 0.8 line is the clean-break window for CLI ergonomics. Every rename below
keeps the **old spelling working** as a deprecated alias that prints a stderr
warning (never on stdout, so JSON consumers are unaffected) and delegates to the
canonical form. **All of these deprecated aliases are removed in 0.9.0.** See
[`docs/migration/v0.8-to-v0.9.md`](docs/migration/v0.8-to-v0.9.md) for the full
old → new table.

- **Proposal queue is now a noun group**: `akm proposal {list,show,diff,accept,reject,revert}`.
  The flat verbs `akm proposals`, `akm show proposal <id>`, `akm accept`,
  `akm reject`, `akm diff`, and `akm revert` are deprecated aliases.
  Bare `akm proposal` behaves as `akm proposal list`.
- **`--detail` is now verbosity only** (`brief|normal|full`). The output
  *projection* moved to a new **`--shape`** flag (`human|agent|summary`).
  `--detail summary` and `--detail agent` are deprecated aliases that map to
  `--shape summary` / `--shape agent`.
- **`--for-agent`** is a deprecated alias for `--shape agent`.
- **`--generator`** replaces `--source` on `accept` / `reject` / `history`
  (which generator produced the proposal/event). `--source` is a deprecated
  alias on **those three commands only** — it is unchanged on
  `search` / `curate` / `graph` / `remember`, where it means "read from here".
- **`akm save` → `akm sync`** (commit + optional push; `sync` connotes push
  better). `akm save` is a deprecated alias. `akm sync` adds `--no-push`.
- **`akm enable` / `akm disable` → `akm config enable` / `akm config disable`**.
  The top-level `enable` / `disable` are deprecated aliases.
- **`akm events` → `akm log`**: `log` is an additive alias for the same
  state.db stream in 0.8 and becomes primary in 0.9.0. (`akm history` remains the
  asset-scoped, cross-source analytical trail — a different surface.)
- **`akm wiki remove --force` → `-y` / `--yes`** for skipping the confirmation
  prompt. `wiki remove` now also *prompts* interactively when a TTY is present;
  `--force` is a deprecated alias for `-y`.
- **`akm feedback --note` → `--reason`**: `--note` is a deprecated alias and
  warns when used without `--reason`.
- **`akm workflow next --dry-run` removed**: the flag is no longer declared, so
  it no longer appears in `--help`. The explicit "next does not support
  --dry-run" guard remains (read from argv) so existing callers still get a clear
  message instead of silent acceptance.
- **Singular aliases added** (additive, non-breaking): `akm task` for
  `akm tasks`, `akm lesson` for `akm lessons`.

### Safety

Two destructive paths that previously acted with no confirmation now guard
behind an interactive prompt (or `-y` / `--yes` in non-interactive use).
**Scripts that ran these non-interactively must add `-y`.**

- **`akm registry remove`** now confirms before splicing the registry out of the
  config (`confirmDestructive`). Pass `-y` / `--yes` to skip the prompt;
  non-interactive use without `-y` aborts.
- **Bulk `akm proposal accept --generator <g>`** (the multi-proposal branch) now
  confirms before promoting every matching proposal, mirroring the existing
  guard on bulk `reject`. Single-id accept stays unguarded (it is revertable).

### Fixed

- **Consolidation `delete_failed` on stale index entries** — when consolidation
  successfully deleted a memory file, the index DB was not re-indexed between
  runs. Subsequent runs loaded the stale DB entry into their memory map, the LLM
  re-proposed the deletion, and `deleteAssetFromSource` threw "not found in
  source" — appearing as `delete_failed` in skipReasons. Fix: `loadMemoriesForSource`
  now filters entries whose file no longer exists on disk before building chunks,
  so phantom memories are never sent to the LLM. A secondary catch in the delete
  handler emits `delete_already_gone` instead of `delete_failed` when the file
  is confirmed absent.

> **CI / Docker users:** the 0.8.0 storage split moved `akm.lock`, the event
> database, and the registry cache out of `$XDG_CONFIG_HOME/akm/` into
> `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, and `$XDG_CACHE_HOME` respectively. If
> you override any of `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`,
> `AKM_CACHE_DIR` in CI to isolate per-job state, set **all four** (or none,
> and rely on XDG defaults). Overriding only `AKM_CONFIG_DIR` will leave the
> lock file / event DB pointing at the host's default `$XDG_DATA_HOME`,
> causing lock contention and bleed between jobs.

### Removed

- **Install-time security audit (`security.installAudit`) and the `--trust`
  flag**. The audit scanned incoming stash assets for risky patterns (e.g.
  `curl ... | bash`, "ignore previous instructions") and blocked installs on
  critical findings. In practice it produced too many false positives on
  benign documentation strings and forced first-time users to pass `--trust`
  or twiddle config just to install the official stash. The whole feature is
  gone:
  - `akm add` and `akm update` no longer scan synced content.
  - The `--trust` flag is removed from `akm add` and `akm wiki register`.
  - The `security.installAudit.*` config keys (`enabled`, `blockOnCritical`,
    `registryAllowlist`, `registryWhitelist`, `blockUnlistedRegistries`,
    `allowedFindings`) are no longer recognised; the entire `security` block
    is removed from the config schema.
  - The `akm config set security.installAudit.*` keys now error as unknown.
  - `audit` fields are removed from `AddResponse.installed` and
    `SourceInstallStatus`.

### Breaking Changes

- **Project-level `.akm/config.json` files are no longer merged**. The
  multi-layer config discovery introduced in the 0.7 line was deprecated
  in late-0.8.x with a warning; that warning is now backed by removal.
  `loadConfig` walks cwd-ancestors only to emit a one-time deprecation
  warning per discovered file. Move any needed settings to
  `~/.config/akm/config.json`. `stashInheritance` (a multi-layer-only
  field) is removed from the schema.

- **`${VAR}` env-var expansion only resolves at the apiKey consumption
  sites**. The recursive expansion walker that ran on the load path is
  gone. Other config string values now round-trip verbatim: a literal
  `${HOME}` in (say) `stashDir` is preserved as the literal `${HOME}`
  on read. The new exported `resolveSecret(value)` helper is applied
  only where authorization headers are built (`src/llm/client.ts`,
  `src/llm/embedders/remote.ts`, `src/integrations/agent/sdk-runner.ts`).
  Documented `${OPENAI_API_KEY}` recipes in `docs/configuration.md`
  continue to work because expansion still happens at request time for
  apiKey fields.

- **`AKM_FORCE_DOWNGRADE_CONFIG` env var removed**. The newer-than-binary
  read-only guard (`configReadOnlyReason`, `markConfigReadOnlyIfNewer`,
  `getConfigReadOnlyReason`) is gone. Configs declaring a `configVersion`
  newer than the running binary now save through silently — unknown
  fields are stripped on save by `sanitizeConfigForWrite` plus the
  strict-walled Zod schema. Users on 0.9.x configs should not open them
  with a 0.8.x binary in writable workflows.

### Changed

- **Rebrand**: the full name "Agent Kit Manager" is now **Agent Knowledge Manager** — `akm` stands for Agent Knowledge Manager going forward. The binary name, npm package (`akm-cli`), and all APIs remain unchanged.

- **Config layer rewrite** — single-source-of-truth Zod schema in
  `src/core/config-schema.ts` replaces the per-field parse switch AND
  the per-shape load-time parser. Adding a new config field is now one
  line of schema + zero lines of CLI code. `loadConfig` now consists of
  parse-text → migrate (pure JSON transforms) → Zod safeParse → overlay
  defaults — a ~30-line pipeline that absorbs ~900 LOC of legacy
  per-shape parsers (`parseLlmConfig`, `parseEmbeddingConfig`,
  `parseIndexConfig`, `parseSourceConfigEntry`, and ~20 more).
  - **#454**: `akm config set llm.apiKey` / `embedding.apiKey` /
    `profiles.llm.<name>.apiKey` now throws `UsageError` pointing at the
    corresponding env var (`AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`,
    `AKM_PROFILE_<NAME>_API_KEY`). Was previously a silent strip.
  - **#455**: every schema-leaf key is now reachable via `akm config set`.
    Includes previously hand-listed gaps: `defaults.agent`, `search.minScore`,
    `improve.eventRetentionDays`, `embedding.provider`, `llm.temperature`,
    `profiles.llm.<name>.*`, `profiles.agent.<name>.*`, etc.
  - **#456**: `akm config validate` and `akm config migrate` are now real
    registered subcommands. The orphan implementations in `config-validate.ts`
    have been removed; the new entry points live in `src/cli/`.
  - **#457**: project-level `.akm/config.json` files are now flagged with a
    deprecation warning ("will be ignored in 0.9.0+"). The merge still
    happens in 0.8.x — one release of grace.
  - **#458**: malformed JSON or non-object root in the config file now raises
    `ConfigError("INVALID_CONFIG_FILE")` with the underlying parse error.
    Was previously a silent fallback to `DEFAULT_CONFIG`, which masked
    corruption. File-not-existing remains the legitimate cold-start case.
  - **#459**: `~/.cache/akm/config-backups/` is now bounded to the 5 most
    recent timestamped backups. Pruning runs on each `saveConfig`.
    `config.latest.json` is preserved separately.
  - **#460**: `UNKNOWN_CONFIG_KEY_HINT` is now auto-generated from the
    schema via `listTopLevelConfigKeys()`. No more stale hand-maintained string.
  - **#461**: if the auto-migration disk-write fails, `loadConfig` now throws
    a hard error instead of returning the in-memory migrated shape. Eliminates
    the silent infinite re-migrate loop on every `akm` command.
  - **#462**: nested registries[], sources[], profiles.* objects are
    `.strict()` — unknown keys are rejected with a path-pointing error at
    both set time and saveConfig time.
  - **#463**: `schemas/akm-config.json` is now auto-generated from the Zod
    source via `bun scripts/gen-config-schema.ts`. A drift test fails CI if
    the committed file disagrees with the regeneration output.
  - **#464.a**: `defaultWriteTarget` is validated via Zod `.refine()` against
    `sources[].name`. With no sources configured, save-time validation
    rejects instead of silently accepting (no implicit "first writable" fallback).
  - **#464.b**: generic unset works on `semanticSearchMode` and every other
    key via the dotted-path walker.
  - **#464.c**: all write paths route through `writeFileAtomic`.
  - **#464.d**: duplicate `mergeSecurityConfig` / `mergeInstallAuditConfig`
    in `config-cli.ts` are deleted; merging happens via re-parse through the
    Zod schema.

See `docs/migration/v0.7-to-v0.8.md` for the user-facing migration guide.

## [0.7.5] - 2026-05-08

### Added

- **Feedback tag/filter filtering** — `akm feedback` and related event-reading paths now support richer filtering by tags and other event metadata, making it easier to inspect and reuse accumulated feedback signals.
- **Vault path/run UX improvements** — vault flows now better support path discovery and command-scoped secret injection without surfacing values, with expanded regression coverage for the path/run contract.
- **Reflect fallback improvements for external agents** — reflection/proposal flows now support a more robust fallback path for proposal content, including the file-write path used by the `opencode` agent integration.

### Changed

- **Workflow runs are now scoped to the current workspace** — ref-based workflow commands (`workflow next/status/list`) now resolve runs within the current project, worktree, or non-repo directory instead of sharing active-run state globally across the whole cache. Direct run-id commands still target the exact run.
- **Help, hints, and workflow docs now explain run scoping** — CLI descriptions, embedded hints, operator docs, and workflow guides now describe the current-scope semantics so users understand how ref-based run resolution behaves across repos and local sandboxes.
- **`akm show` auto-indexes stale state instead of falling back to raw filesystem reads** — show/search parity is tighter because stale index state now triggers refresh rather than silently drifting to a separate fallback path.
- **Release metadata lookup follows the published `CHANGELOG.md` layout** — migration-help, package publish metadata, and related docs now consistently reference the shipped changelog location at the package root.
- **Documentation refresh across README and posts** — README positioning, command-tour docs, workflow examples, and dev.to post organization were refreshed to better match the current CLI surface.

### Fixed

- **Cross-repo and cross-directory workflow leakage** — an active workflow run in one repo or sandbox no longer blocks or leaks into another when the same workflow ref is used from a different working directory.
- **`show` workflow hints now respect the current scope** — `show workflow:...` only surfaces the active workflow run for the current workspace instead of attaching the latest run from anywhere on the machine.
- **Agent-output and local-model JSON hardening** — reflect/propose and LLM-backed parsing paths are significantly more defensive against malformed JSON and partial local-model output.
- **Reflect draft-file isolation** — reflect no longer writes intermediate draft files into the stash itself; temporary draft output now lives in OS temp space instead of polluting user content.
- **Memory-inference token budgeting** — memory inference now respects the configured LLM token budget instead of overrunning long inputs.
- **Named git stash selectors in `akm save`** — save now resolves named git-backed stash selectors correctly.
- **Indexed script refs in search results** — script entries now surface the correct refs in indexed search results.
- **Feedback ref resolution and LLM indexing regressions** — feedback targeting and related LLM indexing paths were corrected.
- **Release workflow reruns and optional native dependency handling** — release automation is now rerunnable and avoids tripping over optional native dependency edges in CI/publish contexts.
- **Published static-file checks** — migration-help packaging/tests now verify the shipped changelog and bundled release-note files are present and loadable from the published layout.

### Documentation

- **Bundled migration notes now cover 0.7.5** — `akm help migrate 0.7.5` and `akm help migrate latest` now surface the full 0.7.5 operator summary alongside the changelog section.

## [0.7.4] - 2026-05-06

## [0.7.3] - 2026-05-05

### Added

- **`akm index --enrich` opt-in for LLM passes** — index-time enrichment work such as metadata enhancement, memory inference, and graph extraction now runs only when explicitly requested with `--enrich`. Default indexing is faster and no longer surprises operators with LLM-backed work during normal maintenance runs.
- **Config backup snapshots before writes** — config writes now create AKM cache backups so setup/config flows have a recovery path if a config is overwritten or corrupted during development or testing.

### Changed

- **Setup wizard UX refresh** — `akm setup` now better reflects the real configured state: source prompts are ordered more sensibly, configured and preserved stash information is surfaced, agent defaults can be selected explicitly (including disabled), and post-setup indexing does not implicitly enable enrichment.
- **CI workflows updated for current GitHub Actions runtimes** — CI, release, and publishing workflows now use current action majors (`checkout@v5`, `cache@v5`, `setup-node@v5`, `upload-artifact@v5`, `download-artifact@v6`) to stay off deprecated Node 20 action runtimes.
- **Technical investigation notes updated** — the index investigation note now reflects the latest `.stash.json` migration status, current green CI runs, and the narrowed remaining compatibility surface ahead of `v0.8.0`.

### Fixed

- **Embedding-dimension drift on read-only DB opens** — read/telemetry paths no longer mutate the live index schema with the default embedding dimension. `akm info`, search/show parity paths, and related readers now preserve the configured embedding shape instead of downgrading vector tables.
- **Incremental index churn across multiple source layouts** — incremental indexing is now significantly more stable for filename-less legacy metadata, wiki-root sources, repo-root git stash layouts, non-indexed companion files, and cross-source dedupe cases.
- **Git source indexing for repo-root stashes** — git-backed sources no longer assume a `<repo>/content` subtree; repo-root stash layouts are indexed correctly and cached mirrors are treated as fresh instead of being needlessly refreshed.
- **`show` metadata no longer depends on `.stash.json`** — command and skill summary/show metadata now comes from file-local frontmatter and renderer parsing rather than the deprecated disk fallback sidecar.
- **`.stash.json` no longer drives incremental stale detection** — editing `.stash.json` alone no longer forces directories to rescan during incremental indexing.

### Internal

- **Ranking and scoring fixtures migrated toward file-local metadata** — routine benchmark and regression fixtures now prefer markdown frontmatter or inline script metadata, with `.stash.json` retained only for intentional legacy-compatibility coverage that still exercises explicit-file override behavior.
- **Production-path ranking regression coverage** — ranking regression tests now build their fixture index through the production indexer rather than a custom `.stash.json` crawler, reducing fixture drift and improving confidence in the real indexing/search path.

### Added

- **One-shot URL ingest for `akm import` and `akm wiki stash`** — both commands now accept a single HTTP/HTTPS URL in addition to file paths and stdin. `akm import <url>` fetches the exact page, converts it to markdown, and writes it into `knowledge/` using a URL-path-derived default name. `akm wiki stash <wiki> <url>` fetches the exact page, converts it to markdown, and writes it into `wikis/<wiki>/raw/`. Neither command registers a persistent website source or crawls linked pages.

### Changed

- **Shared website ingest boundary** — website URL validation, single-page fetch/convert, and website mirror generation now live in a dedicated shared ingest module. The website source provider is a thin adapter, and `akm add`, `akm import`, and `akm wiki stash` all reuse the same core website-ingest path.
- **`.stash.json` docs deprecation timeline** — the docs now explicitly state that `.stash.json` is deprecated, remains only as a 0.7.x compatibility bridge, and will be removed in v0.8.0 to match the current aggressive pre-release phase-out posture.

## [0.7.0]

### Added

- **Proposal queue (`akm proposal *`)** (#225, #226, #233) — durable queue for proposal-producing commands. New verbs `akm proposal {list, show, diff, accept, reject, revert}`. Promotion runs full validation before routing through `writeAssetToSource()`. Multiple proposals for the same `ref` coexist without filesystem collisions. Auto-accept is gated per-source via `autoAcceptProposals: true` (default off; requires a writable source). See v1 spec §11.
- **`akm reflect`, `akm propose`, `akm distill`** (#225, #226, #227) — three new commands that write **only** to the proposal queue. `reflect` and `propose` shell out via the agent CLI (`agent.*` config); `distill` is the canonical bounded in-tree LLM call gated behind `llm.features.feedback_distillation`. Usage events `reflect_invoked`, `propose_invoked`, `distill_invoked`.
- **`lesson` asset type** (#227) — first-class well-known type with required frontmatter `description` and `when_to_use`, stored under `lessons/<name>.md`. Normally produced by `akm distill <ref>` as a `proposed`-quality proposal and promoted via `akm proposal accept`.
- **`llm.features.*` map with mixed defaults** (#227, #284) — every bounded in-tree LLM call site is gated behind exactly one feature flag. Four keys ship: `curate_rerank`, `feedback_distillation`, `memory_inference`, `graph_extraction`. `memory_inference` and `graph_extraction` default to `true`; the others default to `false`. Wrapper `tryLlmFeature(feature, config, fn, fallback)` in `src/llm/feature-gate.ts` guarantees disabled/throw/timeout fall back without crashing the call site. See v1 spec §14.
- **`quality: "proposed"` and `--include-proposed`** — `SearchHit.quality` open string set; `proposed` is excluded from default search and surfaces only via `akm search ... --include-proposed` or `akm proposal *`. Unknown values parse-warn-include. `SearchHit` gains optional `quality?` and `warnings?` fields.
- **`akm-bench` v1** (#234, PRs #266, #268, #269) — paired-utility benchmark framework. Track A runs each task with and without akm available and emits a comparable score pair; `akm-bench compare` aggregates paired runs into a delta report; `akm-bench attribute` maps utility deltas back to specific `[origin//]type:name` refs (Track B); `akm-bench evolve` is a stub for the closed-loop workflow that lands in 0.8.
- **Operator env-var documentation** (#284 Wave B, PR #285) — `docs/configuration.md` now documents `AKM_NPM_REGISTRY`, `AKM_REGISTRY_URL`, `AKM_CACHE_DIR`, `HF_HOME`, and `GH_TOKEN`.
- **Empty-state hints** (#284 Wave C, PR #286) — `akm proposal list`, `akm workflow list`, and `akm vault list` empty-state messages now include "how to create the first one" guidance.
- **Canned error hints** (#284 Wave C, PR #286) — four new typed error hints added: `INVALID_FLAG_VALUE`, `ASSET_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `FILE_NOT_FOUND`.
- **`--verbose` global flag in `--help`** (#284 Wave C, PR #286) — the flag was honoured at runtime but invisible in help output; now declared.
- **~90 new tests** (#284 Wave D, PR #285) — direct coverage for the proposal/reflect/propose/distill CLI integration paths, output-shape contracts, workflow-runs state machine, and lesson-init scaffolding.

### Security

- **Git message sanitization** (#270) — commit messages and remote URLs written by akm are sanitized to prevent shell-substitution and control-character injection through user-supplied content.
- **Bench env isolation** (#271) — `akm-bench` runs each agent invocation in a scrubbed environment so host secrets do not leak into bench transcripts or paired-run logs.
- **LLM body redact + npm tarball host validation** (#272) — outbound LLM request/response bodies are redacted in error reporting before surfacing to stderr or warnings; `akm add npm:…` validates the tarball download host against the configured npm registry rather than following arbitrary `dist.tarball` URLs.

### Changed

- **Workflow noise gate, sources deprecation warn, setup `--help`** (#273) — `akm workflow next/complete/status` no longer print spurious progress noise on quiet runs; the legacy `stashes[]` key emits a single deprecation warning per process (was: per call site); `akm setup --help` renders the same help block as `akm setup` with no args plus the agent-detection summary.
- **tsconfig + HF pin + shapes throw** (#274) — `tsconfig.json` now includes `tests/` so `bunx tsc --noEmit` covers test files; the HF embeddings model is pinned to a specific revision to avoid silent upstream changes; the output-shape registry throws on a missing shape rather than silently `JSON.stringify`-ing.
- **Bench tmp redirect** (#276) — `akm-bench` no longer writes scratch state under `/tmp`; everything lands under the AKM cache dir (`~/.cache/akm/bench/`) so cleanup is bounded and CI sandboxes that ban `/tmp` writes work out of the box.
- **Registry-build tmp redirect** (#284 Wave E, PR #285) — `inspectArchive` now mkdtemps under `${getCacheDir()}/registry-build/` instead of `os.tmpdir()`. Mirrors the bench-only redirect from #276 for non-bench code. `vault load` retains its `/tmp` mode-0600 sentinel by design.

### Fixed

- **Agent spawn timeout** (#284 Wave A, PR #285, BUG-H1) — stdin write could hang past `agent.timeoutMs`; the write now races against `proc.exited` so the timeout is always honoured.
- **Captured-stdio leak on spawn failure** (#284 Wave A, PR #285, BUG-H2) — stream readers no longer leak as floating promises on the spawn-failed path.
- **`defaultWriteTarget` writability check** (#284 Wave A, PR #285, BUG-H3) — resolving `defaultWriteTarget` was missing the writability gate that the `--target` path enforces; now mirrored.
- **Schema-upgrade row loss** (#284 Wave A, PR #285, BUG-H4) — `restoreUsageEventsBackup` silently dropped rows when the new schema added a NOT-NULL column without DEFAULT; now projects rows onto the column intersection and warns loudly.
- **Bench cleanup registry running flag** (#284 Wave A, PR #285, BUG-H5) — `runAllAndExit` now resets `registry.running` in a `try/finally` so a synchronous throw cannot deadlock subsequent SIGINT handlers.
- **`akm search` with no query** (#284 Wave C, PR #286) — error hint now references `--type`/`--limit` instead of show-style ref grammar.
- **`akm workflow next <bogus-id>`** (#284 Wave C, PR #286) — surfaces `WORKFLOW_NOT_FOUND` with `Run \`akm workflow list --active\`` instead of a cryptic ref-parse error.
- **`akm add /missing/path`** (#284 Wave C, PR #286) — throws typed `NotFoundError("FILE_NOT_FOUND")` with hint instead of a bare `Error`.
- **`akm update <bogus>`** (#284 Wave C, PR #286) — now uses `SOURCE_NOT_FOUND` (with the existing hint pointing at `akm list`) instead of the default `ASSET_NOT_FOUND`.
- **Setup wizard source count + embedding-dim prompt** (#284 Wave C, PR #286) — the wizard now reads `newConfig.sources ?? newConfig.stashes` to count configured sources (was reading the dropped legacy key); the embedding-dimension prompt now explains what the value is for.
- **`formatPlain` null fallback** (#284 Wave C, PR #286) — text renderers now exist for every command that calls `output()`; no more silent JSON when an operator passes `--format text`.
- **Arity guards** (#284 Wave C, PR #286) — `propose`, `feedback`, `curate`, and `help migrate` no longer exit 0 with citty's help screen when required positionals are missing; they now exit 2 with `MISSING_REQUIRED_ARGUMENT`.

### Removed

- **Legacy registry `curated` boolean** — legacy v2 index JSON parses and silently ignores it; renderers no longer surface a `curated` column. The per-asset `quality` field replaces it. Publishers do not need to migrate existing JSON.
- **Phantom config keys** (#284 Wave B, PR #285): `llm.features.{tag_dedup, memory_consolidation, embedding_fallback_score}`, `llm.capabilities.{longContext, toolUse}`, and `llm.contextWindow`. These were parsed and persisted by the loader but never read at any call site, and the docs that described their behaviour were misleading. Operators with these keys in `config.json` will see them silently ignored — `akm config get llm.features.tag_dedup` (etc.) will return undefined.
- **`disableGlobalStashes`** (#284 Wave B, PR #285) — legacy config key removed; the one-cycle deprecation window from the v1 spec has expired.
- **`stashes[]` config-key migration shim** (#284 Wave B, PR #285) — the `stashes[]` → `sources[]` migration was advertised for one release cycle in 0.6.x; that cycle has now expired. 0.5.x configs that have not been touched since will produce a `ConfigError` on parse instead of auto-migrating. Run `akm setup` (or rename the key by hand) to migrate.
- **`searchPaths` legacy migration** (#284 Wave B, PR #285) — pre-0.5.x config key; deprecation window long expired.
- **`context-hub` source-kind migration paths** (#284 Wave B, PR #285) — `STASH_TYPE_ALIASES`, the `parseSourceSpec` `case "context-hub"` arm, the `context-hub-${key}` git rename migration, and the `normalizeToggleTarget("context-hub")` arm are all gone. Per CLAUDE.md, `context-hub` is just a git repo and was never a first-class kind.
- **Legacy lockfile migration** (#284 Wave B, PR #285) — `migrateLegacyLockfileIfNeeded` (the `stash.lock` → `akm.lock` rename) is removed; the rename ran for at least two release cycles.

### Internal

- 9 `console.warn` sites migrated to `warn()` from `src/core/warn.ts` for uniform `--quiet` honoring (#284 Waves A/B, PR #285).
- 6 unused exports removed: `StashLockEntry`, `listProviderTypes`, `resetBuiltinsCache`, and two `GraphRelation` re-exports (#284 Wave A, PR #285).
- ~472 LoC net deletion from `src/core/config.ts` from removing the legacy migration paths above (#284 Wave B, PR #285).
- `--for-agent` deprecation note retained in `docs/technical/akm-core-principles.md` and `docs/technical/search-updated.md` for at least one more cycle.
- Workflow-runs state machine, lesson-init scaffolding, and the proposal/reflect/propose/distill CLI now have direct test coverage (#284 Wave D, PR #285).

### Migration

- See [`docs/migration/release-notes/0.7.0.md`](docs/migration/release-notes/0.7.0.md) for the operator summary and the [archived pre-1.0 plan](https://github.com/itlackey/akm/blob/be3a6a632b0cbe7a63ce71b7d093d8ac266e857c/docs/archive/pre-1.0-migration.md) for the historical per-surface delta from any 0.6.x baseline.

## [0.6.0] - 2026-04-23

### Added

- **`akm workflow validate <ref|path>`** — new subcommand that validates a workflow markdown file or ref, surfacing every error in one pass (without running a full reindex).
- **`akm feedback` now accepts any indexed ref** — previously type-restricted. `memory:`, `vault:`, `workflow:`, `wiki:` refs all work. Vault feedback never echoes vault values.
- **`akm upgrade` runs post-upgrade tasks automatically.** After a successful upgrade, the new binary is invoked as a child process running `akm index`, which auto-migrates any legacy `stashes` → `sources` config keys via `loadConfig` and rebuilds the index against the new schema (`DB_VERSION` 8 → 9 forces a rebuild). Pass `--skip-post-upgrade` to opt out (config migration still runs on the next `akm` invocation; you'd just need to run `akm index` yourself). Result is reported in the `postUpgrade` field of the upgrade response.
- **`writable` flag on sources.** New optional `SourceConfigEntry.writable` controls whether write commands (`akm remember`, `akm import`, `akm save`, `akm clone`) may target the source. Defaults: `true` for `filesystem`, `false` for `git` / `website` / `npm`. `writable: true` on `website` or `npm` is rejected at config load with `ConfigError("writable: true is only supported on filesystem and git sources")`.
- **`defaultWriteTarget` root config key.** Names the source that receives writes when no `--target` flag is given. Resolution order: `--target` → `defaultWriteTarget` → `stashDir` (working stash) → `ConfigError("no writable source configured; run \`akm init\`")`. There is no implicit "first writable in `sources[]` order" fallback.

### Changed

- **Workflows are now stored as validated `WorkflowDocument` JSON** — workflows are compiled into a validated `WorkflowDocument` JSON shape with line-anchored `SourceRef`s back into the source markdown, cached in a new `workflow_documents` table in `index.db`. The run engine reads from the cache on `akm workflow next` instead of re-parsing markdown each step.
- **Feedback events flow into utility recomputation** — positive/negative feedback signals now feed utility scoring alongside search/show events. Telemetry records both `entry_ref` and `entry_id` so feedback signals survive a reindex.

### Changed (breaking)

- **v1 architecture refactor.** The internal architecture was rebuilt around a single minimal `SourceProvider` interface (`{ name, kind, init, path, sync? }`), a unified FTS5 index that owns search and show, and a single `writeAssetToSource` helper that owns all writes. The CLI command surface and all user-visible config keys are unchanged. See `docs/archive/pre-1.0-migration.md` for the historical guide.
- **Config key `stashes[]` renamed to `sources[]`.** Configs with the legacy key load with one deprecation warning and are auto-migrated in memory; the new key is persisted on the next `akm config` write. New configs should use `sources[]`. Configs that contain both keys are rejected with `ConfigError`.
- **Error hints surface without `--verbose`.** Error classes own their `hint()` text; the regex-on-message hint chain in `cli.ts` is removed. Hints print to stderr inline alongside the error message.
- **Registry providers loop through a uniform interface.** Context Hub is no longer a special-cased provider type. Add it as a regular git source (`akm add github:andrewyng/context-hub`) or include it as a kit in your registry index. Legacy `type: "context-hub"` entries normalize to `type: "git"` at load time.
- **Terminology cleanup — clean break from "kit" → "stash"** (#148). Pre-v1, no fallback period.
  - **Wire format**: `RegistryIndex.kits[]` renamed to `RegistryIndex.stashes[]`. Schema version bumped to **v3** — `akm-cli >= 0.6.0` only parses indexes with `version: 3`. v1/v2 indexes are no longer accepted. Every static-index registry must regenerate its `index.json` with `version: 3` to be readable. The official `akm-registry` ships a regenerated index alongside this release.
  - **Discovery**: npm packages and GitHub repos are now discovered via the `akm-stash` keyword/topic only. Legacy `akm-kit` and `agentikit` keywords/topics are no longer honored. Publishers must retag.
  - **Schemas**: `schemas/registry-index.json` and `docs/technical/registry-index.schema.json` updated (`RegistryKit` → `RegistryStash`, `kits` → `stashes`).
  - **Internal types**: `RegistryKitEntry` → `RegistryStashEntry`, `InstalledKitEntry` → `InstalledStashEntry`, `KitInstallStatus` → `StashInstallStatus`, `KitSource` → `StashSource`. Files `src/kit-include.ts` → `src/stash-include.ts` and `src/installed-kits.ts` → `src/installed-stashes.ts`.
  - **Asset hit field**: `RegistryAssetSearchHit.kit` → `RegistryAssetSearchHit.stash`.
  - **Docs**: `docs/kit-makers.md` → `docs/stash-makers.md`. All user-facing "kit" references in docs and the README replaced with "stash".
  - **Preserved**: the *Agent Kit Manager* tagline, the `akm-cli` npm package name, and the `akm.include` package.json field.
  - **Migration**: a curated registry author should regenerate their `index.json` (rename `kits` → `stashes`, drop legacy keyword filtering). Publishers should add the `akm-stash` keyword/topic and remove `akm-kit`/`agentikit`.
- **`akm registry` description**: changed from "Manage kit registries" to "Manage stash registries".

### Migration / Breaking

- **`DB_VERSION` bumped 8 → 9.** On first run after upgrade, the version-mismatch path in `ensureSchema()` drops + recreates all `index.db` tables (preserving `usage_events` via a typed backup); the next `akm index` rebuilds the index. `workflow.db` (run state) is unaffected.

### Removed (breaking)

- **OpenViking source provider.** The `openviking` source kind is no longer supported. Configs that contain one fail to load with `ConfigError("openviking is not supported in akm v1. …")` and a hint pointing to `akm config sources remove <name>`. API-backed sources will return as a separate `QuerySource` tier post-v1. To downgrade in the meantime, pin to `akm-cli@0.5`.
- **`akm enable context-hub` / `akm disable context-hub` toggles.** Add Context Hub as a regular git source (`akm add github:andrewyng/context-hub`) or list it as a kit entry in your registry; remove or disable it via `akm config sources remove context-hub` or by editing the entry's `enabled` flag.
- **Legacy re-export shims** `src/llm.ts`, `src/registry-provider.ts`, and `src/ripgrep.ts`. akm has no public API (CLI-only package, no barrel exports), so external consumers should be unaffected.

### Internal

- **`src/` reorganized into purpose-named subdirectories** (`commands/`, `core/`, `indexer/`, `output/`, `registry/`, `setup/`, `sources/`, `wiki/`, `workflows/`). No public API surface change.
- **Single `writeAssetToSource` helper** under `src/core/write-source.ts` is the only place that branches on `source.kind` to add behaviour. All write call sites (`remember`, `import`, `clone`, `save`) route through it.
- **`SourceProvider` interface simplified** to `{ name, kind, init, path, sync? }`. The previous `LiveStashProvider` / `SyncableStashProvider` split is gone.

## [0.5.0] - 2026-04-22

### Added

- **Multi-wiki support** (#119, #121, #136, #139, #144): new `wiki` asset type with ten CLI verbs under `akm wiki …` (`create`, `register`, `list`, `show`, `remove`, `pages`, `search`, `stash`, `lint`, `ingest`). Each wiki lives at `<stashDir>/wikis/<name>/` with `schema.md`, `index.md`, `log.md`, `raw/`, and agent-authored pages. Wiki pages are first-class in stash-wide `akm search`. `akm index` regenerates each wiki's `index.md` as a side effect and is resilient to malformed workflow assets. Raw sources under `raw/` and the `schema.md` / `index.md` / `log.md` infrastructure files are intentionally excluded from the search index. See `docs/wikis.md` for the full guide. Design principle: **akm surfaces, the agent writes** — no LLM calls, no network access; akm owns only operations with invariants an agent can't reliably enforce (lifecycle, raw-slug uniqueness, structural lint, index regeneration, workflow discovery).
- **External wiki registration** (#139, #144): `akm wiki register <name> <path-or-repo>` and `akm add --type wiki --name <name> <source>` register an existing directory or git/website repo as a first-class wiki without copying or mutating it; source and wiki search state are refreshed immediately and refs/state are normalized on subsequent indexing.
- **Workflow asset type** (#118): new `workflow` type with `akm workflow` subcommands `template`, `create`, `start`, `next`, `complete`, `status`, `list`, and `resume` for authoring and stepping through multi-step workflows stored in the stash. Runs snapshot their step list at start so edits to the source workflow do not affect an in-flight run.
- **Vault asset type** (#117): new `vault` type backed by `.env` files; `akm vault` subcommand with `list`, `show`, `create`, `set`, `unset`, and `load` (emits a `source` snippet for the current shell via a mode-0600 temp file); values never appear in structured output.
- **`--trust` flag for installs**: `akm add <source> --trust` performs a one-off trusted install, bypassing the install audit for that source. Blocked install errors now include a `hint` pointing to `--trust` as a remediation option.
- **Writable git stash + `akm save`** (#114): `akm add … --writable` opts a remote git-backed stash into push-on-save; `akm save [name] [-m message]` commits (and pushes when writable + remote is set); default stash is auto-initialized as a git repo; git stash provider now uses `git clone` instead of HTTP tarball download.
- **`akm help migrate <version>`** (#132): prints the release notes and migration guidance for a given version (accepts `0.5.0`, `v0.5.0`, or `latest`). Pulls the matching section from `CHANGELOG.md` when available and supplements it with embedded migration notes for major releases.
- **Broader `akm upgrade` coverage** (#132, #134): self-update now detects and upgrades npm, bun, pnpm, and standalone-binary installs (previously binary-only). Runtime assets covered by the upgrade flow were also expanded so newly shipped asset types stay current.

### Fixed

- **0.5.0 QA follow-ups** (#130): fixes across the new wiki, workflow, vault, and save/trust surfaces surfaced during release-candidate QA.

### Removed (breaking)

- The unreleased single-wiki LLM POC: removes `akm lint` command, `akm import --llm` / `--dry-run` flags, `knowledge.pageKinds` config, and the `ingestKnowledgeSource` / `lintKnowledge` LLM prompts. Users of the POC should migrate to the new `akm wiki …` surface; raw content can be manually moved to `wikis/<name>/raw/`.

### Documentation

- **Technical docs refresh** (#138): stash and search architecture docs updated to match the current implementation.
- **Wiki configuration guide** (#115): new docs page covering wiki configuration and ingest flow.

## [0.4.1] - 2026-04-21

### Added

- **`akm enable` / `akm disable`** (#108): toggle optional components (`skills.sh`, `context-hub`) on/off without manually editing config
- **`akm remember` and `akm import` commands** (#110): capture in-session knowledge directly from the CLI; `akm remember` records a memory to the default stash (supports stdin); `akm import` ingests a file or stdin as a knowledge asset
- **Karpathy-style wiki workflow in knowledge assets** (#113): `akm show knowledge:<doc>` now surfaces an `ingest` workflow for knowledge documents; `--dry-run` flag added; `pageKind` taxonomy made extensible
- Documentation: expanded `agent-install.md`, added `info` and `feedback` command docs, global flags reference (#106)

### Fixed

- Remote embedding endpoint URL normalization — trailing slashes and path segments now handled correctly (#112)
- Reduced fallback capture-name collisions in `akm remember`

## [0.4.0] - 2026-04-19

### Added

- **Install security audit**: new pre-install scanner inspects kit contents for dangerous patterns and executable scripts before install; configurable via `config` CLI
- **Project-level config stash merging**: `.akm.json` in a project directory merges its stash/registry entries with user config during CLI runs
- **Disable inherited project stashes**: project config can disable stashes inherited from parent/user scopes
- **`akm curate` command**: new subcommand for curating assets from the stash (initial skeleton)

### Fixed

- Index nested agent markdown files as agents so `akm search agent:...` finds them
- `install-audit` now reads at most `MAX_SCANNED_FILE_BYTES` per file using `Buffer.alloc`, with the file descriptor always closed via `try/finally`, and corrects the `scannedBytes` counter

## [0.3.1] - 2026-04-01

### Added

- **Website stash provider**: add a URL directly as a stash source with `akm stash add <url>`; crawls the site and indexes pages as knowledge assets
- Website provider options: `--max-pages` and `--depth` flags to bound crawling

### Fixed

- Relaxed HTTP warnings for localhost website sources
- Addressed review feedback around website provider routing and security heuristics

## [0.3.0] - 2026-03-30

### Added

- Regression tests for vector/semantic search readiness, install, and setup flows
- `CONTRIBUTING.md` and "Why akm" section in documentation
- Three draft SEO blog posts

### Changed

- **Unified source model**: replaced the `kit` vs `stash` split with a single source concept; `akm add` works for all source types
- Removed `stash` and `kit` subcommand groups; their behaviors fold into the top-level CLI (`akm list`, `akm add`, etc.)
- Refactored semantic search readiness tracking for clearer state transitions
- Aligned documentation voice and updated older posts for the current CLI surface

### Fixed

- Embedding fingerprint is purged on model change and `usage_events` are re-linked correctly
- Local embedder dtype selection
- Release validation workflow
- Prereleases (versions with suffixes) are marked as such on GitHub releases and published to npm with `--tag next`

## [0.2.2] - 2026-03-28

### Fixed

- Binary install detection in `akm upgrade` self-update; centralized `AKM_VERSION` declaration with binary detection tests

## [0.2.1] - 2026-03-25

### Added

- Docker-based install tests covering multiple OS configurations (skipped in CI)
- Detailed error reporting in embedding availability checks
- Actionable guidance when `sqlite-vec` fails to open the DB

### Changed

- **Rename**: project renamed from `Agent-i-Kit` to `akm` across docs and links
- Local embeddings switched to `@huggingface/transformers`
- `@huggingface/transformers` moved to `optionalDependencies`, then promoted to a runtime dependency
- Improved semantic search setup and index UX

## [0.2.0] - 2026-03-18

### Added

- **Extensible asset type system**: `AkmAssetType` (formerly `AgentIKitAssetType`) is now `string` instead of a fixed union; new types can be registered at runtime via `registerAssetType()`
- **Memory asset type**: built-in `memory` type stored in `memories/`, with `memory-md` renderer and directory/parent-dir-hint matchers
- **OpenViking stash provider**: `openviking` provider type for searching OpenViking servers via REST; add with `akm stash add <url> --provider openviking`
- **Remote show for `viking://` URIs**: `akm show viking://resources/my-doc` fetches content directly from an OpenViking server (returns `editable: false`)
- **`--options` flag** for `akm registry add` and `akm stash add`: pass provider-specific JSON config (e.g., `--options '{"apiKey":"key"}'`)
- **`akm registry build-index` command**: generates a v2 registry index JSON from npm/GitHub discovery with `--out`, `--manual`, `--npmRegistry`, `--githubApi`, and `--format` flags
- Exact-name match, type-relevance, and alias boosts in the search scoring pipeline
- Ranking regression tests with a synthetic fixture stash and a 41-case benchmark suite (MRR / Recall@5)
- `estimatedTokens` on context-hub provider search results and in `--for-agent` output
- Architecture docs and test fixture for OpenViking manual testing (`tests/fixtures/openviking/`)

### Changed

- Unified context-hub indexing and fair provider scoring: local FTS scores are preserved everywhere and remote provider scores compete on equal footing
- Replaced RRF with normalized BM25 scoring across all merge paths
- EMA utility decay is now time-proportional instead of tied to index frequency
- Replaced the `(Bun as any).YAML` hack with a proper `yaml` package dependency
- YAML output format fixed; local registry refs now use a `file:` prefix

### Removed

- `manifest` subcommand (adds no value over `search`)
- URI schemes (`viking://`, `context-hub://`) from user-facing refs — assets are addressed as `type:name`; sources use URLs
- Stale audit/ergonomics markdown from the repo

### Fixed

- `skills.sh` install refs now produce valid `akm add` commands (#82)
- Prevented `akm remove` and `akm update --force` from deleting user-owned local source directories installed via path refs
- `usage_events` reverted to `DELETE` on full reindex

## [0.1.0] - 2026-03-10

Major internal overhaul and rebrand. This release simplifies the asset model,
cleans up the CLI surface, and renames the package from `agent-i-kit` to `akm-cli`.

### Added

- `--verbose` flag on `search` for detailed scoring output
- ExecHints system (`run`, `cwd`, `setup`) for script assets, replacing the old tool-runner
- New environment variable overrides: `AKM_CONFIG_DIR`, `AKM_CACHE_DIR`, `AKM_STASH_DIR`
- CI workflow running lint, type-check, and tests on every push/PR
- Biome linter and formatter configuration
- README badges (npm version, CI status, license)

### Changed

- **Rebrand**: npm package `agent-i-kit` renamed to `akm-cli`; binary remains `akm`
- **Rebrand**: config field `"agent-i-kit"` renamed to `"akm"` in `package.json`
- **Rebrand**: plugin `agent-i-kit-opencode` renamed to `akm-opencode`
- **Rebrand**: registry `agent-i-kit-registry` renamed to `akm-registry`
- **Rebrand**: default paths changed (`~/agent-i-kit` to `~/akm`, `~/.config/agent-i-kit` to `~/.config/akm`)
- **Rebrand**: environment variables `AGENT_I_KIT_*` renamed to `AKM_*`
- Removed `tool` asset type entirely; `script` is the only script-like type
- `.stash.json` field renames: `intents` to `searchHints`, `entry` to `filename`; removed `generated` boolean
- `show` command: `--view` flag replaced with positional syntax (`akm show <ref> toc`)
- Collapsed `AssetTypeHandler` handlers into a unified renderer pipeline
- Dropped provider presets (raw JSON config only)
- Pinned `sqlite-vec` to exact version `0.1.7-alpha.2` (removed caret range)
- Replaced `(Bun as any).YAML` cast with proper type guard in CLI
- Version now injected at compile time via `--define AKM_VERSION` with safe runtime fallback

### Removed

- `submit` command
- Provider presets (configure providers with raw JSON)
- `generated` boolean from `.stash.json`

### Fixed

- CLI crash on macOS when running as compiled binary (`package.json` not embedded)
- Cleaned up search output formatting

## [0.0.17] - 2026-03-12

Registry refactor and documentation overhaul. This release introduces a
first-class registry management CLI, modernizes the config schema, and
rewrites all documentation against the final asset model.

### Added

- `akm registry` subcommand group with `list`, `add`, `remove`, and `search` subcommands
- `akm registry search --assets` flag for asset-level search against v2 registry indexes
- `registries` config field (`RegistryConfigEntry[]`) with `url`, `name`, and `enabled` properties
- Registry Index v2 schema with optional `assets` array on kit entries for asset-level discovery
- Official registry pre-configured by default in new installations
- Type names: `KitSource`, `InstalledKitEntry`, `KitInstallResult`, `KitInstallStatus`, `InstalledKitListEntry`

### Changed

- Config: `installed` is now a top-level field (`config.installed`) instead of nested under `config.registry.installed`
- Config: registry URLs configured via `registries` array instead of `registryUrls`
- Documentation: complete rewrite of concepts, registry, CLI reference, README, and all technical docs
- Documentation: added "Mental Model" (registries --> kits --> stash --> assets) to concepts
- Documentation: added asset classification taxonomy description
- Documentation: merged ref format documentation into concepts (removed "opaque handle" framing)
- Documentation: revised apt analogy in core principles to map registries, kits, stash, and assets
- Documentation: added `akm registry` subcommand group to CLI reference
- Documentation: added registry hosting and v2 index format guides

### Removed

- `tool` asset type (fully removed across all documentation and code)
- `registryUrls` config field (replaced by `registries`)
- `config.registry.installed` nesting (replaced by `config.installed`)
- All `tools/` directory references from documentation

## [0.0.13] - 2026-03-09

Initial public release of Agent-i-Kit (`akm` CLI).

### Added

- CLI tool (`akm`) for searching, showing, and running Agent-i-Kit stash assets
- Hybrid search with FTS5 full-text and optional vector similarity scoring
- Registry support for discovering, installing, and updating community kits
- Multiple install sources: npm, GitHub, git URLs, and local directories
- Self-update via `akm upgrade`
- Multiple output formats: plain text, YAML, and JSON (`--json`)
- Knowledge asset navigation with TOC, section, and line-range views
- `akm clone` to fork installed assets into your working stash
- Configuration system with embedding and LLM provider management
- Standalone binary distribution (no runtime dependencies)
