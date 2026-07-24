# akm-eval — lightweight standalone evaluation toolkit

Read-only-by-default, deterministic measurement of `akm` over the existing
run envelopes, events table, and proposal queue. Implements all eight
phases of the (since-retired) akm-eval implementation plan.

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

# Paired mode: snapshot → akm improve → re-eval, with deltas. Sandboxed by default.
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
  --improve-args "--limit 10 --dry-run"

# Compare two completed eval runs
scripts/akm-eval/bin/akm-eval-compare <baseline-id|latest> <current-id|latest>

# TSV trend across the last N runs (pipe to `column -t` for a table)
scripts/akm-eval/bin/akm-eval-trend --limit 20 --metric overall

# Ingest a stash's improve-result.json into a paired-mode-ready summary
scripts/akm-eval/bin/akm-eval-collect --from-improve-run latest

# Read-only memory-inference and graph-extraction downstream attribution
scripts/akm-eval/bin/akm-eval-attribution-rollup --format json

# Capture one immutable full-installation input for control/treatment evaluation
scripts/akm-eval/bin/akm-eval-snapshot capture \
  --out "$HOME/.cache/akm-eval/snapshots/baseline" \
  --producer-version "0.9.0-rc.10" \
  --producer-commit "$(git rev-parse HEAD)"

# Structural smoke from the same snapshot. If improve invokes an LLM, omitting
# endpoint identity below intentionally makes the result inconclusive.
scripts/akm-eval/bin/akm-eval-twin \
  --snapshot "$HOME/.cache/akm-eval/snapshots/baseline" \
  --suite improve-smoke \
  --akm "bun $PWD/src/cli.ts" \
  --out "$HOME/.cache/akm-eval/results" \
  --samples 2 --required-samples 2 \
  --protected-case retrieval-search-returns-hits \
  --minimum-deterministic-lift 0.01 --protected-loss-margin 0 \
  --max-treatment-tokens 200000 --max-treatment-calls 100 \
  --max-treatment-duration-ms 3600000
```

Outputs land in `<stash>/.akm/evals/runs/<eval-run-id>/`:

```
<stash>/.akm/evals/runs/
  2026-05-21T19-12-44-002Z-a1b2c3d4/
    eval-result.json     — summary envelope (schemaVersion: 2)
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

## Frozen twin evaluation

`akm-eval-snapshot` captures one verified input before either experiment arm is
created. It copies configured bundle roots, `config.json`, `index.db`, and
`state.db` into a canonical, private manifest. The SQLite databases are copied
without content redaction and may contain sensitive historical metadata, so the
entire snapshot is private-sensitive and must stay on trusted local storage.
Capture fails rather than silently weakening privacy or reproducibility when it
encounters literal config secrets, known secret-bearing bundle paths, links,
executable files, empty nested directories, mutable source trees, or
non-private source permissions.
Use repeated `--bundle id=/materialized/path` arguments for configured git,
website, or npm bundles whose local roots cannot be derived from config.

```sh
scripts/akm-eval/bin/akm-eval-snapshot verify \
  "$HOME/.cache/akm-eval/snapshots/baseline"
```

`akm-eval-twin` materializes independent opaque control and treatment copies
for each sample. The control is indexed and evaluated without improve; the
treatment runs the current improve command, reindexes, and evaluates the same
suite. Zero cases, failed commands, identity drift, incomplete telemetry,
fingerprint mismatches, and unsupported `candidate-only` execution are
`inconclusive`, never passes. Full artifacts and retained sandboxes are opt-in;
the default output contains metrics only.

Decision thresholds are mandatory and predeclared with
`--minimum-deterministic-lift`, `--protected-loss-margin`,
`--max-treatment-tokens`, `--max-treatment-calls`,
`--max-treatment-duration-ms`, and `--required-samples`. At least one case must
be protected with a `protected`/`regression-guard` suite tag or a repeated
`--protected-case <id>` argument. The duration budget measures the complete
improve subprocess wall time; model-call duration remains separate throughput
telemetry.

