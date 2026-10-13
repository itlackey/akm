# Implementation Brief: Rebuilding `akm-bench` and `akm-eval` on Upstream Harnesses

**Status:** Draft — awaiting review
**Scope:** [`itlackey/akm-bench`](https://github.com/itlackey/akm-bench) (rewrite), [`itlackey/akm-eval`](https://github.com/itlackey/akm-eval) (strip + finish)
**Targets:** `akm-cli >= 0.9.1`, `akm-opencode >= 0.9.x`, Harbor `0.22.x`
**Branch (this doc):** `claude/akm-benchmark-measurement-75rpsg`
**Evidence basis:** Harbor source @ `39b8587` (v0.22.0), akm 0.9.1 source (exercised live), both repos read in full, upstream memory-benchmark survey. Claims below carry file:line or URL citations.

---

## 1. The split

| Repo | Owns | Executed by | Answers |
| --- | --- | --- | --- |
| **`akm-bench`** | Standard agentic-coding benchmarks + akm's own task corpus | **Harbor** | "Does the akm-opencode plugin change scores on benchmarks the field recognizes?" |
| **`akm-eval`** | Memory / long-term-recall benchmarks | **Upstream dataset harnesses** (LongMemEval, LoCoMo, BEAM) | "Does akm hold up as a memory layer against mem0 / Zep / raw vector?" |

Both emit the same normalized per-trial record and share one statistics module. Neither owns a container runtime, an agent driver, or a benchmark scorer.

### 1.1 The honest framing

"Thin wrapper" is true of **execution** and false of **analysis**. Harbor replaces containers, agent install, parallelism, retries, resume, trajectories and artifact layout. It supplies **zero** statistics: no pass@1, no confidence intervals, no significance tests, no bootstrap, no CSV export, and no local `job compare` CLI (`src/harbor/metrics/`, `src/harbor/utils/pass_at_k.py`). Every number in an A/B report is code we write.

Plan for roughly: **execution → upstream, analysis → ours.** Section 6 sizes what "ours" means.

---

## 2. Why rewrite, not port

### 2.1 `akm-bench` — legacy against a retired akm interface

| Fact | Evidence |
| --- | --- |
| Pins `akm-cli ^0.7.1` | `package.json` |
| Whole AKM toggle is retired in 0.9: `AKM_STASH_DIR` (zero refs in akm 0.9.1), `stashDir` config key ("retired in 0.9", `akm/src/core/config/config-schema.ts:169`), `akm distill` / `akm reflect` (hard-removed, `akm/src/cli/retired-commands.ts`) | `src/environment.ts:205,232`, `src/evolve.ts:568-620` |
| Hard-codes `plugin: []` specifically to keep `akm-opencode` out | `src/environment.ts:29-49` (`BENCH_OPENCODE_INVARIANTS`) |
| ~5,100 LOC of container/exec/verifier machinery duplicating Harbor | `driver.ts`, `environment.ts`, `runner.ts`, `verifier.ts`, `corpus.ts`, `tmp.ts`, `cleanup.ts` |
| Published v1 reference run has **no** measured baseline arm (`arms: ["akm"]` only) | `results/reference/v1/SUMMARY.md:55-70` |

It benchmarks an akm generation the plugin cannot run against. Rewrite is correct.

### 2.2 `akm-eval` — mis-scoped, not rotten

Correcting an earlier assumption: **akm-eval is already most of the way to being the memory-eval repo.**

- `locomo`, `longmemeval`, `beam` and `tau-bench` packs all exist and all instantiate a `MemoryBackend` (`src/memory/types.ts` — a 4-method interface: `add`/`search`/`reset`/`healthCheck`).
- `src/packs/locomo/adapter.ts:309-370` already runs the exact `reset() → add(documents) → search(question) → answer` pipeline this plan wants.
- LoCoMo already downloads the official `locomo10.json` and shells out to a wrapper around the **official** scorer (`src/packs/locomo/dataset.ts`, `scripts/locomo-evaluator.py`) — the recommended shape, already done.
- The A/B path is **proven live**: `config/common/locomo-smoke.json` defines two arms (`baseline` + `raw-vector`) with different memory backends. (My earlier statement that every committed config defines only `baseline` was wrong.)

What is actually wrong with it:

| Problem | Evidence |
| --- | --- |
| `swe-bench` pack is a **one-shot patch completion**, not an agentic run — a session-lifecycle plugin has no surface to act on | `src/packs/swe-bench/adapter.ts:71-72,522-548` |
| `terminal-bench` pack rides the **frozen** legacy `tb` CLI (PyPI `terminal-bench` last released 0.2.18, 2025-09) — can never produce TB2-comparable numbers | `scripts/setup-terminal-bench-runtime.sh` |
| `plugin` is a **forbidden** config key; every materialized config gets `plugin: []` | `src/opencode-config.ts:71-92,283-288` |
| The `akm` memory backend is a deliberate throwing stub that probes `akm memory --help` — **a command that has never existed** in any akm version | `src/memory/backends/akm.ts:29-51` |
| `docs/operator-blockers.md` item 3 blames an "upstream add/search contract" that akm 0.9.1 ships today (`akm remember` + `akm search`, JSON by default) | stale doc |
| `src/memory/judge.ts` is a **heuristic** judge (max of exactMatch/tokenF1/contains, pass ≥ 0.6) feeding `judgedPass` — directly contradicting the README's "no synthetic or heuristic success metrics" | `src/memory/judge.ts`, `src/packs/longmemeval/scorer.ts` |

So: **strip the coding half, delete the heuristic judge, implement the akm backend.** Not a from-scratch rewrite.

### 2.3 The common failure

Neither repo can measure the thing we care about. Both deliberately exclude `akm-opencode` from every run, and `akm-plugins/evals` never launches a real opencode binary (in-process mock client). **Zero existing first-party tooling exercises the plugin in a real opencode session.**

---

## 3. What upstream gives us — and what it doesn't

### 3.1 Harbor (v0.22.0) — verified

**Free:**
- Built-in `opencode` agent (`src/harbor/agents/installed/opencode.py`): installs Node + `npm i -g opencode-ai@<version>`, runs `opencode --model=<p/m> run --format=json`, parses to ATIF-v1.7 trajectory with per-step tool calls, token counts and `cost_usd`. `SUPPORTS_ATIF = True`, `SUPPORTS_RESUME = True`.
- **Plugin injection is a config kwarg**: `opencode_config` is deep-merged into the container's `~/.config/opencode/opencode.json` (`opencode.py:478`), `_DEFAULT_CONFIG` is empty, arbitrary keys pass through. Confirmed from source, not inferred.
- Custom agents via `--agent module.path:ClassName` (`src/harbor/cli/jobs.py:548-556`) — the supported extension point for an `AkmOpenCode(OpenCode)` subclass overriding `install()`.
- Local task dirs run with **zero** hub involvement: `harbor run -p <dir>` (`jobs.py:1774-1798`). A local `registry.json` gives named+versioned local datasets (`src/harbor/models/registry.py`).
- Per-trial provenance: `<trial>/result.json` carries `agent_info` (name/version/model), **`config.agent.kwargs`** (our arm's full config), `verifier_result.rewards`, `agent_result.{n_input_tokens,n_cache_tokens,n_output_tokens,cost_usd}`, `exception_info.exception_type`, per-phase `TimingInfo`. `<trial>/lock.json` adds content digests of task + agent + skills + harbor version.
- **Resume is real and cost-safe**: `harbor job resume -p <job_dir>` reuses every trial with a parseable `result.json` (`src/harbor/job.py:237-320`). Critical for 500-instance runs.

**Not free — and each is a trap:**
- `jobs/<job>/result.json` on disk **never** contains `trial_results` (always written with `exclude_trial_results=True`, `job.py:712-720`). Walk trial subdirs.
- `pass@1` is **unreachable**: k starts at 2, and `pass_at_k` returns `{}` unless every trial has exactly one reward key valued exactly 0 or 1 (`utils/pass_at_k.py`).
- Default `Mean` metric folds errored trials in as **0** (`metrics/base.py:36-40`).
- `-k N` records **no attempt index** — trials differ only by a random 7-char suffix. Attempt *i* of arm A **cannot** be paired with attempt *i* of arm B. Paired statistics must be redesigned as per-(task, arm) aggregates.
- `task.toml` `[metadata]` **never reaches** `result.json` at any level. Every grouping we care about (domain, slice, difficulty, memory_ability) requires a left-join from our corpus onto `TrialResult.task_name`. There is no hook to smuggle it through (`src/harbor/cli/plugins/` contains only `harbor_hub.py`).
- `ctrf.json` is written by the **task's** `tests/test.sh`, never by Harbor, which stores it as opaque text (`viewer/server.py:2661`). Per-test granularity is ours to guarantee and parse.
- Retries `rmtree` the failed trial dir and reuse the name — failure forensics are destroyed. Run `--max-retries 0` if transient-failure analysis matters.
- Resume demands a **byte-identical** `JobConfig`; regenerating a config with any changed field (even `n_concurrent_trials`) breaks resume mid-sweep.
- `harbor run -p <dir>` scans **exactly one directory level**. Our current `tasks/<domain>/<task-id>/` layout resolves to **zero tasks**.

### 3.2 Dataset IDs — correction

The shipped `registry.json` at v0.22.0 (80 datasets) uses `name@version`, resolved from pinned git commits:

- `terminal-bench@2.0` (89 tasks), `terminal-bench-sample@2.0` (10), `terminal-bench-pro@1.0` (200)
- `swebench-verified@1.0` (500), `swebenchpro@1.0` (731), `swebench_multilingual@1.0` (300)

Hub packages use a separate `org/name` form (`PackageTaskId`, `models/task/id.py:35`). **Both mechanisms are real**; earlier drafts of this analysis quoted only the hub form. Confirm the exact spelling for the installed version with `harbor dataset list` before pinning anything. Note: every shipped registry entry has `metrics: []`.

### 3.3 Memory evals — there is no Harbor equivalent

Verified: **no neutral multi-backend memory-eval harness exists** that we can adopt as a dependency.

- Harbor's registry has **zero** memory/conversational-QA datasets. Its one LoCoMo adapter (`adapters/locomo`, parity-verified) is **closed-book long-context** — the transcript is mounted at `/app/conversation.md`, there is no ingest/query protocol — and its dataset PR is still open. Not the memory harness.
- `supermemoryai/memorybench` (MIT, Bun/TS — our stack) is the closest: one `Provider` (~200 LOC: initialize/ingest/awaitIndexing/search/clear) buys LoCoMo + LongMemEval + ConvoMem, three judges, checkpointed phases, and `compare -p akm,mem0,zep`. But providers are a static in-tree `Record`, so integration = submodule/fork or upstream PR, not a dependency.
- `mem0ai/memory-benchmarks` (Apache-2.0) covers LoCoMo + LongMemEval + BEAM but hardcodes a Mem0 client — escapable via a 3-endpoint (`POST /memories`, `POST /search`, `DELETE /memories`) mem0-OSS-compatible shim. Highest coverage per line, but it is mem0's harness and mem0's prompts: publish as "akm under mem0's protocol", never as neutral.
- `LongMemEval v1` (MIT) has the **thinnest contract of any memory benchmark**: write JSONL of `{question_id, hypothesis}`, shell out to `src/evaluation/evaluate_qa.py`. Zero scoring code owned.
- `BEAM` has **no plugin interface** at all (hardcoded retrieval families, torch/qdrant/FAISS/Bedrock deps). Fork or shim only. Its reusable part is the per-ability rubric judge.
- `OpenDataBox/MemoryData` is the most unified suite but ships **no LICENSE** — legally unusable.
- **Never write a LoCoMo scorer.** Import the pinned upstream, or lift Harbor's parity-verified `adapters/locomo/.../verifier.py`.

---

## 4. Target: `akm-bench`

### 4.1 Architecture

```
akm-bench/
  agents/akm_opencode.py     # AkmOpenCode(OpenCode): install() override      (~40 LOC Python)
  tasks/                     # 46 tasks, Harbor format, ONE level deep
  registry.json              # akm-tasks-train@1.0 / akm-tasks-eval@1.0
  arms/*.yaml                # Harbor job configs: baseline vs akm
  analysis/                  # trial loader, corpus join, metrics, statistics  (TS)
  bin/akm-bench              # argv builder over `harbor run` / `harbor job resume`
```

No executor, no container code, no verifier dispatcher, no agent driver.

### 4.2 Delete (~5,100 LOC)

`src/driver.ts`, `src/environment.ts`, `src/runner.ts`, `src/verifier.ts`, `src/corpus.ts`, `src/opencode-config.ts`, `src/support/agent.ts`, `src/trajectory.ts`, `src/tmp.ts`, `src/cleanup.ts`, `src/doctor.ts`, `src/fixture-index-*.ts`, `src/build-fixture-indexes.ts`, `Dockerfile`, `bin/docker-entrypoint.sh`, all 13 `config/*.json` run configs.

### 4.3 Keep and re-point (~8,500 LOC — this is the repo's actual value)

Harbor replaces **none** of `src/metrics/` (13 modules), `src/report/`, `src/workflow-*.ts`, `evolve*.ts`. What changes is only their **input adapter**:

| Analysis input (today) | Becomes |
| --- | --- |
| bespoke `RunResult.events` | akm's own `state.db` — `akm log --since @offset:<N> --detail full --format json` + the `usage_events` table |
| scraped agent stdout for `akm show <ref>` | `<trial>/agent/trajectory.json` ATIF `tool_calls` (structured, with arguments) |
| `verifierStdout` | `<trial>/verifier/{reward.json,ctrf.json}` |
| `workspaceWrites` | trajectory tool calls + `/logs/artifacts/` |

`src/workflow-trace.ts` already normalizes exactly this evidence set behind one interface, so the change is confined to its source adapters. **This is a strict upgrade in fidelity**: `src/metrics/attribution.ts` today admits all three of its detection strategies are heuristic regex over stdout; akm's `usage_events` table gives per-query attribution natively (`event_type`, `entry_ref`, `query`, `source`). Set `AKM_EVENT_SOURCE=audit` on all harness-side akm calls so the agent's own traffic stays separable as `source='user'` — that one env var is what makes the metric honest.

### 4.4 Corpus conversion — mechanical except for one part

46 tasks → Harbor format (`task.toml` + `instruction.md` + `environment/` + `tests/test.sh`). Census: az-cli 6, docker-homelab 6, drillbit 7, inkwell 9, opencode 6, workflow-compliance 11, `_example` 1. Verifier: script 29 / pytest 17. Slice: train 27 / eval 19.

The verifier contract is permissive — `tests/test.sh` need only write `/logs/verifier/reward.json` (flat `{key: number}`) or `reward.txt` (a bare float). Harbor does **not** wrap pytest. Existing `verify.sh` scripts port nearly as-is.

**The non-mechanical part:** no `task.yaml` carries an instruction or prompt beyond a one-line `title` — the actual prompt is synthesized today by the driver. An `instruction.md` must be authored for all 46, and **the derivation rule materially changes task difficulty**. Budget real time here; it is the least mechanical part of a "mechanical" conversion.

Also required: flatten to one directory level (or ship `registry.json`); rewrite 43 `gold_ref` values from the pre-0.9 `type:name` grammar to `[bundle//]conceptId[#fragment]` (`akm lint --fix` migrates a `type:name` xref to `[bundle//]conceptId[#fragment]` when the rewritten ref still resolves); map `budget.tokens` and `slice` into `[metadata]` (Harbor has neither concept) knowing they will need the corpus join to be usable.

Good news: the 7 fixture bundles are already akm-retrievable (frontmatter `description:` + headings), so §5.4's indexing ceiling does **not** bite here.

### 4.5 Arms

```sh
# Baseline
harbor run -d terminal-bench@2.0 -a opencode -m <provider/model> \
  --ak version=<pinned-opencode-ai> -k 5 -n 8

# Treatment
harbor run -d terminal-bench@2.0 -a akm_opencode:AkmOpenCode -m <provider/model> \
  --ak version=<pinned-opencode-ai> -k 5 -n 8
```

**Load-bearing detail:** any `opencode_config` we write must carry the permission block (`permission: {bash: allow, edit: allow, write: allow}`). In non-interactive `opencode run`, opencode **silently skips** tool calls lacking explicit grants — the failure looks like agent incompetence, not misconfiguration. This is why `BENCH_OPENCODE_INVARIANTS` exists; carry it forward.

---

## 5. Target: `akm-eval`

### 5.1 Delete (~1,400 LOC + runtime plumbing)

`src/packs/swe-bench/` (736), `src/packs/terminal-bench/` (725), `src/packs/akm-bench/` (36 — a circular dependency the split kills), `src/opencode-config.ts` (the plugin-forbidding materializer), `tools/terminal_bench_agent.py`, `tools/terminal-bench-opencode-setup.sh.j2`, `scripts/setup-{swe-bench,terminal-bench}-runtime.sh`, `scripts/swebench_list_instances.py`, `bin/{swe-bench-eval,terminal-bench-eval}`, the coding-benchmark entries in `src/variants/registry.ts`.

**Also delete `src/memory/judge.ts`** and the heuristic paths in `answer-metrics.ts` / `retrieval-metrics.ts` that feed `judgedPass`. Replace with upstream evaluators. Keeping them silently inherits a metric the repo's own README disavows.

### 5.2 Keep

`src/packs/{locomo,longmemeval,beam}`, `src/memory/` interface + registry, `src/variants/`, `src/reporting/`, `src/config/`, `src/core/`, the Docker CLI image. Decide `tau-bench`'s fate (§8).

Note the surviving half is the **expensive** half: `beam/official.ts` alone is 777 LOC of upstream repo discovery, dataset prep and judge credential checking. BEAM has no plugin interface, so that is irreducible vendor plumbing.

### 5.3 Build: the akm memory backend

The interface is 4 methods. Subprocess form, verified live against 0.9.1:

```
add(text, metadata) → akm remember "<text>" --name <id> --description "<md>" --tag k:v --format json
                      → {ok, ref, path}          # auto-indexes; no separate `akm index` needed
search(query)       → akm search "<q>" --limit N --detail agent --format json
                      → hits[].{ref, name, type, path, score, description, estimatedTokens}
get(ref)            → akm show <ref> --detail agent --format json → .content
```

Verified gotchas:
- `--format json` is already the **default** on every command; errors are a uniform JSON envelope on **stderr**; exit codes are a stable 5-value table (0/1/2/4/70/78).
- **`--detail normal` silently drops `ref`** (`akm/src/output/shapes/helpers.ts:295-306`). Use default `brief` or `--shape agent`, never `normal`.
- There is no `snippet` field. `--shape agent` returns an absolute `path`, so read the file directly rather than paying a second `akm show`.
- In-process fast path exists (`akm-cli/dist/commands/read/{search,show,curate}.js`) but only on the **npm** install (the standalone binary ships no `dist/*.js`), and under Node it needs `dist/text-import-hook.mjs` registered first. Make it an opt-in flag; subprocess is the always-correct default. Note `dist/akm` is a launcher that re-spawns `bun dist/cli.js` — each CLI call is up to **two** processes.

### 5.4 Two things that are not thin

**(a) akm does not index body prose.** FTS and embedding fields are name, frontmatter `description`, tags/aliases, hints and **headings** (+ optionally the first ~280 chars of body via `index.indexBodyOpening`). Verified empirically: a word appearing only in body prose returns **zero** hits, and embeddings do not help — `buildSearchText` concatenates the same fields. A naive `add(raw conversational turn)` is therefore near-unretrievable, and the arm would measure ~0 recall and blame akm.

akm-eval must own a per-document **description/tag synthesis** step. Either an LLM (cost, non-determinism, and a confound: you are now partly measuring the synthesis prompt) or a documented deterministic heuristic. **This step sets the ceiling of every retrieval metric and must be declared in every published number.**

**(b) Bulk ingest and `reset()` have no cheap primitive.** `akm remember` re-indexes after **every** write, so per-turn ingest of a LongMemEval-m haystack (~500 sessions) is O(n) reindex per document. The bulk path is "write N markdown files, then `akm bundle add <dir>` / `akm index`" — different code from the per-document `add()` the interface assumes. And `reset()` has **no akm command**: it means `rm -rf` the bundle + `$DATA` + `$STATE` and re-init, per instance.

### 5.5 Integration surface, per benchmark

| Benchmark | Surface | Effort |
| --- | --- | --- |
| **LongMemEval v1** | JSONL of `{question_id, hypothesis}` → pinned `evaluate_qa.py` | Thinnest. **Do this first.** The `oracle` variant gives a retrieval-free ceiling that separates "akm retrieval is bad" from "the answering LLM is bad". |
| **LoCoMo** | Already done — keep `dataset.ts` + `locomo-evaluator.py` | Zero |
| **BEAM** | No plugin interface; fork or mem0-shim | Highest; `official.ts` stays |
| **memorybench** (optional) | One `Provider` (~200 LOC) buys LoCoMo + LongMemEval + ConvoMem **plus** head-to-head vs mem0/zep under one protocol | Best leverage per line; needs submodule/fork |

---

## 6. The shared piece

One normalized per-trial record, one loader, one statistics module, used by both repos.

- **Record:** keep akm-eval's `NormalizedRunResult` shape (`schemaVersion`, arm id, pack/dataset, metrics, telemetry, artifacts) and extend it to carry Harbor's per-trial provenance (`agent_info`, `config.agent.kwargs`, `task_checksum`, lock digests).
- **Loader:** walk `<job>/<trial>/result.json`; group by `(task_name, arm)`; left-join corpus `[metadata]` on `task_name`. Do **not** trust Harbor's `evals` key (`{agent}__{model}__{dataset}`, ambiguous if any component contains `__`).
- **Statistics (all ours):** pass@1, per-arm mean ± CI, paired-by-task bootstrap over per-(task, arm) aggregates (attempt-level pairing is impossible — §3.1), and a declared minimum detectable effect. Harbor's `Mean` counting errors as 0 must be replaced with an explicit errored-trial policy.
- **Reproducibility manifest** on every published number: pinned Harbor version, opencode-ai version, akm-cli version, plugin version, dataset ref/commit, model, judge model, protocol flags, seed count, cost. For LoCoMo specifically, protocol (upstream F1 + Porter stem vs LLM-judge), judge model, and cat-5 inclusion (1,986 vs 1,540 QA pairs) are **required** fields — that label is what makes our numbers defensible against mem0's 92.5% and Zep's 94.7%.

Ship it as one small package consumed by both repos, not two copies.

---

## 7. Phased plan

Each phase ends in a gate that produces a number or a proof, not a refactor.

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **P0 — Pilot** | `AkmOpenCode` agent + one Harbor job on a 1-task subset | `/logs/agent/opencode.txt` shows the model actually calling `akm_*` tools in-container. **Nothing else starts until this passes.** |
| **P1 — Shared analysis** | Record schema, trial loader, corpus join, statistics module | Loader reproduces a known job's rewards; bootstrap CI on synthetic data |
| **P2 — akm-bench standard arms** | Harbor job configs for `terminal-bench@2.0` and `swebench-verified@1.0`, baseline + akm | A/B on a 10-task subset with CIs; resume verified after a kill |
| **P3 — Corpus conversion** | 46 tasks in Harbor format + `registry.json` slices + authored `instruction.md` | All 46 run green under the oracle/solution path; reward parity vs the old harness on a sample |
| **P4 — akm-bench analysis re-point** | metrics/report re-sourced from trajectory + `state.db` | Attribution reproduces a hand-checked trial; workflow-compliance scores a known-violating run |
| **P5 — akm-eval strip** | Coding packs, heuristic judge, plugin-stripping deleted | Repo runs locomo + longmemeval green; boundary check passes |
| **P6 — akm memory backend** | `add`/`search`/`reset` + bulk ingest + description synthesis | LongMemEval **oracle** ceiling measured first, then `s`; akm vs raw-vector vs none with CIs |
| **P7 — Decide** | Attribution / evolve / BEAM / memorybench per §8 | — |

---

## 8. Open decisions — these need your call

> **Live status:** decisions and their consequences are tracked in
> [`benchmark-harness-decisions.md`](./benchmark-harness-decisions.md).
> As of 2026-08-22, D1/D2/D4/D6/D7 are decided; the rest remain open.

Ordered by blast radius. Several change what earlier phases emit, so they cannot be deferred past P2.

1. **Do the longitudinal workflows survive?** *(biggest scoping decision)* Harbor gives every trial an isolated container. `evolve` (train → feedback → improve → accept → reindex → eval in pre/post/synthetic arms) and `attribute` (leave-one-out asset masking over a saved report) are **multi-run orchestrations with no Harbor primitive**. Six tasks carry `repeated_failure_group` requiring two tasks in one pass to accumulate feedback against the same asset. Options: Harbor multi-step tasks, orchestrate outside Harbor in akm-bench, or **explicitly kill them**. "akm-bench becomes a thin Harbor wrapper" silently kills both — say which we mean. (There is also a third arm, `synthetic`, in `src/run-config.ts:362`, unaccounted for in this plan.)
2. **How does akm get into each trial container?** (a) custom agent `install()` override — clean arm/task separation, real Python in akm-bench; (b) task `environment/Dockerfile` — contaminates 46 arm-neutral tasks and makes the baseline arm run an image containing akm; (c) `--skill` upload — portable but files, not a global install. **(a) is recommended.** Decide before conversion starts: (b) changes what the converter emits.
3. **Network policy for the akm arm.** opencode resolves `plugin: ["akm-opencode"]` from npm **at session start**; TB2 tasks commonly restrict egress. Pre-install at image build (offline-safe, couples image to plugin version) vs allow `registry.npmjs.org` (changes the environment relative to baseline — itself a confound). Note `akm-opencode` depends on `akm-cli ^0.9.0`, so one install brings both.
4. **Canonical reward shape.** Single `reward` key (Harbor's aggregates work) vs multi-key (all Harbor aggregates silently degrade and we own 100% of scoring). Workflow-compliance sub-scores are the forcing case.
5. **Where is workflow-compliance scored?** In-container `tests/test.sh` (it **can** read `/logs/agent/trajectory.json` — verified: `_sync_agent_output` runs before `_run_verifier`, and cloud envs upload logs back in — and can read akm's `state.db` directly) puts compliance into the reward; post-hoc in analysis keeps it out of every Harbor artifact and regrade path.
6. **Cold-start library content** *(carried over — still unanswered)*. Nothing in any repo provides a knowledge library relevant to SWE-bench repos or TB2 tasks. An empty-but-configured library is **not** a null treatment: the plugin injects a ~2KB doctrine block every turn and registers 5 tools regardless, so it measures pure overhead and likely shows a *negative* delta. Options: generic SWE skills bundle, per-domain `akm import` (watch contamination for SWE-bench), or a learned library harvested from a train split.
7. **Cross-task accumulation policy.** Shared mutable bundle across trials (the "akm learns" story) needs a mounted volume and introduces ordering effects and concurrent-write races at `-n > 1`; per-trial read-only copies give clean statistics but measure only static retrieval. **This changes the claim the numbers can support.**
8. **Which upstream memory harness akm-eval adapts** (§5.5), and whether to invest the ~200 LOC in a memorybench `Provider` for head-to-head vs mem0/zep.
9. **Judge-model cost budget.** LongMemEval-V2 defaults to a gpt-5.2 medium-reasoning judge; BEAM-10M ingest is likely the single most expensive item in the suite; Harbor's own LoCoMo parity run cost ~$35 for 5×10 trials on gpt-5-mini. No estimate exists for a full akm sweep — **force a number before P6.**
10. **Slice representation, bundle fixture delivery, token budgets, attribution masking** — mechanical but each needs a call; see §4.4.
11. **What happens to `akm-plugins/evals`?** A third eval surface this plan never mentions (tier2 deterministic plugin metrics against a fake-akm shim; tier3 LLM-judge scenarios). It holds akm's ranker constant so it does not overlap akm-bench, but ownership and CI wiring need a decision.
12. **Harbor version pin.** Every behavior above is **internal, not a documented contract** (`[metadata]` exclusion, agent-then-verifier ordering, reward parsing, one-level `-p` scanning), all read at v0.22.0/`39b8587`. Pin a version and add a CI check that re-verifies these on bump.

---

## 9. Risks

- **P0 fails.** Harbor invokes `opencode run` once per task; the plugin's per-prompt curation lands on the *next* turn, which never arrives. The treatment effect rides on the session-start curate (a pointer to a tmp file the model must read), the doctrine block, and the model choosing to call `akm_*` itself. If P0 shows no tool calls, the whole premise needs rework before any spend.
- **Analysis is the long pole, not execution.** ~8,500 LOC survives in akm-bench and every statistic is ours. A brief that reads as "delete it all" will produce a repo that runs benchmarks and cannot say anything about them.
- **Version pinning everywhere.** Harbor's default and akm-eval's setup both install `opencode-ai@latest`. Pin opencode-ai, akm-cli, akm-opencode, Harbor, and the dataset commit in **both** arms, set `OPENCODE_DISABLE_AUTOUPDATE=true`, and set the plugin kill switches (`AKM_AUTO_MEMORY=0` — memory harvest exits 78 without a configured LLM engine — and `AKM_INDEX_ON_SESSION_END=0`).
- **Determinism.** Use `AKM_EMBED_DETERMINISTIC=1` with `semanticSearchMode: "auto"` (384-dim feature hashing, offline, byte-identical across machines) so ranking deltas are attributable to akm source changes rather than embedding drift. Set `registries: []` to kill registry network. akm has **no** outbound analytics — nothing to opt out of.
- **Container traps** (verified live): `akm setup --dir /tmp/...` is refused without `AKM_FORCE_SETUP_TMP_STASH=1`; bare `akm setup` hard-fails on a non-TTY without `--yes`.
- **LoCoMo dataset quality is contested** (a 2026 third-party audit claims 6.4% of the answer key is wrong). Expect LoCoMo numbers to be challenged regardless of harness — which is why the protocol label in §6 is non-negotiable.
- **Image economics flip.** akm-bench today is one Docker image for the whole harness; Harbor's model is one environment image **per task**. Either publish a shared base image resolvable from cloud sandbox providers, or rebuild 46. Most cloud providers support Dockerfile-defined environments only, not compose.

---

## 10. Non-goals

- Building a fourth generic benchmark harness. The differentiator is the akm adapter plus the reproducibility manifest, not new metric code.
- Terminal-Bench 1.x comparisons (frozen, legacy `tb` CLI only).
- Making akm-eval run coding benchmarks, or akm-bench run memory benchmarks. The split in §1 is the point.
- Publishing to the TB2 leaderboard. Out of scope until P2 produces stable internal numbers.
