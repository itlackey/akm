# consolidate · eval 0.2 · scoring 0.2

A: 1195-baseline-public (<AKM_CHECKOUT>/docs/evaluations/1195/baseline-public)
B: 1195-v22-public (<AKM_CHECKOUT>/docs/evaluations/1195/candidate-public)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1195-baseline-public | 1195-v22-public | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-20T21:55:55.509Z | 2026-10-20T23:12:26.463Z | — |  |
| Quality % | 87.5 | 82.5 | -5 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 35 | 33 | -2 |  |
| Quality cases | 40 | 40 | 0 |  |
| Cases recorded | 80 | 80 | 0 |  |
| Cases scored | 80 | 80 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 6.42625 | 4.32375 | -2.1025 |  |
| Case p50 (s) | 6.5 | 4.35 | -2.15 |  |
| Case p95 (s) | 9.14 | 5.505 | -3.635 |  |
| Cases timed | 80 | 80 | 0 |  |
| Case time sum (s) | 514.1 | 345.9 | -168.2 |  |
| Run wall time (s) | 514.085 | 346.133 | -167.952 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 181 | 178 | -3 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 836.9 | 892.4 | 55.5 |  |
| Mean output tokens / call | 94.9 | 89.6 | -5.3 |  |
| Mean model request (s) | 2.42 | 1.48 | -0.94 |  |
| Model output tokens / s | 39.3 | 60.6 | 21.3 |  |
| Recorded input tokens | 151474 | 158847 | 7373 |  |
| Recorded output tokens | 17184 | 15947 | -1237 |  |
| Usage cases | 80 | 80 | 0 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | real | real | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 4d14d45 | 4d14d45-dirty | — |  |
| Retirements that were safe % | 94.59 | 100 | 5.41 |  |
| Safe retirements found % | 87.5 | 82.5 | -5 |  |
| Unsafe retirements | 2 | 0 | -2 |  |
| metrics.unsafe.n | 2 | 0 | -2 |  |
| metrics.unsafe.of | 80 | 80 | 0 |  |
| metrics.unsafe.staged | 0 | 0 | 0 |  |
| metrics.staged.n | 22 | 19 | -3 |  |
| metrics.staged.safe | 22 | 19 | -3 |  |
| metrics.precision.value | 0.9459 | 1 | 0.0541 |  |
| metrics.precision.safe | 35 | 33 | -2 |  |
| metrics.precision.retired | 37 | 33 | -4 |  |
| metrics.recall.value | 0.875 | 0.825 | -0.05 |  |
| metrics.recall.retired_safe | 35 | 33 | -2 |  |
| metrics.recall.of | 40 | 40 | 0 |  |
| metrics.classes.duplicate.n | 13 | 13 | 0 |  |
| metrics.classes.duplicate.error | 0 | 0 | 0 |  |
| metrics.classes.duplicate.paired | 13 | 13 | 0 |  |
| metrics.classes.duplicate.judged_as.duplicate | 12 | 10 | -2 |  |
| metrics.classes.duplicate.judged_as.subsumed | 0 | 2 | 2 |  |
| metrics.classes.duplicate.judged_as.supersedes | 1 | 0 | -1 |  |
| metrics.classes.duplicate.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.overlap | 0 | 1 | 1 |  |
| metrics.classes.duplicate.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.duplicate.retired_safe | 13 | 12 | -1 |  |
| metrics.classes.duplicate.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.duplicate.kept | 0 | 1 | 1 |  |
| metrics.classes.subsumed.n | 14 | 14 | 0 |  |
| metrics.classes.subsumed.error | 0 | 0 | 0 |  |
| metrics.classes.subsumed.paired | 13 | 13 | 0 |  |
| metrics.classes.subsumed.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.subsumed | 13 | 12 | -1 |  |
| metrics.classes.subsumed.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.overlap | 0 | 1 | 1 |  |
| metrics.classes.subsumed.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.subsumed.retired_safe | 11 | 12 | 1 |  |
| metrics.classes.subsumed.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.subsumed.kept | 3 | 2 | -1 |  |
| metrics.classes.supersedes.n | 13 | 13 | 0 |  |
| metrics.classes.supersedes.error | 0 | 0 | 0 |  |
| metrics.classes.supersedes.paired | 12 | 12 | 0 |  |
| metrics.classes.supersedes.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.subsumed | 0 | 9 | 9 |  |
| metrics.classes.supersedes.judged_as.supersedes | 12 | 0 | -12 |  |
| metrics.classes.supersedes.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.supersedes.judged_as.overlap | 0 | 3 | 3 |  |
| metrics.classes.supersedes.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.supersedes.retired_safe | 11 | 9 | -2 |  |
| metrics.classes.supersedes.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.supersedes.kept | 2 | 4 | 2 |  |
| metrics.classes.contradicts.n | 13 | 13 | 0 |  |
| metrics.classes.contradicts.error | 0 | 0 | 0 |  |
| metrics.classes.contradicts.paired | 12 | 12 | 0 |  |
| metrics.classes.contradicts.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.contradicts.judged_as.contradicts | 11 | 0 | -11 |  |
| metrics.classes.contradicts.judged_as.overlap | 1 | 12 | 11 |  |
| metrics.classes.contradicts.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.contradicts.kept | 13 | 13 | 0 |  |
| metrics.classes.overlap.n | 13 | 13 | 0 |  |
| metrics.classes.overlap.error | 0 | 0 | 0 |  |
| metrics.classes.overlap.paired | 12 | 13 | 1 |  |
| metrics.classes.overlap.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.subsumed | 2 | 0 | -2 |  |
| metrics.classes.overlap.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.overlap.judged_as.overlap | 10 | 13 | 3 |  |
| metrics.classes.overlap.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.overlap.retired_unsafe | 2 | 0 | -2 |  |
| metrics.classes.overlap.kept | 11 | 13 | 2 |  |
| metrics.classes.unrelated.n | 14 | 14 | 0 |  |
| metrics.classes.unrelated.error | 0 | 0 | 0 |  |
| metrics.classes.unrelated.paired | 2 | 2 | 0 |  |
| metrics.classes.unrelated.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.unrelated.judged_as.overlap | 0 | 2 | 2 |  |
| metrics.classes.unrelated.judged_as.unrelated | 2 | 0 | -2 |  |
| metrics.classes.unrelated.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.unrelated.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.unrelated.kept | 14 | 14 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1195-v22/src/cli.ts","build":null,"build_fingerprint":null} |
| engines | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"<MODEL_BASE_URL>","temperature":0,"enableThinking":false,"timeoutMs":600000}} | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:37309","temperature":0,"enableThinking":false,"timeoutMs":600000}} |
