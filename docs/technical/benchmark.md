# akm-bench: Evaluation & Benchmarking Framework

**Status:** Implemented (v0.7.0+).
**Location:** `tests/bench/` (harness), `tests/fixtures/bench/` (corpus), `tests/fixtures/stashes/` (shared fixture stashes).
**Companion docs:** `docs/technical/v1-architecture-spec.md`, `tests/BENCHMARKS.md`.
**Companion repo:** [itlackey/akm-bench](https://github.com/itlackey/akm-bench) for the standalone benchmark and evaluation work that complements the in-repo harness described here.

## 1. Quick Start

Run the benchmarks:

```sh
# 5-task smoke test (~10 min)
bun run tests/bench/run-nano-quick.ts

# Full 40-task × 5-seed corpus on default model (qwen3.5-9b)
bun run tests/bench/run-full-bench.ts

# 9 targeted tasks (previously-failing or items 3-6 verification)
bun run tests/bench/run-waveg-targeted.ts
bun run tests/bench/run-items36-targeted.ts

# Bench doctor — harness health check
bun run tests/bench/doctor.ts
```

Model selection via `tests/fixtures/bench/opencode-providers.json` (or `.local.json` override). Default output goes to stderr (progress lines `[N/total] task-id arm pass|fail Xs`); JSON report to stdout. Redirect to a file:

```sh
bun run tests/bench/run-full-bench.ts > /tmp/bench-results-$(date +%s).log 2>&1 &
```

Two arms: `akm` (agent has stash access) and `noakm` (baseline). Targeted scripts often run `akm` arm only via `--no-noakm`. Current baseline (qwen3.5-9b, 2026-05-03): ~67% pass rate on 40 tasks (akm arm).

## 2. What this is and why

akm v1 ships three self-improvement surfaces — `feedback`, `reflect`, `propose`, `distill` — all funneled through a durable proposal queue that a human accepts. The existing `tests/benchmark-suite.ts` and `tests/ranking-regression.test.ts` are excellent at one specific job: validating that the search pipeline returns the right asset for a query, fast, with consistent scoring. They do not measure what the v1 self-improvement surfaces are actually for: making an agent *do its job better* over time.

This plan defines `akm-bench` — a sibling benchmark harness — that measures two questions:

1. **Marginal utility of akm.** Does an agent equipped with akm's stash and search resolve more tasks (and more efficiently) than the same agent without akm? This is the "should I install akm at all" signal.
2. **Self-improvement effectiveness.** After a defined evolution loop (use → feedback → distill → propose → accept), does the agent perform better on a held-out slice of tasks than the agent against the un-evolved stash? This is the "does the loop actually loop" signal.

A third question — "did this akm code change regress the above?" — is answered by running either bench on two branches and comparing. It doesn't need its own track. Contract-stability checks (event schema, prompt structure, lint rules) belong in `bun test` next to the existing `tests/architecture/` and `tests/proposed-quality.test.ts` suites, not in the bench.

The bench is run manually by the operator. It is not wired into CI. The framework produces JSON output and a markdown report, and a `compare` subcommand diffs two reports.

## 3. Methodology: State of the art (April 2026)

The framework draws on three lines of recent work, none of which fits akm directly but all of which shape the methodology.

**Paired evaluation against deterministic verifiers.** SkillsBench (Li et al., Feb 2026, 86 tasks across 11 domains) and SWE-Skills-Bench (Han et al., Mar 2026, 49 SWE skills × 565 task instances) both compare an agent on the *same* task with and without skill injection, using execution-based pytest verifiers rather than LLM-as-judge. Both find that skill injection benefits are highly variable: SWE-Skills-Bench reports 39 of 49 skills produce zero pass-rate improvement and three actually *degrade* performance by up to 10% due to context interference; SkillsBench reports +16.2pp average gain but with 16/84 tasks showing negative deltas. The methodological lesson: paired Docker-isolated runs with deterministic verifiers are the only way to get a clean delta, and the variance across tasks means individual deltas matter more than the average.

**Longitudinal test-time learning.** EvoTest (He et al., Oct 2025) and the Jericho Test-Time Learning (J-TTL) benchmark explicitly measure whether an agent improves *across consecutive episodes on the same task family*. This is the right shape for akm's self-improvement loop: episode 1 produces feedback events, distill produces a lesson proposal, an oracle (or human) accepts it, episode 2 sees the new lesson in search results. EvoTest, ReasoningBank (Sep 2025), Memento-Skills (Mar 2026), and SkillLearnBench (Apr 2026) all use a "first run vs. nth run" delta as the core metric. SkillLearnBench in particular evaluates skill-generation methods at three levels — skill quality, execution trajectory, and task outcome — which maps cleanly onto akm's distinction between proposal validation (lint), agent run trajectory, and final test pass.

**Outcome plus trajectory metrics.** Galileo's 2026 agent-evaluation guide and Vertex AI's `trajectory_exact_match` / `trajectory_precision` / `trajectory_recall` define a now-standard split: outcome metrics tell you *if* the agent worked, trajectory metrics tell you *why*. For akm specifically, trajectory metrics include "did the agent run `akm search` before generating code," "did it pull the correct asset," "did it write a feedback event after using it." These are cheap to compute from `events.jsonl` plus tool-call traces and they explain the outcome deltas.

**Reflective evaluators.** GEPA (Agrawal et al., ICLR 2026 oral) makes the case that collapsing execution traces to a scalar reward throws away the diagnostic signal. For akm-bench's reporting layer, this matters less than the metric design itself — but for the optional `akm-bench evolve` mode (using bench results to optimize akm's reflect/propose/distill prompts), GEPA's `dspy.Prediction(score=..., feedback=...)` shape is the right output contract.

