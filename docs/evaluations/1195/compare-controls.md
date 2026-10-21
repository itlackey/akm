# consolidate · eval 0.2 · scoring 0.2

A: 1195-baseline-controls (<AKM_CHECKOUT>/docs/evaluations/1195/baseline-controls)
B: 1195-v22-controls (<AKM_CHECKOUT>/docs/evaluations/1195/candidate-controls)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1195-baseline-controls | 1195-v22-controls | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-20T23:21:02.743Z | 2026-10-20T23:21:51.140Z | — |  |
| Quality % | 66.67 | 100 | 33.33 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 2 | 3 | 1 |  |
| Quality cases | 3 | 3 | 0 |  |
| Cases recorded | 3 | 3 | 0 |  |
| Cases scored | 3 | 3 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 8.2 | 16.066667 | 7.866667 |  |
| Case p50 (s) | 8.9 | 19.6 | 10.7 |  |
| Case p95 (s) | 8.99 | 20.5 | 11.51 |  |
| Cases timed | 3 | 3 | 0 |  |
| Case time sum (s) | 24.6 | 48.2 | 23.6 |  |
| Run wall time (s) | 24.536 | 48.174 | 23.638 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 9 | 9 | 0 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 4138.1 | 8306.3 | 4168.2 |  |
| Mean output tokens / call | 30.2 | 50.7 | 20.5 |  |
| Mean model request (s) | 2.44 | 5.09 | 2.65 |  |
| Model output tokens / s | 12.4 | 10 | -2.4 |  |
| Recorded input tokens | 37243 | 74757 | 37514 |  |
| Recorded output tokens | 272 | 456 | 184 |  |
| Usage cases | 3 | 3 | 0 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | real | real | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 4d14d45-dirty | 4d14d45-dirty | — |  |
| Retirements that were safe % | 66.67 | 100 | 33.33 |  |
| Safe retirements found % | 66.67 | 100 | 33.33 |  |
| Unsafe retirements | 1 | 0 | -1 |  |
| metrics.unsafe.n | 1 | 0 | -1 |  |
| metrics.unsafe.of | 3 | 3 | 0 |  |
| metrics.unsafe.staged | 1 | 0 | -1 |  |
| metrics.staged.n | 3 | 2 | -1 |  |
| metrics.staged.safe | 2 | 2 | 0 |  |
| metrics.precision.value | 0.6667 | 1 | 0.3333 |  |
| metrics.precision.safe | 2 | 3 | 1 |  |
| metrics.precision.retired | 3 | 3 | 0 |  |
| metrics.recall.value | 0.6667 | 1 | 0.3333 |  |
| metrics.recall.retired_safe | 2 | 3 | 1 |  |
| metrics.recall.of | 3 | 3 | 0 |  |
| metrics.classes.duplicate.n | 2 | 2 | 0 |  |
| metrics.classes.duplicate.error | 0 | 0 | 0 |  |
| metrics.classes.duplicate.paired | 2 | 2 | 0 |  |
| metrics.classes.duplicate.judged_as.duplicate | 2 | 2 | 0 |  |
| metrics.classes.duplicate.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.duplicate.retired_safe | 2 | 2 | 0 |  |
| metrics.classes.duplicate.retired_unsafe | 0 | 0 | 0 |  |
| metrics.classes.duplicate.kept | 0 | 0 | 0 |  |
| metrics.classes.subsumed.n | 1 | 1 | 0 |  |
| metrics.classes.subsumed.error | 0 | 0 | 0 |  |
| metrics.classes.subsumed.paired | 1 | 1 | 0 |  |
| metrics.classes.subsumed.judged_as.duplicate | 1 | 0 | -1 |  |
| metrics.classes.subsumed.judged_as.subsumed | 0 | 1 | 1 |  |
| metrics.classes.subsumed.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.subsumed.retired_safe | 0 | 1 | 1 |  |
| metrics.classes.subsumed.retired_unsafe | 1 | 0 | -1 |  |
| metrics.classes.subsumed.kept | 0 | 0 | 0 |  |
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
| engines | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:39813","temperature":0,"enableThinking":false,"timeoutMs":600000}} | {"consolidate":{"model":"fast/qwen3.6-35b-a3b","endpoint":"http://127.0.0.1:36447","temperature":0,"enableThinking":false,"timeoutMs":600000}} |
