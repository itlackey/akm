# akm-bench: Evaluation & Benchmarking Framework — Detailed Plan

**Status:** Proposal (2026-04-27).
**Target branch:** `release/1.0.0`.
**Companion docs:** `docs/technical/v1-architecture-spec.md`, `docs/reviews/v1-agent-reflection-issues.md`, `tests/BENCHMARKS.md`.

## 1. What this is and why

akm v1 ships three self-improvement surfaces — `feedback`, `reflect`, `propose`, `distill` — all funneled through a durable proposal queue that a human accepts. The existing `tests/benchmark-suite.ts` and `tests/ranking-regression.test.ts` are excellent at one specific job: validating that the search pipeline returns the right asset for a query, fast, with consistent scoring. They do not measure what the v1 self-improvement surfaces are actually for: making an agent *do its job better* over time.

This plan defines `akm-bench` — a sibling benchmark harness — that measures two questions:

1. **Marginal utility of akm.** Does an agent equipped with akm's stash and search resolve more tasks (and more efficiently) than the same agent without akm? This is the "should I install akm at all" signal.
2. **Self-improvement effectiveness.** After a defined evolution loop (use → feedback → distill → propose → accept), does the agent perform better on a held-out slice of tasks than the agent against the un-evolved stash? This is the "does the loop actually loop" signal.

A third question — "did this akm code change regress the above?" — is answered by running either bench on two branches and comparing. It doesn't need its own track. Contract-stability checks (event schema, prompt structure, lint rules) belong in `bun test` next to the existing `tests/architecture/` and `tests/proposed-quality.test.ts` suites, not in the bench.

The bench is run manually by the operator. It is not wired into CI. The framework produces JSON output and a markdown report, and a `compare` subcommand diffs two reports.

## 2. State of the art (April 2026)

The framework draws on three lines of recent work, none of which fits akm directly but all of which shape the methodology.

**Paired evaluation against deterministic verifiers.** SkillsBench (Li et al., Feb 2026, 86 tasks across 11 domains) and SWE-Skills-Bench (Han et al., Mar 2026, 49 SWE skills × 565 task instances) both compare an agent on the *same* task with and without skill injection, using execution-based pytest verifiers rather than LLM-as-judge. Both find that skill injection benefits are highly variable: SWE-Skills-Bench reports 39 of 49 skills produce zero pass-rate improvement and three actually *degrade* performance by up to 10% due to context interference; SkillsBench reports +16.2pp average gain but with 16/84 tasks showing negative deltas. The methodological lesson: paired Docker-isolated runs with deterministic verifiers are the only way to get a clean delta, and the variance across tasks means individual deltas matter more than the average.

**Longitudinal test-time learning.** EvoTest (He et al., Oct 2025) and the Jericho Test-Time Learning (J-TTL) benchmark explicitly measure whether an agent improves *across consecutive episodes on the same task family*. This is the right shape for akm's self-improvement loop: episode 1 produces feedback events, distill produces a lesson proposal, an oracle (or human) accepts it, episode 2 sees the new lesson in search results. EvoTest, ReasoningBank (Sep 2025), Memento-Skills (Mar 2026), and SkillLearnBench (Apr 2026) all use a "first run vs. nth run" delta as the core metric. SkillLearnBench in particular evaluates skill-generation methods at three levels — skill quality, execution trajectory, and task outcome — which maps cleanly onto akm's distinction between proposal validation (lint), agent run trajectory, and final test pass.

**Outcome plus trajectory metrics.** Galileo's 2026 agent-evaluation guide and Vertex AI's `trajectory_exact_match` / `trajectory_precision` / `trajectory_recall` define a now-standard split: outcome metrics tell you *if* the agent worked, trajectory metrics tell you *why*. For akm specifically, trajectory metrics include "did the agent run `akm search` before generating code," "did it pull the correct asset," "did it write a feedback event after using it." These are cheap to compute from `events.jsonl` plus tool-call traces and they explain the outcome deltas.

**Reflective evaluators.** GEPA (Agrawal et al., ICLR 2026 oral) makes the case that collapsing execution traces to a scalar reward throws away the diagnostic signal. For akm-bench's reporting layer, this matters less than the metric design itself — but for the optional `akm-bench evolve` mode (using bench results to optimize akm's reflect/propose/distill prompts), GEPA's `dspy.Prediction(score=..., feedback=...)` shape is the right output contract.

