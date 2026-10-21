# retrieval · eval 0.3 · scoring 0.3

A: 1199-public-baseline-rescored (/tmp/akm-eval-1199/evals/retrieval/results/2026-10-21-1199-public-baseline-library-rescored)
B: 1199-public-matched-rescored (/tmp/akm-eval-1199/evals/retrieval/results/2026-10-21-1199-public-matched-library-rescored)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | 1199-public-baseline-rescored | 1199-public-matched-rescored | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | library | library | — |  |
| Collected (UTC) | 2026-10-21T04:26:39.402Z | 2026-10-21T04:31:01.916Z | — |  |
| Quality % | 75.65 | 75.65 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 101 | 101 | 0 |  |
| Cases recorded | 136 | 136 | 0 |  |
| Cases scored | 136 | 136 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 189.222 | 184.409 | -4.813 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.261691 | 0.260809 | -0.000882 |  |
| Keyword query p50 (s) | 0.24 | 0.24 | 0 |  |
| Keyword query p95 (s) | 0.3825 | 0.4175 | 0.035 |  |
| Keyword query timed | 136 | 136 | 0 |  |
| Semantic query mean (s) | 0.328824 | 0.304412 | -0.024412 |  |
| Semantic query p50 (s) | 0.29 | 0.28 | -0.01 |  |
| Semantic query p95 (s) | 0.4425 | 0.455 | 0.0125 |  |
| Semantic query timed | 136 | 136 | 0 |  |
| Keyword index (s) | 0.5 | 0.6 | 0.1 |  |
| Semantic index (s) | 11.9 | 11.6 | -0.3 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.3 | 0.3 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | cold | cold | — |  |
| Collector commit | 27f5240-dirty | 27f5240-dirty | — |  |
| Keyword hit rate@5 % | 97.03 | 97.03 | 0 |  |
| Keyword judged nDCG@10 | 0.7565 | 0.7565 | 0 |  |
| Keyword MRR | 0.9109 | 0.9109 | 0 |  |
| Keyword precision@5 % | 55.05 | 55.05 | 0 |  |
| Keyword ranking · nDCG@10 | 0.7565 | 0.7565 | 0 |  |
| Keyword recall@10 % | 74.4 | 74.4 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic hit rate@5 % | 98.02 | 98.02 | 0 |  |
| Semantic judged nDCG@10 | 0.8235 | 0.8217 | -0.0018 |  |
| Semantic MRR | 0.9561 | 0.9561 | 0 |  |
| Semantic precision@5 % | 60.4 | 60.4 | 0 |  |
| Semantic ranking · nDCG@10 | 0.8196 | 0.8179 | -0.0017 |  |
| Semantic recall@10 % | 80.93 | 80.4 | -0.53 |  |
| Semantic results with judgments % | 82.28 | 82.87 | 0.59 |  |
| metrics.search.n | 101 | 101 | 0 |  |
| metrics.search.ndcg_10 | 0.7565 | 0.7565 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.7565 | 0.7565 | 0 |  |
| metrics.search.p_5 | 0.5505 | 0.5505 | 0 |  |
| metrics.search.success_5 | 0.9703 | 0.9703 | 0 |  |
| metrics.search.mrr | 0.9109 | 0.9109 | 0 |  |
| metrics.search.recall_10 | 0.744 | 0.744 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.n | 101 | 101 | 0 |  |
| metrics.curate.ndcg_10 | 0.7565 | 0.7565 | 0 |  |
| metrics.curate.ndcg_10_condensed | 0.7565 | 0.7565 | 0 |  |
| metrics.curate.p_5 | 0.5505 | 0.5505 | 0 |  |
| metrics.curate.success_5 | 0.9703 | 0.9703 | 0 |  |
| metrics.curate.mrr | 0.9109 | 0.9109 | 0 |  |
| metrics.curate.recall_10 | 0.744 | 0.744 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.n | 101 | 101 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.8196 | 0.8179 | -0.0017 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.8235 | 0.8217 | -0.0018 |  |
| metrics.semantic_search.p_5 | 0.604 | 0.604 | 0 |  |
| metrics.semantic_search.success_5 | 0.9802 | 0.9802 | 0 |  |
| metrics.semantic_search.mrr | 0.9561 | 0.9561 | 0 |  |
| metrics.semantic_search.recall_10 | 0.8093 | 0.804 | -0.0053 |  |
| metrics.semantic_search.judged_10 | 0.8228 | 0.8287 | 0.0059 |  |
| metrics.semantic_curate.n | 101 | 101 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0.819 | 0.8159 | -0.0031 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.8231 | 0.8199 | -0.0032 |  |
| metrics.semantic_curate.p_5 | 0.604 | 0.6059 | 0.0019 |  |
| metrics.semantic_curate.success_5 | 0.9802 | 0.9802 | 0 |  |
| metrics.semantic_curate.mrr | 0.9561 | 0.9511 | -0.005 |  |
| metrics.semantic_curate.recall_10 | 0.8093 | 0.802 | -0.0073 |  |
| metrics.semantic_curate.judged_10 | 0.8228 | 0.8267 | 0.0039 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1199-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/1199-matched.ts","build":null,"build_fingerprint":null} |
