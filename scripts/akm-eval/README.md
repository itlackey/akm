# akm-eval — lightweight standalone evaluation toolkit

Read-only-by-default, deterministic measurement of `akm` over the existing
run envelopes, events table, and proposal queue. Implements Phases 1 and 2
of `docs/technical/akm-eval-implementation-plan.md`.

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

## Coverage

Phase 1 + Phase 2 runner types:

- **retrieval** — shells out to `akm search <query> --format jsonl
  --detail agent` and scores against `mustIncludeRefs`,
  `mustNotIncludeRefs`, `keywords`, and `minHits`.
- **proposal-quality** — reads `state.db` (or `<stash>/.akm/proposals/`
  as fallback) and reports counts, validation pass rate, accept rate,
  reject rate, and accept-rate-per-source.
- **regression** — diffs the current `case-results.jsonl` against a
  previous eval-run-id (literal or `latest`). Surfaces newly-failing
  cases, newly-passing cases, score drops above a configurable
  threshold (default 0.1), and cases that disappeared.

The toolkit is **read-only by default**. The only mutation path is
`--mode paired` without `--no-sandbox`, which copies the stash to a
tmpdir and runs `akm improve` against the copy.

Other case types declared in `src/types.ts` (`memory-safety`,
`workflow-compliance`, `lesson-application`) are accepted in case files
but produce a `skipped` result. They land in Phase 3.

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
for a pretty table.

## Collect (improve-run ingestion)

`akm-eval-collect --from-improve-run <run-id|latest>` reads
`<stash>/.akm/runs/<run-id>/improve-result.json` and surfaces the
metrics paired-mode comparison cares about — proposals emitted that
run, validation failures, consolidation, memory cleanup. Writes the
summary to `<stash>/.akm/evals/collected/<improve-run-id>.json`.

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
    akm-eval-run           dispatches to src/run.ts
    akm-eval-compare       dispatches to src/compare.ts
    akm-eval-trend         dispatches to src/trend.ts
    akm-eval-collect       dispatches to src/collect.ts
  src/
    run.ts                 orchestrator (baseline | akm | paired)
    compare.ts             two-run diff command
    trend.ts               N-run trend command
    collect.ts             improve-result.json ingestion command
    types.ts               EvalCase, EvalCaseResult, EvalRunResult
    scoring.ts             weighted aggregation
    report.ts              Markdown renderer
    runners/
      retrieval.ts         akm search → score
      proposal-quality.ts  state.db / .akm/proposals → score
      regression.ts        case-results.jsonl diff
    sources/
      paths.ts             stash + data-dir + state.db path resolution
      state-db.ts          read-only SQLite reader
      stash-fs.ts          filesystem fallback for proposals
      akm-cli.ts           shell wrapper for `akm search/improve/index/--version`
      eval-runs.ts         resolver + loader for <stash>/.akm/evals/runs/
      improve-result.ts    loader for <stash>/.akm/runs/<id>/improve-result.json
  cases/
    improve-smoke/         starter cases
```

## See also

- `docs/akm-eval.md` — operator guide.
- `docs/technical/akm-eval-implementation-plan.md` — the full plan.
- `scripts/improve-stats/` — the toolkit pattern this one mirrors.
