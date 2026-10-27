# Fixture: `akm-workflow` bundle (SPECIFICATION goldens)

A standalone workflow bundle: a markdown workflow (≈ OKF concept) and a YAML
program form (an AKM extension). Both emit `type=workflow`.

- **Adapter:** `src/core/adapter/adapters/akm-workflow-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/akm-workflow/{recognition,placement,lint,renderer}.json`
- **Grounding:** existing akm workflow codec (`src/workflows/`) + the frozen
  `all-types` workflow fixtures.

Files: `release.md` (unified markdown workflow).
