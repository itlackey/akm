# Improve Evaluation Execution Plan

## Status

Approved for implementation on 2026-07-23. This plan builds the minimum
isolated evaluation infrastructure needed to determine whether `akm improve`
causes measurable quality gains over a no-improve control. It does not authorize
the later improve behavioral changes; those remain gated on experiment results.

## Objective

Answer, with reproducible evidence:

> Does the current improve pipeline make a frozen AKM installation better than
> leaving the same installation unchanged, without protected regressions and at
> acceptable cost?

Activity, proposal volume, accepted changes, and retrieval impressions are not
quality outcomes. The primary comparison is a treatment-independent deterministic
suite executed against equivalent control and treatment installations.

## Existing Substrate

Reuse rather than replace:

- `scripts/akm-eval/src/graph-ablation.ts` for twin-sandbox orchestration and
  repeated samples.
- `scripts/akm-eval/src/run.ts` and `src/compare.ts` for case execution and
  result comparison.
- `scripts/akm-eval/src/sources/sandbox.ts` for process isolation.
- `scripts/akm-eval/src/sources/eval-runs.ts` for suite fingerprints.
- `tests/fixtures/stashes/curate-golden` for rank-aware retrieval quality.
- `tests/fixtures/stashes/ranking-baseline` and `all-types` for general search
  and AKM-native behavior.
- `tests/fixtures/bundles/**` for adapter, format, read-only, and secret-safety
  conformance.
- `scripts/akm-eval/cases/memory-regression` and `judge-calibration` for memory
  safety and generation-gate calibration.
- `tests/docker/**` for container build and installation patterns.

Known fixtures prove deterministic behavior and safety. They do not represent a
full improve installation because they generally omit config, state, index,
usage, feedback, proposals, and eligibility history. A full-state snapshot is
therefore required for the causal experiment.

## Frozen Contracts

### Installation Snapshot

One snapshot is captured before either arm is created. It contains:

- every configured local bundle root needed by the experiment;
- `config.json` with literal secrets rejected and runtime values supplied
  separately;
- verified SQLite snapshots of `state.db` and `index.db`;
- a canonical manifest with relative paths, byte sizes, SHA-256 hashes, and
  snapshot schema version;
- producer version/commit, config fingerprint, and source snapshot hash.

Live SQLite databases must be copied with the SQLite backup API or an existing
verified generation-copy algorithm. Raw copying of a changing main/WAL pair is
not allowed.

Snapshot capture and materialization fail closed on missing files, hash mismatch,
path escape, or inconsistent database generations.

The database snapshots are not content-sanitized and may contain sensitive
historical metadata. The whole snapshot is classified private-sensitive, stays
on trusted local storage, is never committed or uploaded, and is never included
in a container build context. Known secret-bearing bundle paths and obvious
literal config secrets are rejected as an additional guard, not as proof that
the SQLite contents are secret-free.

### Twin Experiment

Each sample materializes two independent installations from the same snapshot:

- `control`: index and evaluate without running improve;
- `treatment`: run the selected improve command, reindex when required, then
  evaluate the identical suite.

Both arms receive the same external event inputs, suite fingerprint, model
configuration, and starting bytes. Results retain both sandboxes when requested
and always record final file-tree fingerprints, database mutation counts, and
mutation summaries. Full path-bearing manifests are private artifacts retained
only when explicitly requested.

The treatment policy is explicit:

- `current`: run current shipped behavior, including the changes it directly
  applies;
- `candidate-only`: evaluate queued candidates without applying them;
- future policies require a new named value and cannot silently change an
  existing experiment.

### Result Envelope

The twin result records:

- experiment and sample IDs;
- snapshot and suite fingerprints;
- separate snapshot and runtime producers plus control/treatment config,
  prompt, model, and endpoint fingerprints;
- treatment policy and improve arguments;
- per-case control/treatment scores and deltas;
- newly passing and newly failing cases;
- protected regressions;
- file and database mutation summaries;
- model calls, prompt/completion/total tokens, improve wall duration, model-call
  duration, telemetry completeness, and available throughput telemetry;
- status: `pass`, `fail`, or `inconclusive`, with reasons.

Zero executed cases, mismatched fingerprints, incomplete attribution, or failed
materialization produce `inconclusive`, never `pass` or `fail`.

### Endpoint Contract

Experiments may use two endpoints hosting the same nominal model. Endpoint
hardware and tokens/second may differ. Every endpoint must record:

- stable endpoint ID;
- model identifier and model-file/hash fingerprint when available;
- quantization, context limit, server implementation/version, and relevant
  sampler settings;
- measured calls, tokens, duration, and tokens/second.

