---
description: Derived twin of base-memory, carrying no belief state of its own, sharing base-memory's gridlock tag.
tags:
  - gridlock
  - derived-twin
quality: generated
inferred: true
source: memory:base-memory
derivedFrom: base-memory
---

# Base Memory (Derived Twin)

Gridlock guidance distilled from base-memory. The structural `.derived` name
suffix plus `inferred: true` mark this as memory-inference output. It
deliberately carries NO `beliefState` frontmatter of its own.

**PARITY case (verified empirically, WI-0b.5a):** because this twin shares the
`gridlock` tag with its base, it is a candidate on BOTH search paths for a
`gridlock` query. `searchDatabase` (scored path) calls
`inheritDerivedTwinBeliefStates` at `src/indexer/search/db-search.ts:459`
(before ranking) and `enumerateEntries` (enumerate path) calls the very same
function at `:636` (before its belief filter) — contrary to
`docs/design/execution/chunk-0b/anchors.md` Section D.1's framing ("scored
path lacks this call"), BOTH paths call it. Because the scored path's later
filter chain (`:513-530`) derives from the SAME mutated `scored` array via
chained `.filter()` calls (which preserve object references, not copies),
the inherited `contradicted` belief state IS visible to the scored path's own
belief filter too. For THIS twin (a full FTS candidate under `gridlock`),
both paths therefore agree on filter membership under every belief mode —
see `memories/silent-twin-base.derived.md` for the pair that DOES diverge,
and why.
