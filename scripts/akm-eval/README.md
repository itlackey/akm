# akm-eval — lightweight standalone evaluation toolkit

Read-only-by-default, deterministic measurement of `akm` over the existing
run envelopes, events table, and proposal queue. Implements Phases 1–4 of
`docs/technical/akm-eval-implementation-plan.md`.

Mirrors `scripts/improve-stats/`: shell entry points under `bin/`,
TypeScript runners under `src/`, no `akm` subcommand integration.

## Quick start

```sh
# From this repo root (or any clone of it)
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke

# Against a specific stash
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --stash /path/to/stash

# JSON-only output (no Markdown to stdout)
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --format json

# CI gate: fail when overall score drops below 0.75
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --fail-below-score 0.75

# Paired mode: snapshot → akm improve → re-eval, with deltas. Sandboxed by default.
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
  --improve-args "--limit 10 --dry-run"

# Compare two completed eval runs
scripts/akm-eval/bin/akm-eval-compare <baseline-id|latest> <current-id|latest>

# TSV trend across the last N runs (pipe to `column -t` for a table)
scripts/akm-eval/bin/akm-eval-trend --limit 20 --metric overall

# Ingest a stash's improve-result.json into a paired-mode-ready summary
scripts/akm-eval/bin/akm-eval-collect --from-improve-run latest
```

Outputs land in `<stash>/.akm/evals/runs/<eval-run-id>/`:

```
<stash>/.akm/evals/runs/
  2026-05-21T19-12-44-002Z-a1b2c3d4/
    eval-result.json     — summary envelope (schemaVersion: 1)
    case-results.jsonl   — one line per case
    report.md            — human-readable rollup
  latest                 — symlink to most recent run
```

`<stash>/.akm/evals/` is owned by this toolkit. The existing
`<stash>/.akm/eval-cases/` directory is owned by `akm improve` and is
left untouched.

## Requirements

- `bun` >= 1.0 on `$PATH` (same as the rest of the repo).
- `akm` on `$PATH` (or override with `--akm <bin>` / `AKM_BIN`).

## Coverage

Phase 1 + Phase 2 runner types:

- **retrieval** — shells out to `akm search <query> --format jsonl
  --detail agent` and scores against `mustIncludeRefs`,
  `mustNotIncludeRefs`, `keywords`, and `minHits`.
- **proposal-quality** — reads `state.db` (or `<stash>/.akm/proposals/`
  as fallback) and reports counts, validation pass rate, accept rate,
  reject rate, and accept-rate-per-source.
- **regression** — diffs the current `case-results.jsonl` against a
  previous eval-run-id (literal or `latest`). Surfaces newly-failing
  cases, newly-passing cases, score drops above a configurable
  threshold (default 0.1), and cases that disappeared.

The toolkit is **read-only by default**. The only mutation path is
`--mode paired` without `--no-sandbox`, which copies the stash to a
tmpdir and runs `akm improve` against the copy.

Phase 3 added two more runner types — both mandatory-sandbox and zero
mutation of the real stash:

- **memory-safety** — copies a fixture stash into a sandbox, runs `akm
  index` + `akm improve --json-to-stdout`, and scores the resulting
  belief-state transitions against per-case allow / forbid lists.
- **workflow-compliance** — reads `state.db` events directly and scores
  required event types, event-count bounds, required ordering, and
  forbidden event types over a window.

