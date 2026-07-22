---
description: Rules that govern this wiki. Read before ingesting, searching, or editing pages.
wikiRole: schema
---

# sample-wiki wiki schema

This wiki follows the three-layer pattern:

- `raw/` — immutable ingested sources (never edit)
- `pages/<page>.md` and `pages/<topic>/<page>.md` — agent-authored pages
- `schema.md` (this file), `index.md`, `log.md` — wiki-level metadata

## Page frontmatter

```yaml
---
description: one-sentence summary
pageKind: entity | concept | question | note | <your-custom-kind>
xrefs:
  - wiki:sample-wiki/pages/other-page
sources:
  - raw/<slug>.md
---
```

## Hard rules

- `raw/` is immutable. Never edit ingested sources.
- Cross-references must point at pages that actually exist.
- Cite the raw source id when copying claims.
