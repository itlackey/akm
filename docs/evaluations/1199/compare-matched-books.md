# retrieval · eval 0.3 · scoring 0.3

A: 1199-public-baseline-rescored (/tmp/akm-eval-1199/evals/retrieval/results/2026-10-21-1199-public-baseline-books-rescored)
B: 1199-public-matched-rescored (/tmp/akm-eval-1199/evals/retrieval/results/2026-10-21-1199-public-matched-books-rescored)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | 1199-public-baseline-rescored | 1199-public-matched-rescored | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | books | books | — |  |
| Collected (UTC) | 2026-10-21T04:27:57.473Z | 2026-10-21T04:32:02.884Z | — |  |
| Quality % | 82.43 | 82.43 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 51 | 51 | 0 |  |
| Cases recorded | 51 | 51 | 0 |  |
| Cases scored | 51 | 51 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 78.058 | 60.965 | -17.093 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.300588 | 0.220784 | -0.079804 |  |
| Keyword query p50 (s) | 0.28 | 0.22 | -0.06 |  |
| Keyword query p95 (s) | 0.415 | 0.25 | -0.165 |  |
| Keyword query timed | 51 | 51 | 0 |  |
| Semantic query mean (s) | 0.350588 | 0.261569 | -0.08902 |  |
| Semantic query p50 (s) | 0.33 | 0.25 | -0.08 |  |
| Semantic query p95 (s) | 0.52 | 0.3 | -0.22 |  |
| Semantic query timed | 51 | 51 | 0 |  |
| Keyword index (s) | 0.7 | 0.3 | -0.4 |  |
| Semantic index (s) | 3.8 | 5.6 | 1.8 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.3 | 0.3 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | cold | cold | — |  |
| Collector commit | 27f5240-dirty | 27f5240-dirty | — |  |
| Keyword banned result above first relevant % | 17.65 | 17.65 | 0 |  |
| Keyword banned result above relevant % | 35.29 | 35.29 | 0 |  |
| Keyword hit rate@5 % | 100 | 100 | 0 |  |
| Keyword judged nDCG@10 | 0.8243 | 0.8243 | 0 |  |
| Keyword MRR | 0.8954 | 0.8954 | 0 |  |
| Keyword precision@5 % | 40 | 40 | 0 |  |
| Keyword ranking · nDCG@10 | 0.8243 | 0.8243 | 0 |  |
| Keyword recall@10 % | 92.23 | 92.23 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic banned result above first relevant % | 7.84 | 7.84 | 0 |  |
| Semantic banned result above relevant % | 23.53 | 23.53 | 0 |  |
| Semantic hit rate@5 % | 98.04 | 98.04 | 0 |  |
| Semantic judged nDCG@10 | 0.9013 | 0.9015 | 0.0002 |  |
| Semantic MRR | 0.9534 | 0.9534 | 0 |  |
| Semantic precision@5 % | 44.71 | 45.1 | 0.39 |  |
| Semantic ranking · nDCG@10 | 0.8988 | 0.8989 | 0.0001 |  |
| Semantic recall@10 % | 98.49 | 98.49 | 0 |  |
| Semantic results with judgments % | 88.63 | 88.63 | 0 |  |
| metrics.search.n | 51 | 51 | 0 |  |
| metrics.search.ndcg_10 | 0.8243 | 0.8243 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.8243 | 0.8243 | 0 |  |
| metrics.search.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.search.success_5 | 1 | 1 | 0 |  |
| metrics.search.mrr | 0.8954 | 0.8954 | 0 |  |
| metrics.search.recall_10 | 0.9223 | 0.9223 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.search.banned_above | 0.3529 | 0.3529 | 0 |  |
| metrics.search.banned_above_first | 0.1765 | 0.1765 | 0 |  |
| metrics.curate.n | 51 | 51 | 0 |  |
| metrics.curate.ndcg_10 | 0.8243 | 0.8243 | 0 |  |
| metrics.curate.ndcg_10_condensed | 0.8243 | 0.8243 | 0 |  |
| metrics.curate.p_5 | 0.4 | 0.4 | 0 |  |
| metrics.curate.success_5 | 1 | 1 | 0 |  |
| metrics.curate.mrr | 0.8954 | 0.8954 | 0 |  |
| metrics.curate.recall_10 | 0.9223 | 0.9223 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.banned_above | 0.3529 | 0.3529 | 0 |  |
| metrics.curate.banned_above_first | 0.1765 | 0.1765 | 0 |  |
| metrics.semantic_search.n | 51 | 51 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.8988 | 0.8989 | 0.0001 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.9013 | 0.9015 | 0.0002 |  |
| metrics.semantic_search.p_5 | 0.4471 | 0.451 | 0.0039 |  |
| metrics.semantic_search.success_5 | 0.9804 | 0.9804 | 0 |  |
| metrics.semantic_search.mrr | 0.9534 | 0.9534 | 0 |  |
| metrics.semantic_search.recall_10 | 0.9849 | 0.9849 | 0 |  |
| metrics.semantic_search.judged_10 | 0.8863 | 0.8863 | 0 |  |
| metrics.semantic_search.banned_above | 0.2353 | 0.2353 | 0 |  |
| metrics.semantic_search.banned_above_first | 0.0784 | 0.0784 | 0 |  |
| metrics.semantic_curate.n | 51 | 51 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0.899 | 0.8987 | -0.0003 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.9015 | 0.9011 | -0.0004 |  |
| metrics.semantic_curate.p_5 | 0.4471 | 0.451 | 0.0039 |  |
| metrics.semantic_curate.success_5 | 0.9804 | 0.9804 | 0 |  |
| metrics.semantic_curate.mrr | 0.9534 | 0.9534 | 0 |  |
| metrics.semantic_curate.recall_10 | 0.9849 | 0.9849 | 0 |  |
| metrics.semantic_curate.judged_10 | 0.8863 | 0.8863 | 0 |  |
| metrics.semantic_curate.banned_above | 0.2353 | 0.2353 | 0 |  |
| metrics.semantic_curate.banned_above_first | 0.0784 | 0.0784 | 0 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-1199-baseline/src/cli.ts","build":null,"build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/1199-matched.ts","build":null,"build_fingerprint":null} |
