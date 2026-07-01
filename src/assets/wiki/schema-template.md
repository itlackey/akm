---
description: Rules that govern this wiki. Read before ingesting, searching, or editing pages.
wikiRole: schema
---

# {{WIKI_NAME}} wiki schema

This wiki follows the three-layer pattern:

- `raw/` — immutable ingested sources (never edit)
- `pages/<page>.md` and `pages/<topic>/<page>.md` — agent-authored pages
- `schema.md` (this file), `index.md`, `log.md` — wiki-level metadata

## Page frontmatter

Every page should carry frontmatter so akm can index and link it:

```yaml
---
description: one-sentence summary used in search and lint
pageKind: entity | concept | question | note | <your-custom-kind>
xrefs:
  - wiki:{{WIKI_NAME}}/pages/other-page
sources:
  - raw/<slug>.md
---
```

`pageKind` accepts any non-empty string. Add new categories freely; they
will surface in `index.md` as new sections after the next `akm index` run.

## Three operations

### Ingest

1. Copy the new source into `raw/` with `akm wiki stash {{WIKI_NAME}} <path>`.
2. Find related pages: `akm wiki search {{WIKI_NAME}} "<terms>"`.
3. For each related page: append a section, note a contradiction, or create a
   new page under `pages/`. Update xrefs on both sides.
4. Cite the raw source in each touched page's `sources:` frontmatter.
5. Append one entry to `log.md` describing what was assimilated.

### Query

1. `akm wiki search {{WIKI_NAME}} "<question>"` — find candidate pages.
2. `akm show wiki:{{WIKI_NAME}}/pages/<page>` — read the top hits.
3. Compose the answer from the wiki; cite raw sources only when the wiki
   points at them.

### Lint

1. `akm wiki lint {{WIKI_NAME}}` — deterministic structural checks.
2. Resolve each finding: link orphans, fix broken xrefs, add descriptions,
   cite uncited raws, refresh the index.

## Hard rules

- `raw/` is immutable. Never edit ingested sources.
- Cross-references must point at pages that actually exist.
- Prefer appending to an existing page over duplicating one.
- Cite the raw source id (e.g. `raw/2026-04-foo.md`) when copying claims.
