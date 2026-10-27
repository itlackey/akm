# Fixture: `dotenv` bundle (SPECIFICATION goldens)

A standalone dotenv bundle. `env/*.env` → `type=env` (KEY NAMES only, values
never indexed); `secrets/*` → `type=secret` (FILE NAME only). Redaction is a
hard contract keyed on the adapter/component, never the open `type`.

- **Adapter:** `src/core/adapter/adapters/dotenv-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/dotenv/{recognition,lint,renderer}.json`
  — **`renderer.json` is the field-omission redaction oracle.**
- **Real-world source:** https://www.dotenv.org/docs/security/env

Files:
- `env/app.env` — clean env (keys FIXTURE_GREETING, LOG_LEVEL).
- `env/dangerous.env` — **dangerous-key case** (PATH, NODE_OPTIONS) → exercises
  the `dangerous-vault-key` scan.
- `secrets/deploy-key` — bare secret file (whole file is the value; NOT scanned).
- `secrets/ci.env` — a `.env` UNDER `secrets/` → `type=secret` (name-only
  redaction, stronger than env/).
