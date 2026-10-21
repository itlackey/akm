# retrieval · eval 0.2 · scoring 0.3

A: issue1198-baseline-full-rescored (/tmp/akm-coordination-eval/evals/retrieval/results/2026-10-21-issue1198-baseline-full-library-rescored)
B: issue1198-candidate-full-rescored (/tmp/akm-coordination-eval/evals/retrieval/results/2026-10-21-issue1198-candidate-full-library-rescored)

Stored results. Delta is B minus A; percentage deltas are percentage points. No statistical winner is inferred.


| Metric / setting | A | B | Delta (B − A) | Note |
|---|---:|---:|---:|---|
| Run | issue1198-baseline-full-rescored | issue1198-candidate-full-rescored | — |  |
| Test | retrieval | retrieval | — |  |
| Collection | library | library | — |  |
| Collected (UTC) | 2026-10-21T03:17:23.870Z | 2026-10-21T03:25:49.542Z | — |  |
| Quality % | 75.68 | 75.68 | 0 |  |
| Quality metric | Keyword ranking · nDCG@10 | Keyword ranking · nDCG@10 | — |  |
| Quality cases | 101 | 101 | 0 |  |
| Cases recorded | 136 | 136 | 0 |  |
| Cases scored | 136 | 136 | 0 |  |
| Errors | 0 | 0 | 0 |  |
| Timeouts | 0 | 0 | 0 |  |
| Run wall time (s) | 161.671 | 286.115 | 124.444 |  |
| Run wall time basis | Runner elapsed | Runner elapsed | — |  |
| Keyword query mean (s) | 0.243088 | 0.429926 | 0.186838 |  |
| Keyword query p50 (s) | 0.22 | 0.39 | 0.17 |  |
| Keyword query p95 (s) | 0.3425 | 0.815 | 0.4725 |  |
| Keyword query timed | 136 | 136 | 0 |  |
| Semantic query mean (s) | 0.291765 | 0.49875 | 0.206985 |  |
| Semantic query p50 (s) | 0.28 | 0.465 | 0.185 |  |
| Semantic query p95 (s) | 0.4125 | 0.8225 | 0.41 |  |
| Semantic query timed | 136 | 136 | 0 |  |
| Keyword index (s) | 0.8 | 0.9 | 0.1 |  |
| Semantic index (s) | 0.3 | 0.3 | 0 |  |
| AKM version | 0.10.261008 | 0.10.261008 | — |  |
| Eval version | 0.2 | 0.2 | — |  |
| Scoring version | 0.3 | 0.3 | — |  |
| Search methods | keyword; semantic | keyword; semantic | — |  |
| Embedding model | embed/qwen3-embedding-0.6b | embed/qwen3-embedding-0.6b | — |  |
| Retrieval depth | 10 | 10 | 0 |  |
| Semantic index state | warm | warm | — |  |
| Collector commit | 1002fa2-dirty | 1002fa2-dirty | — |  |
| AKM build | v0.9.0-beta.60-2842-gd0fe1d000 | v0.9.0-beta.60-2842-gd0fe1d000-dirty | — |  |
| Keyword hit rate@5 % | 97.03 | 97.03 | 0 |  |
| Keyword judged nDCG@10 | 0.7568 | 0.7568 | 0 |  |
| Keyword MRR | 0.9109 | 0.9109 | 0 |  |
| Keyword precision@5 % | 55.05 | 55.05 | 0 |  |
| Keyword ranking · nDCG@10 | 0.7568 | 0.7568 | 0 |  |
| Keyword recall@10 % | 74.4 | 74.4 | 0 |  |
| Keyword results with judgments % | 100 | 100 | 0 |  |
| Semantic hit rate@5 % | 98.02 | 98.02 | 0 |  |
| Semantic judged nDCG@10 | 0.8215 | 0.8183 | -0.0032 |  |
| Semantic MRR | 0.9561 | 0.9511 | -0.005 |  |
| Semantic precision@5 % | 60.59 | 60.4 | -0.19 |  |
| Semantic ranking · nDCG@10 | 0.8177 | 0.8143 | -0.0034 |  |
| Semantic recall@10 % | 80.26 | 80.42 | 0.16 |  |
| Semantic results with judgments % | 82.18 | 82.57 | 0.39 |  |
| metrics.search.n | 101 | 101 | 0 |  |
| metrics.search.ndcg_10 | 0.7568 | 0.7568 | 0 |  |
| metrics.search.ndcg_10_condensed | 0.7568 | 0.7568 | 0 |  |
| metrics.search.p_5 | 0.5505 | 0.5505 | 0 |  |
| metrics.search.success_5 | 0.9703 | 0.9703 | 0 |  |
| metrics.search.mrr | 0.9109 | 0.9109 | 0 |  |
| metrics.search.recall_10 | 0.744 | 0.744 | 0 |  |
| metrics.search.judged_10 | 1 | 1 | 0 |  |
| metrics.curate.n | 101 | 101 | 0 |  |
| metrics.curate.ndcg_10 | 0.7568 | 0.7568 | 0 |  |
| metrics.curate.ndcg_10_condensed | 0.7568 | 0.7568 | 0 |  |
| metrics.curate.p_5 | 0.5505 | 0.5505 | 0 |  |
| metrics.curate.success_5 | 0.9703 | 0.9703 | 0 |  |
| metrics.curate.mrr | 0.9109 | 0.9109 | 0 |  |
| metrics.curate.recall_10 | 0.744 | 0.744 | 0 |  |
| metrics.curate.judged_10 | 1 | 1 | 0 |  |
| metrics.semantic_search.n | 101 | 101 | 0 |  |
| metrics.semantic_search.ndcg_10 | 0.8177 | 0.8143 | -0.0034 |  |
| metrics.semantic_search.ndcg_10_condensed | 0.8215 | 0.8183 | -0.0032 |  |
| metrics.semantic_search.p_5 | 0.6059 | 0.604 | -0.0019 |  |
| metrics.semantic_search.success_5 | 0.9802 | 0.9802 | 0 |  |
| metrics.semantic_search.mrr | 0.9561 | 0.9511 | -0.005 |  |
| metrics.semantic_search.recall_10 | 0.8026 | 0.8042 | 0.0016 |  |
| metrics.semantic_search.judged_10 | 0.8218 | 0.8257 | 0.0039 |  |
| metrics.semantic_curate.n | 101 | 101 | 0 |  |
| metrics.semantic_curate.ndcg_10 | 0.8183 | 0.8153 | -0.003 |  |
| metrics.semantic_curate.ndcg_10_condensed | 0.822 | 0.8195 | -0.0025 |  |
| metrics.semantic_curate.p_5 | 0.6059 | 0.6059 | 0 |  |
| metrics.semantic_curate.success_5 | 0.9802 | 0.9802 | 0 |  |
| metrics.semantic_curate.mrr | 0.9561 | 0.9511 | -0.005 |  |
| metrics.semantic_curate.recall_10 | 0.804 | 0.8061 | 0.0021 |  |
| metrics.semantic_curate.judged_10 | 0.8238 | 0.8267 | 0.0029 |  |
| status | complete | complete | — |  |

Changed settings:

| Setting | A | B |
|---|---|---|
| akm | {"version":"0.10.261008","bin":"bun /tmp/akm-coordination-baseline/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000","build_fingerprint":null} | {"version":"0.10.261008","bin":"bun /tmp/akm-1198/src/cli.ts","build":"v0.9.0-beta.60-2842-gd0fe1d000-dirty","build_fingerprint":"01f5ff41622a6eeef5e7d2976c9be350ab6ed184ae1b95034ade342dd65bffe1"} |

