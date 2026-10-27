# Fixture: `website-snapshot` bundle (SPECIFICATION goldens)

A materialized read-only crawl snapshot, in the exact on-disk shape
`src/sources/snapshot-fetchers/website-ingest.ts` writes: a `manifest.json` (`{url, fetchedAt}`)
plus crawled pages under `stash/knowledge/<slug>.md` (knowledge-shaped
frontmatter, tagged `website`). The `website-snapshot` adapter re-types those
pages to the open `type = "website"` and is READ-ONLY (Mode A).

- **Adapter:** `src/core/adapter/adapters/website-snapshot-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/website-snapshot/{recognition,placement,lint,renderer}.json`
- **Real-world source:** `src/sources/snapshot-fetchers/website-ingest.ts`, https://example.com/

Files: `manifest.json` (provenance — NOT indexed), `stash/knowledge/example-com/index.md`
+ `stash/knowledge/example-com/about.md` (crawled pages → `type=website`).

**Flags:** on-disk pages carry no `type:` field (only a `website` tag) — the
adapter re-types them; the conceptId prefix (`stash/knowledge/`) normalization
and the missing `website` presentation entry are open questions.
