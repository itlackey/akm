# retrieval · eval 0.3 · scoring 0.3

A: 1199-baseline (/tmp/akm-eval-1199/private/retrieval/results/2026-10-21-1199-baseline-own)
B: 1199-candidate (/tmp/akm-eval-1199/private/retrieval/results/2026-10-21-1199-candidate-own)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- /tmp/akm-eval-1199/private/retrieval/results/2026-10-21-1199-baseline-own: status aborted: 10 semantic calls failed, or answered with keyword search. Their queries are left out of the semantic columns: see the errors in samples.jsonl..
- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | 1199-baseline | 1199-candidate | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | own | own | — |  |
| Collected (UTC) | 2026-10-21T04:21:54.239Z | 2026-10-21T04:23:09.777Z | — |  |
| Quality % | 97.64 | 97.64 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 13 | 13 | 0 |  |
| Cases recorded | 14 | 14 | 0 |  |
| Cases scored | 4 | 14 | 10 |  |
| Errors | 10 | 0 | -10 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 15.747 | 18.351 | 2.604 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.247143 | 0.262143 | 0.015 |  |
| Keyword query p50 (s) | 0.24 | 0.25 | 0.01 |  |
| Keyword query p95 (s) | 0.294 | 0.3375 | 0.0435 |  |
| Keyword query timed | 14 | 14 | 0 |  |
| Semantic query mean (s) | 0.282143 | 0.282143 | 0 |  |
| Semantic query p50 (s) | 0.28 | 0.26 | -0.02 |  |
| Semantic query p95 (s) | 0.31 | 0.366 | 0.056 |  |
| Semantic query timed | 14 | 14 | 0 |  |
| Keyword index (s) | 0.3 | 0.3 | 0 |  |
| Semantic index (s) | 0.2 | 0.8 | 0.6 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.3 | 0.3 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | warm | cold | — |  |
| Collector commit | 27f5240-dirty | 27f5240-dirty | — |  |
| AKM build | — | v0.9.0-beta.60-2846-g79cf3236a-dirty | — |  |
| Keyword banned result above first relevant % | 14.29 | 14.29 | 0 |  |
| Keyword banned result above relevant % | 14.29 | 14.29 | 0 |  |
| Keyword hit rate@5 % | 100 | 100 | 0 |  |
| Keyword judged nDCG@10 | 0.9764 | 0.9764 | 0 |  |
| Keyword MRR | 0.9615 | 0.9615 | 0 |  |
| Keyword precision@5 % | 27.69 | 27.69 | 0 |  |
| Keyword ranking · nDCG@10 | 0.9764 | 0.9764 | 0 |  |
| Keyword recall@10 % | 100 | 100 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic banned result above first relevant % | 14.29 | 14.29 | 0 |  |
| Semantic banned result above relevant % | 14.29 | 14.29 | 0 |  |
| Semantic hit rate@5 % | 100 | 100 | 0 |  |
| Semantic judged nDCG@10 | 0.9697 | 0.9697 | 0 |  |
| Semantic MRR | 0.9615 | 0.9615 | 0 |  |
| Semantic precision@5 % | 27.69 | 27.69 | 0 |  |
| Semantic ranking · nDCG@10 | 0.9697 | 0.9697 | 0 |  |
| Semantic recall@10 % | 100 | 100 | 0 |  |
| Semantic results with judgments % | 100 | 100 | 0 |  |
| metrics.search.n | 13 | 13 | 0 |  |
| metrics.search.ndcg_10 | 0.9764 | 0.9764 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.9764 | 0.9764 | 0 |  |
| metrics.search.p_5 | 0.2769 | 0.2769 | 0 |  |
| metrics.search.success_5 | 1 | 1 | 0 |  |
| metrics.search.mrr | 0.9615 | 0.9615 | 0 |  |
| metrics.search.recall_10 | 1 | 1 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.search.banned_above | 0.1429 | 0.1429 | 0 |  |
| metrics.search.banned_above_first | 0.1429 | 0.1429 | 0 |  |
| metrics.curate.n | 4 | 13 | 9 |  |
| metrics.curate.ndcg_10 | 0.9234 | 1 | 0.0766 |  |
| metrics.curate.ndcg_10_condensed | 0.9234 | 1 | 0.0766 |  |
| metrics.curate.p_5 | 0.25 | 0.2769 | 0.0269 |  |
| metrics.curate.success_5 | 1 | 1 | 0 |  |
| metrics.curate.mrr | 0.875 | 1 | 0.125 |  |
| metrics.curate.recall_10 | 1 | 1 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.banned_above | 0.3333 | 0 | -0.3333 |  |
| metrics.curate.banned_above_first | 0.3333 | 0 | -0.3333 |  |
| metrics.semantic_search.n | 13 | 13 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.9697 | 0.9697 | 0 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.9697 | 0.9697 | 0 |  |
| metrics.semantic_search.p_5 | 0.2769 | 0.2769 | 0 |  |
| metrics.semantic_search.success_5 | 1 | 1 | 0 |  |
| metrics.semantic_search.mrr | 0.9615 | 0.9615 | 0 |  |
| metrics.semantic_search.recall_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.banned_above | 0.1429 | 0.1429 | 0 |  |
| metrics.semantic_search.banned_above_first | 0.1429 | 0.1429 | 0 |  |
| metrics.semantic_curate.n | 4 | 13 | 9 |  |
| metrics.semantic_curate.ndcg_10 | 0.9127 | 0.9904 | 0.0777 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.9127 | 0.9904 | 0.0777 |  |
| metrics.semantic_curate.p_5 | 0.25 | 0.2769 | 0.0269 |  |
| metrics.semantic_curate.success_5 | 1 | 1 | 0 |  |
| metrics.semantic_curate.mrr | 0.875 | 1 | 0.125 |  |
| metrics.semantic_curate.recall_10 | 1 | 1 | 0 |  |
| metrics.semantic_curate.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_curate.banned_above | 0.3333 | 0 | -0.3333 |  |
| metrics.semantic_curate.banned_above_first | 0.3333 | 0 | -0.3333 |  |
| status | aborted | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1199-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun ~/.codex/worktrees/1199-curate-recall-controls/akm/src/cli.ts","build":"v0.9.0-beta.60-2846-g79cf3236a-dirty","build_fingerprint":"9dd5c9ab6eef4776d78fd160f1d6d14b78a1a933c9a730368f93382b0e536dca"} |
| semantic_index | warm | cold |