The closest existing artifact in the akm repo is `tests/benchmark-suite.ts`, which measures the search subsystem in isolation. akm-bench is its sibling — it measures the agent-plus-akm system end-to-end.

## 3. What akm v1 already gives us

Before designing new infrastructure, what's already there:

| Capability | Where | Status on `release/1.0.0` |
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

The pieces akm-bench needs that *don't* exist yet:

- A small task corpus with ground-truth verifiers.
- A set of reusable **fixture stashes** — curated bundles of assets that both bench tasks and `bun:test` suites can reference by name, so search behavior verified in unit tests is verified against the same content the benchmark scores on.
- An opencode-driven harness that can run with akm enabled and disabled, against any model the operator selects.
- A multi-episode driver that materializes feedback → distill → accept between episodes.
- Aggregation/comparison across runs (current branch vs main, before evolution vs after).
- JSON output and a markdown report.

The plan below builds those pieces. It does not modify any locked v1 contract; it only consumes them.

## 4. Two benchmark tracks

`akm-bench` ships as two tracks with one shared driver. Each track answers exactly one of the questions in §1.

### Track A — Marginal utility (`bench utility`)

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

### Track B — Self-improvement effectiveness (`bench evolve`)

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

## 5. Architecture

### 5.1 Directory layout

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

### 5.2 The driver (`tests/bench/driver.ts`)

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

### 5.3 Verifier (`tests/bench/verifier.ts`)

One dispatcher, three verifier kinds:

| Kind | Trigger | Mechanism |
|---|---|---|
| `script` | task has `verify.sh` | spawn the script in the workspace, exit code = pass/fail |
| `pytest` | task has `tests/test_*.py` | `pytest -q --tb=line` exit code |
| `regex` | task has `expected_match` in `task.yaml` | regex over the agent's final stdout |

This mirrors SWE-Skills-Bench's "deterministic verifiers" rule. **No LLM-as-judge anywhere in the verifier path.** Trajectory metrics may use string parsing on the event stream but never an LLM to score outcomes — the published failure rate of LLM judges (>50% per Galileo's 2026 review) makes them unsuitable for measurement, and "let the agent grade itself" defeats the whole point.

### 5.4 Corpus & slicing (`tests/bench/corpus.ts`)

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

### 5.5 Fixture stashes (`tests/fixtures/stashes/`)

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

## 6. Metrics catalog

### 6.1 Outcome metrics

All outcome metrics aggregate over `K` seeds per (task, arm) and produce a per-task value plus a corpus-wide aggregate.

| Metric | Definition | Higher is |
|---|---|---|
| `pass_rate` | fraction of seeds where verifier exits 0 | better |
| `pass@1` | per-task pass rate at seed=0 (single-shot) | better |
| `tokens_per_pass` | `(tokens_in + tokens_out) / passes`, mean over seeds | lower better |
| `wallclock_ms` | mean over seeds | lower better |

`pass@1` is the headline — it's the single-shot experience the user actually feels. `pass_rate` over K seeds smooths model noise.

### 6.2 Trajectory metrics

Computed by parsing `events.jsonl` and the agent's tool-call output. None of these affect pass/fail; they exist to *explain* pass-rate deltas.

| Metric | Definition |
|---|---|
| `correct_asset_loaded` | did `akm show <gold_ref>` appear in the trace? |
| `feedback_recorded` | did an `akm feedback` event land in events.jsonl? |

Trajectory metrics are reported next to outcome metrics — never instead of them. If `delta_pass_rate ≤ 0` and `correct_asset_loaded` is also low, the agent isn't using akm — that's an akm UX problem, not a "akm doesn't help" finding. The two metrics here are the minimum needed to make that distinction; richer trace analysis is post-v1.

### 6.3 Proposal-quality metrics (Track B only)

For each proposal produced during Phase 2:

| Metric | Definition |
|---|---|
| `lint_pass` | proposal passes `lintLessonContent` (for lessons) or schema validation |
| `accepted` | did `akm proposal accept` succeed? |

