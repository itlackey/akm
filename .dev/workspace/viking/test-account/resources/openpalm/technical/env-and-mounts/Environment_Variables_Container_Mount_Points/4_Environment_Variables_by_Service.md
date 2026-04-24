## 4. Environment Variables by Service

### 4.1 Admin Service

| Variable | Value | Purpose |
|---|---|---|
| `PORT` | `8100` | HTTP server listen port |
| `ADMIN_TOKEN` | from secrets.env | Bearer token for Admin API |
| `GUARDIAN_URL` | `http://guardian:8080` | Internal URL to guardian |
| `OPENPALM_ASSISTANT_URL` | `http://assistant:4096` | Internal URL to assistant |
| `HOME` | `${OPENPALM_DATA_HOME}/admin` | Writable home directory for varlock runtime state (`~/.varlock`) |
| `OPENPALM_CONFIG_HOME` | Same as host path | In-container path to CONFIG_HOME (same-path mount) |
| `OPENPALM_DATA_HOME` | Same as host path | In-container path to DATA_HOME (same-path mount) |
| `OPENPALM_STATE_HOME` | Same as host path | In-container path to STATE_HOME (same-path mount) |
| `OPENPALM_UID` | `${OPENPALM_UID:-1000}` | Target UID for privilege drop (gosu) |
| `OPENPALM_GID` | `${OPENPALM_GID:-1000}` | Target GID for privilege drop (gosu) |

### 4.2 Guardian Service

| Variable | Value | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP server listen port |
| `OPENPALM_ASSISTANT_URL` | `http://assistant:4096` | Internal URL for message forwarding |
| `GUARDIAN_AUDIT_PATH` | `/app/audit/guardian-audit.log` | Audit log path; compose sets this to write into STATE_HOME/audit |
| `OPENCODE_TIMEOUT_MS` | `120000` | Timeout (ms) for assistant message response (LLM inference can be slow; code default 120s) |
| `ADMIN_TOKEN` | from secrets.env | Admin API token |
| `GUARDIAN_SECRETS_PATH` | `/app/secrets/stack.env` | Path to bind-mounted stack.env for runtime secret re-reads |
| `CHANNEL_*_SECRET` | system-generated (injected into staged stack.env) | HMAC keys for channel signature verification |

### 4.3 Assistant Service (OpenCode Runtime)

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Built-in config, tools, plugins, skills |
| `OPENCODE_PORT` | `4096` | Web-server listen port |
| `OPENCODE_AUTH` | `false` | Disabled — host-only binding (127.0.0.1) provides the security boundary |
| `OPENCODE_ENABLE_SSH` | `0` (default) | SSH server toggle |
| `HOME` | `/home/opencode` | User home directory |
| `OPENPALM_ADMIN_API_URL` | `http://admin:8100` | Admin API URL for admin tools |
| `OPENPALM_ADMIN_TOKEN` | from secrets.env | Bearer token for Admin API |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL |
| `MEMORY_USER_ID` | `default_user` | User identifier for memory (entrypoint auto-falls back to runtime username when left as default) |
| `OPENPALM_UID` | `${OPENPALM_UID:-1000}` | Target runtime UID used by assistant entrypoint before dropping privileges |
| `OPENPALM_GID` | `${OPENPALM_GID:-1000}` | Target runtime GID used by assistant entrypoint before dropping privileges |
| `OPENAI_API_KEY` | pass-through | OpenAI provider key |
| `ANTHROPIC_API_KEY` | pass-through | Anthropic provider key |
| `GROQ_API_KEY` | pass-through | Groq provider key |
| `MISTRAL_API_KEY` | pass-through | Mistral provider key |
| `GOOGLE_API_KEY` | pass-through | Google AI provider key |

### 4.4 Memory

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_DATA_DIR` | `/data` | Base directory for Qdrant data and history DB |
| `HOME` | `/data` | Home directory used by mem0 for user-scoped defaults |
| `MEM0_DIR` | `/data/.mem0` | mem0 runtime directory for local state/config |
| `OPENAI_API_KEY` | pass-through | Required for embedding generation |
| `OPENAI_BASE_URL` | pass-through | Custom OpenAI-compatible base URL |

Memory uses the `@openpalm/memory` Bun.js package with sqlite-vec for vector
storage (configured via `default_config.json`). No external database servers
needed.

---