# retrieval · eval 0.2 · scoring 0.3

A: issue1200-baseline-full (/tmp/akm-coordination-eval/private/retrieval/results/2026-10-21-issue1200-baseline-full-own)
B: issue1200-candidate-full (/tmp/akm-coordination-eval/private/retrieval/results/2026-10-21-issue1200-candidate-full-own)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.

- Several settings changed; these differences do not isolate the effect of any one change.

| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | issue1200-baseline-full | issue1200-candidate-full | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | own | own | — |  |
| Collected (UTC) | 2026-10-21T03:21:58.125Z | 2026-10-21T03:23:54.214Z | — |  |
| Quality % | 98.33 | 98.33 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 3 | 3 | 0 |  |
| Cases recorded | 3 | 3 | 0 |  |
| Cases scored | 3 | 3 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 7 | 5.695 | -1.305 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.386667 | 0.27 | -0.116667 |  |
| Keyword query p50 (s) | 0.37 | 0.27 | -0.1 |  |
| Keyword query p95 (s) | 0.442 | 0.297 | -0.145 |  |
| Keyword query timed | 3 | 3 | 0 |  |
| Semantic query mean (s) | 0.43 | 0.32 | -0.11 |  |
| Semantic query p50 (s) | 0.44 | 0.3 | -0.14 |  |
| Semantic query p95 (s) | 0.467 | 0.363 | -0.104 |  |
| Semantic query timed | 3 | 3 | 0 |  |
| Keyword index (s) | 0.4 | 0.4 | 0 |  |
| Semantic index (s) | 0.4 | 0.7 | 0.3 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | warm | cold | — |  |
| Collector commit | 1002fa2-dirty | 1002fa2-dirty | — |  |
| AKM build | v0.9.0-beta.60-2842-gd0fe1d000 | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Keyword hit rate@5 % | 100 | 100 | 0 |  |
| Keyword judged nDCG@10 | 0.9833 | 0.9833 | 0 |  |
| Keyword MRR | 1 | 1 | 0 |  |
| Keyword precision@5 % | 40 | 40 | 0 |  |
| Keyword ranking · nDCG@10 | 0.9833 | 0.9833 | 0 |  |
| Keyword recall@10 % | 100 | 100 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic hit rate@5 % | 100 | 100 | 0 |  |
| Semantic judged nDCG@10 | 0.9907 | 0.9907 | 0 |  |
| Semantic MRR | 1 | 1 | 0 |  |
| Semantic precision@5 % | 40 | 40 | 0 |  |
| Semantic ranking · nDCG@10 | 0.9907 | 0.9907 | 0 |  |
| Semantic recall@10 % | 100 | 100 | 0 |  |
| Semantic results with judgments % | 100 | 100 | 0 |  |
| metrics.search.n | 3 | 3 | 0 |  |
| metrics.search.ndcg_10 | 0.9833 | 0.9833 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.9833 | 0.9833 | 0 |  |
| metrics.search.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.search.success_5 | 1 | 1 | 0 |  |
| metrics.search.mrr | 1 | 1 | 0 |  |
| metrics.search.recall_10 | 1 | 1 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.n | 3 | 3 | 0 |  |
| metrics.curate.ndcg_10 | 0.9833 | 0.9833 | 0 |  |
| metrics.curate.ndcg_10_condensed | 0.9833 | 0.9833 | 0 |  |
| metrics.curate.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.curate.success_5 | 1 | 1 | 0 |  |
| metrics.curate.mrr | 1 | 1 | 0 |  |
| metrics.curate.recall_10 | 1 | 1 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.n | 3 | 3 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.9907 | 0.9907 | 0 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.9907 | 0.9907 | 0 |  |
| metrics.semantic_search.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.semantic_search.success_5 | 1 | 1 | 0 |  |
| metrics.semantic_search.mrr | 1 | 1 | 0 |  |
| metrics.semantic_search.recall_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_curate.n | 3 | 3 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0.9907 | 0.9907 | 0 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.9907 | 0.9907 | 0 |  |
| metrics.semantic_curate.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.semantic_curate.success_5 | 1 | 1 | 0 |  |
| metrics.semantic_curate.mrr | 1 | 1 | 0 |  |
| metrics.semantic_curate.recall_10 | 1 | 1 | 0 |  |
| metrics.semantic_curate.judged_10 | 1 | 1 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-coordination-baseline/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000","build_fingerprint":"27acaf5fb46d44c59a877b6235f133257640308816a590b32a2f2690a32c325e"} | {"version":"0.10.261008","bin":"bun /tmp/akm-1200/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"ee2a2413ad961461adee19e8a3cda2c0d71380d02bb4d70bc4fe86c69d244009"} |
| semantic_index | warm | cold |
