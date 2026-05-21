# akm-eval — improve-smoke — `baseline`

**Run ID:** `2026-05-22T00-09-36-165Z-45efc0dd`
**Started:** 2026-05-22T00:09:36.324Z
**Duration:** 3.10s
**akm version:** `0.8.0`
**Stash:** `/home/founder3/code/github/itlackey/akm/.claude/worktrees/agent-accd0a5c55f553e16/docs/example-stash`

## Scores

| Score | Value |
| --- | ---: |
| Overall | 1.000 |
| Deterministic | 1.000 |

## Cases by type

| Type | Run | Passed | Skipped |
| --- | ---: | ---: | ---: |
| retrieval | 5 | 5 | 0 |
| proposal-quality | 0 | 0 | 3 |
| planner-waste | 0 | 0 | 2 |

## Accept-rate by source

| Source | Total | Accepted | Rejected | Accept-rate |
| --- | ---: | ---: | ---: | ---: |

## Case results

| Case | Type | Score | Status |
| --- | --- | ---: | --- |
| `planner-waste-breakdown` | planner-waste | 1.000 | skipped (no improve runs under /home/founder3/code/github/itlackey/akm/.claude/worktrees/agent-accd0a5c55f553e16/docs/example-stash/.akm/runs) |
| `planner-waste-rate-ceiling` | planner-waste | 1.000 | skipped (only 0 action(s) across 0 run(s); minActions=50) |
| `proposal-accept-rate-floor` | proposal-quality | 1.000 | skipped (no proposal traffic in window) |
| `proposal-metrics-snapshot` | proposal-quality | 1.000 | skipped (no proposal traffic in window) |
| `proposal-validation-floor` | proposal-quality | 1.000 | skipped (no proposal traffic in window) |
| `retrieval-deploy-keywords` | retrieval | 1.000 | pass |
| `retrieval-improve-keywords` | retrieval | 1.000 | pass |
| `retrieval-release-keywords` | retrieval | 1.000 | pass |
| `retrieval-search-returns-hits` | retrieval | 1.000 | pass |
| `retrieval-skill-type-filter` | retrieval | 1.000 | pass |

## Artifacts

- evalResult: `eval-result.json`
- caseResults: `case-results.jsonl`
- markdownReport: `report.md`