These are *quality* metrics for the proposal itself, distinct from whether the resulting accepted asset improves agent performance. SkillLearnBench's three-level evaluation insists on this separation and it matters: a lesson can be well-formed (high `lint_pass`) but useless (low `improvement_slope`), or scrappy but transformative — both failure modes are real and they need different fixes.

### 6.4 Longitudinal metrics (Track B only)

| Metric | Definition |
|---|---|
| `improvement_slope` | `pass_rate(post) − pass_rate(pre)` on the eval slice |
| `degradation_count` | eval tasks where `post` underperforms `pre` by > 1 seed |
| `over_synthetic_lift` | `pass_rate(post) − pass_rate(synthetic)` |
| `acceptance_rate` | accepted / (accepted + rejected) — quality signal on what the LLM produces |

**Acceptance is auto-accept only.** Every proposal that passes lesson lint and proposal validation is accepted; everything else is rejected. This is a deliberate scoping choice: the bench measures the loop as a system, mixing in human judgment would make runs unrepeatable. The reported number is "what would the loop produce if every lint-passing proposal were accepted" — operators reading the report should interpret it accordingly. Human-in-the-loop is out of scope (see §11).

`over_synthetic_lift` is the keystone metric for Track B. If `post` doesn't beat `synthetic`, akm's distill/reflect/propose machinery is, on this corpus, no better than asking the agent to take its own notes. That's a finding worth knowing — it tells the user where to invest improvement effort.

### 6.5 Attribution metrics (per-asset diagnostics)

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

### 6.6 Failure-mode taxonomy (per-task diagnostics)

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

### 6.7 Search-pipeline bridge

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

### 6.8 Feedback-signal integrity (Track B only)

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

## 7. Isolation and reproducibility

### 7.1 No Docker for v1

Each run uses tmpdirs and per-process env isolation; Docker is not required. `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `AKM_STASH_DIR`, and `OPENCODE_CONFIG` all point at fresh tmpdirs so two parallel runs never collide and the operator's personal config is never touched. Verifiers shell out to `pytest` / `bash` in the workspace; if a task's verifier needs a runtime that isn't on the operator's machine, that task is skipped with a clear message.

Operators who want stronger isolation can wrap the run in `docker run` themselves — the bench is just a Bun process reading and writing tmpdirs, it doesn't care. Containerizing the full corpus is a Phase-3+ activity tied to publishing the corpus externally.

### 7.2 Seed and budget discipline

Every run carries an explicit seed (default: `0..K-1` where K=5) recorded in the output. opencode-and-LLM combinations don't honor seeds meaningfully — the seed is logged for traceability but real reproducibility comes from K-seed averaging. Budgets are hard: `budgetTokens` and `budgetWallMs` are enforced via `runAgent`'s existing timeout. The `budget_exceeded` outcome is *not* a fail — it's a third state so cost regressions don't hide as quality regressions.

### 7.3 Model selection is part of the run identity

Because outcome metrics are model-dependent, the model string is stamped into every output and `bench compare` refuses to diff runs that used different models. The recovery path is "rerun on the same model" — `bench compare` prints the mismatch so the operator knows what to do.

### 7.4 Data leakage prevention

Following SkillsBench's leakage audit and SWE-Bench Pro's contamination principles:

- Tasks are **not** drawn from public benchmarks. The corpus is small and originates in the user's own domains (docker-homelab, az-cli, etc.) where the agent's training data is unlikely to contain the exact `verify.sh` semantics.
- Gold assets in the curated stash are **not** identical to the verifier — a skill that documents docker-compose patterns is fine; a skill that says "the answer to `redis-healthcheck` is `healthcheck: { test: redis-cli ping }`" is a leak. The corpus reviewer checks for this.
- Eval-slice tasks are excluded from any LLM-visible content the akm stash provides during distillation. The driver enforces this by stash-rebuilding between Phase 1 and Phase 3 with the eval slice's gold-ref content stripped, so the agent can't be asked to "distill a lesson from feedback on a task it's about to be re-tested on."

## 8. Wiring into the existing test suite

The framework reuses what's there rather than duplicating it.

| Existing artifact | Role in akm-bench |
|---|---|
| `tests/benchmark-suite.ts` | Independent search-pipeline benchmark; runs alongside the bench, not consumed by it. |
| `tests/ranking-regression.test.ts` | Pre-flight check: bench refuses to run if any regression test fails. |
| `tests/distill.test.ts` | Validation harness for proposal-quality metrics. |
| `tests/proposed-quality.test.ts` | Confirms `quality: "proposed"` filtering — the bench depends on this being correct. |
| `tests/benchmark-compare.sh` | Template for `bench compare` (two-branch diff). |
| `src/integrations/agent/profiles.ts` (opencode profile) | The agent surface for every track; bench reuses the locked v1 profile rather than defining its own. |

The new `tests/bench/cli.ts` exposes:

```sh
# Track A — paired noakm vs akm utility benchmark
BENCH_OPENCODE_MODEL=anthropic/claude-opus-4-7 \
  bun run tests/bench/cli.ts utility --tasks all

