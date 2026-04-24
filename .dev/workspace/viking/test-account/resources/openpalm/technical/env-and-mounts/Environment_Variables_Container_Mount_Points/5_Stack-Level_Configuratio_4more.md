## 5. Stack-Level Configuration Variables

These variables are consumed by `docker compose` via `STATE_HOME/artifacts/stack.env`.
They are **system-managed** — the admin auto-detects and writes them on every apply.
You never set these in `CONFIG_HOME/secrets.env`.

| Variable | Default | Source |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | admin process env |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | admin process env |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | admin process env |
| `OPENPALM_WORK_DIR` | `$HOME/openpalm` | admin process env |
| `OPENPALM_UID` | current user UID | `process.getuid()` |
| `OPENPALM_GID` | current group GID | `process.getgid()` |
| `OPENPALM_IMAGE_NAMESPACE` | `openpalm` | admin process env (overridable) |
| `OPENPALM_IMAGE_TAG` | `latest` | admin process env (overridable) |
| `OPENPALM_INGRESS_BIND_ADDRESS` | `127.0.0.1` | admin process env (overridable) |
| `OPENPALM_INGRESS_PORT` | `8080` | admin process env (overridable) |
| `OPENPALM_ASSISTANT_BIND_ADDRESS` | `127.0.0.1` | compose default |
| `OPENPALM_ASSISTANT_SSH_BIND_ADDRESS` | `127.0.0.1` | compose default |
| `OPENPALM_ASSISTANT_SSH_PORT` | `2222` | compose default |
| `OPENPALM_MEMORY_BIND_ADDRESS` | `127.0.0.1` | compose default |
| `MEMORY_USER_ID` | `default_user` | admin process env (overridable) |

Overridable values can be customized by setting the variable in the admin container's
environment before startup (e.g. via docker-compose.yml `environment:` override).

---

## 6. LLM Provider Keys (Pass-Through)

Read from the host environment and passed into containers that need them.
Never generated or defaulted by OpenPalm.

| Variable | Consumed By | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | assistant, memory | OpenAI API (also used for embeddings) |
| `ANTHROPIC_API_KEY` | assistant | Anthropic LLM provider |
| `GROQ_API_KEY` | assistant | Groq LLM provider |
| `MISTRAL_API_KEY` | assistant | Mistral LLM provider |
| `GOOGLE_API_KEY` | assistant | Google AI provider |

---

## 7. Docker Networks

| Network | Services | Purpose |
|---|---|---|
| `assistant_net` | caddy, memory, assistant, guardian, admin | Internal service mesh |
| `channel_lan` | caddy, guardian, channel services | LAN-restricted channel access |
| `channel_public` | caddy, guardian, channel services | Publicly accessible channels |

---

## 8. Port Mappings

| Service | Container Port | Host Binding | Default Host Port |
|---|---|---|---|
| Caddy | 80 | `$OPENPALM_INGRESS_BIND_ADDRESS` | 8080 |
| Admin | 8100 | `127.0.0.1` (fixed) | 8100 |
| Assistant | 4096 | `$OPENPALM_ASSISTANT_BIND_ADDRESS` | 4096 |
| Assistant SSH | 22 | `$OPENPALM_ASSISTANT_SSH_BIND_ADDRESS` | 2222 |
| Memory API | 8765 | `$OPENPALM_MEMORY_BIND_ADDRESS` | 8765 |

---