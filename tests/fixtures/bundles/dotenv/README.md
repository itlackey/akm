# Fixture: `dotenv` bundle (SPECIFICATION goldens)

A standalone dotenv bundle. `env/*.env` → `type=env` (KEY NAMES only, values
never indexed); `secrets/*` → `type=secret` (FILE NAME only). Redaction is a
hard contract keyed on the adapter/component, never the open `type`.

- **Adapter built by:** a future Chunk-2 format-adapter work item (env/secret
  recognition currently lives in the akm matcher stack; the env-file/secret-file
  RENDERERS already exist and are ported as adapter-keyed presentation).
- **Goldens:** `tests/fixtures/format-family-goldens/dotenv/{recognition,placement,lint,renderer}.json`
  — **`renderer.json` is the §C.2 field-omission redaction oracle.**
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (dotenv row), §6
  (env/secret rows), §2 (redaction keyed on adapter); normative
  `akm-format-neutral-bundle-workspace-spec.md` §21.2 (Sensitivity exception).
- **Real-world source:** https://www.dotenv.org/docs/security/env

Files:
- `env/app.env` — clean env (keys FIXTURE_GREETING, LOG_LEVEL).
- `env/dangerous.env` — **dangerous-key case** (PATH, NODE_OPTIONS) → exercises
  the `dangerous-vault-key` scan.
- `secrets/deploy-key` — bare secret file (whole file is the value; NOT scanned).
- `secrets/ci.env` — a `.env` UNDER `secrets/` → `type=secret` (name-only
  redaction, stronger than env/).
