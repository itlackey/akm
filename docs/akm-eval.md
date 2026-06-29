# akm-eval — Analyzing `akm` Quality and Improvement

`akm-eval` is a standalone, read-only toolkit that measures whether
`akm` improvements are actually working. Every invocation of `akm
improve` already writes a structured envelope to
`<stash>/.akm/runs/<run-id>/improve-result.json`, and every mutating CLI
verb writes to the `events` table in `state.db`. `akm-eval` consumes
those artifacts plus the live `akm search` output and turns them into
operator-friendly metrics — without modifying anything.

The toolkit is shell + Bun TypeScript with no extra dependencies beyond
what the `akm` repo already requires. It lives at `scripts/akm-eval/`.
(It originally mirrored a now-removed `scripts/improve-stats/` toolkit
whose metrics were absorbed into `akm health`.)

This page documents Phases 1–7 (read-only deterministic runner, paired
mode, compare/trend/collect, regression diffing, memory-safety +
workflow-compliance suites, judge-calibration probe, graph A/B ablation,
deterministic replay, and optional LLM judging with guardrails). See
`docs/archive/akm-eval-implementation-plan.md` for the full eight-phase
plan and `scripts/akm-eval/README.md` for the operator quick-start.

## Quick start

```sh
cd /path/to/akm                                 # or any clone of it
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke
```

Outputs land under `<stash>/.akm/evals/runs/<eval-run-id>/`:

| File | Purpose |
| --- | --- |
| `eval-result.json` | Summary envelope. `schemaVersion: 1`. |
| `case-results.jsonl` | One JSON line per case. |
| `report.md` | Human-readable rollup (also written to stdout by default). |
| `latest` | Symlink to the most recent run. |

By default the runner reads from `$AKM_STASH_DIR` (falling back to
`~/akm`). Override with `--stash <path>` per invocation.

## What it measures

Three runner types ship in Phases 1 + 2:

### Retrieval

Shells out to `akm search <query> --format jsonl --shape agent` and
scores the result set against:

- `mustIncludeRefs` — refs that must appear in the top-K.
- `mustNotIncludeRefs` — refs that must not appear.
- `keywords` — substrings expected to appear in hit metadata.
- `minHits` — minimum hit count.

Tells you whether retrieval finds the right things for the queries you
care about.

> **Retrieval vs. curate.** This runner shells out to `akm search`, which does
> NOT exercise curate's fallback-merge + selector stages (where the "keyword
> leapfrog" bug lived), and it scores set-membership (recall), not rank — so a
> junk hit ranked above a good hit still scores 1.0. For rank-aware, hybrid-path
> curate measurement that is reproducible across versions, use the deterministic
> **curate benchmark**: `scripts/akm-eval/bin/akm-eval-curate-bench` (see
> `docs/technical/curate-performance-evals.md`).

### Proposal quality

Reads the proposal queue from `state.db` (or
`<stash>/.akm/proposals/` as filesystem fallback), and the events table
for `proposal_creation_rejected` events. Reports:

- counts: total, pending, accepted, rejected, reverted, creation-rejected
- validation pass rate
- accept rate (of decided proposals)
- reject rate (of decided proposals)
- **accept-rate-by-source** — the canonical PROV-DM metric named in
  `src/core/proposals.ts`

Tells you whether `akm improve`'s output is actually being kept, broken
down by `reflect` / `distill` / `consolidate` / `schema-repair` /
`propose` / etc.

### Regression

Diffs the current `case-results.jsonl` against a previously-stored
eval-run-id (resolved like `latest` or a literal id). Surfaces:

- newly-failing cases (passed before, fail now),
- newly-passing cases (failed before, pass now),
- score drops above a configurable delta (default 0.1),
- cases that disappeared between runs.

Available both as an `EvalCase` of `type: "regression"` embedded in a
suite (with `input.previousRunId` and optional `input.threshold`) and
as a standalone command via `akm-eval-compare`.

## Paired mode

