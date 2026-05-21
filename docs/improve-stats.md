# improve-stats — Analyzing `akm improve` Runs

These scripts analyze structured run logs from `akm improve`. Every
invocation of `akm improve` writes a JSON envelope to
`<stash>/.akm/runs/<run-id>/improve-result.json` capturing what was
considered, what was acted on, what was skipped and why. The toolkit in
`scripts/improve-stats/` reads those envelopes and produces compact,
operator-friendly summaries so you don't have to grep raw JSON.

The toolkit is shell + `jq`; no extra dependencies. Run from the source
repo (or any clone of it) — the scripts read your local stash directly.

## Quick start

Clone the `akm` source repo (these scripts live in `scripts/improve-stats/`),
then point them at your stash:

```bash
cd ~/code/akm                              # or wherever the source lives
scripts/improve-stats/runs-trend 12 | column -t
scripts/improve-stats/run-show latest
```

By default the scripts read from `$AKM_STASH_DIR` (falling back to
`~/akm`). Every script accepts `--stash <path>` to override per-call.

## Scripts

| Script              | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `runs-list`         | Recent runs as a table — one row per run, lint/mem/distill columns.   |
| `run-show <id>`     | Pretty summary for one run (`latest` resolves to the most recent).    |
| `runs-trend [N]`    | TSV across last N runs (default 12). Pipe to `column -t`.             |
| `actions-breakdown` | Mode + skip-reason counts for one run.                                |
| `lint-current`      | Live `akm lint --json` grouped by issue type.                         |

### `runs-list [N]`

One-line summary per recent run. Default `N = 20`. Output is a tab-aligned
table with these columns:

- `ts` — run timestamp.
- `ok` — overall result (`true` / `false`).
- `actions` — total action count (`distill-*`, `reflect-*`, memory writes, etc.).
- `lint_fixed`, `lint_flagged` — `akm lint` outcome that ran inside the
  improve pass.
- `mem_written`, `mem_considered` — memory inference: facts persisted vs
  candidates seen.
- `distill_attempt`, `distill_skipped` — distill action counts.
- `run_id` — the directory id, used to drill in with `run-show`.

Example:

```sh
scripts/improve-stats/runs-list 5
```

### `run-show <id|latest>`

Pretty per-run summary as JSON. Pass a run id, or `latest` / `last` to
resolve the most recent one. Surfaces the same fields as `runs-list` plus:

- `modes` — count per action mode (e.g.
  `{"memory-write": 5, "distill-attempt": 10, "distill-skipped": 18}`).
- `memoryInference`, `memorySummary` — the full memory-inference block.
- `graphExtraction` — entity / relation counts, warnings.
- `stalenessDetection` — confirmed / deprecated counts.
- `evalCasesWritten`, `orphansPurged`, `lintSummary`.

Use this when `runs-trend` shows something unusual and you want the full
context of a single run.

```sh
scripts/improve-stats/run-show latest
scripts/improve-stats/run-show 2026-05-20T18-03-12-411Z-4
```

### `runs-trend [N]`

Trend TSV across the last `N` runs (default 12), oldest-first so reading
top-to-bottom matches the order events happened. Pipe to `column -t` for
visual scanning, or to `awk` / `gnuplot` for plotting.

Columns:

```
ts  lint_fixed  lint_flagged  mem_written  mem_considered  graph_entities
graph_relations  distill_attempt  distill_skipped  planned  actions
```

The most useful single command for catching regressions:

```sh
scripts/improve-stats/runs-trend 24 | column -t
```

Reads top-to-bottom as a chronological audit log. A column that drops to
zero across consecutive runs is the canonical signal that a feature gate
or cooldown flipped silently.

### `actions-breakdown <id|latest>`

Decomposes a single run's `actions[]` into:

- **modes** — `mode` counts in descending order. Surfaces what the run
  actually did (vs the headline "actions: 207" number).
- **distill skip reasons** — grouped counts. Catches cases where the
  cooldown / no-eligible-candidate / model-failure path dominates.
- **reflect skip reasons** — same idea for reflect actions.
- **non-skip outcomes (sample)** — first 5 non-skipped actions in full,
  for spot-checking.

Use this when `run-show` says `actions: 207` but you suspect 200 of them
are just skips.

```sh
scripts/improve-stats/actions-breakdown latest
```

### `lint-current`

Live snapshot of `akm lint --json` for the configured stash, grouped by
issue type with a total count. Add `--sample N` to show N representative
entries per issue class.

```sh
scripts/improve-stats/lint-current
scripts/improve-stats/lint-current --sample 3
```

The `--sample` form is the one to reach for when starting a lint sweep:
the count tells you how many flags you have; the samples tell you what
kinds of flags they are so you can pick a repair strategy.

## Tuning playbook

The scripts were extracted from a session that diagnosed three concrete
production issues. Each example shows the diagnostic that surfaced the
problem and the resulting fix.

### Distill never attempted

`runs-trend 12` exposed `distill_attempt: 0` across 8 consecutive hourly
runs. Root cause: the 30-day default cooldown on distillable refs meant
nothing was eligible. Fix: drop the cooldown to 1 day. Next run jumped
`actionable` from 0 to 17.

Diagnostic recipe:

```sh
scripts/improve-stats/runs-trend 24 | column -t
# If distill_attempt is 0 across many runs, drill in:
scripts/improve-stats/actions-breakdown latest
# Look at the "distill skip reasons" block — a dominant
# "cooldown" reason is the smoking gun.
```

### Memory inference silent

`runs-trend` showed `mem_written: 0` for most runs; `run-show latest`
confirmed the v2 feature gate wasn't being honoured. Fix: corrected the
gate in `feature-gate.ts`. The next run wrote 5 facts from 5 split
parents.

Diagnostic recipe:

```sh
scripts/improve-stats/runs-trend 12 | column -t
# mem_considered > 0 AND mem_written == 0 means inference saw candidates
# but rejected all of them. Drill into the actual decisions:
scripts/improve-stats/run-show latest
# memoryInference + memorySummary blocks show per-candidate disposition.
```

### Lint convergence

`lint-current` decomposed 120 flags into 5 issue classes; a repair agent
fixed 116 of them. The other 4 stayed flagged because they needed a
human decision (cross-directory ambiguity in ref targets).

Diagnostic recipe:

```sh
scripts/improve-stats/lint-current --sample 3
# Use the per-issue sample to pick a repair strategy:
#   - missing-ref → does a near-match target exist? If yes, fix the ref.
#                   If no, drop the broken line or add a refs: [] carve-out.
#   - stale-path  → the filesystem reference is gone; remove the line.
#   - dangerous-vault-key → security review; not a bug to "fix".
```

## The loop

When tuning the improve pipeline the canonical loop is:

```sh
scripts/improve-stats/runs-trend 12 | column -t   # see what's moving
scripts/improve-stats/run-show latest             # zoom on the most recent
scripts/improve-stats/actions-breakdown latest    # why are actions skipping?
```

Three commands, ten seconds, full picture. Reach for it before opening
any single `improve-result.json` by hand.
