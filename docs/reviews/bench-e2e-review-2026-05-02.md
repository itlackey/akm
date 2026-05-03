# AKM Bench E2E Review — 2026-05-02

## Executive Summary

The akm-bench harness is architecturally sound and has reached the point where an end-to-end utility run completes without crashing (confirmed by two real runs on 2026-05-02). However, the measurement is substantially weaker than the framework's own spec claims: `akm search` and `akm show` do not write events to `events.jsonl`, so the two most important workflow compliance checks (`akm_search`, `akm_show`) depend entirely on fragile stdout scraping. The task corpus is heavily skewed toward `procedural_lookup` with zero coverage of `multi_asset_composition`, `temporal_update`, `conflict_resolution`, and `noisy_retrieval` in the real eval slice; three of the five eval domains (drillbit, inkwell) have no train tasks at all, making Track B (evolve) structurally impossible to run on those domains. The `noakm` arm is now opt-in, which removes the control condition for measuring utility — the primary claim the framework is supposed to support. Highest priority: land structured events from `akm search` and `akm show` into `events.jsonl`; second priority: add train tasks to drillbit and inkwell or document that those domains are eval-only.

---

## What's Working

- **Harness runs end-to-end.** Both the opencode/big-pickle and shredder/qwen3.6-27b runs exited 0 with valid JSON and a full 40-run bag. The eight silent failures found on 2026-05-02 (wrong OPENCODE_CONFIG path, missing model key, missing `run` subcommand, blocked node_modules symlink, open stdin pipe, SIGTERM/SIGKILL gap, readStream deadlock, unknown cloud prefix) are all fixed and captured in `doctor.ts`.

- **Doctor subcommand covers the previous failure modes.** `bun run tests/bench/cli.ts doctor` runs a live `opencode run` invocation with the same environment the harness uses, catching misconfiguration in 30 seconds rather than mid-run.

