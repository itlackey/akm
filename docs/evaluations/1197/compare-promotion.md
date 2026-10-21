# bakeoff · eval 0.2 · scoring 0.2

A: 1197-baseline-promotion (/tmp/akm-1197-eval/evals/bakeoff/results/2026-10-21-1197-baseline-promotion)
B: 1197-candidate-promotion (/tmp/akm-1197-eval/evals/bakeoff/results/2026-10-21-1197-candidate-promotion)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | 1197-baseline-promotion | 1197-candidate-promotion | — |  |
| Test | bakeoff | bakeoff | — |  |
| Collected (UTC) | 2026-10-21T02:50:42.107Z | 2026-10-21T02:53:20.099Z | — |  |
| Quality % | 62.5 | 62.5 | 0 |  |
| Quality metric | Cases passed | Cases passed | — |  |
| Quality passed | 5 | 5 | 0 |  |
| Quality cases | 8 | 8 | 0 |  |
| Cases recorded | 8 | 8 | 0 |  |
| Cases scored | 8 | 8 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 13.0125 | 22.7 | 9.6875 |  |
| Case p50 (s) | 5.95 | 10.65 | 4.7 |  |
| Case p95 (s) | 30.81 | 61.13 | 30.32 |  |
| Cases timed | 8 | 8 | 0 |  |
| Case time sum (s) | 104.1 | 181.6 | 77.5 |  |
| Run wall time (s) | 104.121 | 181.646 | 77.525 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 24 | 24 | 0 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 626.3 | 620.2 | -6.1 |  |
| Mean output tokens / call | 209.7 | 190 | -19.7 |  |
| Mean model request (s) | 3.89 | 7.04 | 3.15 |  |
| Model output tokens / s | 53.9 | 27 | -26.9 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | unknown | unknown | — |  |
| AKM build | — | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Cases passed % | 62.5 | 62.5 | 0 |  |
| Checks passed % | 85.42 | 85.42 | 0 |  |
| Usable outputs % | 100 | 100 | 0 |  |
| metrics.valid_output.n | 8 | 8 | 0 |  |
| metrics.valid_output.passed | 8 | 8 | 0 |  |
| metrics.valid_output.rate | 1 | 1 | 0 |  |
| metrics.case_pass.n | 8 | 8 | 0 |  |
| metrics.case_pass.passed | 5 | 5 | 0 |  |
| metrics.case_pass.rate | 0.625 | 0.625 | 0 |  |
| metrics.checks.n | 8 | 8 | 0 |  |
| metrics.checks.rate | 0.8542 | 0.8542 | 0 |  |
| metrics.median_seconds | 5.9 | 10.6 | 4.7 |  |
| metrics.by_process.consolidate-promote.n | 8 | 8 | 0 |  |
| metrics.by_process.consolidate-promote.valid_output | 8 | 8 | 0 |  |
| metrics.by_process.consolidate-promote.passed | 5 | 5 | 0 |  |
| metrics.by_process.consolidate-promote.checks | 0.8542 | 0.8542 | 0 |  |
| metrics.by_process.consolidate-promote.outcomes.output | 8 | 8 | 0 |  |
| metrics.by_process.consolidate-promote.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.by_process.consolidate-promote.outcomes.error | 0 | 0 | 0 |  |
| metrics.by_process.consolidate-promote.failed.promotes memories/signed-artifacts | 1 | 1 | 0 |  |
| metrics.by_process.consolidate-promote.failed.no extra or missing promotions | 1 | 1 | 0 |  |
| metrics.by_process.consolidate-promote.failed.promotes memories/artifact-signing-observation | 1 | 1 | 0 |  |
| metrics.by_process.consolidate-promote.failed.leaves protected memories/failover-drill-placeholder untouched | 1 | 1 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1197-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1197/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"0967c6be9e23e770fe5a25c7c853682b710d17ff2e90516acc17b96dbc11d988"} |

