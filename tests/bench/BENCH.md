# akm-bench — Operator Guide

Sibling of `tests/BENCHMARKS.md`. The bench measures whether akm changes how
an agent performs on real tasks; the search benchmark measures whether the
search pipeline returns the right asset for a query. Different jobs.

See `docs/technical/benchmark.md` for the full design.

## Prerequisites

- `bun >= 1.0` (already required by the rest of the repo).
- `opencode` CLI on `PATH`. The bench shells out via the built-in
  `opencode` profile in `src/integrations/agent/profiles.ts`.
- `BENCH_OPENCODE_MODEL` env var. The model identifier is stamped into
  every `RunResult` and the report envelope; `bench compare` refuses to diff
  reports run on different models.
- For tasks with `verifier: pytest`, Python + `pytest` on `PATH`. Tasks whose
  runtime is missing produce `harness_error`, not `fail`.

## Running a track

The CLI is a thin Bun script:

```sh
BENCH_OPENCODE_MODEL=anthropic/claude-opus-4-7 \
  bun run tests/bench/cli.ts utility --tasks eval

BENCH_OPENCODE_MODEL=anthropic/claude-haiku-4-5 \
  bun run tests/bench/cli.ts utility --tasks all --json > report.json
```

Subcommands:

- `utility` — Track A: paired noakm vs akm utility benchmark.
- `evolve` — Track B: longitudinal evolution loop. Stub in #236; lands in #239.
- `compare` — diff two report JSON files. Stub in #236; lands in #240.
- `attribute` — per-asset marginal contribution. Stub in #236; lands in #243.

`--tasks` accepts `train | eval | all`; any other value exits 2 with a clear
error rather than silently coercing. The JSON envelope is **always** written
to stdout — that is the bench's machine-readable contract and matches
`tests/benchmark-suite.ts`. The `--json` flag means "machine-readable only":
it suppresses the human-friendly markdown summary that is otherwise written to
stderr alongside the JSON. Without `--json`, both stdout (JSON) and stderr
(markdown summary) get content; with `--json`, stderr only carries minor trace
lines (e.g. the `tasks discovered: …` line).

## Trajectory metrics — what the v1 contract emits

`docs/technical/benchmark.md` §6.2 is the normative list of trajectory
metrics. It defines two booleans that the v1 utility report emits today:

- `correct_asset_loaded` — did the agent invoke `akm show <goldRef>`?
- `feedback_recorded` — did the agent emit any `feedback` event?

The §13.3 sample envelope shows two additional illustrative fields
(`searched_before_acting` and `irrelevant_assets_loaded`). Those were
aspirational sketches, not part of the v1 commitment, and computing them
well requires tool-call tracing that #238 deliberately deferred. The JSON
`trajectory.akm` object therefore carries **only** the two §6.2 fields in
v1; if a future PR wants to land them, it can extend the shape additively
without breaking the v1 contract.

Per-run inputs (events.jsonl bytes-read and verifierStdout substring scan)
are capped at 16 MiB each. A runaway agent that produces more than that does
not OOM the bench; trajectory is computed from the prefix and a warning is
appended to the report's top-level `warnings[]`.

## Per-run isolation

Every (task, arm, seed) triple gets a fresh tmp dir holding:

- `XDG_CACHE_HOME` — akm's index DB and `events.jsonl` land here.
- `XDG_CONFIG_HOME` — akm's config lookup falls back to this dir.
- `OPENCODE_CONFIG` — opencode's per-run config dir.
- `AKM_STASH_DIR` — set only when the arm is `akm` or `post-evolve`.

The operator's personal `~/.config/akm`, `~/.cache/akm`, `~/.config/opencode`,
and any pre-existing `AKM_STASH_DIR` are NEVER read or written. The driver
asserts this in `tests/bench/driver.test.ts`.

`OPENCODE_API_KEY` is intentionally inherited from the operator's environment
so opencode can authenticate with its provider — it is the one credential the
harness deliberately does NOT isolate, while `OPENCODE_CONFIG`, `XDG_CACHE_HOME`,
`XDG_CONFIG_HOME`, and `AKM_STASH_DIR` are pinned to per-run tmpdirs.

After the run completes the entire tmp tree is removed; the driver copies
`events.jsonl` into the `RunResult.events` array first so trajectory parsing
in #238 has the bytes it needs without touching disk again.

## Outcome vocabulary

Every `RunResult` carries one of four outcomes:

- `pass` — verifier exited 0.
- `fail` — verifier exited non-zero. The agent ran, the workspace got
  modified, the deterministic check still failed.
