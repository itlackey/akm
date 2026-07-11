---
category: convention
description: How to cross-link assets so retrieval compounds — one mandatory provenance xref, sparse real associative xrefs, corrections as new assets, and canonical entity naming.
when_to_use: Surfaced to authoring agents when they create or revise any non-wiki asset that derives from, corrects, or relates to another asset.
---

<!--
  SOFT guidance only — advice, not a contract. Back-linking here is a RETRIEVAL
  mechanism, not decoration: `xrefs:` frontmatter folds into the search index and
  feeds the entity/relation graph boost. Over-linking degrades ranking, so these
  rules are deliberately conservative. Wikis have their own xref + lint system —
  this convention is for non-wiki assets.
-->

# Back-linking conventions

Cross-references are how knowledge compounds instead of being re-derived every
session. In AKM they are also **indexed**: the strings in an asset's `xrefs:`
frontmatter fold into its search-hint text, and knowledge/memory bodies feed an
LLM-extracted entity/relation graph that boosts ranking. So links are a retrieval
lever — which means both too few and too many hurt.

```yaml
---
description: OAuth refresh-token race on token rotation
tags: [auth, projectA]
xrefs:
  - knowledge:vendor-x/token-api        # provenance: what this was synthesized from
  - lesson:projectA/token-refresh-gotcha # one real associative link
---
```

## Link rules

- **Exactly one mandatory xref: provenance.** Every synthesized or derived asset
  cites the ref of the source it came from
  (`memory:projectA/token-quirk` xrefs `knowledge:vendor-x/token-api`). It is
  single-target, self-limiting, and the one link backed by real lint
  (`uncited-raw`, for wikis).
- **Associative xrefs are discretionary — real relationships only.** Add one when
  you already know a genuine load-bearing connection. Do **not** hit a link
  quota by pointing at the topically-nearest sibling you can name — a
  plausible-but-wrong edge poisons the graph boost and surfaces unrelated assets.
- **Cap total xrefs at ~5.** Because ref strings fold into the FTS hint field, a
  high-degree asset smears its ref token across every citer, wrecking the ranking
  signal of popular sources and hubs.
- **Corrections are new assets, never edits to a source.** Treat ingested
  `knowledge/` as immutable-by-discipline. A hard-won fix is a new `lesson:` or
  `knowledge:` asset that xrefs the thing it corrects
  (`lesson:projectA/oauth-race-fix` xrefs `knowledge:auth/oauth-refresh-races`) —
  this preserves provenance and lets the synthesized layer be rewritten without
  losing ground truth.
- **Bidirectional back-links are best-effort.** Add a return xref only when you
  are already editing the target in the same pass. Never require editing a
  separate hot file just to add a back-xref — concurrent writes drop it under
  last-writer-wins and no lint will notice.

## Canonical naming feeds the graph

The entity/relation graph is extracted from **body text, not the path**. So the
retrieval boost only fires when names are spelled consistently. Open every asset
with a **self-situating header** — a plain title plus a one-line orientation
naming what it is, its scope/domain, and its key entities in canonical spelling
(`Postgres`, `OAuth`, `TLS`, `Acme`). This single move helps FTS, embeddings, the
entity graph, and humans at once, and the literature ties it to a large drop in
failed retrievals. Keep a short canonical-spelling list in
`fact:conventions/domains` (or a `fact:canonical-names`) so agents don't
fragment `postgres` / `postgresql` / `pg`.

## Hubs are optional, not per-namespace obligations

A hub (a `wiki:` overview page that xrefs the key assets in a domain) is worth
authoring for a **few genuinely high-traffic domains** — wikis are the one type
with real orphan/broken-xref/stale-index lint to keep a hub honest. Do **not**
mandate a hub per namespace and do not edit a hub on every write: that is O(n)
maintenance, a concurrent-write contention point, and it flattens the multi-hop
graph into a namespace-wide star. Let the FTS index be the catalog; spend the
effort on per-asset self-situating headers instead.

## Keep assets atomic

One concept per asset. If a note covers two concepts, write two assets and xref
them — atomic assets give the ranker clean, single-topic targets and give you a
real relationship to link rather than a blurred one to bury.
