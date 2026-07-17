# Fixture: `akm-task` bundle (SPECIFICATION goldens)

A standalone task bundle of `.yml` tasks (AKM-native, not OKF markdown). Emits
`type=task`.

- **Adapter built by:** a future Chunk-2 format-adapter work item (task
  recognition currently lives in the akm matcher stack; no dedicated
  `akm-task` adapter module exists yet).
- **Goldens:** `tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/design/akm-0.9.0-bundle-adapter-spec.md` §7 (akm-task row),
  §6 (task row).

Files:
- `nightly-index.yml` — **conformant** (schedule + enabled + one target).
- `two-targets.yml` — **`invalid-task-yaml` violation** (declares both a prompt
  and a command).
