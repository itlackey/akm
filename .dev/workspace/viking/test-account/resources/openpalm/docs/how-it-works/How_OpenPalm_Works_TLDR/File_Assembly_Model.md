## File Assembly Model

OpenPalm doesn't generate config by filling in templates. It copies whole files.

`CONFIG_HOME` is user-owned and persistent. Allowed writers are:
- You, by editing files directly
- The admin via explicit UI/API config actions
- The assistant, only when you request it and it uses authenticated,
  allowlisted admin API actions

```
CONFIG_HOME/channels/chat.yml   ──copy──▶  STATE_HOME/artifacts/channels/chat.yml
CONFIG_HOME/channels/chat.caddy ──copy──▶  STATE_HOME/artifacts/channels/lan/chat.caddy
CONFIG_HOME/secrets.env         ──copy──▶  STATE_HOME/artifacts/secrets.env
assets/docker-compose.yml  ──copy──▶  STATE_HOME/artifacts/docker-compose.yml
DATA_HOME/caddy/Caddyfile       ──copy──▶  STATE_HOME/artifacts/Caddyfile
```

Docker and Caddy read exclusively from STATE_HOME at runtime. CONFIG_HOME is
never read directly by Docker or Caddy — it's only read by the admin during
apply.

`STATE_HOME/artifacts/secrets.env` is a verbatim copy of
`CONFIG_HOME/secrets.env`. System-managed values (channel HMAC secrets) are written into `STATE_HOME/artifacts/stack.env`
separately — they do not appear in the staged `secrets.env`.

Access scope is controlled by the system-managed core Caddyfile in
`DATA_HOME/caddy/Caddyfile` (the `@denied not remote_ip ...` line), which admin
stages into `STATE_HOME/artifacts/Caddyfile`.

### Caddyfile lifecycle

Three copies of the Caddyfile exist in the system:

1. **`assets/Caddyfile`** — Immutable template bundled into the admin image.
   Used to seed `DATA_HOME/caddy/Caddyfile` on first install. Contains
   `import lan_only` snippets for default LAN access control.
2. **`DATA_HOME/caddy/Caddyfile`** — Mutable system-managed source of truth.
   The admin mutates the `@denied not remote_ip ...` line here when the
   access scope changes via `POST /admin/access-scope`. This file persists
   across reinstalls (it lives in DATA_HOME).
3. **`STATE_HOME/artifacts/Caddyfile`** — Staged runtime copy. Read-only mount into
   Caddy's container. Regenerated from `DATA_HOME/caddy/Caddyfile` on
   every apply.

Caddy only reads from `STATE_HOME/artifacts/Caddyfile` at runtime. User-facing access
scope changes flow: API → `DATA_HOME/caddy/Caddyfile` → re-stage to
`STATE_HOME/artifacts/Caddyfile` → Caddy reload.

---