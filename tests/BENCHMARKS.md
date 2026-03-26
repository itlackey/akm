# Search Benchmarks & Ranking Regression Tests

This document explains the benchmark and test infrastructure for validating akm search quality, performance, and correctness.

## Quick Start

```bash
# Run the ranking regression tests (fast, deterministic)
bun test tests/ranking-regression.test.ts

# Run the full benchmark suite (standalone, detailed metrics)
bun run tests/benchmark-suite.ts

# Machine-readable benchmark output
bun run tests/benchmark-suite.ts --json
```

## What's in this directory

```
tests/
├── BENCHMARKS.md                  ← this file
├── benchmark-suite.ts             ← standalone benchmark (41 cases, 6 scenarios)
├── ranking-regression.test.ts     ← bun:test regression suite (35 tests)
└── ranking-fixtures/
    ├── config.json                ← sanitized test config
    └── stash/                     ← synthetic fixture stash (17 assets)
        ├── skills/                ← 4 skills (docker-homelab with sub-refs, svelte, k8s, code-review)
        ├── commands/              ← 2 commands (security-review, release-manager)
        ├── agents/                ← 2 agents (code-reviewer, svelte-expert)
        ├── scripts/               ← 3 scripts (mem0-search, deploy-check, docker-clean)
        └── knowledge/             ← 2 knowledge docs (skill-library-evolution, incident-response)
```

---

## Benchmark Suite (`benchmark-suite.ts`)

A standalone script that creates its own temporary stash, indexes it, and measures search quality and performance across 6 scenarios. It is NOT a bun:test — run it directly with `bun run`.

### How to run

```bash
# Human-readable summary on stderr, full JSON on stdout
bun run tests/benchmark-suite.ts

# JSON only (for CI, diffing, or piping)
bun run tests/benchmark-suite.ts --json

# Save results for comparison
bun run tests/benchmark-suite.ts --json > results-$(git rev-parse --short HEAD).json
```

### Scenarios

#### 1. Search Quality (`search_quality`)

Measures how well the search pipeline finds the right asset for a given query.

**Metrics:**

- **MRR (Mean Reciprocal Rank)** — average of `1/rank` across all test queries. MRR of 1.0 means every query found its expected result at rank 1. MRR of 0.5 means results average rank 2.
- **Recall@5** — fraction of queries where the expected result appears in the top 5. Should be 1.0.
- **Recall@10** — fraction of queries where the expected result appears in the top 10. Should be 1.0.

**15 test queries covering:**

- Exact keyword matches (name, tags, description)
- Partial/prefix matches ("kube" → k8s-deploy)
- Multi-word queries ("ci cd pipeline")
- Natural language intent ("renew ssl certificate")
- Cross-field weighting (name match vs description-only match)
- Parameter-based discovery ("docker image" → docker-build)

**How to read:** MRR ≥ 0.95 is excellent. If MRR drops below 0.90, a ranking regression has occurred. Check individual case results to find which queries degraded.

#### 2. Search Performance (`search_performance`)

Measures search latency in milliseconds.

**Metrics:**

- **cold_ms** — first query (no caches warm)
- **warm_ms** — repeated identical query (LRU cache hit)
- **fts_only_ms** — search with no embeddings
- **large_result_ms** — empty query returning all assets

**How to read:** All values should be under 10ms for the 30-asset test stash. If cold search exceeds 50ms, investigate. The warm/cold ratio indicates LRU cache effectiveness.

#### 3. Indexing Performance (`indexing_performance`)

Measures index build time in milliseconds.

**Metrics:**

- **full_ms** — full index build from empty DB
- **incremental_ms** — incremental index (no changes, should be faster)
- **fts_rebuild_ms** — FTS5 table rebuild only
- **recompute_utility_ms** — utility score recomputation from usage events

**How to read:** Incremental should be faster than full. FTS rebuild should be sub-millisecond for 30 assets. If `recompute_utility_ms` grows, the N+1 query fix may have regressed.

#### 4. Token Efficiency (`token_efficiency`)

Measures how much output size is reduced by new features.

**Metrics:**

- **summary_savings_pct** — `--detail summary` vs full show output (target: >60%)
- **manifest_bytes_per_asset** — bytes per asset in `akm manifest` (target: <200)
- **for_agent_savings_pct** — `--for-agent` vs normal output (target: >40%)
- **jsonl_savings_pct** — JSONL vs JSON format

**How to read:** Higher savings = more token-efficient for LLM agent consumers. If summary savings drops below 50%, the summary renderer may be leaking content.

#### 5. Utility Scoring (`utility_scoring`)

Validates the MemRL-pattern utility-based re-ranking.

**Tests:**

- **baseline_no_usage** — fresh index has no utility boosts (clean baseline)
- **boost_applied** — simulated usage events produce positive utility scores
- **decay_works** — old usage events contribute less than recent ones
- **cap_works** — extreme utility scores don't produce unbounded boosts

