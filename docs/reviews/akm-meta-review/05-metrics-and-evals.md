# 05 — What does "better" even mean for akm?

> Adapts **"What does 'better' even mean"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> akm has already been burned by proxy metrics twice: promotion volume rewarded churn, and gated skips were counted as rejections. This review defines the real metric and builds the regression net.

## Prompt

```text
Define what "better" actually means for akm, then build the measurement to defend it.

1. Propose the north-star metric(s), grounded in what akm is for — candidates to
   evaluate, not assume: retrieval quality (does curate surface the asset that
   materially helps this task?), learning quality (coverage of real sessions ×
   accepted-change-rate of improve output), time-to-context in a fresh session,
   cost per useful recall. Explicitly rank them and say which is primary.

2. Enumerate the proxy metrics the system currently optimizes or reports, and find
   the drift: places where a number can improve while the real goal degrades. Known
   prior art to build on, not re-litigate: promotion volume rewarded churn;
   pre-beta.50 "rejected" counts were actually gated skips (discriminate old rows
   with `skippedCount IS NOT NULL`). Find the NEXT such trap — e.g., does rank_score
   feeding search reward frequently-recalled assets into self-reinforcing loops?

3. Audit the existing eval infrastructure: the curate golden benchmark
   (deterministic embedder, frozen corpus, nDCG/MRR/leapfrog, CI guard
   tests/curate-golden-eval.test.ts) and akm-eval. What does it cover, what does it
   miss (improve quality has no golden benchmark; memory recall has none; the
   SessionStart hook payload has none)?

4. Design the missing evals and regression gates — each must be deterministic,
   CI-runnable, and catch degradation BEFORE the owner feels it. Reuse the golden
   benchmark pattern (deterministic embedder + frozen fixtures) rather than
   inventing new harness machinery. For each: what it measures, its fixture source,
   its failure threshold, and where it hooks into CI.

5. Output: findings/05-metrics-and-evals.md — metric definitions with the primary
   one argued, the proxy-drift list, the eval gap table, and an implementation plan
   ordered by leverage.

Guardrails: read-only on live data; never trigger improve runs to generate data —
design evals around fixtures and existing telemetry. New evals must not add flaky
I/O to the unit suite (tests/ is CI-fast; integration goes in tests/integration/).

ultracode
```

## Refs

Stash:

- `knowledge:curate-golden-benchmark` — the working rank-aware eval pattern (deterministic embedder, frozen corpus, nDCG/MRR); the template for everything new.
- `knowledge:curate-golden-fixture-spec` — how the frozen fixtures are structured.
- `knowledge:akm-metrics-observability-enhancement` — prior metrics/observability design work.
- `knowledge:projects/akm/improve-pipeline-quality-audit` — prior attempt to judge improve quality; mine it for metric candidates.

Repo:

- `docs/akm-eval.md` — the existing eval entry point.
- `docs/technical/curate-performance-evals.md` — perf-side eval work.
- `tests/curate-golden-eval.test.ts` — the CI guard as it exists.
- `docs/design/improve-beta50-monitoring.md` — what improve telemetry is available to build learning-quality metrics from.
- `docs/design/improve-pipeline-deep-tuning-analysis.md` — where the churn-rewarding metric problem was dissected.

Live (read-only): `state.db` improve_runs/llm_usage tables for baseline numbers (`skippedCount IS NOT NULL` discriminator), `akm stats`.