```sh
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
  --improve-args "--limit 10 --timeout-ms 600000"
```

Orchestrates four steps:

1. **Baseline pass** — run the suite against the current stash.
2. **`akm improve`** — shell out with the forwarded `--improve-args`.
3. **Re-eval** — run the suite again against the post-improve state.
4. **Merged envelope** — write a single `eval-result.json` with
   `scores.baseline` and `scores.delta` populated, plus
   `artifacts/baseline-case-results.jsonl` and
   `artifacts/paired-comparison.json` for the per-case diff.

Sandbox semantics:

- `--sandbox` (default) — copy the stash to a tmpdir and run there;
  the real stash is never touched. Cleaned up on success unless
  `--keep-sandbox`.
- `--no-sandbox` / `--allow-mutate` — opt into mutating the real stash.

## Replay mode (Phase 6)

```sh
# Record every akm CLI invocation, state.db query, and improve-result read
# made during an eval-run, into <run-dir>/artifacts/replay/.
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --record

# Re-run the same eval against those captured I/O surfaces. Compares
# per-case score / passed / metrics / evidence against the original
# case-results.jsonl. Exit 0 if deterministic, 1 on any divergence.
scripts/akm-eval/bin/akm-eval-replay latest
```

Replay mode is the implementation of roadmap item R8. It exists so a CI
gate can prove that a given eval-run's results are reproducible from
captured I/O alone — useful for debugging flaky cases, for re-running
historical evals against a refactored runner, and for distinguishing
"the akm CLI changed its output" from "the eval runner has a bug".

Three JSONL logs land under `<run-dir>/artifacts/replay/`:

| File | Contents |
| --- | --- |
| `akm-invocations.jsonl` | one record per `AkmCli.run()` call: args, stdout, stderr, status, durationMs. |
| `state-db-queries.jsonl` | one record per `readEvents` / `readProposals` / `available()` call, plus the captured rows. |
| `improve-results.jsonl` | one record per `<stash>/.akm/runs/<id>/improve-result.json` read. |
| `replay-result.json` | written by `akm-eval-replay`: `{ deterministic, divergentCases, missingCases, extraCases }`. |

These three surfaces are sufficient because every Phase 1 + Phase 3
runner bottoms out on them. `--strict` additionally fails on missing or
extra cases (the default fails only on per-case divergences). Score
comparison uses `1e-9` tolerance; metrics and evidence are deep-equal.

## Compare, trend, collect

`akm-eval-compare <baseline-id|latest> <current-id|latest>` prints
overall + per-type score deltas, regression list, newly-passing and
newly-failing per case, and writes a JSON comparison artifact next to
the current run (`--out` overrides). Exits non-zero if any regressions.

`akm-eval-trend [--suite name] [--limit 20] [--metric overall]` walks
`<stash>/.akm/evals/runs/*` oldest-first and prints a TSV with
`ts | suite | mode | label | <metric>`. `--metric` accepts `overall`,
`deterministic`, or any dot-separated path into the envelope. Pipe to
`column -t` for a pretty table.

`akm-eval-collect --from-improve-run <run-id|latest>` reads
`<stash>/.akm/runs/<run-id>/improve-result.json` and surfaces the
metrics paired-mode comparison cares about: proposals emitted, actions
by mode and outcome, validation failures, consolidation, memory cleanup.
Writes a summary to `<stash>/.akm/evals/collected/<improve-run-id>.json`.

## Suites

A suite is a directory under `scripts/akm-eval/cases/`. Each case is a
JSON file matching the `EvalCase` shape in
`scripts/akm-eval/src/types.ts`. The `improve-smoke` suite ships five
retrieval + three proposal-quality cases designed to run on any stash
without per-stash customization.

To author your own suite, copy `improve-smoke/` to a sibling directory
and edit the JSON.

## Case schema (Phase 1)

