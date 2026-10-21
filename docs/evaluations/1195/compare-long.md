# consolidate · eval 0.2 · scoring 0.2

A: 1195-baseline-long-final (<AKM_CHECKOUT>/docs/evaluations/1195/baseline-long)
B: 1195-v22-long (<AKM_CHECKOUT>/docs/evaluations/1195/candidate-long)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1195-baseline-long-final | 1195-v22-long | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-20T21:47:21.169Z | 2026-10-20T23:18:41.173Z | — |  |
| Quality % | 60 | 100 | 40 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 3 | 5 | 2 |  |
| Quality cases | 5 | 5 | 0 |  |
| Cases recorded | 5 | 5 | 0 |  |
| Cases scored | 5 | 5 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 8.16 | 8.7 | 0.54 |  |
| Case p50 (s) | 6.8 | 8.6 | 1.8 |  |
| Case p95 (s) | 12.92 | 9.18 | -3.74 |  |
| Cases timed | 5 | 5 | 0 |  |
| Case time sum (s) | 40.8 | 43.5 | 2.7 |  |
| Run wall time (s) | 40.831 | 43.476 | 2.645 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 14 | 15 | 1 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 3283.1 | 3680.4 | 397.3 |  |
| Mean output tokens / call | 50.9 | 40.7 | -10.2 |  |
| Mean model request (s) | 2.63 | 2.24 | -0.39 |  |
| Model output tokens / s | 19.4 | 18.2 | -1.2 |  |
| Recorded input tokens | 45963 | 55206 | 9243 |  |
| Recorded output tokens | 712 | 611 | -101 |  |
| Usage cases | 5 | 5 | 0 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | real | real | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 4d14d45 | 4d14d45-dirty | — |  |
| Retirements that were safe % | 75 | 100 | 25 |  |
| Safe retirements found % | 60 | 100 | 40 |  |
| Unsafe retirements | 1 | 0 | -1 |  |
| metrics.unsafe.n | 1 | 0 | -1 |  |
| metrics.unsafe.of | 5 | 5 | 0 |  |
| metrics.unsafe.staged | 1 | 0 | -1 |  |
| metrics.staged.n | 3 | 0 | -3 |  |
| metrics.staged.safe | 2 | 0 | -2 |  |
| metrics.precision.value | 0.75 | 1 | 0.25 |  |
| metrics.precision.safe | 3 | 5 | 2 |  |
| metrics.precision.retired | 4 | 5 | 1 |  |
| metrics.recall.value | 0.6 | 1 | 0.4 |  |
| metrics.recall.retired_safe | 3 | 5 | 2 |  |
| metrics.recall.of | 5 | 5 | 0 |  |
| metrics.classes.duplicate.n | 1 | 1 | 0 |  |
| metrics.classes.duplicate.error | 0 | 0 | 0 |  |
| metrics.classes.duplicate.paired | 1 | 1 | 0 |  |
| metrics.classes.duplicate.judged_as.duplicate | 1 | 1 | 0 |  |
| metrics.classes.duplicate.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.duplicate.retired_safe | 1 | 1 | 0 |  |
| metrics.classes.duplicate.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.duplicate.kept | 0 | 0 | 0 |  |
| metrics.classes.subsumed.n | 4 | 4 | 0 |  |
| metrics.classes.subsumed.error | 0 | 0 | 0 |  |
| metrics.classes.subsumed.paired | 4 | 4 | 0 |  |
| metrics.classes.subsumed.judged_as.duplicate | 2 | 0 | -2 |  |
| metrics.classes.subsumed.judged_as.subsumed | 1 | 4 | 3 |  |
| metrics.classes.subsumed.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.overlap | 1 | 0 | -1 |  |
| metrics.classes.subsumed.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.subsumed.retired_safe | 2 | 4 | 2 |  |
| metrics.classes.subsumed.retired_unsafe | 1 | 0 | -1 |  |
| metrics.classes.subsumed.kept | 1 | 0 | -1 |  |
| metrics.classes.supersedes.n | 0 | 0 | 0 |  |
| metrics.classes.supersedes.error | 0 | 0 | 0 |  |
| metrics.classes.supersedes.paired | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.supersedes.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.supersedes.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.supersedes.kept | 0 | 0 | 0 |  |
| metrics.classes.contradicts.n | 0 | 0 | 0 |  |
| metrics.classes.contradicts.error | 0 | 0 | 0 |  |
| metrics.classes.contradicts.paired | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.kept | 0 | 0 | 0 |  |
| metrics.classes.overlap.n | 0 | 0 | 0 |  |
| metrics.classes.overlap.error | 0 | 0 | 0 |  |
| metrics.classes.overlap.paired | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.overlap.kept | 0 | 0 | 0 |  |
| metrics.classes.unrelated.n | 0 | 0 | 0 |  |
| metrics.classes.unrelated.error | 0 | 0 | 0 |  |
| metrics.classes.unrelated.paired | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.unrelated.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.unrelated.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.unrelated.kept | 0 | 0 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-v22/src/cli.ts","build":null,"build_fingerprint":null} |
| engines | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"<MODEL_BASE_URL>","temperature":0,"enableThinking":false,"timeoutMs":600000}} | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:40375","temperature":0,"enableThinking":false,"timeoutMs":600000}} |
