# akm-eval — lightweight standalone evaluation toolkit

Read-only-by-default, deterministic measurement of `akm` over the existing
run envelopes, events table, and proposal queue. Implements Phases 1 and 2
of `docs/technical/akm-eval-implementation-plan.md`.

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

## Replay mode (Phase 6)

```sh
# 1. Run the suite with --record to capture every akm / state-db / improve-result I/O.
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --record

# 2. Replay the recorded run deterministically. Compares per-case score,
#    passed, metrics, and evidence against the original case-results.jsonl;
#    exits 0 if all match (within 1e-9 for scores), 1 on any divergence.
scripts/akm-eval/bin/akm-eval-replay latest
```

Recording lands under `<run-dir>/artifacts/replay/`:

```
artifacts/replay/
  akm-invocations.jsonl   one record per AkmCli.run() call (search, version,
                          improve, index — whatever the runners shelled out).
  state-db-queries.jsonl  one record per readEvents / readProposals /
                          available() call, plus the captured result rows.
  improve-results.jsonl   one record per <stash>/.akm/runs/<id>/improve-result.json
                          read.
  replay-result.json      written by akm-eval-replay; reports
                          { deterministic, divergentCases, missingCases,
                            extraCases }.
```

Replay flags:

- `--strict` — also fail on missing or extra cases (default fails only on
  per-case divergences).
- `--format json|md|none` — summary format on stdout (default: md).
- `--stash <path>` / `--out <path>` — same semantics as `akm-eval-run`.

Replay is intentionally narrow: it swaps the three I/O surfaces
(`AkmCli`, `StateDbSources`, `improve-result.json` loader) for playback
wrappers and re-runs the unchanged runners. Determinism therefore holds
for any runner whose only external I/O is those three surfaces —
retrieval and proposal-quality in Phase 1, workflow-compliance in
Phase 3. Memory-safety touches the sandboxed filesystem after `akm
improve` mutates it, so its replay determinism depends on rerunning
against the same fixture (a future filesystem-capture step lands in
Phase 8 if needed).

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

Other case types declared in `src/types.ts` (`memory-safety`,
`workflow-compliance`, `lesson-application`) are accepted in case files
but produce a `skipped` result. They land in Phase 3.

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

## Suites

- `cases/improve-smoke/` — the smoke suite. Five retrieval + three
  proposal-quality cases. Designed to run on any populated stash without
  per-stash customization.

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
    akm-eval-replay        dispatches to src/replay.ts (Phase 6)
  src/
    run.ts                 orchestrator (baseline | akm | paired)
    replay.ts              deterministic replay orchestrator (Phase 6)
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
      state-db.ts          read-only SQLite reader (+ Phase 6 record/playback)
      stash-fs.ts          filesystem fallback for proposals
      akm-cli.ts           shell wrapper (+ Phase 6 record/playback)
      replay-log.ts        Phase 6 recorder/player + JSONL log helpers
      eval-runs.ts         resolver + loader for <stash>/.akm/evals/runs/
      improve-result.ts    loader for <stash>/.akm/runs/<id>/improve-result.json (+ Phase 6 record/playback)
  cases/
    improve-smoke/         starter cases
```

## See also

- `docs/akm-eval.md` — operator guide.
- `docs/technical/akm-eval-implementation-plan.md` — the full plan.
- `scripts/improve-stats/` — the toolkit pattern this one mirrors.
