# consolidate · eval 0.2 · scoring 0.2

A: 1195-v22-pool (/tmp/akm-1197/docs/evaluations/1195/candidate-pool)
B: 1197-candidate-real-pool (/tmp/akm-1197-eval/evals/consolidate/results/2026-10-21-1197-candidate-real-pool)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1195-v22-pool | 1197-candidate-real-pool | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-20T23:15:56.411Z | 2026-10-21T02:54:09.401Z | — |  |
| Quality % | 94.74 | 94.74 | 0 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 18 | 18 | 0 |  |
| Quality cases | 19 | 19 | 0 |  |
| Cases recorded | 47 | 47 | 0 |  |
| Cases scored | 47 | 47 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 95.614 | 204.373 | 108.759 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 57 | 57 | 0 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 1115.7 | 1115.6 | -0.1 |  |
| Mean output tokens / call | 104.3 | 111.7 | 7.4 |  |
| Mean model request (s) | 1.62 | 3.5 | 1.88 |  |
| Model output tokens / s | 64.5 | 31.9 | -32.6 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Run mode | pool | pool | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | real | real | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 4d14d45-dirty | unknown | — |  |
| AKM build | — | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Retirements that were safe % | 100 | 100 | 0 |  |
| Safe retirements found % | 94.74 | 94.74 | 0 |  |
| Unsafe retirements | 0 | 0 | 0 |  |
| metrics.unsafe.n | 0 | 0 | 0 |  |
| metrics.unsafe.of | 18 | 18 | 0 |  |
| metrics.unsafe.staged | 0 | 0 | 0 |  |
| metrics.staged.n | 12 | 12 | 0 |  |
| metrics.staged.safe | 12 | 12 | 0 |  |
| metrics.precision.value | 1 | 1 | 0 |  |
| metrics.precision.safe | 18 | 18 | 0 |  |
| metrics.precision.retired | 18 | 18 | 0 |  |
| metrics.recall.value | 0.9474 | 0.9474 | 0 |  |
| metrics.recall.retired_safe | 18 | 18 | 0 |  |
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
| metrics.classes.subsumed.hit | 5 | 5 | 0 |  |
| metrics.classes.subsumed.retired_safe | 5 | 5 | 0 |  |
| metrics.classes.subsumed.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.subsumed.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.subsumed.untouched | 0 | 0 | 0 |  |
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
| metrics.classes.overlap.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.overlap.wrong_successor | 0 | 0 | 0 |  |
| metrics.classes.overlap.untouched | 7 | 7 | 0 |  |
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
| metrics.pairs.labels.duplicate | 11 | 11 | 0 |  |
| metrics.pairs.labels.subsumed | 11 | 11 | 0 |  |
| metrics.pairs.labels.supersedes | 0 | 0 | 0 |  |
| metrics.pairs.labels.contradicts | 0 | 0 | 0 |  |
| metrics.pairs.labels.overlap | 10 | 10 | 0 |  |
| metrics.pairs.labels.unrelated | 0 | 0 | 0 |  |
| metrics.calls.calls | 57 | 57 | 0 |  |
| metrics.calls.failures | 0 | 0 | 0 |  |
| metrics.calls.prompt_tokens | 63595 | 63591 | -4 |  |
| metrics.calls.completion_tokens | 5944 | 6366 | 422 |  |
| metrics.chunks.total | 7 | 7 | 0 |  |
| metrics.chunks.failed | 0 | 0 | 0 |  |
| metrics.chunks.deferred_memories | 0 | 0 | 0 |  |
| metrics.chunks.promote_ops | 40 | 36 | -4 |  |
| status | complete | complete | — |  |
| metrics.warnings.0 | — | Skipping promote: pending proposal already exists for knowledge/dunmere-feature-flags | — |  |
| metrics.warnings.1 | — | Skipping promote: pending proposal already exists for knowledge/vesper-token-rotation | — |  |
| metrics.warnings.2 | — | Skipping promote: pending proposal already exists for knowledge/kettering-tls-certificate-renewal | — |  |
| metrics.warnings.3 | — | Skipping promote: pending proposal already exists for knowledge/kettering-tls-certificate-renewal | — |  |
| metrics.warnings.4 | — | Skipping promote: pending proposal already exists for knowledge/pellam-kiosk-update | — |  |
| metrics.warnings.5 | — | Skipping promote: pending proposal already exists for knowledge/jessamy-oncall-handover | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-v22/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1197/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"0967c6be9e23e770fe5a25c7c853682b710d17ff2e90516acc17b96dbc11d988"} |
| config | {"configVersion":"0.9.0","semanticSearchMode":"auto","registries":[],"engines":{"consolidate":{"kind":"llm","provider":"openai","apiKey":"$MODEL_API_KEY"}},"defaults":{"llmEngine":"consolidate"},"embedding":{"localModel":"Xenova/bge-small-en-v1.5","queryTimeoutMs":120000,"endpoint":"<EMBEDDING_ENDPOINT>","model":"embed/qwen3-embedding-0.6b","apiKey":"$MODEL_API_KEY"}} | {"configVersion":"0.9.0","semanticSearchMode":"auto","registries":[],"engines":{"consolidate":{"kind":"llm","provider":"openai","apiKey":"$MODEL_API_KEY"}},"defaults":{"llmEngine":"consolidate"},"embedding":{"localModel":"Xenova/bge-small-en-v1.5","queryTimeoutMs":120000,"endpoint":"<LAB_ENDPOINT>/v1/embeddings","model":"embed/qwen3-embedding-0.6b","apiKey":"$MODEL_API_KEY"}} |
| engines | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:38593","temperature":0,"enableThinking":false,"timeoutMs":600000}} | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"<LAB_ENDPOINT>","temperature":0,"enableThinking":false,"timeoutMs":600000}} |

