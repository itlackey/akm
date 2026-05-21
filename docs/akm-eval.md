# akm-eval — Analyzing `akm` Quality and Improvement

`akm-eval` is a standalone, read-only toolkit that measures whether
`akm` improvements are actually working. Every invocation of `akm
improve` already writes a structured envelope to
`<stash>/.akm/runs/<run-id>/improve-result.json`, and every mutating CLI
verb writes to the `events` table in `state.db`. `akm-eval` consumes
those artifacts plus the live `akm search` output and turns them into
operator-friendly metrics — without modifying anything.

The toolkit is shell + Bun TypeScript with no extra dependencies beyond
what the `akm` repo already requires. It lives at `scripts/akm-eval/`
and mirrors the established `scripts/improve-stats/` pattern.

This page documents Phases 1–4 (read-only deterministic runner, paired
mode, compare/trend, regression diffing, memory-safety + workflow
compliance suites, and the judge-calibration probe). See
`docs/technical/akm-eval-implementation-plan.md` for the full eight-phase
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

Shells out to `akm search <query> --format jsonl --detail agent` and
scores the result set against:

- `mustIncludeRefs` — refs that must appear in the top-K.
- `mustNotIncludeRefs` — refs that must not appear.
- `keywords` — substrings expected to appear in hit metadata.
- `minHits` — minimum hit count.

Tells you whether retrieval finds the right things for the queries you
care about.

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

When `llm.features.feedback_distillation` is disabled in the test env
the judge returns `skipped` for every probe — that's expected; the case
scores low but the runner machinery and the metrics block still work.

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

## What Phases 1–4 do not do

- No mutation of the real stash (paired mode and the
  judge-calibration / memory-safety runners all sandbox to a tmpdir).
- No graph A/B harness yet (lands in Phase 5).
- No replay / capture-and-replay determinism check (Phase 6).
- No optional LLM judging of free-form outputs (Phase 7) — Phase 4 only
  measures the existing distill judge's calibration; it does not add a
  new judge.

## See also

- [`scripts/akm-eval/README.md`](../scripts/akm-eval/README.md) —
  operator quick-start.
- [`docs/technical/akm-eval-implementation-plan.md`](technical/akm-eval-implementation-plan.md) —
  the full eight-phase plan.
- [`docs/improve-stats.md`](improve-stats.md) — companion toolkit for
  per-improve-run analysis.
- [`docs/technical/improve-pipeline-analysis-0.8.0.md`](technical/improve-pipeline-analysis-0.8.0.md) —
  the roadmap this toolkit implements R10 of (and Phases 2–6 implement
  R1, R3, R5, R8).
