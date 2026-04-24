## Channels

A channel is a `.yml` compose overlay (required) plus an optional `.caddy` route.

### Install a channel from the registry

Available channels can be installed via the admin API:

```bash
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "chat"}'
```

This copies the channel files from the registry to `~/.config/openpalm/channels/`,
generates an HMAC secret, stages artifacts, and starts the channel.

### Add a channel manually

1. Drop `<name>.yml` into `~/.config/openpalm/channels/`
2. Optionally drop `<name>.caddy` for HTTP access through Caddy
3. Apply (restart admin or POST to `/admin/install`)

### Uninstall a channel

```bash
curl -X POST http://localhost:8100/admin/channels/uninstall \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "chat"}'
```

Or manually: remove (or rename) its `.yml` from `channels/` and apply.

### HTTP routing per channel

| File present? | Result |
|---|---|
| No `.caddy` file | Channel is Docker-network only — no HTTP route |
| `.caddy` with `import lan_only` | LAN-restricted HTTP route |
| `.caddy` with `import public_access` | Publicly accessible HTTP route |
| `.caddy` with no import statement | Admin auto-adds `import lan_only` (LAN by default) |

---