Use
`--endpoint-metadata`, `--endpoint-assignment balanced`, and a mode-0600
`--endpoint-runtime` file for compatible dual-endpoint runs. Endpoint runtime
values affect only the treatment improve call and are never serialized. Model
identity is accepted only when complete `llm_usage` telemetry reports the
assigned model ID; prompt fingerprints remain operator-attested metadata.
Use a separate mode-0600 `--common-runtime` file shaped as `{ "env": { ... } }`
for embedding credentials or other values that must be identical during both
arms' index, improve base environment, reindex, and evaluation phases.

A conclusive single-endpoint LLM run supplies all private and identity inputs:

```sh
chmod 600 "$HOME/.config/akm-eval/common-runtime.json" \
  "$HOME/.config/akm-eval/endpoint-runtime.json"

scripts/akm-eval/bin/akm-eval-twin \
  --snapshot "$HOME/.cache/akm-eval/snapshots/baseline" \
  --suite improve-smoke \
  --akm "bun $PWD/src/cli.ts" \
  --out "$HOME/.cache/akm-eval/results" \
  --samples 2 --required-samples 2 \
  --protected-case retrieval-search-returns-hits \
  --endpoint-metadata "$HOME/.config/akm-eval/local-a.json" \
  --endpoint-assignment local-a \
  --endpoint-runtime "$HOME/.config/akm-eval/endpoint-runtime.json" \
  --common-runtime "$HOME/.config/akm-eval/common-runtime.json" \
  --minimum-deterministic-lift 0.01 --protected-loss-margin 0 \
  --max-treatment-tokens 200000 --max-treatment-calls 100 \
  --max-treatment-duration-ms 3600000
```

The endpoint runtime file is keyed by endpoint ID, for example
`{ "local-a": { "env": { ... } } }`. Endpoint metadata must use the strict
`EndpointFingerprint` shape in `src/twin-types.ts`; its serving fingerprint is
the canonical hash produced by `deriveEndpointServingFingerprint`. A completed
LLM run is still inconclusive unless every request attempt has exact terminal
accounting and reports a response-observed model matching `modelId`.

For OS-level process isolation, run the same experiment through Docker. This
bare form is likewise an intentionally inconclusive structural smoke if improve
invokes an LLM:

```sh
scripts/akm-eval/bin/akm-eval-twin-docker \
  --snapshot "$HOME/.cache/akm-eval/snapshots/baseline" \
  --suite improve-smoke \
  --out "$HOME/.cache/akm-eval/results" \
  --samples 2 --required-samples 2 \
  --protected-case retrieval-search-returns-hits \
  --minimum-deterministic-lift 0.01 --protected-loss-margin 0 \
  --max-treatment-tokens 200000 --max-treatment-calls 100 \
  --max-treatment-duration-ms 3600000
```

The Docker launcher copies an explicit source allowlist into a private temporary
build context, builds the current workspace, supplies that build as the AKM
command, mounts snapshots read-only, and forwards no host environment or
credentials. Snapshot, output, metadata, and runtime paths must stay outside the
workspace. Shared credentials belong in `--common-runtime`; treatment endpoint
routing belongs in `--endpoint-runtime`. Keep bind sources outside `/tmp` and
`/var/tmp`; Docker daemons using systemd `PrivateTmp` can otherwise mount an
empty directory.

For a conclusive Docker LLM run, add the same `--endpoint-metadata`,
`--endpoint-assignment`, `--endpoint-runtime`, and `--common-runtime` arguments
shown above. When a local endpoint must be reached through the host network on
Linux, set `AKM_EVAL_TWIN_DOCKER_NETWORK=host`; latency remains endpoint-specific
and is not interpreted as a treatment effect across different hardware.

## Replay mode (Phase 6)

