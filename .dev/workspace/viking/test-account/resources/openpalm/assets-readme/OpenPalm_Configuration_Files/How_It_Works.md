## How It Works

### Docker Compose Overlays

The core `docker-compose.yml` defines infrastructure services. Channel services live in separate compose files that are merged at runtime using the `-f` flag:

```bash
docker compose \
  -f docker-compose.yml \
  -f registry/chat.yml \
  -f registry/discord.yml \
  --env-file secrets.env \
  up -d
```

Docker Compose merges all `-f` files into a single configuration. Channel overlays can reference networks and services defined in the core file.

### Caddy Imports

The core `Caddyfile` includes these lines:

```caddy
import channels/public/*.caddy
import channels/lan/*.caddy
```

Caddy loads staged `.caddy` files from the `channels/public/` and `channels/lan/` directories at startup. No changes to the core Caddyfile are needed when adding or removing channels.

In admin-managed mode, this file is seeded to and managed from
`DATA_HOME/caddy/Caddyfile`, then staged to `STATE_HOME/artifacts/Caddyfile` during apply.

**Caddy files are optional.** If a channel has no `.caddy` file, it gets no HTTP route through Caddy and is only accessible on the Docker network (host and other containers). This is the default for channels that don't need public or LAN access.

### Access Control

The Caddyfile defines a `(lan_only)` snippet:

```caddy
(lan_only) {
    @denied not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10
    abort @denied
}
```

Channel `.caddy` files are LAN-restricted by default. Add `import public_access` to opt into public routing.

For host-only access (localhost only), replace the IP ranges with `127.0.0.1 ::1`.

### Environment Variables

Each service's `environment:` block lists only the `${VAR}` references it needs. Docker Compose substitutes values from:

- A `.env` file in the project directory (standalone default)
- An explicit `--env-file secrets.env` flag

This means each container only receives the secrets it explicitly declares — the guardian gets channel secrets, the assistant gets API keys, etc.