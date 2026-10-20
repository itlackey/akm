# consolidate · eval 0.2 · scoring 0.2

A: 1195-baseline-pool (<AKM_CHECKOUT>/docs/evaluations/1195/baseline-pool)
B: 1195-v22-pool (<AKM_CHECKOUT>/docs/evaluations/1195/candidate-pool)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1195-baseline-pool | 1195-v22-pool | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-20T21:59:00.609Z | 2026-10-20T23:15:56.411Z | — |  |
| Quality % | 84.21 | 94.74 | 10.53 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 16 | 18 | 2 |  |
| Quality cases | 19 | 19 | 0 |  |
| Cases recorded | 47 | 47 | 0 |  |
| Cases scored | 47 | 47 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 184.887 | 95.614 | -89.273 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 57 | 57 | 0 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 1040.3 | 1115.7 | 75.4 |  |
| Mean output tokens / call | 114.5 | 104.3 | -10.2 |  |
| Mean model request (s) | 3.12 | 1.62 | -1.5 |  |
| Model output tokens / s | 36.7 | 64.5 | 27.8 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Run mode | pool | pool | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | real | real | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 4d14d45 | 4d14d45-dirty | — |  |
| Retirements that were safe % | 88.89 | 100 | 11.11 |  |
| Safe retirements found % | 84.21 | 94.74 | 10.53 |  |
| Unsafe retirements | 2 | 0 | -2 |  |
| metrics.unsafe.n | 2 | 0 | -2 |  |
| metrics.unsafe.of | 18 | 18 | 0 |  |
| metrics.unsafe.staged | 0 | 0 | 0 |  |
| metrics.staged.n | 12 | 12 | 0 |  |
| metrics.staged.safe | 12 | 12 | 0 |  |
| metrics.precision.value | 0.8889 | 1 | 0.1111 |  |
| metrics.precision.safe | 16 | 18 | 2 |  |
| metrics.precision.retired | 18 | 18 | 0 |  |
| metrics.recall.value | 0.8421 | 0.9474 | 0.1053 |  |
| metrics.recall.retired_safe | 16 | 18 | 2 |  |
| metrics.recall.of | 19 | 19 | 0 |  |
| metrics.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.duplicate.clusters | 7 | 7 | 0 |  |
| metrics.classes.duplicate.with_safe_retirement | 7 | 7 | 0 |  |
| metrics.classes.duplicate.hit | 6 | 6 | 0 |  |
| metrics.classes.duplicate.retired_safe | 6 | 6 | 0 |  |
| metrics.classes.duplicate.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.duplicate.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.duplicate.untouched | 1 | 1 | 0 |  |
| metrics.classes.triple.clusters | 2 | 2 | 0 |  |
| metrics.classes.triple.with_safe_retirement | 2 | 2 | 0 |  |
| metrics.classes.triple.hit | 2 | 2 | 0 |  |
| metrics.classes.triple.retired_safe | 2 | 2 | 0 |  |
| metrics.classes.triple.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.triple.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.triple.untouched | 0 | 0 | 0 |  |
| metrics.classes.subsumed.clusters | 5 | 5 | 0 |  |
| metrics.classes.subsumed.with_safe_retirement | 5 | 5 | 0 |  |
| metrics.classes.subsumed.hit | 3 | 5 | 2 |  |
| metrics.classes.subsumed.retired_safe | 3 | 5 | 2 |  |
| metrics.classes.subsumed.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.subsumed.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.subsumed.untouched | 2 | 0 | -2 |  |
| metrics.classes.supersedes.clusters | 5 | 5 | 0 |  |
| metrics.classes.supersedes.with_safe_retirement | 5 | 5 | 0 |  |
| metrics.classes.supersedes.hit | 5 | 5 | 0 |  |
| metrics.classes.supersedes.retired_safe | 5 | 5 | 0 |  |
| metrics.classes.supersedes.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.supersedes.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.supersedes.untouched | 0 | 0 | 0 |  |
| metrics.classes.overlap.clusters | 7 | 7 | 0 |  |
| metrics.classes.overlap.with_safe_retirement | 0 | 0 | 0 |  |
| metrics.classes.overlap.hit | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_unsafe | 2 | 0 | -2 |  |
| metrics.classes.overlap.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.overlap.untouched | 5 | 7 | 2 |  |
| metrics.classes.contradicts.clusters | 2 | 2 | 0 |  |
| metrics.classes.contradicts.with_safe_retirement | 0 | 0 | 0 |  |
| metrics.classes.contradicts.hit | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.contradicts.untouched | 2 | 2 | 0 |  |
| metrics.classes.lookalike.clusters | 3 | 3 | 0 |  |
| metrics.classes.lookalike.with_safe_retirement | 0 | 0 | 0 |  |
| metrics.classes.lookalike.hit | 0 | 0 | 0 |  |
| metrics.classes.lookalike.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.lookalike.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.lookalike.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.lookalike.untouched | 3 | 3 | 0 |  |
| metrics.classes.single.clusters | 16 | 16 | 0 |  |
| metrics.classes.single.with_safe_retirement | 0 | 0 | 0 |  |
| metrics.classes.single.hit | 0 | 0 | 0 |  |
| metrics.classes.single.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.single.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.single.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.single.untouched | 16 | 16 | 0 |  |
| metrics.pairs.initiators | 80 | 80 | 0 |  |
| metrics.pairs.judged | 28 | 28 | 0 |  |
| metrics.pairs.considered | 32 | 32 | 0 |  |
| metrics.pairs.failed | 4 | 4 | 0 |  |
| metrics.pairs.labels.duplicate | 12 | 11 | -1 |  |
| metrics.pairs.labels.subsumed | 6 | 11 | 5 |  |
| metrics.pairs.labels.supersedes | 6 | 0 | -6 |  |
| metrics.pairs.labels.contradicts | 2 | 0 | -2 |  |
| metrics.pairs.labels.overlap | 6 | 10 | 4 |  |
| metrics.pairs.labels.unrelated | 0 | 0 | 0 |  |
| metrics.calls.calls | 57 | 57 | 0 |  |
| metrics.calls.failures | 0 | 0 | 0 |  |
| metrics.calls.prompt_tokens | 59298 | 63595 | 4297 |  |
| metrics.calls.completion_tokens | 6527 | 5944 | -583 |  |
| metrics.chunks.total | 7 | 7 | 0 |  |
| metrics.chunks.failed | 0 | 0 | 0 |  |
| metrics.chunks.deferred_memories | 0 | 0 | 0 |  |
| metrics.chunks.promote_ops | 35 | 40 | 5 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-v22/src/cli.ts","build":null,"build_fingerprint":null} |
| engines | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"<MODEL_BASE_URL>","temperature":0,"enableThinking":false,"timeoutMs":600000}} | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:38593","temperature":0,"enableThinking":false,"timeoutMs":600000}} |