The closest existing artifact in the akm repo is `tests/benchmark-suite.ts`, which measures the search subsystem in isolation. akm-bench is its sibling — it measures the agent-plus-akm system end-to-end.

## 4. v1 contract surfaces

Before designing new infrastructure, what's already there:

| Capability | Where | Status on `release/0.7.0` |
|---|---|---|
| Append-only events stream | `src/core/events.ts`, `events.jsonl` | shipped |
| Feedback event recording | `akm feedback <ref> --positive\|--negative` | shipped |
| Proposal queue (durable, per-id directory) | `src/core/proposals.ts`, `<stashRoot>/.akm/proposals/` | shipped (issue #225) |
| `reflect_invoked`, `propose_invoked`, `distill_invoked`, `promoted`, `rejected` events | `src/commands/{reflect,propose,distill,proposal}.ts` | shipped |
| Bounded in-tree LLM gate (`tryLlmFeature`) | `src/llm/feature-gate.ts` | shipped |
| Agent CLI shell-out wrapper | `src/integrations/agent/spawn.ts` (`runAgent`) | shipped |
| Built-in agent profiles (opencode, claude, codex, gemini, aider) | `src/integrations/agent/profiles.ts` | shipped |
| Lesson asset type with required `description` and `when_to_use` | `src/core/lesson-lint.ts` | shipped |
| `quality: "proposed"` excluded from default search | `src/indexer/metadata.ts` (`isProposedQuality`) | shipped (issue #224) |
| Search ranking regression tests | `tests/ranking-regression.test.ts` | shipped |
| Search-quality benchmark | `tests/benchmark-suite.ts`, `tests/benchmark-search-quality.ts` | shipped |

All pieces are now implemented:

- **Task corpus with ground-truth verifiers:** `tests/fixtures/bench/tasks/` — deterministic pytest/script/regex verifiers. 40+ tasks across 6 domains (docker-homelab, az-cli, inkwell, opencode, litellm-manager, etc.).
- **Fixture stashes:** `tests/fixtures/stashes/<name>/` — reusable curated asset bundles referenced by name from both bench tasks and unit tests. Shared `loadFixtureStash()` helper in `tests/fixtures/stashes/load.ts`. MANIFEST.json in each fixture declares purpose and consumers.
- **Opencode harness:** `tests/bench/driver.ts` — runs with akm enabled and disabled, model-configurable via `tests/fixtures/bench/opencode-providers.json`.
- **Multi-episode driver:** `tests/bench/run-*-bench.ts` scripts drive the full evaluation loop.
- **JSON + markdown output:** structured reporting with aggregation, per-task breakdown, trajectory metrics, attribution analysis.
- **Compare subcommand:** diff two runs, refuse cross-model comparisons, surface deltas.

The framework is stable and requires no further v1 contract modifications.

## 5. Fixture validity principle

All stash assets in the benchmark corpus must teach *HOW* (syntax, schema, patterns, examples), never *WHAT* (task-specific values that would give away the answer).

**Good:** A skill documenting docker-compose healthcheck patterns with examples, redis-cli usage, and general port-health idioms.
**Bad:** A skill that says "the answer to the redis-healthcheck task is `healthcheck: { test: redis-cli ping }`."

The same discipline applies to knowledge docs, commands, and agents in fixture stashes. The corpus review process checks for this at task-creation time to prevent data leakage. If an asset revision would leak answers, it's edited or moved out of scope.

## 6. Two benchmark tracks

`akm-bench` ships as two tracks with one shared driver. Each track answers exactly one of the questions in §1.

### 6.1 Track A — Marginal utility

**Question:** With the same model, harness, task, and seed, does giving the agent akm change resolve rate and/or token economics?

**Shape:** classic paired evaluation, lifted from SWE-Skills-Bench and SkillsBench. For each task `t` in the corpus, run two arms:

- `noakm`: the agent gets the task description and a code workspace, no akm.
- `akm`: same agent, same task, plus a curated akm stash containing one or more assets relevant to `t`, plus the `AGENTS.md` snippet that teaches it `akm search`/`akm show`/`akm feedback`.

Each arm is run `K` times (default 5) with different seeds. The verifier is deterministic (`pytest`, exit-code, file-exists, regex match on output, etc.) — never LLM-as-judge — so per-run pass/fail is unambiguous.

**Primary metrics:**
- `delta_pass_rate = pass_rate(akm) − pass_rate(noakm)` (per task and aggregate).
- `delta_tokens` and `delta_wallclock` (akm − noakm). Negative = win.
- `tokens_per_resolved_task` (akm vs noakm).

**Trajectory metrics (cheap, parsed from event stream + agent stdout):**
- `searched_before_writing` — fraction of `akm` runs where the agent invoked `akm search` before its first code edit.
- `loaded_correct_asset` — fraction where the agent ran `akm show` on the gold asset for the task.
- `recorded_feedback` — fraction where the agent recorded an `akm feedback` event.

Trajectory metrics are not pass/fail but they explain pass-rate deltas. If `delta_pass_rate ≤ 0` and `loaded_correct_asset` is also low, the agent isn't using akm — that's an akm UX problem, not a "akm doesn't help" finding.

### 6.2 Track B — Self-improvement effectiveness

**Question:** Does the feedback → distill → propose → accept loop produce assets that measurably improve the agent on a held-out slice?

**Shape:** longitudinal, two-phase. Borrows directly from EvoTest's J-TTL setup and SkillLearnBench's three-level evaluation.

**Phase 1 — accumulate signal.** Run the agent on a *training slice* of tasks. The agent uses akm normally, including `akm feedback ±` after each task (positive on resolved, negative on failed). The benchmark driver records all events.

**Phase 2 — evolve.** For each asset that received negative feedback above a threshold (default: 2+ negatives or a negative-to-positive ratio above 0.5), the driver runs:

```sh
akm distill <ref>            # produces a lesson proposal
akm reflect <ref>            # produces a revision proposal (if agent.default is set)
```

Proposals are then accepted via `akm proposal accept <id>` by the bench harness — every proposal that passes lesson lint and queue validation is accepted; everything else is rejected. The accepted lessons land at `lesson:<slug>` with `quality: "curated"`, the original assets get their revised versions, and the index is rebuilt.

**Phase 3 — re-evaluate.** Run the agent on a held-out *test slice* of tasks (same domain distribution as training, no overlap) under three conditions:
- `pre`: the original stash, before any evolution.
- `post`: the evolved stash, with new lessons and revised assets.
- `synthetic`: a "synthetic skills" baseline where the agent is asked to write its own helper notes before each task and consume them during it (per SkillsBench's "Bring Your Own Skills" condition).

**Primary metric:** `improvement_slope = pass_rate(post) − pass_rate(pre)` on the held-out slice. SkillLearnBench's three-level breakdown applies:
- **Skill quality** (proposal level): lesson lint pass rate, frontmatter completeness, semantic coverage of feedback signals.
- **Trajectory** (run level): for the held-out tasks, how often does the agent now load the new lesson? How does its tool-call sequence change?
- **Outcome** (task level): pass rate, tokens, wallclock — same as Track A.

**Secondary metric:** `degradation_count` — number of held-out tasks where `post` *underperforms* `pre`. Per SWE-Skills-Bench's findings, distilled lessons can interfere with adjacent contexts; we want to catch those.

The `synthetic` baseline matters because SkillsBench's headline finding is that models can't reliably author their own procedural knowledge. If `post` doesn't beat `synthetic` by a meaningful margin, akm's distillation isn't contributing more than free-form scratchpad notes would.

## 7. Architecture

### 7.1 Directory layout (implemented)

The harness lives entirely under `tests/bench/` and `tests/fixtures/bench/`. No new top-level directory; no source changes outside `tests/`. This matches the existing `tests/benchmark-suite.ts` placement and keeps the contract surface tight.

```
tests/
  bench/
    BENCH.md                 # operator guide; sibling of BENCHMARKS.md
    cli.ts                   # `bun run tests/bench/cli.ts <track> [...]`
    driver.ts                # task runner + opencode harness
    corpus.ts                # task loader, slice splitter (train/eval)
    verifier.ts              # script | pytest | regex dispatcher
    metrics.ts               # outcome, trajectory, longitudinal, attribution, etc.
    report.ts                # JSON output, markdown render, two-run compare
  fixtures/
    stashes/                 # SHARED — used by bench AND by tests/*.test.ts
      <name>/
        MANIFEST.json        # purpose, asset count, intended consumers
        skills/ commands/ agents/ knowledge/ ...   # standard akm stash layout
    bench/
      tasks/
        <domain>/
          <task-id>/
            task.yaml        # metadata: title, slice, gold_ref, stash, verifier
            workspace/       # initial files for the agent's cwd
            verify.sh        # deterministic verifier
```

Seven files under `tests/bench/`, one shared fixture tree, one bench-specific fixture tree. The shared `fixtures/stashes/` directory is the architectural shift in this revision — see §5.5.

### 7.2 The driver (`tests/bench/driver.ts`)

The driver is the only thing that orchestrates a run. Its job is small and well-bounded so the same code powers all three tracks:

```ts
export interface RunOptions {
  track: "utility" | "evolve";
  arm: "noakm" | "akm" | "post-evolve" | "synthetic";
  taskId: string;
  workspace: string;       // ephemeral tmp dir, cwd for the agent
  stashDir?: string;       // omitted for noakm
  model: string;           // e.g. "anthropic/claude-opus-4-7" or "ollama/qwen3:8b"
  seeds: number[];         // K runs per (task, arm)
  budgetTokens: number;
  budgetWallMs: number;
}

export interface RunResult {
  schemaVersion: 1;
  taskId: string;
  arm: string;
  seed: number;
  model: string;
  outcome: "pass" | "fail" | "budget_exceeded" | "harness_error";
  tokens: { input: number; output: number };
  wallclockMs: number;
  trajectory: TrajectoryRecord;
  events: EventEnvelope[];   // copied from the run's events.jsonl
  verifierStdout: string;
  verifierExitCode: number;
}
```

The driver invokes opencode through `runAgent` with the existing built-in `opencode` profile from `src/integrations/agent/profiles.ts`. No new harness abstraction — `runAgent` is the abstraction. Model selection rides on `BENCH_OPENCODE_MODEL`:

```sh
BENCH_OPENCODE_MODEL=anthropic/claude-opus-4-7 bun run tests/bench/cli.ts utility
BENCH_OPENCODE_MODEL=anthropic/claude-haiku-4-5 bun run tests/bench/cli.ts utility --tasks docker-homelab
BENCH_OPENCODE_MODEL=ollama/qwen3:8b           bun run tests/bench/cli.ts evolve
```

Per-run isolation is enforced by env: `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `AKM_STASH_DIR`, and `OPENCODE_CONFIG` all point at fresh tmpdirs so two parallel runs never collide and the operator's personal opencode/akm config is never touched. Each run's `events.jsonl` lives in its own cache dir so trajectory parsing reads only what this run produced.

Hard budgets via `budgetTokens` / `budgetWallMs` use `runAgent`'s existing timeout. A run that exceeds either is recorded as `budget_exceeded` — a distinct outcome from `fail`, so cost regressions stay visible.

The model string is stamped into every `RunResult` and every aggregate report. `bench compare` refuses to diff two reports run on different models and prints the mismatch instead.

### 7.3 Verifier (`tests/bench/verifier.ts`)

One dispatcher, three verifier kinds:

| Kind | Trigger | Mechanism |
|---|---|---|
| `script` | task has `verify.sh` | spawn the script in the workspace, exit code = pass/fail |
| `pytest` | task has `tests/test_*.py` | `pytest -q --tb=line` exit code |
| `regex` | task has `expected_match` in `task.yaml` | regex over the agent's final stdout |

This mirrors SWE-Skills-Bench's "deterministic verifiers" rule. **No LLM-as-judge anywhere in the verifier path.** Trajectory metrics may use string parsing on the event stream but never an LLM to score outcomes — the published failure rate of LLM judges (>50% per Galileo's 2026 review) makes them unsuitable for measurement, and "let the agent grade itself" defeats the whole point.

### 7.4 Corpus & slicing (`tests/fixtures/bench/tasks/`)

Tasks are loaded from `tests/fixtures/bench/tasks/<domain>/<task-id>/`. Each task declares:

```yaml
# task.yaml
id: docker-homelab/redis-healthcheck
title: "Add a healthcheck to the Redis service"
domain: docker-homelab
difficulty: easy           # easy|medium|hard, used for stratified sampling
slice: train               # train|eval
gold_ref: skill:docker-homelab    # the asset that should help if loaded
stash: docker-homelab      # references tests/fixtures/stashes/docker-homelab/
verifier: pytest
budget:
  tokens: 30000
  wallMs: 120000
```

The `stash:` field references a fixture stash by name (see §5.5). Tasks no longer carry their own per-task stash directory — that approach duplicated content and let asset versions drift between tasks targeting the same domain. A task may override with `stash_overlay:` to add extra assets on top of a fixture, but the base must be a named fixture.

The corpus loader produces two slices, deterministically partitioned by `id` hash so two operators get the same split. `train` is used by Track B Phase 1 (signal accumulation); `eval` is used by Track A and by Track B Phase 3. A held-out third slice is overkill for an internal corpus that's manually reviewed for leakage at task-creation time — anything intricate enough to need cross-validation belongs in a public benchmark, which is post-v1.

Initial corpus targets ~30 tasks across 4-6 domains the user already has fixtures for — docker-homelab, az-cli, litellm-manager, opencode are obvious starting points. Each domain contributes 6-10 tasks split roughly 50/50 train/eval. The corpus is meant to grow; the format is the contract, the count is not.

### 7.5 Fixture stashes (`tests/fixtures/stashes/`)

A reusable fixture stash is a curated, hand-authored bundle of akm assets that lives at `tests/fixtures/stashes/<name>/` and can be referenced by name from any test or bench task. This is the cross-cutting artifact the rest of the framework depends on.

**Why they exist.** Two failure modes the current akm test tree already exhibits:

1. `tests/ranking-fixtures/stash/` is a 17-asset stash used by `ranking-regression.test.ts` and `benchmark-suite.ts` only. It's not reachable from anywhere else, so a unit test that wants "a docker-y stash" hand-rolls one inline and gets out of sync with the version the search benchmark verifies against.
2. Per-task stashes in the original bench design duplicate `skill:docker-homelab` content across every task that uses it. When the user updates the docker-homelab skill, ten tasks need editing.

A shared fixture-stash directory fixes both. The bench references a stash by name (`stash: docker-homelab` in `task.yaml`); a unit test references the same stash via a helper (`loadFixtureStash("docker-homelab")`). One source of truth.

**Layout.** Each fixture stash is a directory with the standard akm stash structure plus a `MANIFEST.json`:

```
tests/fixtures/stashes/docker-homelab/
  MANIFEST.json
  skills/
    docker-homelab/
      SKILL.md
      .stash.json
  knowledge/
    healthcheck-patterns.md
    .stash.json
  ...
```

`MANIFEST.json` declares purpose, asset count, and intended consumers — so a future maintainer can read it and know whether removing an asset will break a search-quality test, a Track A benchmark task, or both:

```json
{
  "name": "docker-homelab",
  "description": "Curated skills and knowledge for docker-compose-based homelab management.",
  "purpose": "Used by bench tasks under domain=docker-homelab and by ranking tests for docker queries.",
  "assets": { "skill": 1, "knowledge": 4, "command": 0 },
  "consumers": [
    "tests/bench/fixtures/tasks/docker-homelab/*",
    "tests/ranking-regression.test.ts (docker-* cases)"
  ]
}
```

**Initial set.** Five fixtures cover the v1 surface area:

| Name | Purpose |
|---|---|
| `minimal` | Tiny (5 assets). For unit tests that just need *some* stash to exist. |
| `docker-homelab` | The user's actual docker-homelab skill plus 3-4 supporting knowledge docs. Production-realistic. |
| `az-cli` | Same shape, az-cli domain. |
| `multi-domain` | ~30 assets across 6 domains. Track A's primary fixture for testing search across overlapping vocabularies. |
| `noisy` | `multi-domain` plus 10-15 deliberately irrelevant assets. Used to test that ranking robustness holds when the stash isn't pristine. |

`tests/ranking-fixtures/stash/` migrates into this layout as `tests/fixtures/stashes/ranking-baseline/` with its current asset content preserved. The migration is mechanical — a single move plus updating two import paths in `ranking-regression.test.ts` and `benchmark-suite.ts`.

**Shared helper.** `tests/fixtures/stashes/load.ts` exports one function that copies a fixture stash into a temp directory, sets `AKM_STASH_DIR`, and runs `akm index` so callers get a ready-to-search stash:

```ts
import { loadFixtureStash } from "../fixtures/stashes/load";

const { stashDir, cleanup } = await loadFixtureStash("docker-homelab");
// ... run search, assertions, etc.
cleanup();
```

The bench driver uses the same helper, so identical content is loaded the same way regardless of consumer.

**Versioning rule.** Fixture stashes are content under version control. Any change to a fixture invalidates baseline benchmark results that referenced it — `bench compare` checks the fixture-content hash and refuses to compare runs across fixture changes. This is the same discipline `tests/ranking-fixtures/` already implies but doesn't enforce.

## 8. Metrics catalog

### 8.1 Outcome metrics

All outcome metrics aggregate over `K` seeds per (task, arm) and produce a per-task value plus a corpus-wide aggregate.

| Metric | Definition | Higher is |
|---|---|---|
| `pass_rate` | fraction of seeds where verifier exits 0 | better |
| `pass@1` | per-task pass rate at seed=0 (single-shot) | better |
| `tokens_per_pass` | `(tokens_in + tokens_out) / passes`, mean over seeds | lower better |
| `wallclock_ms` | mean over seeds | lower better |

`pass@1` is the headline — it's the single-shot experience the user actually feels. `pass_rate` over K seeds smooths model noise.

### 8.2 Trajectory metrics

Computed by parsing `events.jsonl` and the agent's tool-call output. None of these affect pass/fail; they exist to *explain* pass-rate deltas.

| Metric | Definition |
|---|---|
| `correct_asset_loaded` | did `akm show <gold_ref>` appear in the trace? |
| `feedback_recorded` | did an `akm feedback` event land in events.jsonl? |

Trajectory metrics are reported next to outcome metrics — never instead of them. If `delta_pass_rate ≤ 0` and `correct_asset_loaded` is also low, the agent isn't using akm — that's an akm UX problem, not a "akm doesn't help" finding. The two metrics here are the minimum needed to make that distinction; richer trace analysis is post-v1.

### 8.3 Proposal-quality metrics (Track B only)

For each proposal produced during Phase 2:

| Metric | Definition |
|---|---|
| `lint_pass` | proposal passes `lintLessonContent` (for lessons) or schema validation |
| `accepted` | did `akm proposal accept` succeed? |

These are *quality* metrics for the proposal itself, distinct from whether the resulting accepted asset improves agent performance. SkillLearnBench's three-level evaluation insists on this separation and it matters: a lesson can be well-formed (high `lint_pass`) but useless (low `improvement_slope`), or scrappy but transformative — both failure modes are real and they need different fixes.

### 8.4 Longitudinal metrics (Track B only)

| Metric | Definition |
|---|---|
| `improvement_slope` | `pass_rate(post) − pass_rate(pre)` on the eval slice |
| `degradation_count` | eval tasks where `post` underperforms `pre` by > 1 seed |
| `over_synthetic_lift` | `pass_rate(post) − pass_rate(synthetic)` |
| `acceptance_rate` | accepted / (accepted + rejected) — quality signal on what the LLM produces |

**Acceptance is auto-accept only.** Every proposal that passes lesson lint and proposal validation is accepted; everything else is rejected. This is a deliberate scoping choice: the bench measures the loop as a system, mixing in human judgment would make runs unrepeatable. The reported number is "what would the loop produce if every lint-passing proposal were accepted" — operators reading the report should interpret it accordingly. Human-in-the-loop is out of scope (see §11).

`over_synthetic_lift` is the keystone metric for Track B. If `post` doesn't beat `synthetic`, akm's distill/reflect/propose machinery is, on this corpus, no better than asking the agent to take its own notes. That's a finding worth knowing — it tells the user where to invest improvement effort.

### 8.5 Attribution metrics (per-asset diagnostics)

The §6.1-6.4 metrics produce aggregate scores. Aggregate scores tell you whether akm is helping; they don't tell you *which assets* in the stash are doing the work. SWE-Skills-Bench's headline finding — 39 of 49 public skills produced zero pass-rate improvement — applies to any skill library, including the operator's. Without per-asset attribution, the bench can't drive curation decisions.

Two complementary signals, both cheap:

| Metric | Definition |
|---|---|
| `load_pass_rate` (per asset) | among runs where the agent loaded this asset, what fraction passed? |
| `load_count_passing` / `load_count_failing` (per asset) | raw counts split by run outcome — sample size for the rate above |
| `marginal_pass_contribution` (per asset) | `pass_rate(akm with asset) − pass_rate(akm without asset)` from a targeted leave-one-out re-run |

`load_pass_rate` and the count split come for free from existing trajectory telemetry — pure post-processing on the JSON the bench already produces. The output is a per-asset table sorted by load count and load_pass_rate, which surfaces both "well-used assets that work" and "well-used assets that don't" without any extra runs.

`marginal_pass_contribution` requires running the corpus with one asset masked from the stash. Doing this for every asset in a 30-asset fixture is 30× the corpus cost, which is too much. Instead, the bench exposes `bench attribute --base <run.json> --top N` that consumes a previous Track A run, picks the N most-loaded assets (default 5), and re-runs the corpus N times with each one masked in turn. Cost is bounded; signal targets the assets that would matter if removed.

The attribution output is the single most actionable artifact the bench produces: a sorted list of assets whose removal *would* reduce pass rate (keep them, possibly improve them) and assets whose removal *wouldn't* (candidates for deletion, consolidation, or reflection-driven rewrite).

### 8.6 Failure-mode taxonomy (per-task diagnostics)

A failed task in the akm arm currently produces one bit (`outcome: "fail"`) plus the verifier's stdout. That bit can hide several distinct failure modes that demand different fixes:

| Failure mode | Trace signature | What to fix |
|---|---|---|
| `no_search` | no `akm search` call in the trace | AGENTS.md guidance — the agent didn't even reach for akm |
| `search_no_gold` | search ran, gold ref absent from results | indexer / search ranking in `src/indexer/` |
| `search_low_rank` | gold ref present at rank > 5 in search results | ranking boosts in `src/indexer/scoring/` |
| `loaded_wrong` | `akm show` on non-gold ref before action; gold ref never loaded | search description / disambiguation, asset metadata |
| `loaded_ignored` | gold ref loaded, but action contradicts its content | prompt design or asset format — agent saw it and didn't follow |
| `followed_wrong` | gold ref loaded and followed, verifier still failed | the asset itself is wrong — distill/reflect target |
| `unrelated_bug` | gold ref loaded and followed correctly, but agent failed elsewhere | task design or model capability — not an akm problem |

Classification is mechanical — string-matching on `events.jsonl` and the agent's tool-call output, no LLM judge. Each failed run is tagged with exactly one of these labels. The corpus-wide breakdown becomes a sorted to-do list: if 40% of failures are `no_search`, that's an AGENTS.md problem; if 40% are `followed_wrong`, that's an asset-quality problem and Track B should be improving it.

The same taxonomy applies to Track B's `degradation_count` — when `post` underperforms `pre` on a specific eval task, the failure-mode tag tells you whether the regression is from a low-quality lesson (`followed_wrong` flips), context interference (`loaded_wrong` shifts), or unrelated noise.

### 8.7 Search-pipeline bridge

`tests/benchmark-suite.ts` measures MRR and Recall@K against synthetic queries on the `ranking-baseline` fixture. akm-bench measures pass rate against real tasks. The two are completely disconnected — when search MRR moves from 0.92 to 0.95, there's currently no way to know whether the change translates to any task-level lift, or whether agents are robust to ranking slop above rank 3.

The bridge is built from data the bench already collects. For each `akm search` invocation in a real run, log the query, the result list, and the rank of the gold ref (when present). Aggregate over the corpus:

| Metric | Definition |
|---|---|
| `gold_rank_distribution` | histogram of rank-of-gold-ref across all real searches that should have surfaced one |
| `gold_rank_p50` / `p90` | median and p90 rank |
| `gold_at_rank_1` | fraction of searches where gold was at rank 1 |
| `gold_missing` | fraction of searches where gold wasn't in the top 10 |
| `pass_rate_by_rank` | pass rate of runs split by where the gold ref appeared in *the search the agent actually ran* |

The last metric is the bridge. It answers: "if the gold ref was at rank 1, did the agent succeed more than when it was at rank 4?" If yes, ranking improvements above rank-3 actually move outcomes. If not, the agent is robust to rank slop and tuning effort should go elsewhere. Either result is actionable; without this metric, search-pipeline changes get evaluated against synthetic MRR deltas that may or may not matter.

### 8.8 Feedback-signal integrity (Track B only)

Track B's entire loop assumes the agent's `akm feedback ±` calls are accurate. If the agent records `--positive` on a task it actually failed, distillation processes garbage and `improvement_slope` is built on noise. The bench currently has no check for this.

The check is a 2×2 confusion matrix joining each `feedback` event with the verifier outcome of the same run, per asset and corpus-wide:

|  | verifier passed | verifier failed |
|---|---|---|
| `feedback +` | true positive | **false positive** |
| `feedback −` | **false negative** | true negative |

| Metric | Definition |
|---|---|
| `feedback_agreement` | (TP + TN) / total feedback events |
| `false_positive_rate` | FP / (FP + TN) — agent said "this helped" when run failed |
| `false_negative_rate` | FN / (FN + TP) — agent said "this didn't help" when run succeeded |
| `feedback_coverage` | fraction of runs that recorded any feedback at all |

Reported per-asset and aggregate. If `feedback_agreement` < 80%, Track B's input signal is noisy and the headline `over_synthetic_lift` number is unreliable until the AGENTS.md guidance gets tightened. This is the metric that protects the integrity of every other Track B number.

## 9. Isolation and reproducibility

### 9.1 Tmpdirs + env isolation (no Docker required)

Each run uses tmpdirs and per-process env isolation; Docker is not required. `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `AKM_STASH_DIR`, and `OPENCODE_CONFIG` all point at fresh tmpdirs so two parallel runs never collide and the operator's personal config is never touched. Verifiers shell out to `pytest` / `bash` in the workspace; if a task's verifier needs a runtime that isn't on the operator's machine, that task is skipped with a clear message.

Operators who want stronger isolation can wrap the run in `docker run` themselves — the bench is just a Bun process reading and writing tmpdirs, it doesn't care. Containerizing the full corpus is a Phase-3+ activity tied to publishing the corpus externally.

### 9.2 Seed and budget discipline

Every run carries an explicit seed (default: `0..K-1` where K=5) recorded in the output. opencode-and-LLM combinations don't honor seeds meaningfully — the seed is logged for traceability but real reproducibility comes from K-seed averaging. Budgets are hard: `budgetTokens` and `budgetWallMs` are enforced via `runAgent`'s existing timeout. The `budget_exceeded` outcome is *not* a fail — it's a third state so cost regressions don't hide as quality regressions.

### 9.3 Model selection is part of the run identity

Because outcome metrics are model-dependent, the model string is stamped into every output and `bench compare` refuses to diff runs that used different models. The recovery path is "rerun on the same model" — `bench compare` prints the mismatch so the operator knows what to do.

### 9.4 Data leakage prevention

Following SkillsBench's leakage audit and SWE-Bench Pro's contamination principles:

- Tasks are **not** drawn from public benchmarks. The corpus is small and originates in the user's own domains (docker-homelab, az-cli, etc.) where the agent's training data is unlikely to contain the exact `verify.sh` semantics.
- Gold assets in the curated stash are **not** identical to the verifier — a skill that documents docker-compose patterns is fine; a skill that says "the answer to `redis-healthcheck` is `healthcheck: { test: redis-cli ping }`" is a leak. The corpus reviewer checks for this.
- Eval-slice tasks are excluded from any LLM-visible content the akm stash provides during distillation. The driver enforces this by stash-rebuilding between Phase 1 and Phase 3 with the eval slice's gold-ref content stripped, so the agent can't be asked to "distill a lesson from feedback on a task it's about to be re-tested on."

## 10. Integration with v1 test infrastructure

The benchmark reuses existing akm contract surfaces:

- **Fixture stashes shared with unit tests:** `tests/ranking-regression.test.ts` and `tests/benchmark-suite.ts` both use `loadFixtureStash()` helper to reference the same assets the bench runs against. One source of truth.
- **Event stream and proposal queue:** bench consumes the same `events.jsonl` and proposal validation that `src/core/events.ts` and `src/core/proposals.ts` provide.
- **Agent profiles:** bench reuses the locked `opencode` profile from `src/integrations/agent/profiles.ts` rather than defining its own harness.
- **Deterministic verifiers:** no LLM-as-judge anywhere. Tasks use `pytest`, bash scripts, or regex matching — same discipline as the existing search benchmarks.

**K=5 seeds + per-task reporting.** Results are non-deterministic with LLMs; K=5 seeds per task+arm with per-task variance reporting lets operators see which tasks are stable signal vs. flaky. The bench runs manually when measurement is needed, not per-PR.

**Corpus quality via leakage review.** The corpus is small and user-authored; every task is reviewed at creation for answer leakage (§5). Deterministic verifiers only (no LLM-as-judge).

**Auto-accept scoping choice.** Track B accepts all lint-passing proposals automatically; mixing human judgment would break reproducibility. The number reported is "what the loop produces under auto-accept" — operators interpret accordingly. Human review is post-v1.

**No new dependencies.** Bench is pure Bun + stdlib + existing packages. Verifiers shell out to `pytest` / bash. No Docker required for v1.

## 12. Out of scope for v1

Listed explicitly so the boundary is clear:

- **CI integration.** The bench is run manually by the operator. No GitHub Actions, no scheduled runs. The contract-stability checks that *do* belong in CI live in `bun test` (existing `tests/architecture/`, `tests/proposed-quality.test.ts`).
- **LLM-as-judge for outcomes.** Trajectory string-matching only. If a task can't be expressed as a deterministic verifier, it doesn't go in the corpus.
- **Human-in-the-loop accept mode.** Auto-accept only.
- **Cross-model comparison.** The bench measures akm under one model at a time. `bench compare` refuses to diff runs that used different models.
- **Alternative agent harnesses.** opencode is the harness. Other tools (Claude Code, Cursor, Aider) have built-in profiles in `src/integrations/agent/profiles.ts` and could be plugged in post-v1.
- **Docker-isolated runs.** Tmpdirs and env isolation only. Operators wanting tighter isolation wrap the run in `docker run` themselves.
- **Public leaderboard / corpus.** Internal only for v1.
- **MCP-server wrapping.** Bench is CLI in / JSON out, like the rest of akm.

## 13. Future enhancements (post-v1)

- **Per-seed variance metrics.** Flag flaky tasks (stdev > 0.2) that need verifier hardening. Data is already collected.
- **Token decomposition by akm phase.** Split `tokens_per_pass` across search-prompt, show-content, action-prompt to validate "every token earns its place."
- **Run-trace persistence.** Optionally dump full opencode session logs for deep-dive debugging of specific failures.
- **Prompt-optimization feedback loop.** Wrap bench signal in GEPA (ICLR 2026) to auto-tune akm's own reflect/propose/distill prompts against real-world data.
- **Multi-objective reporting.** Render Pareto fronts across (pass rate, tokens, wallclock) to surface cost-quality tradeoffs.
- **Public corpus contribution.** Factor sanitized tasks into an akm registry kit for external users to run and contribute back.
- **Human-in-the-loop accept gate.** Measure gap between auto-accept slope and human-curated slope to quantify human reviewer value.
- **Cross-model evaluation matrix.** Run same corpus on multiple models to measure (model × akm) interaction: do gains concentrate on frontier, small, or all tiers equally?

## 14. Reference: task schemas

### 14.1 `task.yaml` schema

```yaml
id: <domain>/<task-name>           # required, unique, kebab-case
title: <one line>                  # required
domain: <domain-slug>              # required, matches a directory under fixtures/bench/tasks/
difficulty: easy | medium | hard   # required
slice: train | eval                # required
gold_ref: <asset-ref>              # optional; the asset that should help
stash: <fixture-name>              # required; references tests/fixtures/stashes/<n>/
stash_overlay: <relative-path>     # optional; extra assets to add on top of the named fixture
verifier: pytest | script | regex  # required
expected_match: <regex>            # required if verifier=regex
budget:
  tokens: <int>                    # required
  wallMs: <int>                    # required
metadata:                          # optional, free-form
  notes: ...
```

### 14.2 Sample task

`tests/fixtures/bench/tasks/docker-homelab/redis-healthcheck/task.yaml`:

```yaml
id: docker-homelab/redis-healthcheck
title: "Add a Redis healthcheck to the homelab compose stack"
domain: docker-homelab
difficulty: easy
slice: eval
gold_ref: skill:docker-homelab
stash: docker-homelab
verifier: pytest
budget:
  tokens: 25000
  wallMs: 90000
```

`workspace/docker-compose.yml` (initial state):
```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

`tests/test_redis_health.py`:
```python
import yaml, pathlib

def test_redis_has_healthcheck():
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    redis = compose["services"]["redis"]
    assert "healthcheck" in redis
    assert "test" in redis["healthcheck"]
    assert "redis-cli" in str(redis["healthcheck"]["test"])
```

The `akm` arm loads `tests/fixtures/stashes/docker-homelab/` (containing the docker-homelab skill plus 3-4 supporting knowledge docs). The `noakm` arm sees only the workspace. Both arms run identical agents, identical seeds, identical budgets — only the stash differs.

Per-task expected behavior:
- `noakm` arm: agent guesses a healthcheck shape; pytest passes if the guess includes `redis-cli`. Expected pass rate: medium.
- `akm` arm: agent runs `akm search "redis healthcheck docker-compose"`, loads `skill:docker-homelab`, follows the documented pattern. Expected pass rate: high.
- Track B: if the `noakm` arm fails enough times that the skill receives `--negative` feedback, distill produces a lesson clarifying the healthcheck pattern. Phase 3 re-evaluation should show pass rate climbing on this task and similar ones.

### 14.3 Sample run output (Track A)

```jsonc
{
  "schemaVersion": 1,
  "track": "utility",
  "branch": "release/0.7.0",
  "commit": "6ffc762",
  "timestamp": "2026-04-27T12:00:00Z",
  "agent": { "harness": "opencode", "model": "anthropic/claude-opus-4-7" },
  "corpus": { "domains": 6, "tasks": 30, "slice": "eval", "seedsPerArm": 5 },
  "aggregate": {
    "noakm":  { "pass_rate": 0.42, "tokens_per_pass": 18450, "wallclock_ms": 41200 },
    "akm":    { "pass_rate": 0.71, "tokens_per_pass": 14900, "wallclock_ms": 36800 },
    "delta":  { "pass_rate": 0.29, "tokens_per_pass": -3550, "wallclock_ms": -4400 }
  },
  "trajectory": {
    "akm": {
      "searched_before_acting":   0.93,
      "correct_asset_loaded":     0.78,
      "irrelevant_assets_loaded": 0.12,
      "feedback_recorded":        0.65
    }
  },
  "tasks": [ /* per-task breakdown */ ],
  "warnings": []
}
```

This shape feeds directly into `bench compare`, which produces the side-by-side diff that goes in PR descriptions.

---

*End of plan. Open questions go in PR review on this document; implementation begins after Phase 1 sign-off.*