Phase 4 added the **judge-calibration** runner (R3 — see "Judge
calibration" below). `lesson-application` is the only declared type that
still produces a `skipped` result.

## Paired mode

```sh
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
  --improve-args "--limit 10 --timeout-ms 600000"
```

Paired mode orchestrates: (1) baseline pass, (2) `akm improve` shell-out
with the forwarded args, (3) re-run of the same suite, (4) delta
computation, (5) merged envelope. The result envelope's `scores.baseline`
and `scores.delta` are populated, and `artifacts/paired-comparison.json`
holds the full per-case diff.

Flags:

- `--sandbox` (default) — copy the stash to a tmpdir; `akm improve`
  mutates only the copy. Cleans up on success unless `--keep-sandbox`.
- `--no-sandbox` / `--allow-mutate` — opt into mutating the real stash.
- `--improve-args "<...>"` — verbatim args forwarded to `akm improve`.
- `--threshold 0.1` — score-drop threshold for the regression diff.
- `--fail-on-regression` — exit non-zero if any regressions are surfaced.

## Graph A/B harness

Phase 5 ships `bin/akm-eval-graph-ablation` (roadmap R5). Drives a single-source
two-sandbox ablation: builds two copies of the stash, runs the same suite
against each with graph extraction on vs. off, and reports per-metric deltas.

```sh
scripts/akm-eval/bin/akm-eval-graph-ablation \
  --suite improve-smoke \
  --stash /path/to/stash \
  --akm /path/to/akm \
  --seeds 1 \
  --improve-args "--dry-run"
```

How the off side is gated: the harness plants `<sandbox>/.config/akm/config.json`
under the sandbox `HOME` carve-out with both `llm.features.graph_extraction:
false` and `index.graph.llm: false` set. This is the dual gate documented in
`src/indexer/graph-extraction.ts`; together they block extraction at both the
v1 feature-gate layer and the per-pass opt-out.

Reports (per side; median + range when `--seeds > 1`):

- retrieval hit@K (mean overall score across retrieval cases)
- retrieval precision@K (mustIncludeRefs returned / topK)
- contradiction-detection precision/recall (counts `contradictedBy` edges in
  surviving memory frontmatter; recall vs an `expectedContradictions` declared
  on `contradiction-detection`-tagged cases — `null` otherwise)
- staleness telemetry from `improveResult.stalenessDetection`
- latency delta (wall-clock index + improve per side)
- **proxy** token-cost delta (`graphExtraction.quality.entityCount +
  relationCount`; clearly labelled as a proxy in the report)

Outputs land under `<stash>/.akm/evals/ablations/<eval-run-id>/` —
namespaced separately from the main `runs/` tree so ablations never collide
with regular eval runs.

Verdict heuristic: `graphEarnsItsCost = true` when retrieval delta ≥ 0.05 AND
improve-duration delta ≤ 5× the off-baseline; `false` otherwise; `inconclusive`
when |Δ| < 0.01 on a single seed (re-run with `--seeds 3` or more for a
decision-quality result).

## Compare and trend

`akm-eval-compare <baseline-id|latest> <current-id|latest>` prints score
deltas, regressions, newly-passing/newly-failing per case, and writes a
JSON comparison artifact under
`<current-run>/compare-vs-<baseline>.json` (override with `--out`).
Exits non-zero if any regressions are surfaced.

`akm-eval-trend [--suite name] [--limit 20] [--metric overall]` walks
`<stash>/.akm/evals/runs/*` oldest-first and prints a TSV with
`ts | suite | mode | label | <metric>`. `--metric` accepts `overall`,
`deterministic`, or any dot-separated path into the envelope (e.g.
`scores.delta`, `countsByType.retrieval.passed`). Pipe to `column -t`
for a pretty table.

## Collect (improve-run ingestion)

`akm-eval-collect --from-improve-run <run-id|latest>` reads
`<stash>/.akm/runs/<run-id>/improve-result.json` and surfaces the
metrics paired-mode comparison cares about — proposals emitted that
run, validation failures, consolidation, memory cleanup. Writes the
summary to `<stash>/.akm/evals/collected/<improve-run-id>.json`.

## Judge calibration

Phase 4 (R3) ships a probe-based runner that measures the distill
judge's agreement with hand-graded proposals and its MT-Bench-style
variance across resamples (D-5 / #388 — `review_needed` band).

Probe shape (under `cases/judge-calibration/probes/*.json`):

```json
{
  "schemaVersion": 1,
  "id": "probe-01",
  "assetType": "memory" | "skill" | "lesson",
  "assetRef": "memory:probe-01-example",
  "asset": {
    "frontmatter": { "description": "...", "captureMode": "hot", "...": "..." },
    "body": "..."
  },
  "feedback": [
    { "ts": "2026-05-01T...", "signal": "positive", "reason": "...", "note": "..." }
  ],
  "humanGrade": {
    "expectedOutcome": "queued" | "review_needed" | "quality_rejected" | "validation_failed",
    "expectedScoreBand": [low, high],
    "rationale": "..."
  }
}
```

The runner builds a fresh sandbox per probe, materializes the asset
file, replays the feedback via `akm feedback ...`, runs `akm index`,
then runs `akm improve --json-to-stdout` `samplesPerProbe` times. Each
sample's `distill_invoked` outcome is harvested from the sandbox's
`state.db` events table. Aggregates: agreement rate, per-band agreement
counts, median + mean across-resample variance (mode-fraction-based),
and an MT-Bench-style flip rate (probes where any two samples
disagree).

The aggregate block is hoisted into `eval-result.json` at
`metrics.judgeCalibration`. Example invocation:

```sh
scripts/akm-eval/bin/akm-eval-run --suite judge-calibration \
  --akm /path/to/akm/dist/cli.js \
  --format md
```

When `llm.features.feedback_distillation` is disabled in the test env
every probe will return `skipped`, the case scores low, but the runner
machinery is verified and the metrics block is still emitted.

## Suites

- `cases/improve-smoke/` — the smoke suite. Five retrieval + three
  proposal-quality cases. Designed to run on any populated stash without
  per-stash customization.
- `cases/memory-regression/` — Phase 3 memory-safety regression suite.
- `cases/workflow-compliance/` — Phase 3 event-trace compliance suite.
- `cases/judge-calibration/` — Phase 4 probe suite (8 hand-graded
  probes spread across all four `expectedOutcome` bands).

Author your own suite by creating a sibling directory. Each case is a
JSON file matching the `EvalCase` shape in `src/types.ts`.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | All cases ran and overall score >= `--fail-below-score`. |
| 1 | Overall score below `--fail-below-score`. |
| 2 | Case error(s), or invocation failure (missing suite, bad JSON, etc.). |

## Files

```
scripts/akm-eval/
  README.md                this file
  _lib.sh                  shared shell helpers
  bin/
    akm-eval-run           dispatches to src/run.ts
    akm-eval-compare       dispatches to src/compare.ts
    akm-eval-trend         dispatches to src/trend.ts
    akm-eval-collect       dispatches to src/collect.ts
    akm-eval-graph-ablation dispatches to src/graph-ablation.ts (Phase 5, R5)
  src/
    run.ts                 orchestrator (baseline | akm | paired)
    compare.ts             two-run diff command
    trend.ts               N-run trend command
    collect.ts             improve-result.json ingestion command
    types.ts               EvalCase, EvalCaseResult, EvalRunResult
    scoring.ts             weighted aggregation
    report.ts              Markdown renderer
    runners/
      retrieval.ts         akm search → score
      proposal-quality.ts  state.db / .akm/proposals → score
      regression.ts        case-results.jsonl diff
    sources/
      paths.ts             stash + data-dir + state.db path resolution
      state-db.ts          read-only SQLite reader
      stash-fs.ts          filesystem fallback for proposals
      akm-cli.ts           shell wrapper for `akm search/improve/index/--version`
      eval-runs.ts         resolver + loader for <stash>/.akm/evals/runs/
      improve-result.ts    loader for <stash>/.akm/runs/<id>/improve-result.json
  cases/
    improve-smoke/         starter cases
```

## See also

- `docs/akm-eval.md` — operator guide.
- `docs/technical/akm-eval-implementation-plan.md` — the full plan.
- `scripts/improve-stats/` — the toolkit pattern this one mirrors.