Response-sourced `llm_usage` model IDs must match the assigned endpoint before
its model and operator-attested prompt fingerprints are accepted into a
conclusive result; a configured-model fallback is not observation. Every HTTP
attempt, including retries and failures, emits one terminal record, and the run
emits a separate expected-count summary marker. Missing or mismatched markers,
failed attempts, configured-only model IDs, required fields, cursors, or
persistence success make the sample inconclusive.

Quality results may be pooled only when model and serving fingerprints are
compatible. Wall-clock latency and tokens/second are never compared across
different endpoint hardware as if they were treatment effects.

For experiments where both arms invoke an LLM, repeated samples use a crossover:

- sample 1: arm A on endpoint 1, arm B on endpoint 2;
- sample 2: arm A on endpoint 2, arm B on endpoint 1.

Endpoint assignment is included in the result. For no-improve versus improve,
only treatment invokes the improve model, so the second endpoint increases
replication throughput but does not create a latency control. Quality samples
should be distributed evenly across compatible endpoints.

## Execution Rounds

### Round 0: Seed And Contracts

One integration owner:

1. Selects the reviewed seed SHA containing current rc.10 fixes.
2. Lands shared snapshot, experiment, endpoint, and result types.
3. Adds contract tests without changing improve behavior.
4. Runs typecheck and focused eval tests.

No implementation workstream edits the shared contracts independently after
this gate.

### Round 1: Parallel Harness Work

Four non-overlapping workstreams:

1. **Snapshot:** safe full-state capture, manifest verification, and
   materialization.
2. **Twin runner:** generalized no-improve/current-improve orchestration based on
   the graph ablation harness.
3. **Semantic fixtures:** labeled consolidation fixtures derived from audited
   true positives, defensible compressions, provenance spelling cases, and
   known false negatives.
4. **Evaluator validity:** complete environment isolation, zero-case
   `inconclusive`, current ref/config fixtures, and sandbox-local state reads.

### Round 2: Parallel Evidence Runs

Run independently:

- full-state no-improve versus current improve;
- semantic consolidation preservation;
- R2 search salience on/off using curate-golden plus frozen real queries;
- reflect/distill judge calibration and candidate quality;
- bundle-format, read-only, secret-safety, and memory-regression suites.

Use repeated samples for LLM-dependent results. Parallelize deterministic tests
freely. Do not send concurrent requests to one local model endpoint unless that
endpoint is explicitly provisioned for concurrency. When two compatible
endpoints are available, use balanced/crossover assignment as defined above.

### Round 3: Evidence-Gated Product Changes

Separate branches may implement only decisions supported by Round 2:

- proposal-only semantic merge/delete and repair proposals;
- mutation journal, run attribution, metric versioning, and one post-mutation
  reindex;
- default-off R2 search salience if it fails the quality/latency gate;
- retain, restrict, or disable reflect/distill lanes according to paired quality
  and cost;
- extraction remains off unless separately approved for a bounded pilot.

### Round 4: Review And Release Gate

Read-only reviewers cover experimental validity, semantic fidelity,
transaction/provenance safety, test isolation/security, and cost/metrics.
Findings return to the owning branch. Final integration runs formatting,
typecheck, unit and integration suites, build, deterministic evals, release
checks, and the Docker matrix.

## Immediate Test Matrix

| Fixture | Required proof |
| --- | --- |
| `curate-golden` | nDCG, MRR, recall, and banned-hit stability |
| `ranking-baseline` | deterministic ranking and salience ablation |
| `all-types` | AKM-native candidate generation and format preservation |
| `bundles/**` | adapter-native validation, read-only refusal, path safety |
| `memory-regression` | stale, superseded, contradicted, and hot-memory safety |
| `judge-calibration` | generation decision agreement and variance |
| audited merge fixtures | direct provenance and required-claim retention |
| full-state private snapshot | realistic eligibility, cost, and end-to-end effect |

Committed fixtures are copied into sandboxes and never mutated in place. Private
full-state snapshots and results stay outside the repository and are handled as
sensitive even after known literal secrets and secret-bearing bundle paths are
rejected.

## Decision Rules

Before reading treatment outcomes, define:

- the primary deterministic quality metric;
- minimum material lift;
- allowed loss/non-inferiority margin for subtractive changes;
- protected cases that may not regress;
- required sample size from untouched-baseline variance;
- hard token, call, and wall-time budgets;
- willingness to pay per incremental verified success.

Proceed only when the treatment clears the predeclared quality threshold, has no
protected regression, has complete attribution, and stays within budget.

Disable an autonomous lane when results demonstrate material harm, futility, or
hard-budget breach. Mark underpowered, mismatched, or incomplete results
`inconclusive` and collect more samples without changing the decision rule.

## No-Go Behavior

Failure does not authorize an in-place downgrade to 0.8.14. Keep the migrated
0.9 installation, disable autonomous improve schedules, and preserve search,
feedback, manual proposals, archives, and state. Any 0.8 comparison runs only in
isolated roots restored from a compatible pre-cutover snapshot.
