# akm-eval — lightweight standalone evaluation toolkit

Read-only, deterministic measurement of `akm` over the existing run
envelopes, events table, and proposal queue. This is the Phase 1
implementation per `docs/technical/akm-eval-implementation-plan.md`.

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

## What Phase 1 covers

Two runner types:

- **retrieval** — shells out to `akm search <query> --format jsonl
  --detail agent` and scores against `mustIncludeRefs`,
  `mustNotIncludeRefs`, `keywords`, and `minHits`.
- **proposal-quality** — reads `state.db` (or `<stash>/.akm/proposals/`
  as fallback) and reports counts, validation pass rate, accept rate,
  reject rate, and accept-rate-per-source.

Phase 1 is **read-only and deterministic**. It does not mutate the
stash, never runs `akm improve`, never calls an LLM.

Other case types declared in `src/types.ts` (`memory-safety`,
`workflow-compliance`, `lesson-application`, `regression`) are accepted
in case files but produce a `skipped` result with reason "runner not
implemented in Phase 1". They land in Phases 2–3 per the plan.

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
    akm-eval-run           Phase 1 entry: invokes src/run.ts
  src/
    run.ts                 orchestrator
    types.ts               EvalCase, EvalCaseResult, EvalRunResult
    scoring.ts             weighted aggregation
    report.ts              Markdown renderer
    runners/
      retrieval.ts         akm search → score
      proposal-quality.ts  state.db / .akm/proposals → score
    sources/
      paths.ts             stash + data-dir + state.db path resolution
      state-db.ts          read-only SQLite reader
      stash-fs.ts          filesystem fallback for proposals
      akm-cli.ts           shell wrapper for `akm search`, `akm --version`
  cases/
    improve-smoke/         Phase-1 starter cases
```

## See also

- `docs/akm-eval.md` — operator guide.
- `docs/technical/akm-eval-implementation-plan.md` — the full plan.
- `scripts/improve-stats/` — the toolkit pattern this one mirrors.
