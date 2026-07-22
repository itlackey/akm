# Curate Workmap

## When To Read This

Read this before changing `akm curate` ranking, fallback, follow-up generation, or agent-facing output.

This page is the shortest path to understanding:
- how `akm curate` currently works
- which tests pin that behavior
- where the current implementation diverges from intended product behavior
- what fix direction has the strongest support from recent review

## Debate Outcome

Recent multi-agent review converged on the same conclusion:

- `curate` should be relevance-first, not diversity-first
- search ranking should remain the backbone of the shortlist
- type diversity should be a soft preference for later slots, not a hard override
- fallback search should run when the initial result set is weak or noisy, not only when it is empty
- `followUp` should become more action-aware over time, but ranking/fallback correctness comes first

Recommended fix order:

1. Make curate selection score-first and diversity-second.
2. Relax fallback suppression so one weak phrase hit does not block token fallback.
3. Revisit follow-up generation after ranking quality improves.

Additional debate outcome:

- simple type-aware reranking is useful only as a thin post-search correction layer
- root-vs-derived asset families should usually be collapsed to one representative in the top-level shortlist
- graph data is better suited for attached support refs or navigation hints than for primary reranking in the first iteration

## Current Curate Contract

- CLI entry lives in `src/commands/read/search-cli.ts`.
- Public entry point is `akmCurate()` in `src/commands/read/curate.ts`.
- Default curated limit is `4`.
- Default search source is `stash`.
- Curate fetches more search hits than it returns: `limit * 4`, minimum `12`.
- `--type <type>` bypasses diversification and returns top hits of that type.
- Default multi-type curate currently keeps one best hit per type, then reorders types using regex heuristics.
- Registry hits only fill leftover slots and are capped at `2`.
- Stash items are enriched via `akmShowUnified()` best-effort.
- Stash `followUp` is always `akm show <ref>` today.
- Curate logs both a summary event and per-item retrieval rows for stash refs.

## Execution Path

Read these first:

- `src/commands/read/search-cli.ts`
- `src/commands/read/curate.ts`
- `src/output/shapes/curate.ts`
- `src/output/text/helpers.ts`
- `src/commands/read/search.ts`
- `src/commands/read/show.ts`

Key functions in `src/commands/read/curate.ts`:

- `akmCurate()`
- `searchForCuration()`
- `deriveCurateFallbackQueries()`
- `mergeCurateSearchResponses()`
- `curateSearchResults()`
- `orderCuratedTypes()`
- `enrichCuratedStashHit()`

## Ranking And Selection Rules

Current behavior:

- Search returns scored, ordered hits.
- Curate then discards most of that ordering by taking the first hit per type.
- Those per-type winners are reordered using query regex boosts such as `deploy`, `review`, `guide`, `agent`, and `memory`.
- This can promote obviously lower-score items above much stronger hits.

Why this is a problem:

- search already has strong ranking tests and should remain the primary relevance signal
- current curate can surface irrelevant filler to satisfy type variety
- users experience curate as a flagship shortlist, so wrong top results damage trust more than low variety does

Preferred direction:

- preserve top-ranked overall hits first
- allow diversity only when alternatives are close in score and plausibly relevant
- keep explicit `--type` behavior unchanged

Small type-aware corrections that are considered in-bounds:

- prefer runnable `script` / concrete `command` over similarly scored `memory` for execution-heavy queries
- prefer `workflow` / `skill` over adjacent explanation docs for multi-step task queries
- include `agent` mainly for explicit delegation / persona / prompt-building queries
- keep `memory` for recall/context queries, not as generic filler

Corrections that are currently considered too risky:

- hard one-per-type quotas
- large hand-authored type matrices
- LLM reranking
- blanket demotion of `memory` or `agent` as types

## Asset Families

Curate should think in terms of asset families, not just isolated types.

Practical examples in this repo:

- `skills/docker-homelab`
- `knowledge/skills/docker-homelab/references/compose`

Desired behavior:

- broad query like `docker homelab` -> prefer the root asset
- narrow query like `docker compose reference` -> prefer the child reference page
- if both are useful, attach the weaker sibling as support instead of spending two top-level slots by default

This should start as an explicit structural heuristic, not semantic lineage inference.

## Fallback Search Behavior

Current behavior:

- `searchForCuration()` only runs fallback token searches when the initial query returns zero hits
- if the initial query returns even one weak or irrelevant hit, fallback does not run
- fallback token extraction removes filler words, dedupes tokens, drops tokens shorter than 3 chars, and caps the set at 6
- fallback is also skipped when normalization leaves only one usable token

Why this is a problem:

- one weak phrase hit can block much better token hits
- prompt-style queries like `the docker` do not get the obvious one-token fallback
- meaningful short tokens such as `ai`, `ci`, `cd`, `go`, `js`, or `ts` are lost today

Preferred direction:

- suppress fallback only when the initial result set is actually strong enough
- allow one-token fallback when that token is clearly the meaningful residue of a prompt-style query
- preserve a narrow allowlist of meaningful short tokens