```json
{
  "schemaVersion": 1,
  "id": "retrieval-deploy-keywords",
  "suite": "improve-smoke",
  "type": "retrieval",
  "description": "Searching for 'deploy' surfaces operational vocabulary.",
  "input": {
    "query": "deploy",
    "topK": 10
  },
  "expected": {
    "keywords": ["deploy"],
    "minHits": 1
  },
  "scoring": {
    "deterministic": true,
    "weights": { "keywordCoverage": 0.5, "minHits": 0.5 },
    "passThreshold": 0.5
  },
  "requires": { "minAkmVersion": "0.8.0" },
  "tags": ["retrieval", "smoke", "vocabulary"]
}
```

`memory-safety` and `workflow-compliance` ship in Phase 3.
`judge-calibration` ships in Phase 4 (see below). `lesson-application` is
the only type that still produces a `skipped` result.

## Judge calibration

The judge-calibration runner (Phase 4, roadmap R3) measures how often
the distill judge agrees with hand-graded probes and how stable its
verdicts are across resamples — MT-Bench (arXiv:2306.05685) reports
~±0.5 judge variance, and D-5 / #388 introduced the `review_needed`
band specifically to absorb that wobble.

Each probe is a JSON file describing an asset (memory, lesson, or skill)
plus feedback events plus a human-graded expected outcome:

```json
{
  "schemaVersion": 1,
  "id": "probe-01-queued-clear-lesson",
  "assetType": "memory",
  "assetRef": "memory:probe-01-deploy-secret-rotation",
  "asset": {
    "frontmatter": { "description": "...", "captureMode": "hot", "...": "..." },
    "body": "..."
  },
  "feedback": [
    { "ts": "2026-05-11T...", "signal": "positive", "reason": "..." }
  ],
  "humanGrade": {
    "expectedOutcome": "queued",
    "expectedScoreBand": [4.0, 5.0],
    "rationale": "Concrete asset with positive signal — judge should queue."
  }
}
```

The runner, per probe:

1. Creates a fresh sandbox (`createSandbox()`) so the real stash and
   data dir are never touched.
2. Writes the probe's asset file under the sandbox stash
   (`memories/<name>.md`, `lessons/<name>.md`, or
   `skills/<name>/SKILL.md`).
3. Runs `akm feedback <ref> --positive|--negative ...` once per
   feedback entry.
4. Runs `akm index` so the new asset enters the index.
5. Runs `akm improve --json-to-stdout` and harvests the most recent
   `distill_invoked` event for the probe's ref from the sandbox's
   `state.db`.
6. Cleans up the sandbox.
7. Repeats `samplesPerProbe` (default 3) times in fresh sandboxes so
   cross-resample variance is measurable.

Aggregate metrics — surfaced both in the case result and at
`eval-result.json` → `metrics.judgeCalibration`:

| Field | Meaning |
| --- | --- |
| `agreementRate` | (sum of agreed samples) / (probes × samples). |
| `perBand` | Per-expected-outcome probe count and agreement rate. |
| `medianVariance` / `meanVariance` | `1 - mode-fraction` across samples per probe. 0 = all agree, 1 = perfectly split. |
| `flipRate` | Fraction of probes where any two samples disagreed. |
| `perProbe` | Per-probe `{ probeId, expected, actual[], agreementCount, variance }`. |

Scoring blends agreement (0.6) and inverse variance (0.4). The probe
suite ships eight probes spread evenly across the four
`humanGrade.expectedOutcome` bands. Example invocation:

```sh
scripts/akm-eval/bin/akm-eval-run --suite judge-calibration \
  --akm /path/to/akm/dist/cli.js --format md
```

When `profiles.improve.default.processes.distill.enabled` is
disabled in the test env the judge returns `skipped` for every probe —
that's expected; the case scores low but the runner machinery and the
metrics block still work.

## Result envelope

