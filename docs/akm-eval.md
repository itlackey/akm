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

This page documents Phase 1 (read-only deterministic runner). See
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

## What it measures (Phase 1)

Two runner types ship in Phase 1:

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
`lesson-application`, `regression`) are accepted in case files but
produce a `skipped` result in Phase 1.

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

## What Phase 1 does not do

- No mutation of the stash.
- No `akm improve` invocation (`--mode paired` lands in Phase 2).
- No memory-safety eval (lands in Phase 3 with a mandatory sandbox).
- No workflow-compliance eval (lands in Phase 3).
- No LLM judging (lands in Phase 7).
- No regression diffing across runs (lands in Phase 2).

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
