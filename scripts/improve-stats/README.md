# improve-stats — analysis toolkit for `akm improve` runs

Quick jq-based scripts for digging into the structured run logs in
`~/akm/.akm/runs/<run-id>/improve-result.json`. Built from the patterns
that came out of tuning the improve pipeline in May 2026.

All scripts read from the stash directory in `$AKM_STASH_DIR` (default:
`~/akm`). Override with `--stash <path>`.

| Script              | What it answers                                                       | Status                                        |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `runs-list`         | Recent runs as a table — one row per run, lint/mem/distill columns.   | active                                        |
| `run-show <id>`     | Pretty summary for one run (`latest` resolves to the most recent).    | **shim** → `akm-eval-collect`                 |
| `runs-trend [N]`    | TSV across last N runs (default 12). Pipe to `column -t`.             | active                                        |
| `actions-breakdown` | Mode + skip-reason counts for one run.                                | **shim** → `akm-eval-collect`                 |
| `lint-current`      | Live `akm lint --json` grouped by issue.                              | active                                        |

## Migration to `scripts/akm-eval/`

`run-show` and `actions-breakdown` are now thin shells over
`scripts/akm-eval/bin/akm-eval-collect`. The same per-run metrics (and
more — full action breakdowns, validation failures, memory cleanup,
graph extraction, staleness telemetry) land in the collected summary.

Reflect-failure classification — succeeded vs schema-shape vs
content-policy vs gate-refused, with the LLM-touched denominator — used
to be a hand-rolled `jq` pipeline over `improve-result.json`. It is now
the `reflect-failure-breakdown` eval case under
`scripts/akm-eval/cases/improve-smoke/`. Run:

```sh
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke
scripts/akm-eval/bin/akm-eval-trend --metric schemaShapeRate
```

`runs-list`, `runs-trend`, and `lint-current` stay because the
akm-eval toolkit doesn't yet cover their use cases.

## Tuning playbook

The scripts were extracted from a session that diagnosed:

- **Distill never attempted** — `runs-trend` exposed `distill_attempt: 0`
  across 8 consecutive hourly runs. Root cause: 30-day default cooldown.
  Fix: drop to 1 day → `actionable` went from 0 to 17.
- **Memory inference silent** — `runs-trend` showed `mem_written: 0` for
  most runs; `run-show latest` confirmed the v2 feature gate wasn't being
  honoured. Fix in `feature-gate.ts`.
- **Lint convergence** — `lint-current` decomposed 120 flags into 5
  issue classes; a repair agent fixed 116 of them.

When tuning the pipeline, the loop is:

```sh
scripts/improve-stats/runs-trend 12 | column -t   # see what's moving
scripts/improve-stats/run-show latest             # zoom on the most recent
scripts/improve-stats/actions-breakdown latest    # why are actions skipping?
```