# Track B — longitudinal evolution loop
BENCH_OPENCODE_MODEL=anthropic/claude-opus-4-7 \
  bun run tests/bench/cli.ts evolve --tasks docker-homelab

# Compare two runs (e.g. before/after an akm change). Refuses to diff
# different models or different tracks.
bun run tests/bench/cli.ts compare --base path/to/baseline.json --current path/to/current.json
```

Output to stdout is a single JSON document; human-readable summary to stderr (matching the `--json` flag convention in `benchmark-suite.ts`). To regression-check an akm change, run Track A on the base branch, run it on the feature branch, and `compare` the two JSON files.

## 9. Phased implementation

Two phases. Each produces something usable on its own. None require modifying `src/` — the bench reads v1 contract surfaces (events, proposal queue, agent profiles) and consumes them from outside.

### Phase 1 — Track A end-to-end (~2 weeks)

The whole utility-benchmark stack plus the cross-cutting fixture-stashes work and the three Track-A diagnostic metrics (attribution, failure-mode taxonomy, search-pipeline bridge).

Deliverables:
- **Fixture stashes (cross-cutting).** Migrate `tests/ranking-fixtures/stash/` to `tests/fixtures/stashes/ranking-baseline/`; author the four other initial fixtures (`minimal`, `docker-homelab`, `az-cli`, `multi-domain`); write the shared `loadFixtureStash()` helper; update `ranking-regression.test.ts` and `benchmark-suite.ts` to use the new helper. This is a prerequisite for everything else and benefits the existing test suite immediately.
- **Bench skeleton.** All seven files under `tests/bench/` (cli, driver, corpus, verifier, metrics, report, BENCH.md).
- **Harness.** `runAgent`-based opencode integration with isolated `OPENCODE_CONFIG`.
- **Corpus.** 15-20 hand-crafted tasks across 3 domains (docker-homelab, az-cli, opencode), each referencing a fixture stash by name.
- **Outcome + trajectory metrics.** `bench utility --tasks <slice>` produces a paired `noakm` vs `akm` JSON report with `pass_rate`, `pass@1`, `tokens_per_pass`, `wallclock_ms`, `correct_asset_loaded`, `feedback_recorded`.
- **Diagnostic metrics (§6.5-6.7).** Per-asset attribution table (`load_pass_rate`, load counts) computed as post-processing on every Track A run. Failure-mode taxonomy classifier producing the labeled failure breakdown. Search-pipeline bridge metrics (`gold_rank_distribution`, `pass_rate_by_rank`).
- **Attribution subcommand.** `bench attribute --base <run.json> --top N` consumes a Track A run and re-runs the corpus N times with each top-loaded asset masked, producing `marginal_pass_contribution` for those assets.
- **Compare.** `bench compare --base a.json --current b.json` produces a markdown diff; refuses to compare across models or fixture-content hashes.

Done = a single Track A run produces a JSON+markdown report containing the aggregate score *and* an actionable per-asset attribution table, a per-task failure-mode breakdown, and a search-rank-to-outcome histogram. Comparing two runs surfaces deltas across all of these dimensions.

### Phase 2 — Track B longitudinal driver (~2.5 weeks)

The evolution loop, its scoring, and the feedback-integrity check that gates trust in everything else.

Deliverables:
- **Three-phase runner.** Signal accumulation on train slice → `akm distill` + `akm reflect` invocation per asset with negative feedback → auto-accept all lint-passing proposals → re-eval on eval slice.
- **Synthetic arm.** Model is asked to produce its own scratch notes per task and consume them during the run.
- **Proposal-quality metrics.** Per-asset `lint_pass`, `accepted`.
- **Longitudinal metrics.** `improvement_slope`, `over_synthetic_lift`, `degradation_count`, `acceptance_rate`.
- **Feedback-signal integrity (§6.8).** Confusion matrix joining `feedback ±` events with same-run verifier outcomes. `feedback_agreement`, false-positive/negative rates per asset and corpus-wide. Reported alongside Track B's headline numbers so operators can see whether the loop's input signal is trustworthy before reading the slope.
- **Reuse of Phase 1 diagnostics.** Track B re-uses §6.5-6.7 — attribution shows which evolved assets are doing the work, failure-mode shows whether degradations are content problems or context interference, search bridge shows whether new lessons are findable.

Done = a single command runs the full evolution loop on a domain slice and produces a longitudinal report whose top line is `improvement_slope` and whose second line is `feedback_agreement` — operators see the lift number paired with the integrity number that determines whether to trust it.

## 10. Risks and mitigations

**Risk: real-model bench is non-deterministic, results drift between runs.**
Mitigation: K=5 seeds per (task, arm) is the floor; report per-task variance alongside means. The bench is run manually when the operator wants a measurement, so the latency cost of K seeds is a one-time choice, not a per-PR friction.

**Risk: corpus quality is the whole game; bad tasks make the bench useless.**
Mitigation: explicit `slice: train|eval` partitioning. Per-task review for leakage at creation time. Start small (15-20 tasks) and only grow after Phase 1 shows stable signal.

**Risk: SkillsBench/SWE-Skills-Bench results suggest skills often don't help. The bench may produce embarrassing numbers for akm.**
Mitigation: this is a feature, not a bug. The bench is what tells the operator *which* assets are pulling weight and which are noise — that's the input to curation. Per-task variance is reported prominently rather than buried under a corpus average.

**Risk: auto-accept inflates `improvement_slope` relative to what a human reviewer would actually merge.**
Acknowledgement, not mitigation: this is a deliberate scoping choice. The bench measures the loop as a system; mixing in human judgment would make runs unrepeatable. The reported number is "what would the loop produce if every lint-passing proposal were accepted" — operators interpret accordingly. Human-in-the-loop is post-v1.

**Risk: trajectory metrics rely on string-matching the event stream; akm changes that rename events silently break the bench.**
Mitigation: the event-type union is part of the v1 contract (§9.7). Trajectory metrics depend only on contract-stable event names. Contract-test coverage in `tests/architecture/` and `tests/proposed-quality.test.ts` already catches schema violations on the PR that introduces them — the bench depends on `bun test` being green, not on its own schema check.

**Risk: framework grows beyond the user's "low-dependency, composable" aesthetic.**
Mitigation: bench is pure Bun + standard library + the same packages already in `package.json`. No new prod dependencies. Verifiers shell out to `pytest`/`bash`. No Docker required.

## 11. Out of scope for v1

Listed explicitly so the boundary is clear:

- **CI integration.** The bench is run manually by the operator. No GitHub Actions, no scheduled runs. The contract-stability checks that *do* belong in CI live in `bun test` (existing `tests/architecture/`, `tests/proposed-quality.test.ts`).
- **LLM-as-judge for outcomes.** Trajectory string-matching only. If a task can't be expressed as a deterministic verifier, it doesn't go in the corpus.
- **Human-in-the-loop accept mode.** Auto-accept only.
- **Cross-model comparison.** The bench measures akm under one model at a time. `bench compare` refuses to diff runs that used different models.
- **Alternative agent harnesses.** opencode is the harness. Other tools (Claude Code, Cursor, Aider) have built-in profiles in `src/integrations/agent/profiles.ts` and could be plugged in post-v1.
- **Docker-isolated runs.** Tmpdirs and env isolation only. Operators wanting tighter isolation wrap the run in `docker run` themselves.
- **Public leaderboard / corpus.** Internal only for v1.
- **MCP-server wrapping.** Bench is CLI in / JSON out, like the rest of akm.

## 12. Future improvements

These are the next-most-valuable additions once Phase 1-2 are landed and have produced enough data to justify investment. They are explicitly *not* in v1 scope but are documented so the framework can grow into them without retrofitting.

### 12.1 Higher-resolution observability

- **Per-seed variance as a first-class metric.** K=5 seeds are currently averaged. Surface stdev per task and flag tasks with stdev > 0.2 as "flaky" — they contaminate aggregates and probably need verifier hardening before they belong in the corpus. Cheap to add; the data is already collected, only the reporting changes.
- **Token decomposition by akm phase.** Total `tokens_per_pass` is one number; in the akm arm those tokens split across search-prompt, show-content, and action-prompt phases. Splitting them tells you whether the "Every token must earn its place" principle is paying off. Requires logging per-tool-call token usage, which opencode supports.
- **Run-trace persistence behind a flag.** RunResult already carries `events`; add `--save-traces` that dumps the full opencode session log next to each run's JSON. Don't default it — traces are MB per run — but make them retrievable when a failure deserves a deep dive. Pairs naturally with the failure-mode taxonomy in §6.6: a `followed_wrong` run is more useful when its trace is on disk and reviewable.

### 12.2 Reflective optimization of akm's own prompts

The bench produces structured per-task signal (outcome, trajectory, failure-mode label). Wrapping that signal in the `dspy.Prediction(score=..., feedback=...)` shape lets the operator run akm's `buildReflectPrompt` / `buildProposePrompt` / distill `SYSTEM_PROMPT` through GEPA (ICLR 2026 oral, +13-20% over MIPROv2/GRPO at 35× fewer rollouts). This is prompt optimization for *akm itself*, not for the user's stash — it would tune the prompts in `src/integrations/agent/prompts.ts` and `src/commands/distill.ts` against real-world bench data.

The integration is mostly an output-format adapter. The constraint is that GEPA needs a Python toolchain alongside Bun, which is a meaningful new dependency for the project's CLI-first aesthetic. A reasonable shape is a separate `tests/bench/gepa/` Python script that consumes the bench's JSON output and emits prompt-optimization runs — keeping the dependency optional and out-of-process.

### 12.3 Multi-objective reporting

SkillMOO (Apr 2026) optimizes skill bundles on (pass rate, cost) jointly via NSGA-II. The bench's `tokens_per_pass` is a natural second axis, and `wallclock_ms` is a natural third. Rendering Pareto fronts across runs surfaces whether akm is winning quality or losing cost — important when comparing "akm + a frontier model" against "no akm + a frontier model" against "akm + a small local model," which is the configuration matrix opencode makes trivially explorable.

### 12.4 Public corpus contribution

Once the internal corpus is stable and the fixture-stash format has settled, factor a sanitized subset out as a kit on the akm registry. Other akm users could run their own stashes through it and contribute back domains. Docker isolation becomes worth the cost at this point — internal operators trust their own machines, public contributors don't.

### 12.5 Continuous loop closure

v1 keeps the proposal-accept gate auto-accept-only and human review out of scope. A natural Phase 3 introduces a third arm to Track B: `human_curated`, where the operator manually reviews each proposal before it lands. The gap between `auto_accept` slope and `human_curated` slope quantifies how much value the human gate adds — currently an open empirical question.

### 12.6 Cross-model evaluation matrix

The bench currently refuses to compare runs across models. A future `bench matrix` subcommand would deliberately run the same corpus under multiple models and produce the model × akm interaction grid: does akm help frontier models and small models equally, or are gains concentrated at one end? SkillsBench's finding (a smaller model with curated skills can match a larger model without them) is suggestive, but specific to skills they wrote — running the akm fixtures through the same matrix would tell the operator whether "akm + Haiku" is a viable substitute for "Opus alone" in their domains.

## 13. Appendix — concrete schemas and a sample task

### 13.1 `task.yaml` schema

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

### 13.2 Sample task

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

### 13.3 Sample run output (Track A)

```jsonc
{
  "schemaVersion": 1,
  "track": "utility",
  "branch": "release/1.0.0",
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
