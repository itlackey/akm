# Fixture: `akm-workflow` bundle (SPECIFICATION goldens)

A standalone workflow bundle: a markdown workflow (≈ OKF concept) and a YAML
program form (an AKM extension). Both emit `type=workflow`.

- **Adapter built by:** a future Chunk-2 format-adapter work item (workflow
  recognition currently lives in the akm matcher stack; no dedicated
  `akm-workflow` adapter module exists yet).
- **Goldens:** `tests/fixtures/format-family-goldens/akm-workflow/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (akm-workflow row),
  §6 (workflow row).
- **Grounding:** existing akm workflow codec (`src/workflows/`) + the frozen
  `all-types` workflow fixtures.

Files: `release.md` (markdown workflow), `deploy.yaml` (YAML program).