**How to read:** All should be `true`. If `boost_applied` is false, the telemetry → utility pipeline is broken.

#### 6. Feature Correctness (`feature_correctness`)

Validates that individual features work correctly.

**Tests:**

- Fuzzy/prefix fallback triggers for partial matches
- Field weighting: name matches outrank description-only matches
- Parameter extraction from `$ARGUMENTS` and `@param`
- `akm info` returns valid capability advertisement
- Feedback events are recorded in the database
- `buildSearchFields` produces correct per-field text
- FTS5 query sanitization neutralizes dangerous syntax
- Empty query returns all assets
- Type filtering works correctly
- Search results are deterministic

**How to read:** Any `false` value indicates a broken feature. Check the case's `details` field for specifics.

### Output format

```json
{
  "branch": "feat/searchImprovements",
  "commit": "abc1234",
  "timestamp": "2026-03-18T...",
  "asset_count": 30,
  "scenarios": {
    "search_quality": { "mrr": 0.97, "recall_at_5": 1, ... },
    "search_performance": { "cold_ms": 1.2, ... },
    ...
  },
  "summary": { "total_cases": 41, "passed": 41, "failed": 0 }
}
```

---

## Ranking Regression Tests (`ranking-regression.test.ts`)

A `bun:test` suite that validates ranking invariants using the synthetic fixture stash. These run as part of the regular test suite (`bun test ./tests`) and will catch regressions immediately.

### How to run

```bash
# Just the ranking tests
bun test tests/ranking-regression.test.ts

# As part of the full suite
bun test ./tests
```

### Test categories (35 tests)

#### Score Differentiation (5 tests)

Validates that the right asset ranks highest for common queries.

- "docker homelab" → `skill:docker-homelab` in top 3
- "docker" → docker-related assets appear
- "svelte component" → `skill:svelte-components` at rank 1
- "code review" → commands/agents above knowledge docs
- "mem0 search" → `script:mem0-search` at rank 1

**Why this matters:** The most common failure mode is skills being buried under their own sub-reference knowledge docs, or irrelevant context-hub results interleaving with local hits.

#### Exact/Near-exact Name Matching (5 tests)

Validates that querying an asset by its exact name always returns it at rank 1.

- "mem0-search" → rank 1
- "security-review" → rank 1
- "k8s-deploy" → rank 1
- "code-reviewer" → rank 1
- Exact match score > 2x the next result

**Why this matters:** If a user types the exact name of an asset, that asset must be #1 with a clear score gap. This catches regressions in the exact-name-match boost.

#### Type Ranking (2 tests)

Validates that actionable assets rank above passive reference material.

- "deploy" → skills/commands/scripts above knowledge docs
- "review" → agents/commands above knowledge docs

**Why this matters:** When a user searches for "deploy", they want something they can execute, not a reference doc that mentions deployment in passing.

#### Fuzzy/Prefix Matching (3 tests)

Validates that partial terms and aliases find the right assets.

- "kube" → finds k8s-deploy via alias
- "dock" → finds docker-homelab via prefix
- "incident" → finds the runbook

**Why this matters:** Users don't always type exact names. Aliases, abbreviations, and partial terms must work.

#### Score Preservation (4 tests)

Validates that the scoring pipeline produces meaningful, differentiated scores.

- Top result score > 0.5 (not capped at 0.016 from old RRF)
- Score gap between #1 and #5 > 50%
- Scores are monotonically decreasing
- Score range is meaningful (not compressed)

**Why this matters:** This catches the most critical regression — the score flattening bug where RRF or provider merging destroys differentiation, making all results look equally relevant.

#### Provider Merge (4 tests)

Validates that merging local and provider results preserves local score quality.

- Local scores unchanged after merge
- Provider-only hits rank below local hits
- Duplicates are removed (local version wins)
- Sort order preserved

**Why this matters:** When context-hub or OpenViking providers add results, they must not flatten or displace well-ranked local results.

#### Cross-type Search Consistency (4 tests)

Validates search works across asset types and narrows correctly with multi-word queries.

#### Metadata Signal Strength (5 tests)

Validates that tags, hints, aliases, and quality metadata actually contribute to ranking.

#### Edge Cases (3 tests)

Empty query, non-matching query, single character query.

---

## Fixture Stash (`ranking-fixtures/stash/`)

A synthetic stash with 17 carefully designed assets that mirror the structure of a real akm stash. Each asset has curated `.stash.json` metadata.

### Design principles

1. **Skills have sub-references** — `docker-homelab/` contains the SKILL.md plus `references/` with 4 knowledge docs. This tests the critical scenario where sub-references must not outrank the parent skill.

