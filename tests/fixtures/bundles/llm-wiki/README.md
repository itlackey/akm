# Fixture: `llm-wiki` bundle (SPECIFICATION goldens) — adapter built in CHUNK 4

An LLM Wiki root. `schema.md`/`index.md`/`log.md` are reserved (not indexed);
`raw/<slug>.md` are immutable ingested sources; `pages/**.md` are agent-authored
pages carrying `pageKind`/`xrefs`/`sources` frontmatter. The `llm-wiki` adapter
owns its native multi-file semantics, xrefs, citations, and validation.

- **Adapter built by:** **CHUNK 4** (the llm-wiki adapter is restored per spec
  DEV-7; its adapter is Chunk 4, but its golden is authored here so Chunk 4 has
  its target).
- **Goldens:** `tests/fixtures/format-family-goldens/llm-wiki/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (llm-wiki row), §6
  (wiki-page row), §0.2 (wiki asset-type dies; adapter first-class), §1.2 (probe
  = schema.md + pages/), §9 (links).
- **Grounding:** `src/wiki/wiki.ts`, `src/assets/wiki/*-template.md`.

Files: `schema.md`, `index.md`, `log.md` (reserved), `raw/2026-07-http-rfc.md`
(immutable source), `pages/http-caching.md` (concept) + `pages/entities/varnish.md`
(entity) — reciprocal xrefs, both cite the raw source — and `pages/orphan.md`
(note; **broken xref** for the lint golden).

**Central flag:** what open `type` a wiki page carries (pageKind vs a single
`wiki` type) is the primary Chunk-4 decision — see the recognition/renderer
goldens and the methodology doc's open-questions section.
