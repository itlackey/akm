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
- `evolve` — Track B: longitudinal evolution loop.
- `compare` — diff two report JSON files (refuses cross-model / cross-corpus / cross-fixture diffs).
- `attribute` — per-asset marginal contribution via leave-one-out masking.

### Implementation status

Operators reading this guide want to know what's safe to trust. As of the
current branch:

| Subcommand | Status | Notes |
|---|---|---|
| `utility` | Implemented | Paired `noakm`/`akm` Track A over the seeded corpus. Persists raw `runs[]` (#249), stamps `taskCorpusHash` + `fixtureContentHash` (#250), tracks `token_measurement.coverage` (#252), aggregates `corpus_coverage` per memory ability + task family (#262). Optional `--include-synthetic` adds a third self-notes arm (#261). |
| `compare` | Implemented | Refuses model / `taskCorpusHash` / `fixtureContentHash` / schema / track mismatches (exit 1); `--allow-corpus-mismatch` and `--allow-fixture-mismatch` downgrade to warnings (#250). Input/parse errors exit 2. |
| `attribute` | Implemented | Top-N leave-one-out masking. Hydrates `runs[]` from the base envelope when present (#249), falls back to synthesising runs from the per-asset table for legacy reports. Masked-stash wiring fixed by #251 (`TaskMetadata.stashDirOverride`); always run a smoke check that the `attribution.maskedRefs` order matches the rows you expect before trusting marginal-contribution numbers. |
| `evolve` | Stub | Track B (longitudinal feedback → distill → propose loop) is wired in `runEvolve`/`renderEvolveReport` for the wave-3 corpus, but the auto-accept evolution path is gated behind further validation. Treat numbers as exploratory until announced. |

### stdout / stderr contract

`utility`, `compare`, and `attribute` follow the same pattern:

- **stdout** always carries the JSON envelope. This is the machine-readable
  contract and is what `tests/benchmark-suite.ts` consumes.
- **stderr** carries a short markdown summary (and a one-line trace such as
  `tasks discovered: …`).
- `--json` suppresses the markdown summary on stderr; the JSON on stdout is
  unaffected. Trace lines (`tasks discovered`, compare's one-line aggregate,
  attribute's projected re-run count) are still emitted on stderr.
- `--tasks` accepts `train | eval | all`; any other value exits 2 with a
  clear error rather than silently coercing.
- Exit codes: `0` success, `1` refusal (e.g. `compare` model mismatch,
  `attribute` masked-corpus failure), `2` input/usage error.

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

`renderUtilityReport` produces a stamped envelope (`branch`, `commit`,
`model`, `timestamp`, per-arm aggregates) on stdout and a short markdown
summary on stderr suitable for PR descriptions. The envelope additionally
carries:

- `runs[]` — one compact row per (task, arm, seed) run (#249). Required
  input for faithful `attribute` re-runs.
- `taskCorpusHash` / `fixtureContentHash` — deterministic identity stamps
  used by `compare` to refuse cross-corpus / cross-fixture diffs (#250).
- `token_measurement` — `total_runs`, `runs_with_measured_tokens`,
  `runs_missing_measurement`, `runs_unsupported_measurement`, `coverage`,
  `reliable` (#252). The markdown summary's "Token measurement" block
  surfaces this.
- `corpus_coverage` — per-`memory_ability` and per-`task_family` pass
  rate / delta / negative-transfer counts (#262).
- `warnings[]` — additive trust signals (e.g. low token-measurement
  coverage, oversized event log, leakage filtering on evolve).

The bench does not persist reports to a predictable path on its own; the
operator (or CI) is responsible for capturing stdout JSON to disk. The
`tests/benchmark-suite.ts` runner does this for the regression harness.

## Validity checklist

A `utility` report is **only** trustworthy when all of the following hold.
Operators should sanity-check these before quoting numbers in a PR or a
roadmap doc.

- **Hash match (#250).** When comparing two runs, both reports must agree
  on `taskCorpusHash` AND `fixtureContentHash`. Mismatches mean the
  corpus or the fixture stashes drifted between runs and the diff is
  apples-to-oranges. `compare` refuses by default; only override with
  `--allow-corpus-mismatch` / `--allow-fixture-mismatch` if you know
  which task or fixture changed and why.
- **Persisted runs[] (#249).** `runs.length` should equal
  `corpus.tasks × arms × seedsPerArm`. A short `runs[]` array means some
  driver invocations crashed or were truncated; pass-rate numbers built
  from aggregates over a partial bag are misleading.
- **Token measurement coverage (#252).** Don't trust token-economics
  numbers (`tokens_per_pass`, cost regressions) when
  `token_measurement.coverage < 0.95` or `token_measurement.reliable ===
  false`. Re-run with a model/profile that emits parseable token
  accounting before quoting cost deltas.
- **Outcome distribution.** A meaningful run has both arms producing a
  mix of `pass` / `fail`. If every run is `harness_error`, you're
  measuring opencode availability, not akm utility — fix the runtime
  (`pytest` on PATH, `opencode` model auth, etc.) and re-run.
- **Trajectory presence.** `trajectory.akm.correct_asset_loaded` and
  `trajectory.akm.feedback_recorded` should be non-null on the akm arm.
  All-null trajectories usually mean the events.jsonl stream wasn't
  captured (per-run isolation broken, or the cap in §"Trajectory
  metrics" was hit).
- **Compare prerequisites.** `bench compare` only emits a meaningful
  diff when both reports share the same `model`, `schemaVersion`, and
  `track`. The first two are stamped at envelope build time; mismatches
  exit 1.
- **Attribute prerequisites (#251).** `bench attribute` only produces
  faithful marginal-contribution numbers when the base report carries
  `runs[]` (#249) AND the masked-stash override is wired correctly so
  the masked corpus genuinely runs without each top-N asset. Verify
  `attribution.maskedRefs` lists the assets you expected before quoting
  marginal contributions, and confirm `attribute.runsPerformed` matches
  `topN × tasks × arms × seedsPerArm`.
- **Workflow-compliance signal (#256, #259, #260).** The
  `corpus_coverage` workflow-focus rows are only meaningful when the
  workflow-compliance domain ran with non-zero seeds AND the spec set
  in `tests/fixtures/bench/workflows/` matches what was loaded. A
  zero-coverage row indicates the spec wasn't applied, not that the
  agent passed.

If any of the above fails, treat the report as a smoke test: useful for
"did the harness run end-to-end?", not for utility decisions.

## Known caveats

- **Token measurement is opencode-dependent.** Some opencode profiles
  don't emit a parseable token total per turn. Those runs are flagged
  `tokenMeasurement: "unsupported"` (issue #252) and excluded from
  `tokens_per_pass`. The aggregate stays reliable as long as
  `coverage >= 0.95`; below that, the markdown summary annotates the
  numbers as "unreliable".
- **Attribution masking is leave-one-out only.** The masking strategy
  is a single value (`"leave-one-out"`); interaction effects between
  two assets are NOT measured. Reading `marginal_contribution` as
  "removing only this asset" is correct; reading it as "this asset's
  share of the total uplift" is not.
- **Attribution masking validation.** The `attribute` path depends on
  the per-task `stashDirOverride` wiring landed in #251. Before
  trusting marginal contributions on a new corpus, run `bench
  attribute --top 1` and confirm the masked stash actually has the
  named asset removed (the markdown table on stderr will show
  `masked_pass_rate` distinctly from `base_pass_rate`).
- **Trajectory metrics are intentionally minimal.** v1 emits only
  `correct_asset_loaded` and `feedback_recorded` (see §6.2).
  `searched_before_acting` and `irrelevant_assets_loaded` from the
  §13.3 sketch are NOT computed today.
- **Evolve numbers are exploratory.** `improvement_slope` and
  `over_synthetic_lift` depend on `feedback_agreement >= 0.80`;
  below that, the JSON envelope's `warnings[]` carries
  `feedback_agreement_below_threshold` and the headline numbers
  should not be quoted.
- **No on-disk persistence by default.** `bench utility` writes JSON to
  stdout; capturing it for later `compare` / `attribute` runs is the
  operator's job. CI pipelines should redirect stdout to a hashed path
  before invoking compare.

## Adding tasks

Tasks live at `tests/fixtures/bench/tasks/<domain>/<task-id>/` and consist of:

- `task.yaml` — metadata (id, title, domain, difficulty, slice, gold_ref,
  stash, verifier, budget). See `docs/technical/benchmark.md` §13.1.
  Optional memory-operation tags (#262): `memory_ability` (closed set —
  see `tests/bench/corpus.ts` `MEMORY_ABILITY_VALUES`), `task_family`
  (`<domain>/<short-name>`), `workflow_focus`, `expected_transfer_from`,
  `abstention_case`, `conflict_case`, `stale_guidance_case`. The utility
  report's `corpus_coverage` block aggregates pass rate / delta / negative
  transfer per ability and per family. See
  `tests/fixtures/bench/tasks/CORPUS.md` for the closed set + current
  per-family coverage.
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
   accepted lessons + revisions), and `synthetic` (no stash; the agent runs
   the **scratchpad "Bring Your Own Skills" prompt** — `buildSyntheticPrompt(task)`
   is forwarded into the runner via the per-arm `buildPrompt` seam, so the
   synthetic arm exercises the BYOS path explicitly rather than falling
   through to the default akm-arm prompt).

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
- `feedback_integrity` — §6.8 confusion matrix (TP/FP/TN/FN) joining each
  Phase 1 feedback event back to the run that produced it. See
  "Feedback-signal integrity" below.

The headline of the markdown summary is `improvement_slope`. The line
directly after it carries `feedback_agreement` (#244) — the headline trust
gate for the run.

### Feedback-signal integrity (§6.8)

Track B's headline numbers (`improvement_slope`, `over_synthetic_lift`)
are only meaningful when Phase 1 feedback agrees with run outcomes most
of the time. If the agent calls `akm feedback --positive` on runs that
actually failed, Phase 2 distillation walks down the wrong branch and the
post-evolve fixture drifts in a direction that has nothing to do with
real task success. `feedback_integrity` quantifies this:

- `feedback_agreement = (TP + TN) / total` — fraction of feedback events
  that match the run's outcome (positive on pass, negative on fail).
- `false_positive_rate = FP / (FP + TN)` — agent claimed success when
  the run failed.
- `false_negative_rate = FN / (FN + TP)` — agent claimed failure when
  the run passed.
- `feedback_coverage = (Phase 1 runs with any feedback dispatched) /
  (total Phase 1 runs)` — how complete the signal stream is.

Per-asset rows surface the same matrix scoped to a single gold ref so
operators can see whether a single skill is responsible for the
disagreement.

**Warning threshold:** when `feedback_agreement < 0.80`, the markdown
summary prepends a warning marker above the headline and the JSON
envelope's `warnings[]` carries a `feedback_agreement_below_threshold`
entry. Below this gate, treat `improvement_slope` and
`over_synthetic_lift` as unreliable until AGENTS.md guidance for `akm
feedback` is tightened.

Attribution rule: a feedback event is joined to the run that produced
it (by `taskId` + `seed`), not to a later run that happened to touch
the same gold ref. Per-asset rows aggregate across runs that share a
ref, but each individual matrix cell is decided by its own run's
outcome.

### Leakage prevention (§7.4)

The evolve runner now passes the eval-slice gold-ref set into `akm distill`
via the `--exclude-feedback-from <csv>` flag (and the matching env var
`AKM_DISTILL_EXCLUDE_FEEDBACK_FROM`, supplied as a fallback for harnesses
that mangle flags). `akmDistill` filters every event whose `ref` matches
the exclusion list out of the LLM input *before* the prompt is built; the
underlying `events.jsonl` is untouched. Distillation still runs on shared
refs — but only against asset content + non-leaked feedback. When every
event for the target ref is filtered, the result carries
`feedbackFullyFiltered: true` so the operator can see which refs ran from
asset content alone.

Operators can also drive the filter manually:

```sh
# Flag form (CLI takes precedence over env when both are present):
akm distill skill:deploy --exclude-feedback-from "team//memory:auth-tips,skill:foo"

# Env-var fallback (used when the flag is absent):
AKM_DISTILL_EXCLUDE_FEEDBACK_FROM="skill:foo,memory:bar" akm distill skill:deploy
```

Each ref in the CSV must match `[origin//]type:name`; an invalid ref
exits 2 (USAGE) with a structured error envelope on stderr. The runner
adds a per-ref info entry to `warnings[]` of the form
`phase2: filtered eval-slice gold-ref feedback from distill input for
<ref> (--exclude-feedback-from <csv>).` so leakage-protection runs are
visible in the report.

### SIGINT / SIGTERM cleanup contract

The bench creates many tmp directories — per-(task, arm, seed) workspace,
per-task fixture stash, per-fixture evolveStash + preStash. Each is wrapped
in a `try/finally` so happy-path runs leave nothing behind, but an external
`SIGINT`/`SIGTERM` (Ctrl-C, CI cancel) bypasses the `finally` blocks
entirely on Bun.

`tests/bench/cleanup.ts` installs **one** process-level pair of signal
handlers on first `registerCleanup` call. Every tmp dir registers its
cleanup fn at the top of its `try` block and deregisters in the matching
`finally` *before* running the cleanup itself, so the handler doesn't
double-fire. On signal, the handler:

1. Walks every registered cleanup fn (swallowing errors).
2. Removes its own listeners so a second Ctrl-C force-exits via the
   runtime default.
3. `process.exit(130)` (POSIX 128 + SIGINT(2)).

Re-entrant signals while cleanup is in flight are dropped. Operators who
need a hard kill can press Ctrl-C twice.

### Workflow specs (#255)

Declarative workflow rules live under `tests/fixtures/bench/workflows/*.yaml`
and define what AKM agent behavior we expect for each task category. They
are loaded by `tests/bench/workflow-spec.ts` and consumed by Wave 3's
compliance evaluator (#256).

**Authoring a spec.** Each YAML file holds one `WorkflowSpec`:

```yaml
id: akm-lookup-before-edit            # unique within the dir
title: "Agent searches AKM before editing"
description: "..."                    # optional
applies_to:                           # optional filters
  arms: ["akm"]                       # arms this spec applies to
  task_domains: ["docker-homelab"]    # domain prefixes from task_id
required_sequence:                    # ordered required events
  - event: agent_started
  - event: akm_search
    before: first_workspace_write     # must occur before this event
forbidden:                            # events that must NOT occur
  - event: first_workspace_write
    before: akm_search
scoring:                              # weights must sum to 1
  required_steps_weight: 0.7
  forbidden_steps_weight: 0.2
  evidence_quality_weight: 0.1
```

The loader rejects:
- malformed YAML or missing required fields,
- unknown event names (validated against the 14-name `KNOWN_EVENT_NAMES`
  set, hardcoded from #254's brief; Wave 3 will reconcile by importing
  from `workflow-trace.ts` directly),
- scoring weights outside `[0,1]` or whose sum is not `1.0` (1e-6
  tolerance),
- `gold_ref` values that fail `parseAssetRef` from `src/core/asset-ref.ts`,
- specs larger than 1 MiB (DoS guard),
- file paths that resolve outside the supplied workflows root
  (path-traversal guard via `path.relative` containment),
- duplicate `id` within a single `loadAllWorkflowSpecs(dir)` call.

**Loading specs.** Use `loadAllWorkflowSpecs(dir)` to load every
`*.yaml` under `dir`. Use `loadWorkflowSpec(path, root?)` to load one;
when `root` is supplied the path-traversal guard is enforced.

**Applying specs.** `specApplies(spec, { arm, taskId })` returns whether
the spec's `applies_to` filters match the run. Wave 3's evaluator calls
this once per (run, spec) before scoring.

**Errors.** All loader failures throw `WorkflowSpecError`, which carries
`.code === "WORKFLOW_SPEC_INVALID"` for v1 contract compliance and
`.specPath` for diagnostics.

## Pointers

- Plan: `docs/technical/benchmark.md`.
- Search-pipeline benchmark sibling: `tests/BENCHMARKS.md`.
- Fixture stashes: `tests/fixtures/stashes/`.
- Workflow specs: `tests/fixtures/bench/workflows/`.
