# improve-stats — analysis toolkit for `akm improve` runs

> **0.8.0+: prefer `akm health`.** Every metric these scripts compute
> is now first-class on the health command's result envelope:
> `akm health --since 24h` (rollup), `--detail per-run` (per-row table),
> `--window-compare 24h` or `--windows 'name=...,since=...'` (A/B).
> See [`docs/improve-stats.md`](../../docs/improve-stats.md). These
> scripts are retained because they're convenient one-shot
> ad-hoc tools that don't require remembering jq paths.

Quick scripts for digging into improve-run envelopes. Built from the
patterns that came out of tuning the improve pipeline in May 2026.

## Storage

As of 0.8.0 every run is persisted as a row in the `improve_runs`
table of `state.db` (`$XDG_DATA_HOME/akm/state.db`, default
`~/.local/share/akm/state.db`). The legacy
`<stash>/.akm/runs/<run-id>/improve-result.json` layout was archived
once by `scripts/migrations/import-fs-improve-runs-to-db.ts`. All
helpers below read from the DB directly via `sqlite3`. `--stash` is
preserved for back-compat but no longer reads from the filesystem.

Override the DB path with `AKM_STATE_DB_PATH` for tests or relocated
installs.

## Backfilling legacy runs

If you find another machine still on the filesystem layout, run:

```sh
bun scripts/migrations/import-fs-improve-runs-to-db.ts          # import + archive
bun scripts/migrations/import-fs-improve-runs-to-db.ts --dry-run # report only
bun scripts/migrations/import-fs-improve-runs-to-db.ts --no-archive
```

The import is idempotent — `INSERT OR IGNORE` on the run-id PK, so
re-running adds nothing. After a clean import the script renames
`<stash>/.akm/runs/` to `<stash>/.akm/runs.archived-<ts>/` (skip with
`--no-archive`).

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
