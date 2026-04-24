## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Admin is sole orchestrator | Only `admin` container mounts `/var/run/docker.sock` |
| Guardian-only ingress | Channel adapters POST to Guardian only; Guardian HMAC-verifies every message |
| Assistant isolation | `assistant` has no Docker socket; calls Admin API on allowlist only |
| LAN-first by default | All ports bind to `127.0.0.1`; Caddy restricts by IP range; nothing public without opt-in |

### HMAC signing

Each channel has its own secret (`CHANNEL_<NAME>_SECRET`). The channel adapter
signs the full JSON payload with HMAC-SHA256 before sending. Guardian verifies
the signature using the same secret. A message with a wrong or missing signature
is rejected at the door.

### Allowlist enforcement

The admin keeps an explicit allowlist of:
- **Legal service names** — core services + any `channel-*` with a staged `.yml`
- **Legal actions** — `install`, `update`, `uninstall`, `containers.*`,
  `channels.list`, `channels.install`, `channels.uninstall`, `artifacts.*`,
  `audit.list`, `accessScope.*`

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Channel (the whole process)

1. Drop `<name>.yml` into `CONFIG_HOME/channels/` — defines the Docker service
2. Drop `<name>.caddy` into `CONFIG_HOME/channels/` — gives it an HTTP route
   (optional; without this it's Docker-network only)
3. Restart admin (triggers apply) or call `/admin/update`
4. Admin stages files, ensures/generates the channel HMAC secret, runs compose up, reloads
   Caddy

No code changes. No image rebuild. The channel is live.