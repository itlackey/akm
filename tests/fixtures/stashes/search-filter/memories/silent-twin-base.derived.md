---
description: Duskfall guidance distilled from silent-twin-base, carrying no belief state of its own.
tags:
  - duskfall
  - derived-twin
quality: generated
inferred: true
source: memory:silent-twin-base
derivedFrom: silent-twin-base
---

# Silent Twin Base (Derived Twin)

Duskfall guidance distilled from silent-twin-base. Deliberately carries NO
"gridlock" anywhere in its indexed fields (description/tags/searchHints/
aliases -- FTS indexes those, NOT raw markdown body prose, unless the
`index.indexBodyOpening` config flag is enabled, which this fixture's index
config leaves at its off-by-default value).

**DIVERGENCE case (verified empirically, WI-0b.5a):** a `gridlock` query's
scored path (`searchDatabase`) builds its candidate pool from
`searchFts`/vector matches for that query's tokens (`combineSearchScores`,
`src/indexer/search/db-search.ts` around :368/:388) -- this twin has ZERO FTS
relevance for "gridlock" and is therefore NEVER a candidate, so
`inheritDerivedTwinBeliefStates` (:459) never sees it and it never appears in
ANY `gridlock`-query scored result, under any belief filter. The enumerate
path (`enumerateEntries`) ignores query-token matching entirely (an empty
query lists `getAllEntries` for the type, unconditionally) -- this twin is
ALWAYS a candidate there, so it reliably inherits `silent-twin-base`'s
`contradicted` belief state and appears under `belief=all`/`belief=historical`
(and is excluded under `belief=current`) via the enumerate path only. THIS is
the real, robust two-path asymmetry this fixture pins -- not a difference in
which function each path calls (both call `inheritDerivedTwinBeliefStates`),
but a difference in which entries ever reach that call: the enumerate path's
candidate set is query-independent; the scored path's is query-token-gated.
