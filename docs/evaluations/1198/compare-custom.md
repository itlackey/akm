# retrieval · eval 0.3 · scoring 0.3

A: i1198-base-custom-final-rescored (/tmp/akm-eval-1198/private/retrieval/results/2026-10-21-i1198-base-custom-final-own-rescored)
B: i1198-candidate-custom-final-rescored (/tmp/akm-eval-1198/private/retrieval/results/2026-10-21-i1198-candidate-custom-final-own-rescored)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | i1198-base-custom-final-rescored | i1198-candidate-custom-final-rescored | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | own | own | — |  |
| Collected (UTC) | 2026-10-21T03:28:05.022Z | 2026-10-21T03:28:28.349Z | — |  |
| Quality % | 0 | 100 | 100 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 8 | 8 | 0 |  |
| Cases recorded | 8 | 8 | 0 |  |
| Cases scored | 8 | 8 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 21.125 | 23.259 | 2.134 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.3075 | 0.3175 | 0.01 |  |
| Keyword query p50 (s) | 0.3 | 0.35 | 0.05 |  |
| Keyword query p95 (s) | 0.3565 | 0.373 | 0.0165 |  |
| Keyword query timed | 8 | 8 | 0 |  |
| Semantic query mean (s) | 0.365 | 0.41125 | 0.04625 |  |
| Semantic query p50 (s) | 0.315 | 0.355 | 0.04 |  |
| Semantic query p95 (s) | 0.575 | 0.6725 | 0.0975 |  |
| Semantic query timed | 8 | 8 | 0 |  |
| Keyword index (s) | 0.9 | 1 | 0.1 |  |
| Semantic index (s) | 8.1 | 8.3 | 0.2 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.3 | 0.3 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | cold | cold | — |  |
| Collector commit | 27f5240-dirty | 27f5240-dirty | — |  |
| AKM build | v0.9.0-beta.60-2842-gd0fe1d000 | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Keyword banned result above first relevant % | 0 | 0 | 0 |  |
| Keyword banned result above relevant % | 0 | 0 | 0 |  |
| Keyword hit rate@5 % | 0 | 100 | 100 |  |
| Keyword judged nDCG@10 | 0 | 1 | 1 |  |
| Keyword MRR | 0 | 1 | 1 |  |
| Keyword precision@5 % | 0 | 20 | 20 |  |
| Keyword ranking · nDCG@10 | 0 | 1 | 1 |  |
| Keyword recall@10 % | 0 | 100 | 100 |  |
| Keyword results with judgments % | — | 100 | — |  |
| Semantic banned result above first relevant % | 0 | 0 | 0 |  |
| Semantic banned result above relevant % | 0 | 0 | 0 |  |
| Semantic hit rate@5 % | 0 | 100 | 100 |  |
| Semantic judged nDCG@10 | 0 | 0.8616 | 0.8616 |  |
| Semantic MRR | 0 | 0.8125 | 0.8125 |  |
| Semantic precision@5 % | 0 | 20 | 20 |  |
| Semantic ranking · nDCG@10 | 0 | 0.8616 | 0.8616 |  |
| Semantic recall@10 % | 0 | 100 | 100 |  |
| Semantic results with judgments % | 100 | 100 | 0 |  |
| metrics.search.n | 8 | 8 | 0 |  |
| metrics.search.ndcg_10 | 0 | 1 | 1 |  |
| metrics.search.ndcg_10_condensed | 0 | 1 | 1 |  |
| metrics.search.p_5 | 0 | 0.2 | 0.2 |  |
| metrics.search.success_5 | 0 | 1 | 1 |  |
| metrics.search.mrr | 0 | 1 | 1 |  |
| metrics.search.recall_10 | 0 | 1 | 1 |  |
| metrics.search.judged_10 | — | 1 | — |  |
| metrics.search.banned_above | 0 | 0 | 0 |  |
| metrics.search.banned_above_first | 0 | 0 | 0 |  |
| metrics.curate.n | 8 | 8 | 0 |  |
| metrics.curate.ndcg_10 | 0 | 0.125 | 0.125 |  |
| metrics.curate.ndcg_10_condensed | 0 | 0.125 | 0.125 |  |
| metrics.curate.p_5 | 0 | 0.025 | 0.025 |  |
| metrics.curate.success_5 | 0 | 0.125 | 0.125 |  |
| metrics.curate.mrr | 0 | 0.125 | 0.125 |  |
| metrics.curate.recall_10 | 0 | 0.125 | 0.125 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.banned_above | 0.875 | 0.875 | 0 |  |
| metrics.curate.banned_above_first | 0.875 | 0.875 | 0 |  |
| metrics.semantic_search.n | 8 | 8 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0 | 0.8616 | 0.8616 |  |
| metrics.semantic_search.ndcg_10_condensed | 0 | 0.8616 | 0.8616 |  |
| metrics.semantic_search.p_5 | 0 | 0.2 | 0.2 |  |
| metrics.semantic_search.success_5 | 0 | 1 | 1 |  |
| metrics.semantic_search.mrr | 0 | 0.8125 | 0.8125 |  |
| metrics.semantic_search.recall_10 | 0 | 1 | 1 |  |
| metrics.semantic_search.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.banned_above | 0 | 0 | 0 |  |
| metrics.semantic_search.banned_above_first | 0 | 0 | 0 |  |
| metrics.semantic_curate.n | 8 | 8 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0 | 0.125 | 0.125 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0 | 0.125 | 0.125 |  |
| metrics.semantic_curate.p_5 | 0 | 0.025 | 0.025 |  |
| metrics.semantic_curate.success_5 | 0 | 0.125 | 0.125 |  |
| metrics.semantic_curate.mrr | 0 | 0.125 | 0.125 |  |
| metrics.semantic_curate.recall_10 | 0 | 0.125 | 0.125 |  |
| metrics.semantic_curate.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_curate.banned_above | 0.875 | 0.875 | 0 |  |
| metrics.semantic_curate.banned_above_first | 0.875 | 0.875 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-coordination-baseline/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000","build_fingerprint":"27acaf5fb46d44c59a877b6235f133257640308816a590b32a2f2690a32c325e"} | {"version":"0.10.261008","bin":"bun /tmp/akm-1198/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"01f5ff41622a6eeef5e7d2976c9be350ab6ed184ae1b95034ade342dd65bffe1"} |
