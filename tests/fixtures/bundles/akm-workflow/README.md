# Fixture: `akm-workflow` bundle (SPECIFICATION goldens)

A standalone workflow bundle with one Markdown workflow (`release.md`), which
emits `type=workflow`.

- **Adapter:** `src/core/adapter/adapters/akm-workflow-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/akm-workflow/{recognition,lint,renderer}.json`
- **Grounding:** existing akm workflow codec (`src/workflows/`) + the frozen
  `all-types` workflow fixtures.

Files: `release.md` (unified markdown workflow).