```sh
# 1. Run the suite with --record to capture every akm / state-db / improve-result I/O.
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --record

# 2. Replay the recorded run deterministically. Compares per-case score,
#    passed, metrics, and evidence against the original case-results.jsonl;
#    exits 0 if all match (within 1e-9 for scores), 1 on any divergence.
scripts/akm-eval/bin/akm-eval-replay latest
```

Recording lands under `<run-dir>/artifacts/replay/`:

```
artifacts/replay/
  akm-invocations.jsonl   one record per AkmCli.run() call (search, version,
                          improve, index — whatever the runners shelled out).
  state-db-queries.jsonl  one record per readEvents / readProposals /
                          available() call, plus the captured result rows.
  improve-results.jsonl   one record per <stash>/.akm/runs/<id>/improve-result.json
                          read.
  replay-result.json      written by akm-eval-replay; reports
                          { suiteFingerprint, deterministic, divergentCases,
                            missingCases, extraCases }.
```

Replay flags:

- `--strict` — also fail on missing or extra cases (default fails only on
  per-case divergences).
- `--format json|md|none` — summary format on stdout (default: md).
- `--stash <path>` / `--out <path>` — same semantics as `akm-eval-run`.

Replay is intentionally narrow: it swaps the three I/O surfaces
(`AkmCli`, `StateDbSources`, `improve-result.json` loader) for playback
wrappers and re-runs the unchanged runners. Determinism therefore holds
for any runner whose only external I/O is those three surfaces —
retrieval and proposal-quality in Phase 1, workflow-compliance in
Phase 3. Memory-safety touches the sandboxed filesystem after `akm
improve` mutates it, so its replay determinism depends on rerunning
against the same fixture (a future filesystem-capture step lands in
Phase 8 if needed).

Before playback starts, replay recomputes the suite's canonical fingerprint,
including transitive fixture and probe bytes, and rejects missing or changed
suite identity. The verified fingerprint is propagated to the replay result.

## Coverage

Phase 1 + Phase 2 runner types:

- **retrieval** — shells out to `akm search <query> --format jsonl
  --detail agent` and scores against `mustIncludeRefs`,
  `mustNotIncludeRefs`, `keywords`, and `minHits`.
- **proposal-quality** — reads `state.db` (or `<stash>/.akm/proposals/`
  as fallback) and reports counts, validation pass rate, accept rate,
  reject rate, and accept-rate-per-source.
- **reflect-quality** — walks `<stash>/.akm/runs/<id>/improve-result.json`
  for the most recent N runs (default 20) and classifies every
  `reflect`/`reflect-failed` action into succeeded vs schema-shape vs
  content-policy vs gate-refused. Reports the LLM-touched denominator
  (succeeded + schemaShape + contentPolicy + other; gateRefused
  excluded) and the schemaShapeRate the PR 3 gate hinges on. Replaces
  the hand-rolled jq-on-improve-result.json classification used during
  May 2026 pipeline tuning.
- **regression** — diffs the current `case-results.jsonl` against a
  previous eval-run-id (literal or `latest`). Surfaces newly-failing
  cases, newly-passing cases, score drops above a configurable
  threshold (default 0.1), and cases that disappeared.

The toolkit is **read-only by default**. The only mutation path is
`--mode paired` without `--no-sandbox`, which copies the stash to a
tmpdir and runs `akm improve` against the copy.

Phase 3 added two more runner types — both mandatory-sandbox and zero
mutation of the real stash:

- **memory-safety** — copies a fixture stash into a sandbox, runs `akm
  index` + `akm improve --json-to-stdout`, and scores the resulting
  belief-state transitions against per-case allow / forbid lists.
- **workflow-compliance** — reads `state.db` events directly and scores
  required event types, event-count bounds, required ordering, and
  forbidden event types over a window.

