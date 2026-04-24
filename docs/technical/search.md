# Search Architecture

Search uses a multi-signal scoring pipeline combining lexical matching, semantic
similarity, and relevance boosts to find the most useful assets for a query.

## Pipeline Overview

```
Query
  │
  ├─ FTS5 (lexical) ──────────────┐
  │   Multi-column BM25 with      │
  │   field weighting              │   Normalize + combine
  │                                ├──────────────────────── Score + Boost ── Sort ── Return
  └─ Vector (semantic) ───────────┘        0.7 FTS          │
      Cosine similarity via                0.3 Vec          │
      sqlite-vec or JS fallback                             │
                                                            │
                                              Boosts applied:
                                              • exact name match
                                              • type relevance
                                              • tag/alias/hint match
                                              • description match
                                              • metadata quality
                                              • usage history (M-2)
```

## Indexed Search (primary)

When an index exists (`~/.cache/akm/index.db`), local search uses two ranking
signals:

### 1. FTS5 (lexical)

SQLite full-text search with Porter stemming, using **multi-column field
weighting**. The FTS5 table has separate columns for different metadata fields,
each weighted differently in the BM25 scoring:

| Column | BM25 Weight | Contents |
| --- | --- | --- |
| `name` | 10.0 | Asset name |
| `description` | 5.0 | Description text |
| `tags` | 3.0 | Tags and aliases |
| `hints` | 2.0 | Search hints and examples |
| `content` | 1.0 | TOC headings, usage, intent, parameters |

A name match is weighted 10x higher than a content match. This ensures that
searching "docker" ranks the `docker-homelab` skill above a knowledge doc that
merely mentions Docker in its table of contents.

**Fuzzy/prefix fallback:** When the exact FTS5 query returns zero results, the
search automatically retries with prefix matching (appending `*` to tokens of
3+ characters). This handles partial terms and minor truncations.

### 2. Semantic (vector)

Cosine similarity between query embedding and stored entry embeddings.
Requires an embedding model — either local (`@huggingface/transformers`, default
model `bge-small-en-v1.5`) or a remote OpenAI-compatible endpoint.

An LRU cache (100 entries) avoids redundant embedding computation for repeated
queries.

### Score Normalization

FTS5 BM25 scores are negative (lower = better match). They are normalized to
a **0.3–1.0 range** using min-max normalization across the result set:

- Best FTS match → 1.0
- Worst FTS match → 0.3 (floor prevents zero-score entries)

When vector search is also active, scores are combined with weighted addition:

```
base_score = 0.7 × normalized_bm25 + 0.3 × cosine_similarity
```

