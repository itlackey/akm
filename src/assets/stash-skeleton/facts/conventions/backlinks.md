---
type: fact
category: convention
description: How to cross-link assets so retrieval compounds — a provenance xref when derived, sparse real associative xrefs, corrections as new assets, and canonical entity naming.
when_to_use: Surfaced to authoring agents when they create or revise any asset that derives from, corrects, or relates to another asset.
updated: 2026-09-28
---

<!--
  SOFT guidance only — advice, not a contract. Back-linking here is a RETRIEVAL
  mechanism, not decoration: `xrefs:` frontmatter folds into the search index
  and is stored as a declared link `akm show` lists on both assets.
  Over-linking degrades ranking, so these rules are deliberately conservative.
  (LLM-wiki bundles carry their own xref system in their pages' frontmatter —
  this convention is for in-stash assets.)
-->

# Back-linking conventions

Cross-references are how knowledge compounds instead of being re-derived every
session. In AKM they are also **indexed**: the strings in an asset's `xrefs:`
frontmatter fold into its search-hint text and are stored as links that
`akm show` lists on both assets (with `supersededBy:`, `contradictedBy:` and a
`.derived` memory's parent). So links are a retrieval lever — which means both
too few and too many hurt.

```yaml
---
description: OAuth refresh-token race on token rotation
tags: [auth, projectA]
xrefs:
  - knowledge/auth/vendor-x-token-api   # provenance: what this was synthesized from
  - lessons/projectA/token-refresh-gotcha # one real associative link
---
```

## Link rules

- **One xref is mandatory when the asset derives from another: cite the source
  ref** (`memories/projectA/token-quirk` xrefs `knowledge/auth/vendor-x-token-api`
  — it also makes this asset findable from searches for its source). An
  original observation with no source carries none — never invent provenance.
  `akm remember`/`akm import` write this channel via `--xref <ref>`
  (repeatable; refs are checked at write time). LLM-wiki bundles enforce the
  analogous rule mechanically (`sources:` frontmatter citations); in-stash
  provenance is discipline only.
- **Associative xrefs are discretionary — real relationships only.** Add one when
  you already know a genuine load-bearing connection. Do **not** hit a link
  quota by pointing at the topically-nearest sibling — a plausible-but-wrong
  xref makes this asset a false search match for the other topic and a false
  declared link on both assets' `akm show` output.
- **Cap total xrefs at ~5 (a heuristic, not a measured threshold).** Each xref
  folds its ref tokens into THIS asset's search hints — past a handful, the
  asset matches queries about several other topics and its own ranking signal
  blurs.
- **Corrections are new assets; ingested material is immutable.** Treat
  ingested raw material, vendored docs, and transcripts as
  immutable-by-discipline: a hard-won fix is a new `lessons/` or `knowledge/`
  asset that xrefs what it corrects.
  Synthesized `knowledge/` pages are the rewritable layer — update them in
  place. When a correction supersedes a standalone asset (memory OR knowledge),
  also set the old asset's `beliefState: superseded` and
  `supersededBy: [<new ref>]` — a metadata edit, not a content edit — so the
  ranker demotes the stale version instead of letting it outrank your fix.
  `akm remember`/`akm import` do both writes in one step via
  `--supersedes <old ref>` (adds the xref and demotes the old asset).
- **Bidirectional back-links are best-effort.** Add a return xref only when you
  are already editing the target in the same pass. Never require editing a
  separate hot file just to add a back-xref — concurrent writes drop it under
  last-writer-wins and no lint will notice.

## Self-situating headers and canonical naming

Put the one-line orientation in `description:` and the trigger conditions in
`when_to_use:` — those remain the higher-weight indexed fields. Bounded body
prose is indexed in the lowest-weight `content` field, so
`description:`/`when_to_use:` remain the primary orientation channel. Then
open the body with a plain title plus a one-line
orientation naming what it is, its scope/domain, and its key entities in
canonical spelling (`Postgres`, `OAuth`, `TLS`, `Acme`) — consistent spelling
keeps search matches from fragmenting across variants, and readers land here
from `akm show`. Keep the canonical-spelling list in `facts/conventions/domains`
so agents don't fragment `postgres` / `postgresql` / `pg`.

## Hubs are optional, not per-namespace obligations

A hub (a `knowledge/` overview page that xrefs the key assets in a domain) is
worth authoring for a **few genuinely high-traffic domains**. Do **not**
mandate a hub per namespace and do not edit a hub on every write: that is O(n)
maintenance, a concurrent-write contention point, and it flattens every linked
asset's declared links into a namespace-wide star centered on the hub. Let the
FTS index be the catalog; spend the effort on per-asset self-situating headers
instead.

## Keep assets atomic

One concept per asset. If a note covers two concepts, write two assets and xref
them — atomic assets give the ranker clean, single-topic targets and give you a
real relationship to link rather than a blurred one to bury.
