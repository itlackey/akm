## Components

### Caddy (reverse proxy)
The front door. Receives all HTTP traffic on `:8080` and routes it:

| Path | Destination | Default access |
|------|-------------|----------------|
| `/opencode/*` | Assistant UI (OpenCode) | LAN only |
| `/admin/*` | Admin UI + API | LAN only |
| `/guardian/*` | Guardian | Unrestricted (Guardian enforces its own auth) |
| channel routes | Channel adapters | LAN only by default |

Channel routes are loaded via `import channels/lan/*.caddy` and
`import channels/public/*.caddy` — Caddy picks them up automatically when the
admin stages them into STATE_HOME.

### Admin (SvelteKit app, port 8100)
The control plane. Only component with Docker socket access.

Responsibilities:
- Assembles runtime artifacts (compose files, Caddyfile, secrets) from user
  config into STATE_HOME
- Runs `docker compose` for all lifecycle operations (install, update, up, down,
  restart)
- Exposes an authenticated API used by the CLI, the browser UI, and the assistant
- Applies explicit config mutations to `CONFIG_HOME` (for example, connections or
  channel install/uninstall) when requested through authorized UI/API actions
- Runs scheduled automations — user-defined files from CONFIG_HOME/automations/
- Writes the audit log
- Discovers installed channels by scanning `CONFIG_HOME/channels/`, then stages
  overlays/snippets into `STATE_HOME/artifacts/channels/` for runtime
- Installs channels from the registry catalog on demand via the API

### Guardian (Bun server, port 8080)
The security checkpoint for all inbound channel traffic.

For every inbound message it:
1. Verifies HMAC signature (`CHANNEL_<NAME>_SECRET`)
2. Rejects replayed messages (5-minute replay cache)
3. Enforces rate limits (120 req/min per user)
4. Validates payload shape (channel, userId, message, timestamp)
5. Forwards validated messages to the assistant

A message that fails any check never reaches the assistant.

### Assistant (OpenCode runtime, port 4096)
The AI. Runs OpenCode. Has no Docker socket.

When it needs to do something to the stack (restart a service, check status), it
calls the Admin API using `OPENPALM_ADMIN_TOKEN`. The Admin allowlists which
actions and service names are legal — the assistant can't do anything
unauthorized.

Extensions live in two places:
- `/etc/opencode/` — system config mounted from `DATA_HOME/assistant/`
  (model, plugins, persona — managed by admin)
- `CONFIG_HOME/assistant/` — user extensions mounted at runtime (no rebuild
  needed)

### Channel adapters (e.g. channel-chat, port 8181)
Translate external protocols into signed Guardian messages. The chat channel
speaks the OpenAI API protocol. Discord, Telegram, and voice channels speak
their native protocols. All of them do the same thing at the end: sign the
message with their HMAC secret and POST it to Guardian.

The runtime image for registry-backed adapters is the unified
`channel`, built from `core/channel/Dockerfile`.

### Supporting services
- **Memory** — Bun.js service (`@openpalm/memory`) with sqlite-vec vector
  storage; gives the assistant persistent memory across conversations

---