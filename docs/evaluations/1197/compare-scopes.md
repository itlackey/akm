# consolidate · eval 0.2 · scoring 0.2

A: 1197-baseline-scopes (/tmp/akm-1197-eval/private/consolidate/results/2026-10-21-1197-baseline-scopes)
B: 1197-candidate-scopes (/tmp/akm-1197-eval/private/consolidate/results/2026-10-21-1197-candidate-scopes)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1197-baseline-scopes | 1197-candidate-scopes | — |  |
| Test | consolidate | consolidate | — |  |
| Collected (UTC) | 2026-10-21T02:39:02.977Z | 2026-10-21T02:40:01.941Z | — |  |
| Quality % | 100 | 100 | 0 |  |
| Quality metric | Safe retirements found | Safe retirements found | — |  |
| Quality passed | 3 | 3 | 0 |  |
| Quality cases | 3 | 3 | 0 |  |
| Cases recorded | 9 | 9 | 0 |  |
| Cases scored | 9 | 9 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 2.733333 | 1.433333 | -1.3 |  |
| Case p50 (s) | 2.7 | 0.8 | -1.9 |  |
| Case p95 (s) | 2.8 | 2.7 | -0.1 |  |
| Cases timed | 9 | 9 | 0 |  |
| Case time sum (s) | 24.6 | 12.9 | -11.7 |  |
| Run wall time (s) | 24.57 | 13.007 | -11.563 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 27 | 15 | -12 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 673 | 605.4 | -67.6 |  |
| Mean output tokens / call | 22.7 | 17 | -5.7 |  |
| Mean model request (s) | 0.69 | 0.48 | -0.21 |  |
| Model output tokens / s | 32.8 | 35.6 | 2.8 |  |
| Recorded input tokens | 18171 | 9081 | -9090 |  |
| Recorded output tokens | 614 | 255 | -359 |  |
| Usage cases | 9 | 9 | 0 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | consolidate | consolidate | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Embedding model | deterministic | deterministic | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | unknown | unknown | — |  |
| AKM build | — | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Retirements that were safe % | 33.33 | 100 | 66.67 |  |
| Safe retirements found % | 100 | 100 | 0 |  |
| Unsafe retirements | 6 | 0 | -6 |  |
| metrics.unsafe.n | 6 | 0 | -6 |  |
| metrics.unsafe.of | 9 | 9 | 0 |  |
| metrics.unsafe.staged | 6 | 0 | -6 |  |
| metrics.staged.n | 9 | 3 | -6 |  |
| metrics.staged.safe | 3 | 3 | 0 |  |
| metrics.precision.value | 0.3333 | 1 | 0.6667 |  |
| metrics.precision.safe | 3 | 3 | 0 |  |
| metrics.precision.retired | 9 | 3 | -6 |  |
| metrics.recall.value | 1 | 1 | 0 |  |
| metrics.recall.retired_safe | 3 | 3 | 0 |  |
| metrics.recall.of | 3 | 3 | 0 |  |
| metrics.classes.duplicate.n | 9 | 9 | 0 |  |
| metrics.classes.duplicate.error | 0 | 0 | 0 |  |
| metrics.classes.duplicate.paired | 9 | 3 | -6 |  |
| metrics.classes.duplicate.judged_as.duplicate | 9 | 3 | -6 |  |
| metrics.classes.duplicate.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.duplicate.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.duplicate.retired_safe | 3 | 3 | 0 |  |
| metrics.classes.duplicate.retired_unsafe | 6 | 0 | -6 |  |
| metrics.classes.duplicate.kept | 0 | 6 | 6 |  |
| metrics.classes.subsumed.n | 0 | 0 | 0 |  |
| metrics.classes.subsumed.error | 0 | 0 | 0 |  |
| metrics.classes.subsumed.paired | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.duplicate | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.subsumed | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.supersedes | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.contradicts | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.overlap | 0 | 0 | 0 |  |
| metrics.classes.subsumed.judged_as.unrelated | 0 | 0 | 0 |  |
| metrics.classes.subsumed.retired_safe | 0 | 0 | 0 |  |
| metrics.classes.subsumed.retired_unsafe | 0 | 0 | 0 |  |
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
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1197-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1197/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"e37d8682865a5f9218068593d5a70830475a2fbd5def78c0c0f4a656ba916938"} |

