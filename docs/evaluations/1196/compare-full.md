# extract · eval 0.2 · scoring 0.2

A: issue-1196-baseline-full (/tmp/akm-coordination-eval/evals/extract/results/2026-10-21-issue-1196-baseline-full)
B: issue-1196-candidate-full (/tmp/akm-coordination-eval/evals/extract/results/2026-10-21-issue-1196-candidate-full)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Model / route | fast/qwen3.6-35b-a3b | fast/qwen3.6-35b-a3b | — |  |
| Run | issue-1196-baseline-full | issue-1196-candidate-full | — |  |
| Test | extract | extract | — |  |
| Collected (UTC) | 2026-10-21T03:25:59.526Z | 2026-10-21T03:28:00.452Z | — |  |
| Quality % | 90 | 90 | 0 |  |
| Quality metric | Useful memories extracted | Useful memories extracted | — |  |
| Quality passed | 36 | 36 | 0 |  |
| Quality cases | 40 | 40 | 0 |  |
| Cases recorded | 64 | 64 | 0 |  |
| Cases scored | 64 | 64 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Case mean (s) | 14.9125 | 13.896875 | -1.015625 |  |
| Case p50 (s) | 13.65 | 14.25 | 0.6 |  |
| Case p95 (s) | 30.295 | 26.61 | -3.685 |  |
| Cases timed | 64 | 64 | 0 |  |
| Case time sum (s) | 954.4 | 889.4 | -65 |  |
| Run wall time (s) | 479.446 | 445.807 | -33.639 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Model calls | 64 | 64 | 0 |  |
| Failed model calls | 0 | 0 | 0 |  |
| Mean input tokens / call | 3595.6 | 3595.6 | 0 |  |
| Mean output tokens / call | 358 | 341.6 | -16.4 |  |
| Mean model request (s) | 14.05 | 12.96 | -1.09 |  |
| Model output tokens / s | 25.5 | 26.4 | 0.9 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.2 | 0.2 | — |  |
| Strategy | extract-only | extract-only | — |  |
| Search methods | semantic (configured) | semantic (configured) | — |  |
| Temperature | 0 | 0 | 0 |  |
| Thinking | Off | Off | — |  |
| Collector commit | 1002fa2-dirty | 1002fa2-dirty | — |  |
| AKM build | v0.9.0-beta.60-2842-gd0fe1d000 | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Planted instructions saved | 2 | 1 | -1 |  |
| Routine sessions skipped % | 100 | 100 | 0 |  |
| Useful memories extracted % | 90 | 90 | 0 |  |
| metrics.insights.n | 40 | 40 | 0 |  |
| metrics.insights.correct | 36 | 36 | 0 |  |
| metrics.insights.rate | 0.9 | 0.9 | 0 |  |
| metrics.routine.n | 20 | 20 | 0 |  |
| metrics.routine.correct | 20 | 20 | 0 |  |
| metrics.routine.rate | 1 | 1 | 0 |  |
| metrics.planted.n | 4 | 4 | 0 |  |
| metrics.planted.correct | 2 | 3 | 1 |  |
| metrics.planted.rate | 0.5 | 0.75 | 0.25 |  |
| metrics.planted.saved_instruction | 2 | 1 | -1 |  |
| metrics.planted.ambiguous | 0 | 0 | 0 |  |
| metrics.classes.insight.n | 21 | 21 | 0 |  |
| metrics.classes.insight.correct | 20 | 20 | 0 |  |
| metrics.classes.insight.rate | 0.9524 | 0.9524 | 0 |  |
| metrics.classes.insight.outcomes.saved | 21 | 21 | 0 |  |
| metrics.classes.insight.outcomes.empty | 0 | 0 | 0 |  |
| metrics.classes.insight.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.classes.insight.memories | 22 | 21 | -1 |  |
| metrics.classes.insight.failed.missing_fact | 1 | 1 | 0 |  |
| metrics.classes.insight.failed.forbidden_claim | 0 | 0 | 0 |  |
| metrics.classes.routine.n | 20 | 20 | 0 |  |
| metrics.classes.routine.correct | 20 | 20 | 0 |  |
| metrics.classes.routine.rate | 1 | 1 | 0 |  |
| metrics.classes.routine.outcomes.saved | 0 | 0 | 0 |  |
| metrics.classes.routine.outcomes.empty | 20 | 20 | 0 |  |
| metrics.classes.routine.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.classes.routine.memories | 0 | 0 | 0 |  |
| metrics.classes.routine.failed.missing_fact | 0 | 0 | 0 |  |
| metrics.classes.routine.failed.forbidden_claim | 0 | 0 | 0 |  |
| metrics.classes.planted.n | 4 | 4 | 0 |  |
| metrics.classes.planted.correct | 2 | 3 | 1 |  |
| metrics.classes.planted.rate | 0.5 | 0.75 | 0.25 |  |
| metrics.classes.planted.outcomes.saved | 4 | 3 | -1 |  |
| metrics.classes.planted.outcomes.empty | 0 | 1 | 1 |  |
| metrics.classes.planted.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.classes.planted.memories | 4 | 3 | -1 |  |
| metrics.classes.planted.failed.missing_fact | 0 | 0 | 0 |  |
| metrics.classes.planted.failed.forbidden_claim | 2 | 1 | -1 |  |
| metrics.classes.preference.n | 11 | 11 | 0 |  |
| metrics.classes.preference.correct | 8 | 8 | 0 |  |
| metrics.classes.preference.rate | 0.7273 | 0.7273 | 0 |  |
| metrics.classes.preference.outcomes.saved | 11 | 11 | 0 |  |
| metrics.classes.preference.outcomes.empty | 0 | 0 | 0 |  |
| metrics.classes.preference.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.classes.preference.memories | 12 | 12 | 0 |  |
| metrics.classes.preference.failed.missing_fact | 3 | 3 | 0 |  |
| metrics.classes.preference.failed.forbidden_claim | 0 | 0 | 0 |  |
| metrics.classes.buried.n | 8 | 8 | 0 |  |
| metrics.classes.buried.correct | 8 | 8 | 0 |  |
| metrics.classes.buried.rate | 1 | 1 | 0 |  |
| metrics.classes.buried.outcomes.saved | 8 | 8 | 0 |  |
| metrics.classes.buried.outcomes.empty | 0 | 0 | 0 |  |
| metrics.classes.buried.outcomes.unusable | 0 | 0 | 0 |  |
| metrics.classes.buried.memories | 13 | 10 | -3 |  |
| metrics.classes.buried.failed.missing_fact | 0 | 0 | 0 |  |
| metrics.classes.buried.failed.forbidden_claim | 0 | 0 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-coordination-baseline/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000","build_fingerprint":"27acaf5fb46d44c59a877b6235f133257640308816a590b32a2f2690a32c325e"} | {"version":"0.10.261008","bin":"bun /tmp/akm-1196/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"a1602091b9241dd3a08d140e205328d32bc7b447b6089c496eebb46839d55f08"} |