```json
{
  "schemaVersion": 1,
  "evalRunId": "2026-05-21T19-12-44-002Z-a1b2c3d4",
  "suite": "improve-smoke",
  "mode": "baseline",
  "startedAt": "2026-05-21T19:12:44.002Z",
  "completedAt": "2026-05-21T19:12:44.847Z",
  "durationMs": 845,
  "akm": { "version": "akm-cli 0.8.0", "stashRoot": "/home/me/akm" },
  "inputs": { "caseCount": 8, "caseDir": "scripts/akm-eval/cases/improve-smoke" },
  "scores": { "overall": 0.83, "deterministic": 0.83 },
  "countsByType": {
    "retrieval": { "run": 5, "passed": 4, "skipped": 0 },
    "proposal-quality": { "run": 3, "passed": 3, "skipped": 0 }
  },
  "metrics": {},
  "errors": [],
  "artifacts": {
    "evalResult": "eval-result.json",
    "caseResults": "case-results.jsonl",
    "markdownReport": "report.md"
  }
}
```

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | All cases ran; overall score above the floor (when `--fail-below-score` set). |
| 1 | Overall score below `--fail-below-score`. |
| 2 | Case error(s) or invocation failure (missing suite, malformed JSON, missing `bun`, etc.). |

## Graph A/B ablation (Phase 5)

`scripts/akm-eval/bin/akm-eval-graph-ablation` (roadmap R5) drives a
two-sandbox ablation against the same source stash — graph extraction on
vs. off — and reports per-metric deltas (retrieval hit@K, precision@K,
contradiction precision/recall, latency, and a proxy token-cost). The off
side is gated via a planted `config.json` that sets both
`profiles.improve.default.processes.graphExtraction.enabled: false` and
`index.graph.llm: false`.

