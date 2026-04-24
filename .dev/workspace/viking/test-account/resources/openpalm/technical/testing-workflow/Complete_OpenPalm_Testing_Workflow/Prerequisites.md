## Prerequisites

Before running any stack tests (Tiers 4+), ensure:

1. **Dev environment is seeded:** `./scripts/dev-setup.sh --seed-env` (seeds `ADMIN_TOKEN=dev-admin-token`, correct Ollama URLs)
2. **Ollama running on host** with `nomic-embed-text` model pulled (768-dim embeddings)
3. **Stack built and running:** `bun run dev:build`

### Local no-skip rule (authoritative)

When running E2E locally, use `bun run admin:test:e2e`.
That script is intentionally configured to run the full integration suite with:
- `RUN_DOCKER_STACK_TESTS=1`
- `RUN_LLM_TESTS=1`
- `ADMIN_TOKEN=dev-admin-token`
- `PW_ENFORCE_NO_SKIP=1` (fails the run if any integration test is skipped)

If you run Playwright directly (or from `packages/admin`), you may get skipped groups due to missing env flags.

Quick preflight checks (recommended):

```bash
# Verify host Ollama is reachable and models are present
curl -sS http://localhost:11434/api/tags

# Verify admin runtime memory config points at host Ollama
curl -sS -H "x-admin-token: dev-admin-token" http://localhost:8100/admin/memory/config
```

> **Common pitfalls (already fixed in code/scripts):**
> - Memory config must use `http://host.docker.internal:11434` for Ollama (not `localhost`, not `ollama:11434`) — Ollama runs on host, not in compose
> - Embedding model dimensions must match config: `nomic-embed-text` = 768, `qwen3-embedding:0.6b` = 1024
> - `ADMIN_TOKEN` in `secrets.env` must be `dev-admin-token` to match test expectations
> - Stack tests hit the admin container directly (`http://localhost:8100`), not the Playwright preview server
> - If you want **zero skipped E2E tests**, run with both `RUN_DOCKER_STACK_TESTS=1` and `RUN_LLM_TESTS=1`
>
> **OpenCode config system (critical for LLM tests — v1.2.24):**
> - OpenCode has TWO config files: **project config** (`DATA_HOME/assistant/opencode.jsonc`) and **user config** (`CONFIG_HOME/assistant/opencode.json`)
> - **Project config** accepts ONLY: `$schema`, `plugin`. Putting `providers`, `model`, or `smallModel` here causes `ConfigInvalidError: Unrecognized key`
> - **User config** accepts ONLY: `$schema`, `model`, `agent`, `mode`, `plugin`, `command`, `username`. Both `providers` and `smallModel` cause fatal `ConfigInvalidError`
> - OpenCode's `openai` provider uses `@ai-sdk/openai` (**Responses API** `/v1/responses`) — Ollama doesn't support this
> - OpenCode's `lmstudio` provider uses `@ai-sdk/openai-compatible` (**Chat Completions API** `/v1/chat/completions`) — Ollama supports this
> - lmstudio provider has **hardcoded base URL** `http://127.0.0.1:1234/v1` per-model — NOT configurable via env vars or config files
> - lmstudio has a **static model catalog**: `qwen/qwen3-30b-a3b-2507`, `qwen/qwen3-coder-30b`, `openai/gpt-oss-20b`
> - **Workaround**: `entrypoint.sh` runs `socat` to proxy `127.0.0.1:1234` → `LMSTUDIO_BASE_URL` (parsed from compose env)
> - **Ollama model alias required**: `ollama cp qwen2.5-coder:3b qwen/qwen3-coder-30b` to match lmstudio catalog
> - User config sets `model: "lmstudio/qwen/qwen3-coder-30b"` — the Ollama alias served via proxy
> - Admin's `ensureOpenCodeSystemConfig()` seeds/updates the project config from bundled asset (plugins only)
> - `dev-setup.sh` seeds user config with model only (no providers — they're invalid in v1.2.24)
>
> **Docker Compose env precedence:**
> - Host shell env vars override `--env-file` values, which override compose `environment:` defaults
> - If host has `GROQ_API_KEY` set, `${GROQ_API_KEY:-}` in compose resolves to the host value even if `--env-file` says otherwise
> - `compose.dev.yaml` explicitly blanks cloud LLM keys (`ANTHROPIC_API_KEY: ""` etc.) to prevent host key leakage
> - `docker restart` does NOT re-read `env_file` changes — must use `docker compose up -d --force-recreate`

---