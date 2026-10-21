# retrieval · eval 0.2 · scoring 0.3

A: issue1198-baseline-full (/tmp/akm-coordination-eval/evals/retrieval/results/2026-10-21-issue1198-baseline-full-books)
B: issue1198-candidate-full (/tmp/akm-coordination-eval/evals/retrieval/results/2026-10-21-issue1198-candidate-full-books)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | issue1198-baseline-full | issue1198-candidate-full | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | books | books | — |  |
| Collected (UTC) | 2026-10-21T03:19:06.361Z | 2026-10-21T03:27:14.248Z | — |  |
| Quality % | 82.75 | 82.75 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 51 | 51 | 0 |  |
| Cases recorded | 51 | 51 | 0 |  |
| Cases scored | 51 | 51 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 102.493 | 84.693 | -17.8 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.368235 | 0.312549 | -0.055686 |  |
| Keyword query p50 (s) | 0.33 | 0.27 | -0.06 |  |
| Keyword query p95 (s) | 0.575 | 0.52 | -0.055 |  |
| Keyword query timed | 51 | 51 | 0 |  |
| Semantic query mean (s) | 0.53098 | 0.382353 | -0.148627 |  |
| Semantic query p50 (s) | 0.45 | 0.32 | -0.13 |  |
| Semantic query p95 (s) | 0.9 | 0.735 | -0.165 |  |
| Semantic query timed | 51 | 51 | 0 |  |
| Keyword index (s) | 0.3 | 0.8 | 0.5 |  |
| Semantic index (s) | 0.2 | 5.2 | 5 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | warm | cold | — |  |
| Collector commit | 1002fa2-dirty | 1002fa2-dirty | — |  |
| AKM build | v0.9.0-beta.60-2842-gd0fe1d000 | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Keyword banned result above first relevant % | 17.65 | 17.65 | 0 |  |
| Keyword banned result above relevant % | 35.29 | 35.29 | 0 |  |
| Keyword hit rate@5 % | 100 | 100 | 0 |  |
| Keyword judged nDCG@10 | 0.8275 | 0.8275 | 0 |  |
| Keyword MRR | 0.8954 | 0.8954 | 0 |  |
| Keyword precision@5 % | 40 | 40 | 0 |  |
| Keyword ranking · nDCG@10 | 0.8275 | 0.8275 | 0 |  |
| Keyword recall@10 % | 92.23 | 92.23 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic banned result above first relevant % | 7.84 | 7.84 | 0 |  |
| Semantic banned result above relevant % | 23.53 | 23.53 | 0 |  |
| Semantic hit rate@5 % | 98.04 | 98.04 | 0 |  |
| Semantic judged nDCG@10 | 0.9048 | 0.9049 | 0.0001 |  |
| Semantic MRR | 0.9534 | 0.9534 | 0 |  |
| Semantic precision@5 % | 45.1 | 44.71 | -0.39 |  |
| Semantic ranking · nDCG@10 | 0.9022 | 0.9022 | 0 |  |
| Semantic recall@10 % | 98.49 | 98.49 | 0 |  |
| Semantic results with judgments % | 88.04 | 88.04 | 0 |  |
| metrics.search.n | 51 | 51 | 0 |  |
| metrics.search.ndcg_10 | 0.8275 | 0.8275 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.8275 | 0.8275 | 0 |  |
| metrics.search.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.search.success_5 | 1 | 1 | 0 |  |
| metrics.search.mrr | 0.8954 | 0.8954 | 0 |  |
| metrics.search.recall_10 | 0.9223 | 0.9223 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.search.banned_above | 0.3529 | 0.3529 | 0 |  |
| metrics.search.banned_above_first | 0.1765 | 0.1765 | 0 |  |
| metrics.curate.n | 51 | 51 | 0 |  |
| metrics.curate.ndcg_10 | 0.8275 | 0.8275 | 0 |  |
| metrics.curate.ndcg_10_condensed | 0.8275 | 0.8275 | 0 |  |
| metrics.curate.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.curate.success_5 | 1 | 1 | 0 |  |
| metrics.curate.mrr | 0.8954 | 0.8954 | 0 |  |
| metrics.curate.recall_10 | 0.9223 | 0.9223 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.banned_above | 0.3529 | 0.3529 | 0 |  |
| metrics.curate.banned_above_first | 0.1765 | 0.1765 | 0 |  |
| metrics.semantic_search.n | 51 | 51 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.9022 | 0.9022 | 0 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.9048 | 0.9049 | 0.0001 |  |
| metrics.semantic_search.p_5 | 0.451 | 0.4471 | -0.0039 |  |
| metrics.semantic_search.success_5 | 0.9804 | 0.9804 | 0 |  |
| metrics.semantic_search.mrr | 0.9534 | 0.9534 | 0 |  |
| metrics.semantic_search.recall_10 | 0.9849 | 0.9849 | 0 |  |
| metrics.semantic_search.judged_10 | 0.8804 | 0.8804 | 0 |  |
| metrics.semantic_search.banned_above | 0.2353 | 0.2353 | 0 |  |
| metrics.semantic_search.banned_above_first | 0.0784 | 0.0784 | 0 |  |
| metrics.semantic_curate.n | 51 | 51 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0.9021 | 0.9023 | 0.0002 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.9048 | 0.9048 | 0 |  |
| metrics.semantic_curate.p_5 | 0.4471 | 0.4431 | -0.004 |  |
| metrics.semantic_curate.success_5 | 0.9804 | 0.9804 | 0 |  |
| metrics.semantic_curate.mrr | 0.9534 | 0.9534 | 0 |  |
| metrics.semantic_curate.recall_10 | 0.9849 | 0.9849 | 0 |  |
| metrics.semantic_curate.judged_10 | 0.8804 | 0.8804 | 0 |  |
| metrics.semantic_curate.banned_above | 0.2353 | 0.2353 | 0 |  |
| metrics.semantic_curate.banned_above_first | 0.0784 | 0.0784 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-coordination-baseline/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000","build_fingerprint":"27acaf5fb46d44c59a877b6235f133257640308816a590b32a2f2690a32c325e"} | {"version":"0.10.261008","bin":"bun /tmp/akm-1198/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"01f5ff41622a6eeef5e7d2976c9be350ab6ed184ae1b95034ade342dd65bffe1"} |
| semantic_index | warm | cold |
