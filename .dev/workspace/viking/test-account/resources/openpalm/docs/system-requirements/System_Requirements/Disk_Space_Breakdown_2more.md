## Disk Space Breakdown

| Category | Approximate Size | Notes |
|---|---|---|
| Docker images (core stack) | ~2-3 GB | 6 images; `node:lts-trixie` (assistant) is the largest at ~1 GB |
| Docker images (per channel) | ~100-200 MB | Shares the `oven/bun:1.3-slim` base layer with guardian |
| Config directory (`CONFIG_HOME`) | < 10 MB | User-editable YAML, secrets, channel configs |
| State directory (`STATE_HOME`) | < 50 MB | Generated compose files, Caddyfile, audit logs |
| Data directory (`DATA_HOME`) | Varies | Memory database grows with usage; starts < 1 MB |
| Ollama models (if local) | 2-8 GB per model | `qwen2.5-coder:3b` ~ 2 GB, `nomic-embed-text` ~ 270 MB |

### XDG Directory Locations

| Tier | Default Path | Purpose |
|---|---|---|
| `CONFIG_HOME` | `~/.config/openpalm` | User-owned config (channels, secrets, assistant config) |
| `DATA_HOME` | `~/.local/share/openpalm` | Service data (memory DB, Caddy certs, assistant state) |
| `STATE_HOME` | `~/.local/state/openpalm` | Generated runtime artifacts (compose files, audit logs) |

---

## Network Requirements

### Outbound Access

| Destination | When Needed |
|---|---|
| LLM provider APIs (api.openai.com, api.anthropic.com, etc.) | When using remote models |
| Docker Hub / GitHub Container Registry | Image pulls during install and updates |
| Ollama on host (`host.docker.internal:11434`) | When using local models via Ollama on the host |

### Inbound Ports

OpenPalm is **LAN-first by default**. No inbound ports need to be opened on your firewall unless you explicitly expose services.

| Port | Binding | Service | Notes |
|---|---|---|---|
| 8080 | `127.0.0.1` (default) | Caddy ingress | Configurable via `OPENPALM_INGRESS_BIND_ADDRESS` and `OPENPALM_INGRESS_PORT` |
| 8100 | `127.0.0.1` | Admin API (direct) | Always localhost-only |
| 4096 | `127.0.0.1` | Assistant (OpenCode) | Host-only access; no auth required (bind address is the security boundary) |
| 8765 | `127.0.0.1` | Memory API | Direct access; normally accessed by assistant internally |
| 2222 | `127.0.0.1` | Assistant SSH | Optional SSH access to OpenCode; disabled by default |

To expose the Caddy ingress on all interfaces (e.g., for LAN access), set `OPENPALM_INGRESS_BIND_ADDRESS=0.0.0.0` in your stack configuration. Public exposure requires additional Caddy TLS configuration.

### Internal Networks

Docker Compose creates four isolated networks. No host configuration is needed:

| Network | Purpose |
|---|---|
| `assistant_net` | Core services (admin, assistant, memory, guardian) |
| `admin_docker_net` | Admin to docker-socket-proxy only |
| `channel_lan` | LAN-restricted channel containers |
| `channel_public` | Publicly accessible channel containers |