**Design decision — why not RRF?** An earlier version used Reciprocal Rank
Fusion (RRF) to merge FTS and vector results. RRF uses rank positions instead
of raw scores, which avoids scale mismatch but destroys score differentiation.
With RRF (K=60), the best result scores 1/61 = 0.0164 and the 5th result
scores 1/65 = 0.0154 — a 6% difference that makes all results look equally
relevant. Normalized BM25 + weighted combination preserves the actual relevance
signal: the best match might score 1.0 while the 5th scores 0.45 — a 55%
difference that enables meaningful ranking. See the
[Scoring Design](#scoring-design) section below for the full rationale.

## Scoring Design

After normalization, multiplicative boosts are applied in a single pass:

```
final_score = base_score × (1 + sum_of_boosts)
```

### Boost signals (ordered by strength)

| Signal | Boost | When it fires |
| --- | --- | --- |
| Exact name match | +2.0 | Query exactly equals the asset's base name |
| Alias exact match | +1.5 | Query exactly matches a defined alias |
| Near-exact name | +1.0 | Query is a substring of the name or vice versa |
| Name token overlap | +0.3/token (max 0.9) | Individual query tokens found in name |
| Type: skill | +0.4 | Asset is a skill |
| Type: command | +0.35 | Asset is a command |
| Type: agent | +0.3 | Asset is an agent |
| Type: script | +0.2 | Asset is a script |
| Tag exact match | +0.15/tag (max 0.3) | Query token exactly matches a tag |
| All-token description | +0.25 | Every query token appears in description |
| Partial description | +0.1 | Some query tokens in description |
| Search hint match | +0.12/hint (max 0.24) | Query token found in a search hint |
| Alias token match | +0.3 | Query token found in any alias |
| Curated metadata | +0.05 | Non-generated metadata (quality signal) |
| Confidence | up to +0.05 | Based on metadata source reliability |
| Usage history (M-2) | up to +0.5 (capped 1.5×) | Utility score from usage telemetry |

### Design principles

**Exact name match is the strongest signal.** If a user types "docker-homelab",
the asset named `docker-homelab` must rank first with a decisive score gap.
This is the single most predictable and important ranking behavior.

**Actionable assets rank above reference material.** Skills, commands, and
agents are things you can execute or dispatch. Knowledge docs are reference
material — valuable but secondary when a user is searching for something to
use. The type boost encodes this hierarchy.

**Author-curated signals are stronger than auto-generated ones.** Tags,
aliases, and search hints are explicitly chosen by the asset author. They
carry more intent than terms that happen to appear in file content.

**Boosts are multiplicative on the base score.** This means a high base score
(strong FTS match) amplified by boosts produces a much larger gap than a low
base score with the same boosts. Highly relevant assets separate clearly from
marginally relevant ones.

### Worked example

Query: `"docker homelab"` → asset: `skill:docker-homelab`

```
Base BM25 (normalized):  1.0    (best FTS match in result set)
+ Name token overlap:    +0.6   (2 tokens match: "docker", "homelab")
+ Type boost (skill):    +0.4
+ Tag exact match:       +0.3   (tags "docker" and "homelab" both match)
+ Alias token match:     +0.3   (alias "docker-compose" contains "docker")
+ Search hint match:     +0.24  (hints contain "docker" and "homelab")
+ All-token description: +0.25  (all query tokens in description)
+ Curated quality:       +0.05
─────────────────────────────
BoostSum:                2.14
Final score:             1.0 × (1 + 2.14) = 3.14
```

Compare to a sub-reference knowledge doc for the same query:

```
Base BM25 (normalized):  0.85   (good FTS match but not the best)
+ Name token overlap:    +0.3   (1 token "homelab" in path-derived name)
+ Type boost:            +0.0   (knowledge docs get no type boost)
+ Tag match:             +0.15  (1 tag matches)
─────────────────────────────
BoostSum:                0.45
Final score:             0.85 × (1 + 0.45) = 1.23
```

The skill scores 3.14 vs the sub-reference at 1.23 — a 2.6× gap that clearly
communicates which result is more useful.

## Result Merging

### Local + provider merge (stash providers)

When additional stash providers (git, OpenViking) return results:

- **Local hits keep their original scores** from the pipeline above
- **Provider hits keep their original scores** and sort fairly alongside
  local hits by score descending
- **Duplicates** (same file path): local version wins, provider copy dropped
- **No score suppression** — provider results compete on equal footing

### Local + registry merge

When registry results (npm, skills.sh) are included (`--source both`):

- Same score-preserving approach as provider merge
- Local hits always rank above registry hits of equal apparent relevance
- Registry raw scores (which may be on a 0-100 scale) do not leak through

**Design decision — why not RRF for merging?** RRF was originally used here
to handle incompatible score scales between local and provider/registry
results. The problem is that RRF replaces ALL scores with rank-based values
(0.0164, 0.0161, 0.0159...), which destroys the differentiation from the
scoring pipeline. A skill scoring 3.14 and a noise result scoring 0.28 would
both become ~0.016 after RRF. The score-preserving merge keeps the 3.14 and
places provider noise below 0.28.

## Substring Fallback

When no index is available, search falls back to scanning the primary stash
plus any installed/cache-backed stash roots and filtering by substring match.
This ensures search always works, even before `akm index` has been run.

## Output Modes

### Standard output

By default (`--format json`, `--detail brief`), search emits minimal fields:
`type`, `name`, `action`, and `estimatedTokens`.

`--detail normal` adds `description`, `score`, `ref`, and `tags`.
`--detail full` adds `whyMatched`, `origin`, `path`, and timing data.
`--detail summary` returns metadata only (no content), under 200 tokens.

### Agent-optimized output

`--detail=agent` strips non-actionable fields, keeping only: `name`, `ref`,
`type`, `description`, `action`, `score`. (The pre-0.6.0 `--for-agent`
boolean is kept as a deprecated alias for one release cycle.)

`--format jsonl` outputs one JSON object per line for streaming consumption.

### Manifest

The manifest API (`akmManifest()`) returns a compact listing of all assets
(name, type, ref, description) — typically under 200 bytes per asset, enabling
cheap capability discovery without loading full content or running a search
query.

## Explainability

`whyMatched` explains which signals contributed to a hit's ranking. Examples:

- `"exact name match"` — query matched the asset name exactly
- `"skill type boost"` — asset is a skill (actionable)
- `"matched tags"` — query token matched a tag
- `"near-exact name match"` — query is a substring of the name
- `"usage history boost"` — utility score from M-2 telemetry

Visible in `--detail full` output.
