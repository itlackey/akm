# Fixture: `okf-sample` bundle

A small, conformant Open Knowledge Format (v0.1) bundle used as the frozen
fixture for the `okf` adapter's unit and integration test suites
(`tests/core/adapter/okf-adapter.test.ts`,
`tests/integration/okf-conformance.test.ts`) and the `okf`
format-family goldens.

This doc file deliberately lives BESIDE `okf-sample/`, not inside it (#730
review). The `okf` adapter's `recognize` has no directory gate — ANY `.md`
file under the bundle root other than the reserved `index.md`/`log.md`
becomes a concept, defaulting to `type: knowledge` when it carries no `type:`
frontmatter. A README dropped inside the bundle root would silently become
an extra indexed concept in a fixture meant to stay behavior-frozen.

- **Adapter:** `src/core/adapter/adapters/okf-adapter.ts` — fully implemented
  (unlike several sibling format families under
  `tests/fixtures/format-family-goldens/`, whose goldens were authored ahead
  of their adapters).
- **Goldens:** `tests/fixtures/format-family-goldens/okf/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/okf-support.md`.
- **Real-world source:** https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

Files:
- `index.md` / `log.md` / `tables/index.md` — reserved OKF structural files
  (never indexed as concepts), at both the root and a nested depth.
- `tables/orders.md`, `tables/customers.md` — `type: "BigQuery Table"`, with
  both `/`-rooted and standard-relative cross-links to each other and to
  `metrics/wau.md`.
- `metrics/wau.md` — `type: Metric`, linking back to `tables/orders.md`.
- `guides/onboarding.md` — no `type:` frontmatter field at all, so the `okf`
  adapter classifies it as the `knowledge` default.

**Frozen (D1.3 / #730):** this fixture predates the OKF v0.2 trust/provenance
family (`generated`/`verified`/`sources`/`status`/`stale_after`) and must stay
byte-identical — the v0.2 read-side tests use a separate sibling fixture,
`tests/fixtures/bundles/okf-sample-v2/`, instead of extending this one.
