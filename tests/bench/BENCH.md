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
(`replan_count` and `tool_call_overhead_ms`). Those were aspirational
sketches, not part of the v1 commitment, and computing them well requires
tool-call tracing and replan detection that #238 deliberately deferred. The
JSON `trajectory.akm` object therefore carries **only** the two §6.2 fields
in v1; if a future PR wants to land replan/overhead metrics, it can extend
the shape additively without breaking the v1 contract.

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

## Pointers

- Plan: `docs/technical/benchmark.md`.
- Search-pipeline benchmark sibling: `tests/BENCHMARKS.md`.
- Fixture stashes: `tests/fixtures/stashes/`.
