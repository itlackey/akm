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

This page documents Phases 1, 2, 3, and 6 (read-only deterministic
runner, paired mode, compare, trend, regression, run-envelope ingestion,
memory-safety + workflow-compliance runners, and deterministic replay).
See `docs/technical/akm-eval-implementation-plan.md` for the full
eight-phase plan and `scripts/akm-eval/README.md` for the operator
quick-start.

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

Other types (`memory-safety`, `workflow-compliance`,
`lesson-application`) are accepted in case files but produce a
`skipped` result until Phase 3. `regression` is implemented.

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

## What Phases 1 + 2 do not do

- No mutation of the real stash (paired mode mutates only a tmpdir copy
  unless you pass `--no-sandbox` / `--allow-mutate`).
- No memory-safety eval (lands in Phase 3 with a mandatory sandbox).
- No workflow-compliance eval (lands in Phase 3).
- No LLM judging (lands in Phase 7).

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