## Enrichment And Follow-Up Fields

Current behavior:

- curate enriches stash hits by calling `akmShowUnified({ ref })`
- if show fails, enrichment silently degrades to raw search-hit data
- stash follow-up remains `akm show <ref>` even for runnable scripts with a concrete `run`
- registry follow-up uses the registry action, usually `akm add ...`

Product implication:

- output is inspect-first, not act-first
- this is acceptable for now, but becomes more visible once result quality improves

For agent consumers, the desired optimization order is:

- actionability
- relevance
- low duplication / root-asset preference
- navigability
- type diversity

## Output Shape And Formatting

Read:

- `src/output/shapes/curate.ts`
- `src/output/text/helpers.ts`

Important details:

- `curate` has a dedicated output shaper now
- `brief` still keeps `followUp` and `reason`
- `--shape agent` trims fields down for agent use
- `--shape summary` is rejected on `curate`
- text output prints fixed `Next steps:` guidance that assumes `akm show <ref>` is the next action

## Telemetry And Retrieval Signal

Read:

- `src/commands/read/curate.ts`
- `tests/get-retrieval-counts.test.ts`

Important detail:

- curate writes per-item `usage_events` rows for stash refs so curated items count as retrieval signal

This means ranking changes do not just affect UX. They also affect downstream improvement-loop evidence.

## Graph Leverage

Existing graph signal:

- there is no first-class asset->asset edge table
- asset relatedness is already derivable via shared-entity overlap
- `listRelatedPathsForFile()` in `src/indexer/graph/graph-boost.ts` returns related assets with `ref`, `type`, `sharedEntities`, and `relationCount`
- `akm show` already exposes a lightweight `related` block using that signal

Limits:

- graph coverage depends on graph extraction having run
- graph is thin or absent on cold stashes
- graph quality is uneven and generic entities can over-connect assets
- graph coverage is strongest for `knowledge` / `memory` and should not be assumed for every asset family

Recommended first graph-aware use in curate:

- do not use graph as a primary reranker yet
- use graph to attach 1-2 support refs or navigation hints to a top-level curated result
- prefer hints like `see also`, `related`, or `inspect next` over full graph payloads
- keep full graph exploration in `akm show` or `akm graph related`

What not to do yet:

- no graph-only reranking
- no graph-required curate path
- no full graph dumps in curate output
- no semantic asset-lineage inference from sparse graph data

## Tests That Pin Behavior

Start with these:

- `tests/curate-command.test.ts`
- `tests/curate-logic.test.ts`
- `tests/curate-search-for-curation.test.ts`

What they cover:

- CLI JSON/text output
- shape/detail behavior
- usage logging
- fallback token derivation
- merge semantics
- type ordering
- diversification logic
- registry filler cap
- blank query rejection
- default limit
- phrase-hit fallback suppression
- current quality baselines showing irrelevant filler

Search-ranking baselines that curate should respect:

- `tests/commands/search.test.ts`
- `tests/ranking-regression.test.ts`

## Known Gaps / Mismatches

- `docs/guides/search-discovery.md` currently says curate prefers one strong match per type; that wording is too strong if curate becomes relevance-first.
- `docs/reference/cli.md` documents `--type`, `--limit`, and `--source`, but does not currently explain the effective `--detail` and `--shape` behavior alongside curate.
- Some historical AKM refs about curate output shaping are stale because curate now has a dedicated shape implementation.

## Safe Edit Checklist

Before editing curate:

1. Read the three curate-focused test files.
2. Read `src/commands/read/curate.ts` top to bottom.
3. Confirm whether you are changing:
   - post-search selection
   - fallback triggering
   - fallback token extraction
   - output contract
   - telemetry side effects
4. Keep CLI surface and output-shape tests passing unless you intentionally change the public contract.
5. If you improve ranking quality, convert current characterization tests that encode bad behavior into regression tests for the new intended behavior.

## Useful AKM Queries And Refs

Queries:

```sh
akm search "curate rerank"
akm search "curate output shape"
akm search "search discovery curate"
akm search "curate telemetry usage_events"
akm search "curate fallback query"
akm search "curate quality baseline"
```

Historical context refs:

- `memories/curate-weak-for-ui-test-audit.derived`
- `knowledge/curate-command-flags-inert`

Note: `knowledge/curate-command-flags-inert` is historical context only. It describes an older output-shaping limitation that is no longer current now that `src/output/shapes/curate.ts` exists.

## Next Fix Candidates

Highest-value next changes:

1. Replace hard one-per-type selection with score-first shortlist selection plus optional soft diversity.
2. Replace empty-only fallback triggering with weak-result fallback triggering.
3. Add simple family-aware root/child collapsing for obvious structural bundles.
4. Add regression tests asserting that docker-specific curate queries stop surfacing unrelated `commands/release-manager` filler.
5. Attach lightweight related-asset hints using existing graph data after ranking quality is fixed.
6. Revisit `followUp` generation after ranking quality is fixed.