Outputs land under `<stash>/.akm/evals/ablations/<eval-run-id>/` so they
never collide with the main `runs/` namespace. See
[`scripts/akm-eval/README.md`](../scripts/akm-eval/README.md#graph-ab-harness)
for usage, the full metric list, and the verdict heuristic.

## LLM judging (optional, Phase 7)

`--llm-judge` opts in to per-case grading with an OpenAI-compatible LLM.
The result is **always recorded separately** from the deterministic
score: it appears as `scores.llmJudged` in the run envelope and as
`llmJudgement` on each per-case record, but is **never** folded into
`scores.deterministic` or `scores.overall`. CI gates remain
deterministic.

This separation is deliberate. LLM-as-judge variance (cf. MT-Bench,
arXiv:2306.05685) is high enough that judge scores cannot reliably gate
merges without per-task calibration (which lands as `judge-calibration`
cases via Phase 4). Until then, judge scores are an audit signal — they
inform but never block.

```sh
# Hosted provider:
OPENAI_API_KEY=sk-... \
  scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --llm-judge

# Local OpenAI-compatible server (Ollama, llama.cpp, vLLM):
AKM_EVAL_JUDGE_ENDPOINT=http://localhost:11434 \
AKM_EVAL_JUDGE_PROVIDER=ollama \
AKM_EVAL_JUDGE_MODEL=llama3.1:8b \
  scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --llm-judge
```

If `--llm-judge` is set but no endpoint or key can be resolved, the run
fails fast with an actionable error — silent degradation is refused.

Per-call provenance lands at
`<run-dir>/artifacts/llm-judgements.jsonl`, one JSON line per case:

```json
{"caseId":"retrieval-deploy-keywords","ts":"…","model":"gpt-4o-mini",
 "provider":"openai","temperature":0,"promptHash":"sha256:…",
 "artifactHash":"sha256:…","score":0.82,"band":"medium",
 "rationale":"…","durationMs":22}
```

- `promptHash` covers the rendered system + user prompt; `artifactHash`
  covers the artifact actually sent to the judge (after the 16 KB cap).
- LLM call failures are non-fatal: an `error` field is recorded on the
  judgement and that call does NOT contribute to `scores.llmJudged`.
- Rubrics are capped at 4 KB (hard error — fix the case). Artifacts are
  capped at 16 KB by default; override per-case with
  `scoring.llmJudge.maxArtifactBytes`.

Author a judge case by adding a `scoring.llmJudge` block to any case
file; see
[`scripts/akm-eval/README.md`](../scripts/akm-eval/README.md) for the
full schema.

## Proactive-improve kill-criterion (real-query suite + verdict)

This is the measurement system that proves whether the `akm improve`
**proactive lane** (`akm-improve-proactive-weekly`) actually improves the
stash versus burning GPU cycles. Three pieces: a real-query retrieval suite
generator, a stored T0 baseline, and a pass/fail verdict runner.

### Why this is a built-in controlled trial

The proactive selector rotates a top-N slice of "due" assets per run.
Because it can only touch N assets at a time, at any instant some due assets
have been proactively touched (TREATMENT) while equally-due assets have not
(CONTROL). Treatment and control therefore **coexist in the same stash**,
giving a natural A/B without having to stand up a parallel environment.

- **TREATMENT** = refs with proposal/event `eligibilitySource = proactive`.
  When that field is absent on older events, the runner falls back to the
  pilot treatment file
  `<stash>/.akm/measurement/treatment-pilot-2026-06-14.txt`.
- **CONTROL** = assets that are "due" (never reflected, OR last reflected
  > 30 days ago) and were **not** touched by the proactive lane, derived
  from `state.db` `reflect_invoked`/`distill_invoked`/`promoted` history and
  the `entries` catalog.

### 1. Real-query retrieval suite

```sh
bun run scripts/akm-eval/src/gen-real-query-suite.ts [--max-cases 150]
```

Mines `index.db` `usage_events` for what users **actually** search for. For
each distinct meaningful `search`/`curate` query it derives
`mustIncludeRefs` = the refs the user subsequently engaged with for that
query (`select`/`curate`/`show`/positive-`feedback` within a 30-minute
window), normalised across bare (`type:name`) and origin-prefixed
(`origin//type:name`) forms (see `src/lib/ref-normalize.ts`). It emits
ordinary `type: "retrieval"` cases into `cases/real-query/` (capped at the
top 150 highest-signal queries; query frequency × engagement weight) plus a
`cases/real-query.manifest.json` recording emitted/dropped counts and the
drop reasons (`too-short`, `synthetic-probe`, `free-text-prompt`,
`no-engaged-refs`, `below-max-cases-cutoff`). The manifest is written
**outside** the suite dir because the orchestrator parses every `*.json`
under a suite dir as a case.

> **The generated `rq-*.json` output is NOT committed** (gitignored). It is
> mined from a personal live `index.db` — PII-ish and non-reproducible on
> another machine — so it is a local, on-demand *trend* tool, not a portable
> benchmark. For a reproducible cross-version corpus benchmark, use the frozen,
> synthetic, deterministic curate benchmark instead (`akm-eval-curate-bench`;
> `docs/technical/curate-performance-evals.md`). Regenerate the local suite with
> the command above whenever you want a fresh trend snapshot.

This suite is the **corpus-quality benchmark**: its aggregate score, tracked
across runs, is the "did retrieval get better or worse" signal. Pass
thresholds per case are deliberately low (0.2) — the aggregate trend matters
more than per-case pass/fail, and the sessionless event stream makes
individual `mustIncludeRefs` noisy.

### 2. T0 baseline

Run the suite once now (state is essentially pre-proactive — only ~13 assets
changed) and store it as the T0 baseline:

```sh
AKM_STASH_DIR=~/akm scripts/akm-eval/bin/akm-eval-run \
  --suite real-query --mode baseline --label "T0-pre-proactive-2026-06-14"
```

The eval-run id it prints is the baseline the verdict runner compares
against. (First captured baseline: `2026-06-14T17-29-48-772Z-498258e2`,
overall retrieval score 0.216, against stash tag
`baseline/pre-proactive-2026-06-14`.)

### 3. Verdict runner

```sh
scripts/akm-eval/bin/akm-eval-proactive-verdict [--format md]
```

Read-only against `index.db`, `state.db`, and the stored eval runs; writes
only its own report to `<stash>/.akm/measurement/verdicts/verdict-<ts>.{json,md}`.
Computes:

- **(a) retrieval-quality delta** — latest real-query run minus the stored
  T0 baseline (no regression allowed).
- **(b) accept-rate-by-source** — proactive vs reactive (reflect
  `signal-delta`/`high-retrieval`) from the proposals table.
- **(c) proactive reversion/reject rate.**
- **(d) downstream lift** — post-touch positive-feedback rate and retrieval
  count per ref, treatment vs control, over the last 30 days.

#### Verdict thresholds + rationale

Named constants in `src/proactive-verdict.ts`, each overridable by flag:

| Constant | Default | Flag | Rationale |
| --- | ---: | --- | --- |
| `ACCEPT_RATIO` | 0.9 | `--accept-ratio` | Proactive may lag reactive slightly (reactive fires on a concrete signal, so it has a structural quality edge), but accepting at < 90% of the reactive rate means the lane mostly emits noise the curator rejects — the "burning cycles" failure. |
| `MAX_REVERSION` | 0.15 | `--max-reversion` | A reverted promotion is strictly negative (churned then undone). 15% tolerates early-rollout noise without rewarding a lane that keeps shipping regressions. |
| `MIN_RETRIEVAL_DELTA` | 0.0 | `--min-retrieval-delta` | The corpus-quality benchmark must not regress. A positive delta isn't required (gains may surface in feedback first), but a negative delta means edits made it harder to find what users use — an immediate kill signal. |
| `MIN_DECIDED` | 30 | `--min-decided` | Below ~30 decided proactive proposals the accept-rate estimate is too noisy to act on; the runner returns **INCONCLUSIVE** rather than pass/fail. |

**PASS** requires proactive accept-rate >= 0.9 × reactive accept-rate AND
proactive reversion <= 0.15 AND retrieval delta >= 0. **FAIL** if any
breaches, emitting `RECOMMEND DISABLE akm-improve-proactive-weekly` plus the
offending metric(s). **INCONCLUSIVE** when proactive decided count < 30 — it
does not pass or fail on thin data. Exit codes: 0 PASS, 1 FAIL, 3
INCONCLUSIVE, 2 error.

On current (pilot) data the verdict is **INCONCLUSIVE** by design: only ~13
proactive promotions / 15 decided proposals exist, well under the 30 floor.

#### Re-running after N weeks

```sh
# 1. Regenerate the suite so it reflects the latest queries.
bun run scripts/akm-eval/src/gen-real-query-suite.ts

# 2. Capture a fresh run of the same suite (the new "current").
AKM_STASH_DIR=~/akm scripts/akm-eval/bin/akm-eval-run --suite real-query --mode baseline

# 3. Render the verdict (auto-selects oldest real-query run as baseline,
#    newest as current).
scripts/akm-eval/bin/akm-eval-proactive-verdict
```

Once proactive promotions clear the 30-decided floor the verdict flips to a
real PASS/FAIL. Override the compared runs with `--baseline-run <id>` /
`--current-run <id>` if you want a specific pair.

## Status

All eight phases of `docs/archive/akm-eval-implementation-plan.md` are
implemented and CI-gated via `.github/workflows/akm-eval-smoke.yml` (Phase 8).
The smoke suite + deterministic replay + memory-regression suite run on every
PR touching `scripts/akm-eval/`, `src/`, or `docs/example-stash/`.

## See also

- [`scripts/akm-eval/README.md`](../scripts/akm-eval/README.md) —
  operator quick-start.
- [`docs/archive/akm-eval-implementation-plan.md`](technical/akm-eval-implementation-plan.md) —
  the full eight-phase plan.
- `akm health` (0.8.0+) — built-in per-improve-run + window analysis
  ([health-command-enhancements.md](technical/health-command-enhancements.md)).
- [`docs/technical/improve-pipeline-analysis-0.8.0.md`](technical/improve-pipeline-analysis-0.8.0.md) —
  the roadmap this toolkit implements R10 of (and Phases 2–6 implement
  R1, R3, R5, R8).