Phase 4 added the **judge-calibration** runner (R3 — see "Judge
calibration" below). `lesson-application` is the only declared type that
still produces a `skipped` result.

## LLM judging (optional, Phase 7)

`--llm-judge` opts in to grading individual cases with an OpenAI-compatible
LLM. LLM scores are **always recorded separately** from deterministic
scores — they show up as `scores.llmJudged` in the run envelope and as
`llmJudgement` on the per-case record, but are **never** folded into
`scores.deterministic` or `scores.overall`. This separation exists
because LLM-judge variance (cf. MT-Bench, arXiv:2306.05685) is too high
to gate CI on without calibration; deterministic gates stay
deterministic.

Enable it on any suite that has at least one case with a
`scoring.llmJudge` block (the smoke suite's `retrieval-deploy-keywords`
ships with one):

```sh
# OpenAI default — needs OPENAI_API_KEY (or AKM_EVAL_JUDGE_API_KEY).
OPENAI_API_KEY=sk-... \
  scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --llm-judge

# Any OpenAI-compatible local server (Ollama, llama.cpp, vLLM):
AKM_EVAL_JUDGE_ENDPOINT=http://localhost:11434 \
AKM_EVAL_JUDGE_PROVIDER=ollama \
AKM_EVAL_JUDGE_MODEL=llama3.1:8b \
  scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --llm-judge

# Override per invocation:
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --llm-judge \
  --judge-provider openrouter --judge-model anthropic/claude-3.5-sonnet \
  --judge-temperature 0
```

If `--llm-judge` is set but neither an endpoint nor an API key can be
resolved, the run **fails fast** with an actionable error rather than
silently degrading.

### What gets recorded

Every judge call appends one JSON line to
`<run-dir>/artifacts/llm-judgements.jsonl` with provenance:

```json
{"caseId":"retrieval-deploy-keywords","ts":"2026-05-21T19:58:34.280Z",
 "model":"gpt-4o-mini","provider":"openai","temperature":0,
 "promptHash":"65e793a9…","artifactHash":"2951eb03…",
 "score":0.82,"band":"medium","rationale":"…","durationMs":22}
```

- `promptHash` is the SHA-256 of the rendered system + user prompt.
- `artifactHash` is the SHA-256 of the (possibly truncated) artifact.
- LLM failures are non-fatal: a per-call `error` field is recorded and
  the run continues. The failed call does NOT contribute to
  `scores.llmJudged`.

### Authoring a judge case

Add a `scoring.llmJudge` block to any case:

```jsonc
{
  "scoring": {
    "deterministic": true,
    "weights": { /* ... */ },
    "passThreshold": 0.6,
    "llmJudge": {
      "artifactField": "topHitArtifact",
      "rubric": "Score 1.0 if the top hit is operationally useful for a deploy…",
      "maxArtifactBytes": 16384
    }
  }
}
```

- `artifactField` names a key on the case result's `evidence` (preferred)
  or `metrics` — its stringified value is what the judge grades.
- `rubric` is capped at 4 KB (hard error — fix the rubric).
- `maxArtifactBytes` is optional (default 16 KB). Artifacts are
  truncated on the artifact side; the rubric is never truncated.

### Flags

| Flag | Default | Env override |
| --- | --- | --- |
| `--llm-judge` | off | — |
| `--judge-model <name>` | `gpt-4o-mini` | `AKM_EVAL_JUDGE_MODEL` |
| `--judge-provider <name>` | `openai` | `AKM_EVAL_JUDGE_PROVIDER` |
| `--judge-temperature <0..1>` | `0.0` | — |
| — | — | `AKM_EVAL_JUDGE_ENDPOINT` (override base URL) |
| — | — | `AKM_EVAL_JUDGE_API_KEY` (explicit key override) |

## Paired mode

```sh
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
  --improve-args "--limit 10 --timeout-ms 600000"
```

Paired mode orchestrates: (1) baseline pass, (2) `akm improve` shell-out
with the forwarded args, (3) re-run of the same suite, (4) delta
computation, (5) merged envelope. The result envelope's `scores.baseline`
and `scores.delta` are populated, and `artifacts/paired-comparison.json`
holds the full per-case diff.

Flags:

- `--sandbox` (default) — copy the stash to a tmpdir; `akm improve`
  mutates only the copy. Cleans up on success unless `--keep-sandbox`.
- `--no-sandbox` / `--allow-mutate` — opt into mutating the real stash.
- `--improve-args "<...>"` — verbatim args forwarded to `akm improve`.
- `--threshold 0.1` — score-drop threshold for the regression diff.
- `--fail-on-regression` — exit non-zero if any regressions are surfaced.

## Graph A/B harness

Phase 5 ships `bin/akm-eval-graph-ablation` (roadmap R5). Drives a single-source
two-sandbox ablation: builds two copies of the stash, runs the same suite
against each with graph extraction on vs. off, and reports per-metric deltas.

```sh
scripts/akm-eval/bin/akm-eval-graph-ablation \
  --suite improve-smoke \
  --stash /path/to/stash \
  --akm /path/to/akm \
  --seeds 1 \
  --improve-args "--dry-run"
```

How the off side is gated: the harness plants `<sandbox>/.config/akm/config.json`
under the sandbox `HOME` carve-out with both `llm.features.graph_extraction:
false` and `index.graph.llm: false` set. This is the dual gate documented in
`src/indexer/graph-extraction.ts`; together they block extraction at both the
v1 feature-gate layer and the per-pass opt-out.

Reports (per side; median + range when `--seeds > 1`):

- retrieval hit@K (mean overall score across retrieval cases)
- retrieval precision@K (mustIncludeRefs returned / topK)
- contradiction-detection precision/recall (counts `contradictedBy` edges in
  surviving memory frontmatter; recall vs an `expectedContradictions` declared
  on `contradiction-detection`-tagged cases — `null` otherwise)
- staleness telemetry from `improveResult.stalenessDetection`
- latency delta (wall-clock index + improve per side)
- **proxy** token-cost delta (`graphExtraction.quality.entityCount +
  relationCount`; clearly labelled as a proxy in the report)

Outputs land under `<stash>/.akm/evals/ablations/<eval-run-id>/` —
namespaced separately from the main `runs/` tree so ablations never collide
with regular eval runs.

Verdict heuristic: `graphEarnsItsCost = true` when retrieval delta ≥ 0.05 AND
improve-duration delta ≤ 5× the off-baseline; `false` otherwise; `inconclusive`
when |Δ| < 0.01 on a single seed (re-run with `--seeds 3` or more for a
decision-quality result).

## Compare and trend

`akm-eval-compare <baseline-id|latest> <current-id|latest>` prints score
deltas, regressions, newly-passing/newly-failing per case, and writes a
JSON comparison artifact under
`<current-run>/compare-vs-<baseline>.json` (override with `--out`).
Exits non-zero if any regressions are surfaced.

`akm-eval-trend [--suite name] [--limit 20] [--metric overall]` walks
`<stash>/.akm/evals/runs/*` oldest-first and prints a TSV with
`ts | suite | mode | label | <metric>`. `--metric` accepts `overall`,
`deterministic`, or any dot-separated path into the envelope (e.g.
`scores.delta`, `countsByType.retrieval.passed`). Pipe to `column -t`
for a pretty table. Trend rejects missing or mixed fingerprints within a suite;
start a separate suite generation when case or fixture bytes change.

New `eval-result.json` files use schema v2, where
`inputs.suiteFingerprint` is required. Historical schema-v1 envelopes remain
readable, but comparison, regression, trend, verdict, and replay operations
fail closed if that optional historical field is absent.

## Collect (improve-run ingestion)

`akm-eval-collect --from-improve-run <run-id|latest>` reads
`<stash>/.akm/runs/<run-id>/improve-result.json` and surfaces the
metrics paired-mode comparison cares about — proposals emitted that
run, validation failures, consolidation, memory cleanup. Writes the
summary to `<stash>/.akm/evals/collected/<improve-run-id>.json`.

## Judge calibration

Phase 4 (R3) ships a probe-based runner that measures the distill
judge's agreement with hand-graded proposals and its MT-Bench-style
variance across resamples (D-5 / #388 — `review_needed` band).

Probe shape (under `cases/judge-calibration/probes/*.json`):

```json
{
  "schemaVersion": 1,
  "id": "probe-01",
  "assetType": "memory" | "skill" | "lesson",
  "assetRef": "memory:probe-01-example",
  "asset": {
    "frontmatter": { "description": "...", "captureMode": "hot", "...": "..." },
    "body": "..."
  },
  "feedback": [
    { "ts": "2026-05-01T...", "signal": "positive", "reason": "...", "note": "..." }
  ],
  "humanGrade": {
    "expectedOutcome": "queued" | "review_needed" | "quality_rejected" | "validation_failed",
    "expectedScoreBand": [low, high],
    "rationale": "..."
  }
}
```

The runner builds a fresh sandbox per probe, materializes the asset
file, replays the feedback via `akm feedback ...`, runs `akm index`,
then runs `akm improve --json-to-stdout` `samplesPerProbe` times. Each
sample's `distill_invoked` outcome is harvested from the sandbox's
`state.db` events table. Aggregates: agreement rate, per-band agreement
counts, median + mean across-resample variance (mode-fraction-based),
and an MT-Bench-style flip rate (probes where any two samples
disagree).

The aggregate block is hoisted into `eval-result.json` at
`metrics.judgeCalibration`. Example invocation:

```sh
scripts/akm-eval/bin/akm-eval-run --suite judge-calibration \
  --akm /path/to/akm/dist/cli.js \
  --format md
```

When `llm.features.feedback_distillation` is disabled in the test env
every probe will return `skipped`, the case scores low, but the runner
machinery is verified and the metrics block is still emitted.

## Suites

- `cases/improve-smoke/` — the smoke suite. Five retrieval + three
  proposal-quality cases. Designed to run on any populated stash without
  per-stash customization.
- `cases/memory-regression/` — Phase 3 memory-safety regression suite.
- `cases/workflow-compliance/` — Phase 3 event-trace compliance suite.
- `cases/judge-calibration/` — Phase 4 probe suite (8 hand-graded
  probes spread across all four `expectedOutcome` bands).
- `cases/consolidation-fidelity/` — deterministic claim and provenance
  preservation fixtures for grading generated consolidation candidates.

Author your own suite by creating a sibling directory. Each case is a
JSON file matching the `EvalCase` shape in `src/types.ts`.

## Recombine candidate analyzer

`akm-eval-recombine-analyze` estimates whether the current memory index has
recurring clusters worth an opt-in observe pass. It reads `index.db`
and its graph tables from a verified private copy of the main database and WAL,
so it does not create source-directory sidecars. Concurrent changes during
snapshot capture fail explicitly. It does not run indexing or an LLM, restore
the removed recombine process, create proposals, emit events, or change
stash/state files.

```sh
scripts/akm-eval/bin/akm-eval-recombine-analyze
scripts/akm-eval/bin/akm-eval-recombine-analyze --format json \
  --min-cluster-size 3 --max-cluster-size 20 --max-clusters 5
scripts/akm-eval/bin/akm-eval-recombine-analyze --out ./recombine-report.md
```

The report goes to stdout by default. `--out` exclusively creates the requested
path; existing files and index/state database aliases are refused. Results
include canonical member refs, source/bundle-isolated clusters, relocation-stable
member-set fingerprints, coverage-gated recurrence/source/project proxies,
generalizability risks (including unknown evidence), and estimated LLM calls
and tokens for a hypothetical observe pass. No observe token limit is enforced.
Associative `xrefs` contribute linkage coverage only; recurrence and the observe
decision require independently supporting members with normalized current refs
in `sources`, `sourceRefs`, or `evidenceSources`. Selection rotates across
bundle/source scopes before applying entity/tag preferences within each scope.
`--relatedness graph` fails with remediation guidance when graph tables cannot
be queried. The default `both` mode falls back to tags but marks the report's
graph status as `degraded` with the query/schema reason; it never presents that
fallback as a healthy empty graph analysis. Available graph status includes
graph-file/unique-entity counts and entity-bearing current-memory coverage, all
read with the entries from one SQLite transaction snapshot. Graph-only mode
does not fall back to tags when graph data is available but empty or uncovered.

## Downstream attribution rollup

`akm-eval-attribution-rollup` copies a stable SQLite main/WAL snapshot into a
private temporary directory without opening the source database through SQLite.
It includes committed WAL data while creating no source sidecars and changing no
source files. The disposable snapshot reports user-only memory-inference
direct/surface exposure and show/curate consumption, graph-ranking exposure and
selected/shown read-back, current versioned controls, historical unattributed
rows, and fully-qualified refs. Curate rows become exposure candidates for a
same-ref show within 60 seconds.

Graph contribution is the positive amount admitted by the active ranking
contributor after the shared cap. It does not establish that graph caused a rank
or selection change. Raw query, body, metadata, and provenance content are never
rendered. The command writes stdout unless `--out` explicitly names a new file;
it never migrates the database or clobbers an existing path.

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
    akm-eval-run           dispatches to src/run.ts
    akm-eval-compare       dispatches to src/compare.ts
    akm-eval-trend         dispatches to src/trend.ts
    akm-eval-collect       dispatches to src/collect.ts
    akm-eval-graph-ablation dispatches to src/graph-ablation.ts (Phase 5, R5)
    akm-eval-replay        dispatches to src/replay.ts (Phase 6)
    akm-eval-recombine-analyze dispatches to the read-only cluster analyzer
    akm-eval-attribution-rollup dispatches to the read-only attribution report
    akm-eval-snapshot      captures/verifies immutable installation snapshots
    akm-eval-twin          runs process-isolated no-improve/current-improve twins
    akm-eval-twin-docker   runs the twin evaluator in a fresh Docker container
  src/
    run.ts                 orchestrator (baseline | akm | paired)
    replay.ts              deterministic replay orchestrator (Phase 6)
    compare.ts             two-run diff command
    trend.ts               N-run trend command
    collect.ts             improve-result.json ingestion command
    recombine-analyzer.ts  read-only current-index cluster analysis
    attribution-rollup.ts  read-only downstream attribution report
    snapshot.ts            installation snapshot CLI
    twin-run.ts            twin experiment orchestrator and decision gate
    twin-types.ts          snapshot, endpoint, sample, and result contracts
    types.ts               EvalCase, EvalCaseResult, EvalRunResult
    scoring.ts             weighted aggregation
    report.ts              Markdown renderer
    runners/
      retrieval.ts         akm search → score
      proposal-quality.ts  state.db / .akm/proposals → score
      regression.ts        case-results.jsonl diff
    sources/
      paths.ts             stash + data-dir + state.db path resolution
      state-db.ts          read-only SQLite reader (+ Phase 6 record/playback)
      stash-fs.ts          filesystem fallback for proposals
      akm-cli.ts           shell wrapper (+ Phase 6 record/playback)
      replay-log.ts        Phase 6 recorder/player + JSONL log helpers
      eval-runs.ts         resolver + loader for <stash>/.akm/evals/runs/
      improve-result.ts    loader for <stash>/.akm/runs/<id>/improve-result.json (+ Phase 6 record/playback)
  cases/
    improve-smoke/         starter cases
```

## See also

- `docs/reference/akm-eval.md` — operator guide.
- `scripts/improve-stats/` — the toolkit pattern this one mirrors.