- `budget_exceeded` — the agent's wallclock or token budget was exhausted.
  This is a separate state from `fail` so cost regressions don't hide as
  quality regressions.
- `harness_error` — opencode failed to spawn, or a required runtime (e.g.
  `pytest`) was missing. NOT the agent's fault; excluded from pass-rate.

## Reports

`renderJsonReport` produces a stamped envelope with `branch`, `commit`,
`model`, `timestamp`, and per-arm aggregates. `renderMarkdownSummary`
produces a 5-ish-line summary suitable for PR descriptions.

For #236 reports go to stdout/stderr; persisting them to disk under a
predictable path is part of #238.

## Adding tasks

Tasks live at `tests/fixtures/bench/tasks/<domain>/<task-id>/` and consist of:

- `task.yaml` — metadata (id, title, domain, difficulty, slice, gold_ref,
  stash, verifier, budget). See `docs/technical/benchmark.md` §13.1.
- `workspace/` — initial files copied into the agent's cwd.
- `verify.sh` (script verifier), `tests/test_*.py` (pytest), or
  `expected_match` regex in `task.yaml` (regex verifier).

A sample task fixture lives at `tests/fixtures/bench/tasks/_example/example-task/`
for unit-test consumption. Detailed task-authoring guidance lands with the
corpus build-out in #237.

Stashes are referenced by name from `tests/fixtures/stashes/`; the bench
loader copies the named fixture into a tmp dir per run via
`loadFixtureStash` from `tests/fixtures/stashes/load.ts`.

## Track B (`bench evolve`)

`bench evolve --tasks <domain>` runs the longitudinal three-phase loop on a
single domain (or `--tasks all` for the whole corpus):

1. **Phase 1 — accumulate signal.** K seeds × train-slice tasks under the akm
   arm. After each run lands the runner invokes
   `akm feedback <gold_ref> --positive` (on pass) or `--negative` (on fail).
2. **Phase 2 — evolve.** Every asset whose negative feedback crosses the
   threshold (default: `>= 2` absolute OR `> 50%` ratio) triggers
   `akm distill` and `akm reflect`. Each resulting proposal is validated via
   `akm proposal show --json`; lint-passing ones are auto-accepted, lint
   failures are auto-rejected with a captured reason. Track B is the
   **auto-accept-only** scope per spec §11; human-in-the-loop is post-v1.
   The index is rebuilt at the end of the phase.
3. **Phase 3 — re-evaluate.** Eval-slice tasks are run under three arms:
   `pre` (the original un-evolved fixture), `post` (the evolved stash with
   accepted lessons + revisions), and `synthetic` (no stash; the agent
   writes its own scratchpad — "Bring Your Own Skills").

`bench evolve` runs **entirely in tmp directories**. Before Phase 1 starts,
the runner materialises one dedicated tmp stash per fixture (the
`evolveStash`) plus a fresh sibling snapshot per fixture (the `preStash`).
Phase 1 + Phase 2 pin `AKM_STASH_DIR` to the appropriate evolveStash for
every spawned `akm` invocation; Phase 3's pre arm reads from preStash, the
post arm reads from the mutated evolveStash, and the synthetic arm reads
no stash at all. **The operator's real `AKM_STASH_DIR` is never read or
written.** All tmp stashes are torn down in a top-level try/finally.

The report (§6.3 + §6.4 envelope) carries:

- `proposals` — `acceptance_rate`, `lint_pass_rate`, plus a per-asset table.
- `longitudinal` — `improvement_slope = post − pre`, `over_synthetic_lift =
  post − synthetic`, and a `degradation_count` of eval tasks where
  `pre − post > 1 / seedsPerArm`. Each degradation row carries the post-arm
  `failure_mode` from §6.6.
- `arms.{pre,post,synthetic}` — full §13.3 utility envelopes per arm so the
  per-task pre→post→synthetic delta is reproducible.

The headline of the markdown summary is `improvement_slope`. The second
line is a placeholder for `feedback_agreement`, which lands with #244.

### Leakage prevention (§7.4)

The evolve runner refuses to invoke `akm distill` / `akm reflect` on any
ref that is also an eval-slice gold ref. It additionally exports
`AKM_BENCH_EXCLUDE_GOLD_REFS=<csv>` so a future akm version can filter
its LLM input. Today's `akm distill` does not honour that hint, so the
runner records a warning when distillation runs on shared content and
defers the harder filter to a follow-up.

## Pointers

- Plan: `docs/technical/benchmark.md`.
- Search-pipeline benchmark sibling: `tests/BENCHMARKS.md`.
- Fixture stashes: `tests/fixtures/stashes/`.
