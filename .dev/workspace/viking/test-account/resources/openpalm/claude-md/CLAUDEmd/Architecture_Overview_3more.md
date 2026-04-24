## Architecture Overview

Repo layout convention:
- `packages/*` contains app/package source workspaces.
- `core/*` contains container/runtime assembly assets and image build contexts.

```
CLI / UI / Assistant  →  Admin API  →  Docker Compose (lifecycle)
External clients      →  Channel    →  Guardian (HMAC/validate)  →  Assistant
```

- **Admin** (`packages/admin/`) — SvelteKit app: operator UI + API + control plane. Only component with Docker socket.
- **Guardian** (`core/guardian/`) — Bun HTTP server: HMAC verification, replay detection, rate limiting for all channel traffic.
- **Assistant** (`core/assistant/`) — OpenCode runtime with tools/skills. No Docker socket. Calls Admin API for stack operations.
- **Channel runtime** (`core/channel/`) — Unified `channel` image build and startup entrypoint.
- **Channel adapters** (`packages/channel-*/`) — Translate external protocols (OpenAI API, Discord, etc.) into signed guardian messages.
- **Assets** (`assets/`) — Static compose and Caddyfile bundled into admin at build time.
- **Registry** (`registry/`) — Channel catalog (definitions available for installation via admin API).

## Key Files

- `packages/admin/src/lib/server/control-plane.ts` — Barrel re-export of all server modules
- `packages/admin/src/lib/server/docker.ts` — Docker Compose CLI wrapper (all lifecycle operations)
- `packages/admin/src/routes/admin/` — API endpoints (see `docs/technical/api-spec.md` for full inventory)
- `assets/docker-compose.yml` — Core service definitions (6 services)
- `assets/Caddyfile` — Reverse proxy with `import channels/{public,lan}/*.caddy`
- `registry/` — Channel registry (channel definitions pointing to published images)

## XDG Directory Model

| Tier | Default Path | Owner | Purpose |
|------|-------------|-------|---------|
| CONFIG_HOME | `~/.config/openpalm` | User | User-owned persistent source of truth (`channels/`, `opencode/`, `secrets.env`) |
| DATA_HOME | `~/.local/share/openpalm` | Services | openmemory, assistant, guardian, caddy data |
| STATE_HOME | `~/.local/state/openpalm` | Admin | Assembled runtime (compose, Caddyfile, audit) — overwritten freely |

Dev mode uses `.dev/config`, `.dev/data`, `.dev/state` instead.