# Fixture: `llm-wiki` bundle (SPECIFICATION goldens)

An LLM Wiki root. `schema.md`/`index.md`/`log.md` are reserved (not indexed);
`raw/<slug>.md` are immutable ingested sources; `pages/**.md` are agent-authored
pages carrying `pageKind`/`xrefs`/`sources` frontmatter. The `llm-wiki` adapter
owns its native multi-file semantics, xrefs, citations, and validation.

- **Adapter:** `src/core/adapter/adapters/llm-wiki-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/llm-wiki/{recognition,placement,lint,renderer}.json`

Files: `schema.md`, `index.md`, `log.md` (reserved), `raw/2026-07-http-rfc.md`
(immutable source), `pages/http-caching.md` (concept) + `pages/entities/varnish.md`
(entity) — reciprocal xrefs, both cite the raw source — and `pages/orphan.md`
(note; **broken xref** for the lint golden).

**Central flag:** what open `type` a wiki page carries (pageKind vs a single
`wiki` type) — see the recognition/renderer goldens.