- **Per-run isolation is correct.** `setupBenchEnvironment` pins `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and `AKM_STASH_DIR` to per-run tmpdirs. The operator's real config is never read or written. `OPENCODE_API_KEY` and `AKM_CONFIG_DIR` are scrubbed from the env source via `buildSanitizedEnvSource` before profile-level passthrough can forward them. Tests in `tests/bench/driver.test.ts` and `tests/bench/environment.test.ts` assert these invariants.

- **Bench tmp root is under `${AKM_CACHE_DIR}/bench/`**, not `/tmp`. A single `rm -rf ~/.cache/akm/bench` cleans all artifacts. The orphan-GC sweep in `cleanup.ts` reaps entries older than 6 hours from prior crashed runs.

- **Corpus identity stamps are in place.** Both `taskCorpusHash` and `fixtureContentHash` are written into every report (issue #250). `bench compare` refuses mismatched corpora by default; `--allow-corpus-mismatch` and `--allow-fixture-mismatch` downgrade to warnings. This is implemented and correct.

- **Partial checkpointing works.** `runner.ts` writes a checkpoint every 5 completed runs under `${AKM_CACHE_DIR}/bench/`. A crashed 40-run session will leave a partial file recoverable without rerunning from scratch.

- **All eight fixture stashes have MANIFEST.json.** `validateFixtureCorpus` checks this at startup and emits named warnings before any work items start rather than producing silent `harness_error` runs. Stashes: `az-cli`, `docker-homelab`, `drillbit`, `inkwell`, `minimal`, `multi-domain`, `noisy`, `ranking-baseline`.

- **Workflow evaluator is fully implemented.** `workflow-evaluator.ts` implements all spec constraints: `required_sequence` (presence, ordering, `before`/`after`, `min_count`, `polarity`, `ref_must_equal`), `forbidden` rules, feedback-polarity verification against verifier outcome, and gold-ref loading checks. The 32-violation cap prevents OOM on pathological traces.

- **Workflow specs are loaded and applied per-run.** `runner.ts` loads the six YAML specs once per `runUtility` call and evaluates every akm-arm run via `evaluateRunAgainstAllSpecs`. Results accumulate in `workflowChecks[]` and are emitted in the report's `workflow` block.

- **Evolve Phase 1 / Phase 2 / Phase 3 are all implemented** in `evolve.ts`. Leakage prevention via `--exclude-feedback-from <csv>` is wired into Phase 2 distill invocations. The feedback integrity confusion matrix is computed by `computeFeedbackIntegrity`.

- **Token measurement status disambiguates real zeros.** `RunResult.tokenMeasurement` (`"parsed"` | `"missing"` | `"unsupported"`) prevents a missing token count from being treated as a cost-free run (issue #252). The markdown summary annotates coverage < 0.95 as unreliable.

- **Failure-mode taxonomy is implemented.** `classifyFailureMode` in `metrics.ts` tags every failed akm-arm run with one of the §6.6 labels. The corpus-wide breakdown surfaces in the report's `failure_modes` block.

- **Attribution (leave-one-out) is implemented.** `bench attribute --base <path> --top N` re-runs the corpus N times with each top-loaded asset masked, computing `marginal_contribution`. The masking strategy and `maskedRefs` are surfaced in the JSON envelope so operators can verify what was masked.

- **Test coverage is broad.** Every major bench module has a test file: `attribution.test.ts`, `compare.test.ts`, `corpus.test.ts`, `driver.test.ts`, `environment.test.ts`, `evolve-metrics.test.ts`, `evolve.test.ts`, `failure-modes.test.ts`, `feedback-integrity.test.ts`, `leakage.test.ts`, `metrics.test.ts`, `report.test.ts`, `runner.test.ts`, `trajectory.test.ts`, `verifier.test.ts`, `workflow-evaluator.test.ts`, `workflow-spec.test.ts`, `workflow-trace.test.ts`.

---

## Gaps and Issues

### Critical (blocks correct measurement)

**C1. `akm search` and `akm show` do not write to `events.jsonl` — `akm_search` and `akm_show` workflow events depend entirely on stdout scraping.**

`src/core/events.ts` defines no `"search"` or `"show"` event types. The `EventType` union contains `"add"`, `"remove"`, `"update"`, `"remember"`, `"import"`, `"save"`, `"feedback"`, and the proposal/workflow verbs. `akm search` writes only to `usage_events` (SQLite, via `logSearchEvent` in `src/commands/search.ts:208-232`). `akm show` emits nothing.

`workflow-trace.ts`'s `AKM_EVENT_TYPE_MAP` maps `"search"` to `"akm_search"` and `"show"` to `"akm_show"`, implying these events come from `events.jsonl`. They do not. Both event types are derived exclusively from `fromAgentStdout`, which regex-matches `akm search` / `akm show` invocations in agent stdout.

This means `akm-lookup-before-edit` and `akm-correct-asset-use` — the two most important compliance specs — cannot be reliably scored. If opencode does not log bash tool calls verbatim to its stdout, or if the agent uses a different invocation form, these events are invisible. Both confirmed real runs (big-pickle and shredder) showed `correct_asset_loaded: 0` despite the agent having access to the stash. It is unclear whether the agent actually failed to search or whether the stdout scraper missed the invocations.

**Action**: Emit a structured event from `akm search` and `akm show` into `events.jsonl`. The `EventType` union should grow `"search"` and `"show"` entries. Until then, compliance scores for the two most important specs are noise.

---

**C2. The `noakm` arm is now default-off, removing the control condition for the primary utility claim.**

`cli.ts:287` sets `arms: options.includeNoakm ? ["noakm", "akm"] : ["akm"]`. The BENCH.md states "The fictional eval corpus has ~0% noakm pass rate by design — only needed to validate task calibration, not for measuring AKM utility."

This reasoning is backwards. If the noakm arm is expected to have ~0% pass rate by design, the corpus is not measuring whether akm *helps* — it is measuring whether the agent can complete AKM-prescriptive tasks with the AKM stash. The delta `pass_rate(akm) - pass_rate(noakm)` is the primary utility metric in spec §4; without it, the report measures only "does the agent use akm correctly on AKM-specific tasks," which is a workflow compliance metric, not a utility metric.

The two confirmed runs both showed negative transfer (big-pickle: -10pp, shredder: -25pp), which suggests either (a) the akm tooling genuinely hurts the model, or (b) the tasks are calibrated so that any agent without a specific stash fails — confirming that the corpus is no longer testing utility at all without the noakm baseline.

**Action**: Re-enable the noakm arm by default, or at minimum document explicitly that the current default-off configuration measures workflow compliance only, not utility, and update `docs/technical/benchmark.md` to reflect this scoping change.

---

**C3. Drillbit and inkwell have no train tasks — Track B (evolve) cannot run on two of the five eval domains.**

`tests/fixtures/bench/tasks/drillbit/` contains five tasks, all `slice: eval`. `tests/fixtures/bench/tasks/inkwell/` contains six tasks, all `slice: eval`. Track B Phase 1 accumulates signal only from the train slice (`corpus.ts:effectiveSlice`). Running `bench evolve --tasks drillbit` would produce zero Phase 1 runs, zero feedback events, zero proposals, and a degenerate Phase 3 report with an improvement_slope that is either 0 or undefined.

These two domains are also missing from CORPUS.md's task table entirely. CORPUS.md describes 23 tasks but the actual corpus has 35 task.yaml files (excluding `_example`).

**Action**: Either add train-slice tasks to drillbit and inkwell (at least 2 each to produce meaningful feedback), or explicitly document that these domains are eval-only measurement targets with no evolve support. Update CORPUS.md to list all 35 tasks.

---

**C4. BENCH.md's workflow spec table describes domain filters that don't exist in the actual spec files.**

BENCH.md (line 470-479) states that `akm-lookup-before-edit` applies to "docker-homelab, az-cli, opencode, workflow-compliance domains" and `akm-correct-asset-use` applies to "docker-homelab, az-cli, opencode, eval, workflow-compliance domains." This implies `task_domains` filters in the YAML files.

The actual spec files: `akm-lookup-before-edit.yaml`, `akm-correct-asset-use.yaml`, `akm-feedback-after-use.yaml`, `akm-negative-feedback-on-failure.yaml`, and `akm-reflect-after-repeated-failure.yaml` have NO `task_domains` filter. Only `akm-workflow-followed.yaml` has `task_domains: ["workflow-compliance"]`.

The four domain-unfiltered specs apply to every akm-arm run across all domains, not just the ones listed in BENCH.md. This means compliance checks run against drillbit and inkwell tasks too (not just the listed domains), inflating workflowChecks counts and making the BENCH.md table actively misleading.

**Action**: Add `task_domains` filters to the four domain-unfiltered specs to match BENCH.md's claims, or update BENCH.md to reflect that those specs apply to all domains.

---

### Significant (degrades signal quality)

**S1. Memory ability coverage is heavily imbalanced — four of six abilities have zero real eval tasks.**

Every real corpus task is tagged `memory_ability: procedural_lookup`. The `MEMORY_ABILITY_VALUES` closed set in `corpus.ts:37-44` defines six abilities: `procedural_lookup`, `multi_asset_composition`, `temporal_update`, `conflict_resolution`, `abstention`, `noisy_retrieval`. CORPUS.md confirms the entire seeded corpus is single-ability.

The `corpus_coverage` block in the report will show non-zero counts only for `procedural_lookup` and (for the workflow-compliance domain) `abstention` (one eval task: `abstention-rust-async-haiku`) and `noisy_retrieval` (one eval task: `distractor-docker-port-publish`). The five memory abilities that make the framework scientifically interesting — multi-asset composition, temporal update, conflict resolution — have zero tasks and will always show zero coverage.

The framework cannot demonstrate that akm helps with knowledge synthesis, staleness management, or disambiguation until these ability slices are populated.

**Action**: Add at least two tasks per missing ability (prioritize `multi_asset_composition` and `conflict_resolution` as the abilities most relevant to real akm use cases) before quoting `corpus_coverage` ability rows in any external communication.

---

**S2. `akm-feedback-after-use` and `akm-negative-feedback-on-failure` require the agent to call `akm feedback` after `verifier_run`, but the harness emits `verifier_run` only via `workspaceWrites` sidecar — not from `events.jsonl` — and only when `workspaceWrites` is passed to `normalizeRunToTrace`.**

The bench calls `normalizeRunToTrace(run, { warnings: runWarnings })` at `runner.ts:512` without passing `harness` lifecycle markers or `workspaceWrites`. This means `agent_started`, `agent_finished`, and `first_workspace_write` events are never populated in the trace, and `verifier_run` is populated only from `run.verifierExitCode` being non-null (which it always is, since the driver initializes it to -1).

The `akm-feedback-after-use` spec requires `verifier_run before akm_feedback`. Since `verifier_run` always appears in the trace (from the exit code), this ordering check will pass even when the agent recorded feedback before the verifier ran in real time — the trace ordering is synthetic, not temporal.

The `akm-feedback-after-use` spec also forbids `akm_feedback before verifier_run`. Since `verifier_run` is always present with a synthetic timestamp (`~verifier`), all stdout-scraped `akm_feedback` events sort before it (they carry `~stdout-XXXXXXXX` order hints), meaning this forbidden rule will fire on every run that records feedback before the agent finishes, which is the expected behavior.

**Action**: Pass `harness: { agentStartedTs, agentFinishedTs }` and `workspaceWrites` to `normalizeRunToTrace`. Without real timestamps, the `before`/`after` ordering constraints in feedback-related specs are unreliable.

---

**S3. `akm-reflect-after-repeated-failure` requires `min_repeated_failures: 2` but the `repeatedFailures` field is never populated on `WorkflowEvalRunContext`.**

`runner.ts:513-522` builds `runCtx` with `{ arm, taskId, seed, outcome }`. The `repeatedFailures` field is omitted. `specApplies` in `workflow-spec.ts:442-458` checks `(ctx.repeatedFailures ?? 0) < a.min_repeated_failures`, which means `repeatedFailures` defaults to 0. With `min_repeated_failures: 2`, the spec is never applicable — it always produces `not_applicable` — unless the runner explicitly tracks per-task failure counts across seeds and threads them into the context.

This spec is the key mechanism for detecting whether agents reflect appropriately on repeated failures. It is currently always `not_applicable`.

**Action**: Compute per-task running failure counts across seeds within the `runInBatches` loop and include them in `runCtx`. This requires tracking cumulative failures before each run starts.

---

**S4. The `akm-workflow-followed` spec fires only on the `workflow-compliance` domain, and the only workflow-compliance task with a workflow gold_ref (`inkwell/workflow-configure-scaling`) is in the inkwell domain.**

`akm-workflow-followed.yaml` applies `task_domains: ["workflow-compliance"]`. The only task in the corpus that exercises the `akm workflow start` / `akm workflow complete` path is `inkwell/workflow-configure-scaling` (gold_ref: `workflow:configure-inkwell-service`, slice: eval). That task is in the inkwell domain, not workflow-compliance, so the spec never fires against it.

The six workflow-compliance tasks do not include any task with a workflow asset gold_ref. None of them are designed to exercise `akm workflow start` / `akm workflow next` / `akm workflow complete`.

**Action**: Either add a workflow-compliance task that uses a workflow asset and exercises `akm workflow start`, or change `akm-workflow-followed`'s `task_domains` to `["workflow-compliance", "inkwell"]` to cover the existing workflow task.

---

**S5. The `opencode` domain has five tasks but the opencode task `opencode-config-model` is not listed in CORPUS.md's task table, and there are discrepancies between CORPUS.md (which lists 23 tasks) and the actual 35 task.yaml files on disk.**

CORPUS.md documents 23 tasks in its table. The corpus directory contains 35 task.yaml files (excluding `_example`). The 12 missing entries are: the five drillbit tasks, the six inkwell tasks, and the opencode `opencode-config-model` task. CORPUS.md also states "train/eval split: 13 train, 10 eval" in the header, but the actual distribution is different with 35 tasks.

The leakage check in `tests/bench/leakage.test.ts` processes all tasks from `listTasks()`, but CORPUS.md's human-readable leakage table is out of date.

**Action**: Update CORPUS.md to list all 35 tasks with slice, fixture, verifier, and leakage-check entries. Update the train/eval split counts in the header.

---

**S6. `correct_asset_loaded` is computed from stdout scraping only — with no structured event from `akm show`, all zero `correct_asset_loaded` results in the two real runs may be false negatives.**

`trajectory.ts:50-57` documents this explicitly: the heuristic first checks `events.jsonl` for a `show` event (which never exists because `akm show` emits no event) then falls back to scanning `verifierStdout` for the literal string `akm show <ref>`. If opencode does not include the exact invocation string in its output, `correct_asset_loaded` is always false even when the agent correctly loaded the asset.

The two real runs reported `correct_asset_loaded: 0/20` and `correct_asset_loaded: 0` respectively. This is consistent with either (a) the agent never loading the asset or (b) the stdout scraper failing to detect the invocation. The BENCH.md note "trajectory.akm.correct_asset_loaded and feedback_recorded should be non-null on the akm arm — all-null trajectories usually mean the events.jsonl stream wasn't captured" is misleading, since `correct_asset_loaded` returns `false` (not null) when the task has a goldRef but the show invocation wasn't detected.

**Action**: Add `eventType: "show"` emission to `akm show` in `src/commands/show.ts`. Until then, `correct_asset_loaded` results from real runs are uninterpretable.

---

**S7. The `evolve` subcommand does not forward `opencodeProviders` into `runEvolveCli` or `runEvolve`.**

`cli.ts:800-830` implements `runEvolveCli`. At `cli.ts:813`, `runEvolve` is called without forwarding `options.opencodeProviders`. The option is accepted in `EvolveCliOptions` and `RunEvolveOptions` but the CLI caller at `cli.ts:919-925` passes `opencodeProviders: options.opencodeProviders` only into `runEvolveCli`, which then calls `runEvolve` without including it.

Check: `runEvolveCli` at `cli.ts:813-823` does not spread `options.opencodeProviders` into the `runEvolve` call. This means `bench evolve` with a local provider config (like LM Studio) will fail to write the provider block into each run's `opencode.json`, causing `BenchConfigError` for any non-cloud model.

**Action**: Thread `opencodeProviders` from `runEvolveCli`'s `options` into the `runEvolve` call at `cli.ts:813`.

---

**S8. The `attribute` subcommand loads `opencodeProviders` but then voids it (`void opencodeProvidersAttr`) without forwarding it to `runAttributeCli`.**

`cli.ts:975-977`: `void opencodeProvidersAttr;` — the comment says "exposed for future wiring." This means `bench attribute` always runs masked re-runs without provider config, which will fail for any local-provider model.

**Action**: Remove the `void` and forward `opencodeProviders` into `runAttributeCli` and then into `defaultMaskedRunner`.

---

### Minor (cleanup / polish)

**M1. The BENCH.md "Implementation status" table marks all four subcommands as "Implemented" but the guide body states evolve numbers are "exploratory until a full domain run is complete."** The table implies `evolve` is production-ready when it is not. The distinction matters for operators quoting numbers.

**Action**: Change the evolve row to "Implemented (exploratory — see Known Caveats)" or add a footnote.

---

**M2. The `KNOWN_EVENT_NAMES` set in `workflow-spec.ts:35-54` is hardcoded and separate from the `WorkflowTraceEventType` union in `workflow-trace.ts:43-62`.** Both lists are currently identical, but future additions to `WorkflowTraceEventType` will silently fail spec validation if `KNOWN_EVENT_NAMES` is not updated in parallel. The comment in `workflow-spec.ts:26-27` acknowledges this: "Wave 3 will reconcile by importing from `workflow-trace.ts` directly."

**Action**: Import `KNOWN_EVENT_NAMES` from `workflow-trace.ts` rather than hardcoding it in `workflow-spec.ts`. This is straightforward — the set is already defined in one place.

---

**M3. `feedback_recorded` in the trajectory is a boolean but `TrajectoryRecord.feedbackRecorded` is `boolean | null`.** When `feedbackRecorded` is null it means the trajectory parser found no events (harness error path). When it is `false` it means no feedback events were found. The JSON report serialization in `report.ts` should distinguish null from false in the markdown summary so operators can distinguish "no events at all" from "agent ran but recorded no feedback."

**Action**: Update `renderUtilityReport`'s markdown section to annotate null vs false for trajectory fields.

---

**M4. The `agent_started` / `agent_finished` harness lifecycle events require `NormalizeOptions.harness` to be populated, but the bench runner never populates it.** Both events are always absent from all traces generated by real runs. The `akm-feedback-after-use` and `akm-negative-feedback-on-failure` specs require `agent_finished` as the last step, which will never appear, making those steps always produce `missing_required_event` violations.

**Action**: Record start/finish timestamps in `runOneIsolated` and pass them to `normalizeRunToTrace`.

---

**M5. The `opencode` task directory contains `opencode-config-model` and `tool-allowlist` as train tasks, but these share the `multi-domain` stash with the eval tasks `agents-md-akm-snippet` and `provider-akm-feedback`.** The leakage check in `leakage.test.ts` verifies verifier content against gold-ref SKILL.md, but does not check whether train task verifiers could inadvertently reveal eval task answers (e.g., if the multi-domain stash's `skill:opencode` content is updated to answer both train and eval tasks).

**Action**: Add a leakage check variant that confirms no train-task verifier pattern appears verbatim in any eval-task verifier, and vice versa, for tasks sharing a stash.

---

**M6. The `noisy` stash contains `skill:docker` (under `tests/fixtures/stashes/noisy/skills/docker/`) referenced by `workflow-compliance/distractor-docker-port-publish` as `gold_ref: skill:docker`.** The `noisy` stash's MANIFEST.json should document this intentional distractor task linkage so a future maintainer does not accidentally remove the `skill:docker` entry thinking it is unused.

**Action**: Add `"distractor-docker-port-publish task uses this as gold_ref"` to the `skill:docker` consumer note in `noisy/MANIFEST.json`.

---

## Recommended Next Steps

Ordered by impact on measurement correctness:

1. **Emit `"search"` and `"show"` events from `akm search` and `akm show` into `events.jsonl`.** Add these as named members of the `EventType` union in `src/core/events.ts`, call `appendEvent` at the top of each command's handler, and include useful metadata (query, resultRefs for search; ref for show). This unblocks `akm_search` and `akm_show` detection without depending on stdout format, makes `correct_asset_loaded` reliable, and is the single change with the highest impact on measurement fidelity. Estimated scope: 2-3 files, no schema break.

2. **Re-enable the noakm arm by default, or explicitly scope the benchmark as "workflow compliance only."** The current default makes the bench unable to measure marginal utility — which is the framework's stated primary purpose. Either revert `--include-noakm` to opt-out rather than opt-in, or rename the benchmark to make clear that it is measuring compliance, not utility, and update the spec accordingly.

3. **Add train-slice tasks to drillbit and inkwell (at least 2 per domain).** Track B (evolve) is currently dead for two of the five eval domains. Each train task takes approximately 30 minutes to author, verify, and leakage-check.

4. **Thread `repeatedFailures` into `WorkflowEvalRunContext` in `runner.ts`.** Without this, `akm-reflect-after-repeated-failure` is never applicable. Track per-task failure counts across seeds during `runInBatches` and include them in the run context.

5. **Pass `harness` lifecycle timestamps to `normalizeRunToTrace`.** Record agent start/finish times in `runOneIsolated`, pass them via `NormalizeOptions.harness`, so `agent_started` and `agent_finished` events have real timestamps and `before`/`after` ordering constraints in feedback-related specs are temporally grounded.

6. **Fix the `opencodeProviders` forwarding gap in `bench evolve` and `bench attribute`.** Both subcommands accept a provider config but fail to thread it into their runners, breaking all local-provider runs silently.

7. **Add `multi_asset_composition` and `conflict_resolution` tasks.** These are the memory abilities most directly relevant to akm's value proposition (composing guidance from multiple skills, choosing the right asset when multiple candidates exist). Without them, the corpus cannot differentiate akm from a simpler single-retrieval baseline.

8. **Reconcile `KNOWN_EVENT_NAMES` in `workflow-spec.ts` with the source-of-truth in `workflow-trace.ts`.** Replace the hardcoded list with an import, eliminating the dual-maintenance hazard.

9. **Update CORPUS.md to reflect all 35 tasks** with leakage-check rows for drillbit, inkwell, and opencode/opencode-config-model. Fix the stated train/eval split.

10. **Add `task_domains` filters to the four workflow specs that BENCH.md claims are domain-scoped.** Align the actual spec files with BENCH.md's applicability table, or vice versa. The current discrepancy means corpus_coverage workflow rows are silently counting more runs than the documentation implies.

---

## Verification Status — 2026-05-02

| Issue | Status | Evidence |
|-------|--------|----------|
| C1 | ✅ FIXED | `src/commands/search.ts:213-216` calls `appendEvent({ eventType: "search", metadata: { query, hitCount, resultRefs } })`. `src/commands/show.ts:209` calls `appendEvent({ eventType: "show", ref, metadata: { type, name } })`. `workflow-trace.ts:305-315` `AKM_EVENT_TYPE_MAP` maps `"search"→"akm_search"` and `"show"→"akm_show"`. However, `"search"` and `"show"` are NOT added as named members of the `EventType` union in `src/core/events.ts:41-61` — they fall through to the trailing `| string` catch-all. The events are emitted correctly, but the union is not hardened. |
| C2 | ❌ NOT ADDRESSED | `tests/bench/cli.ts:287` is unchanged: `const arms = options.includeNoakm ? ["noakm", "akm"] : ["akm"]`. The help text at line 72-73 still explains noakm as "only needed to validate task calibration, not for measuring AKM utility." No documentation update has been made to scope the benchmark as "workflow compliance only." |
| C3 | ✅ FIXED | drillbit now has 2 train tasks: `backup-policy-train` (slice: train) and `scale-replicas-train` (slice: train). inkwell now has 2 train tasks: `new-service-train` (slice: train) and `add-healthcheck-train` (slice: train). Track B (evolve) can now run on all 6 domains. CORPUS.md header updated: "Train/eval split: 23 train, 14 eval. drillbit and inkwell now have both train and eval tasks." |
| C4 | ⚠️ PARTIAL | The four universal specs (`akm-lookup-before-edit`, `akm-correct-asset-use`, `akm-feedback-after-use`, `akm-negative-feedback-on-failure`) still have NO `task_domains` filter in their YAML files. Only `akm-reflect-after-repeated-failure` has `task_domains: ["docker-homelab", "az-cli", "opencode", "eval", "workflow-compliance"]` and `akm-workflow-followed` has `task_domains: ["workflow-compliance"]`. BENCH.md line 469-474 still claims domain-scoped applicability for the four universal specs. The discrepancy between BENCH.md's table and the actual YAML files is unresolved — the BENCH.md note at lines 66-71 now documents that evolve is "exploratory," partially mitigating M1, but the C4 domain-filter mismatch remains. |
| S1 | ⚠️ PARTIAL | `grep -r "memory_ability:" tests/fixtures/bench/tasks/ | grep -v "train"` shows: 32 `procedural_lookup`, 1 `abstention`, 1 `noisy_retrieval`. CORPUS.md now correctly documents: `multi_asset_composition` 0/0, `conflict_resolution` 0/0, `temporal_update` 2 train/0 eval. The four missing abilities are documented but still have zero eval tasks. |
| S2 | ✅ FIXED | `tests/bench/runner.ts:512-517` now passes `harness: { agentStartedTs: run.startedAt, agentFinishedTs: run.finishedAt }` to `normalizeRunToTrace`. `driver.ts:497` sets `result.startedAt = new Date().toISOString()` and `driver.ts:511` sets `result.finishedAt`. Temporal ordering is now grounded. |
| S3 | ❌ NOT ADDRESSED | `akm-reflect-after-repeated-failure.yaml` does not use `min_repeated_failures` at the `applies_to` level (it uses `min_count: 2` on the `akm_feedback` sequence step, which is a different mechanism). `tests/bench/runner.ts:519-524` builds `runCtx` with `{ arm, taskId, seed, outcome }` — `repeatedFailures` is still never populated. `workflow-spec.ts:454-455` checks `(ctx.repeatedFailures ?? 0) < a.min_repeated_failures` but since the reflect spec uses `task_domains` not `min_repeated_failures` in `applies_to`, this particular spec does apply — but through domain filter, not the repeatedFailures gate. The `min_repeated_failures` mechanism is still dead letter code. |
| S4 | ❌ NOT ADDRESSED | `akm-workflow-followed.yaml` still has `task_domains: ["workflow-compliance"]`. The `inkwell/workflow-configure-scaling` task (gold_ref: `workflow:configure-inkwell-service`) is in the `inkwell` domain, not `workflow-compliance`, so the spec still never fires against that task. No workflow-compliance task with a workflow asset gold_ref has been added. |
| S5 | ✅ FIXED | CORPUS.md now documents 37 tasks (header: "Thirty-seven hand-authored tasks"). The task table at lines 23-60 lists all tasks including drillbit (7 entries), inkwell (7 entries), and opencode (5 entries including `opencode-config-model`). `find tests/fixtures/bench/tasks -name "task.yaml" | grep -v _example | wc -l` returns 38. There is a 1-task discrepancy: CORPUS.md says "thirty-seven" but 38 task.yaml files exist. The train/eval split header says "23 train, 14 eval" (total 37), vs 38 files on disk. |
| S6 | ✅ FIXED (with caveat) | `show.ts:209` now emits `appendEvent({ eventType: "show", ref, metadata: { type, name } })`. `trajectory.ts:82-90` checks `event.ref` against the gold ref for ALL events in `runResult.events` — it does not filter by `eventType === "show"` but still correctly detects the show event because `ref` is set. The stale comment at `trajectory.ts:51-52` ("akm itself does not emit an event for `show`, but third parties might, and the field is forward-compatible") was not updated and is now incorrect. |
| S7 | ✅ FIXED | `tests/bench/cli.ts:830-841` `runEvolveCli` now includes `...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {})` in the `runEvolve` call. `EvolveCliOptions` at line 810 declares `opencodeProviders?: LoadedOpencodeProviders`. The forwarding chain is complete. |
| S8 | ✅ FIXED | `tests/bench/cli.ts:994-998` in the `attribute` case now passes `...(opencodeProvidersAttr ? { opencodeProviders: opencodeProvidersAttr } : {})` to `runAttributeCli`. `runAttributeCli` at line 565 forwards it into `defaultMaskedRunner`. The `void opencodeProvidersAttr` line is gone. |
| M1 | ✅ FIXED | BENCH.md lines 53 and 66-72 now show: table row `evolve | Implemented`, but the subcommand note immediately below explains "Numbers from `evolve` are exploratory until a full domain run is complete and `feedback_agreement` passes the threshold." This is the "exploratory" annotation the review requested. |
| M2 | ❌ NOT ADDRESSED | `workflow-spec.ts:14` still says "Until then this set is the contract" and `KNOWN_EVENT_NAMES` at lines 35-54 is still hardcoded. The comment references "#256 will reconcile by importing the source-of-truth set from `workflow-trace.ts`" — this import reconciliation has not happened. `workflow-trace.ts` defines `WorkflowTraceEventType` but `workflow-spec.ts` does not import from it. |
| M3 | ❌ NOT ADDRESSED | `report.ts:857` still uses `formatPercent(input.trajectoryAkm.feedbackRecorded)`. `formatPercent` at line 1028-1031 returns `"n/a"` for `null` and a percentage for any `boolean` value — it receives `boolean | null` but the function signature accepts `number | null`, meaning a `false` (0%) and `null` ("n/a") are distinguishable in the JSON output but in markdown both `false` and `null` from `feedbackRecorded` would be formatted the same way (since `TrajectoryRecord.feedbackRecorded` is `boolean` not `boolean | null`, making the markdown annotation distinction moot here). The `feedback_recorded` field in the JSON is `boolean | null` (report.ts:144) but `computeFeedbackRecorded` in trajectory.ts always returns `boolean`, never `null`. The null case in the JSON shape is vestigial. No annotation change was made. |
| M4 | ✅ FIXED | `driver.ts:166` declares `startedAt?: string` and `driver.ts:172` declares `finishedAt?: string` on `RunResult`. `driver.ts:497` sets `result.startedAt` and `driver.ts:511` sets `result.finishedAt`. `runner.ts:514-516` passes both to `normalizeRunToTrace` via `harness: { agentStartedTs: run.startedAt, agentFinishedTs: run.finishedAt }`. |
| M5 | ❌ NOT ADDRESSED | `leakage.test.ts:97-133` only checks verifier-content-against-gold-ref (not train verifier patterns against eval verifier patterns). No cross-task leakage check has been added. |
| M6 | ❌ NOT ADDRESSED | `tests/fixtures/stashes/noisy/MANIFEST.json` still reads: `"consumers": ["tests/fixtures/bench/tasks/* (Track A — robustness corpus, future)", "tests/ranking-regression.test.ts (noise-tolerance ranking, future)"]`. The `distractor-docker-port-publish` consumer note for `skill:docker` is absent. |
| A1 | ✅ FIXED | `tests/bench/environment.ts:112-124` now throws `BenchConfigError` when a local-prefix model is not in the providers map: `if (modelPrefix && !BUILTIN_CLOUD_PREFIXES.has(modelPrefix)) { throw new BenchConfigError(..., true) }`. Cloud models without a provider entry still get a warning-only path. |
| A2 | ⚠️ PARTIAL | `tests/bench/driver.ts:245-250` still creates a symlink from the real `~/.config/opencode` to `${XDG_CONFIG_HOME}/opencode`. The code now falls back to `fs.mkdirSync` when the real dir does not exist (line 249-251), preventing a hard failure in CI. However, the symlink risk itself — that the real opencode config is readable from inside the isolated env — remains. No comment or note has been added explaining the intentional trade-off. |

### Remaining Gaps

**C2 — noakm arm default-off** (`tests/bench/cli.ts:287`): `arms` is still `["akm"]` by default. No documentation update has been made to frame the benchmark as "workflow compliance only" rather than "utility measurement." The bench cannot claim to measure marginal utility without the control arm.

**C4 — BENCH.md workflow spec table vs YAML files** (`tests/fixtures/bench/workflows/`): `akm-lookup-before-edit.yaml`, `akm-correct-asset-use.yaml`, `akm-feedback-after-use.yaml`, and `akm-negative-feedback-on-failure.yaml` have no `task_domains` filter, but BENCH.md lines 469-472 claim they are domain-scoped. The mismatch causes silently inflated workflowChecks counts for drillbit and inkwell tasks.

**S3 — repeatedFailures never populated** (`tests/bench/runner.ts:519-524`): `WorkflowEvalRunContext` is built without `repeatedFailures`. The `min_repeated_failures` field in `WorkflowAppliesTo` remains dead-letter — no spec currently uses it at the `applies_to` level (the reflect spec uses `task_domains` instead), but the mechanism is broken for any future spec that does.

**S4 — akm-workflow-followed wrong domain** (`tests/fixtures/bench/workflows/akm-workflow-followed.yaml:10`): Still `task_domains: ["workflow-compliance"]`. The only workflow-asset task (`inkwell/workflow-configure-scaling`) is in `inkwell`. The spec never fires against the task it is designed to measure.

**M2 — KNOWN_EVENT_NAMES dual-maintenance** (`tests/bench/workflow-spec.ts:14,35-54`): Still hardcoded. Import from `workflow-trace.ts` has not landed.

**M3 — feedbackRecorded null vs false** (`tests/bench/report.ts:857`): `formatPercent` is called with a `boolean` (from `computeFeedbackRecorded`), so `null` can only appear via the JSON shape's declared `boolean | null` type — the markdown annotation distinction is effectively impossible given the current implementation. No change was made.

**M5 — cross-task leakage check** (`tests/bench/leakage.test.ts`): No check for train-task verifier patterns appearing verbatim in eval-task verifiers (or vice versa) for stash-sharing tasks.

**M6 — noisy MANIFEST.json missing consumer note** (`tests/fixtures/stashes/noisy/MANIFEST.json`): `skill:docker` consumer linkage to `distractor-docker-port-publish` is undocumented.

**S5 minor discrepancy**: CORPUS.md header says "thirty-seven" but `find tests/fixtures/bench/tasks -name "task.yaml" | grep -v _example | wc -l` returns 38. One task is on disk but not in the CORPUS.md header count (the table itself lists 37 rows — one file on disk may be the `inkwell/workflow-configure-scaling` task or a newly added file not yet reflected in the count).

### New Issues Introduced

**N1 — `trajectory.ts` comment is now stale** (`tests/bench/trajectory.ts:51-52`): The comment "akm itself does not emit an event for `show`, but third parties might, and the field is forward-compatible" is incorrect — `akm show` now emits a `"show"` event via `appendEvent` in `show.ts:209`. The comment should be updated to reflect that the event is emitted and the events-stream path is now the primary detection mechanism.

**N2 — `EventType` union does not include `"search"` or `"show"` as named members** (`src/core/events.ts:41-61`): The fix for C1 emits these event types via `appendEvent`, but they fall through to the `| string` catch-all in the `EventType` union. Adding them as named members would harden the type contract, prevent typos in callers, and make it clear to future readers that these are first-class event types. This is a type-safety gap introduced by the partial implementation of C1.

**N3 — CORPUS.md task count mismatch**: CORPUS.md says "Thirty-seven hand-authored tasks" in the header but `find` returns 38 task.yaml files (excluding `_example`). This is a documentation inconsistency introduced with the drillbit/inkwell train-task additions.