2. **Overlapping terms** — multiple assets contain "docker", "deploy", "review" etc. in different fields (name, tags, description, hints). This tests field weighting and type boosting.

3. **Varied metadata quality** — some assets have rich metadata (tags, aliases, searchHints, descriptions), others are sparse. This tests how the scoring pipeline handles incomplete data.

4. **All asset types represented** — skills, commands, agents, scripts, knowledge. This tests type-based ranking.

5. **Aliases and searchHints** — k8s-deploy has aliases ["kube", "k8s"]. docker-homelab has alias ["docker-compose"]. This tests alias matching.

### Adding new fixtures

To add a new test asset:

1. Create the file in the appropriate type directory
2. Add a `.stash.json` in the parent directory with curated metadata
3. Add test cases in `ranking-regression.test.ts` that validate the expected ranking behavior
4. Run `bun test tests/ranking-regression.test.ts` to verify

---

## How the Scoring Pipeline Works

Understanding the scores in benchmark output:

```
Score = NormalizedBM25 × (1 + BoostSum)
```

### Base score: Normalized BM25 (0.3 – 1.0)

FTS5 returns negative BM25 scores (lower = better match). These are normalized to a 0.3–1.0 range using min-max normalization across the result set. The best FTS match gets 1.0, the worst gets 0.3.

When vector search is also active, scores are combined: `0.7 × FTS + 0.3 × vector`.

### Boosts (multiplicative on base score)

| Boost | Value | Trigger |
|-------|-------|---------|
| Exact name match | +2.0 | Query exactly equals asset name |
| Near-exact name | +1.0 | Query is substring of name or vice versa |
| Name token overlap | +0.3/token (max 0.9) | Query tokens found in name |
| Alias exact match | +1.5 | Query matches an alias exactly |
| Alias token match | +0.3 | Query token found in an alias |
| Type: skill | +0.4 | Asset is a skill |
| Type: command | +0.35 | Asset is a command |
| Type: agent | +0.3 | Asset is an agent |
| Type: script | +0.2 | Asset is a script |
| Tag exact match | +0.15/tag (max 0.3) | Query token exactly matches a tag |
| Search hint match | +0.12/hint (max 0.24) | Query token found in a search hint |
| All-token description | +0.25 | All query tokens appear in description |
| Partial description | +0.1 | Some query tokens in description |
| Curated quality | +0.05 | Non-generated metadata |
| Confidence | +0.05 max | Based on metadata source |
| Utility (MemRL) | up to +0.5 (capped 1.5×) | Usage history signal |

### Example score breakdown

Query: "docker homelab" → `skill:docker-homelab`

```
Base BM25 (normalized):  1.0    (best FTS match)
+ Name token overlap:    +0.6   (2 tokens match: "docker", "homelab")
+ Type boost (skill):    +0.4
+ Tag exact match:       +0.3   (tags "docker" and "homelab" both match)
+ Alias token match:     +0.3   (alias "docker-compose" contains "docker")
+ Search hint match:     +0.24  (hints contain "docker" and "homelab")
+ Description match:     +0.25  (all query tokens in description)
+ Curated quality:       +0.05
─────────────────────────────
BoostSum:                2.14
Final score:             1.0 × (1 + 2.14) = 3.14
```

### Provider merge behavior

When additional providers (context-hub, OpenViking) return results:

- **Local hits keep their original scores** from the pipeline above
- **Provider-only hits** are scored below the lowest local hit
- **Duplicates** (same path): local version wins, provider copy dropped
- This prevents provider noise from displacing well-ranked local results

---

## CI Integration

Add to your CI pipeline:

```bash
# Fail if any ranking regression test breaks
bun test tests/ranking-regression.test.ts

# Fail if benchmark MRR drops below threshold
bun run tests/benchmark-suite.ts --json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d['scenarios']['search_quality']['mrr'] >= 0.90 else 1)"
```

---

## Comparing branches

```bash
# Save current branch results
bun run tests/benchmark-suite.ts --json > bench-feat.json

# Switch to main and run
git stash && git checkout main
bun run tests/benchmark-suite.ts --json > bench-main.json
git checkout - && git stash pop

# Compare
python3 -c "
import json
feat = json.load(open('bench-feat.json'))
main = json.load(open('bench-main.json'))
for s in feat['scenarios']:
    fm = {k:v for k,v in feat['scenarios'][s].items() if k != 'cases'}
    mm = {k:v for k,v in main['scenarios'][s].items() if k != 'cases'}
    print(f'\n{s}:')
    for k in fm:
        if k in mm:
            print(f'  {k}: {mm[k]} → {fm[k]}')
"
```

Note: the benchmark uses feat-branch-only features (manifest, info, feedback, utility scoring), so it won't run on branches that don't have these. Use the ranking regression tests for cross-branch comparison since they test only the core search pipeline.
