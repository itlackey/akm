## Adding a New Channel

To add a channel called `my-channel` that runs on port 8185:

### 1. Create the compose overlay

Create `registry/my-channel.yml`:

```yaml
services:
  channel-my-channel:
    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-my-channel:${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    environment:
      PORT: "8185"
      GUARDIAN_URL: http://guardian:8080
      CHANNEL_MY_CHANNEL_SECRET: ${CHANNEL_MY_CHANNEL_SECRET}
    networks: [channel_lan]
    depends_on:
      guardian:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/8185' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
```

**That's it for basic setup.** The channel will be accessible on the Docker network to other services and from the host. No Caddy file is needed unless you want HTTP routing.

### 2. (Optional) Create a Caddy route

If you want the channel accessible via Caddy HTTP routing (LAN-restricted by default), create `registry/my-channel.caddy`:

```caddy
handle_path /channels/my-channel/* {
    import lan_only
    reverse_proxy channel-my-channel:8185
}
```

Add `import public_access` if the channel should be publicly accessible.

### 3. Add the secret to your env file (standalone mode)

Add to `secrets.env` (or `.env`):

```
CHANNEL_MY_CHANNEL_SECRET=<generated-secret>
```

Generate with: `openssl rand -hex 16`

In this repository's compose file, guardian reads `CHANNEL_*_SECRET` values via
`env_file` from `STATE_HOME/artifacts/secrets.env`.

### 4. Start with the new channel

```bash
docker compose \
  -f docker-compose.yml \
  -f registry/chat.yml \
  -f registry/my-channel.yml \
  --env-file secrets.env \
  up -d
```

### Installing a channel via the admin API

When running admin-managed, install channels from the registry catalog:

```bash
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "my-channel"}'
```

Or add channels manually without rebuilding the container:

1. Place `my-channel.yml` (and optional `my-channel.caddy`) in `$OPENPALM_CONFIG_HOME/channels/`
2. No manual channel secret is required; admin generates and stages it
3. Lifecycle apply/install/update discovers the new channel without overwriting existing user files in `CONFIG_HOME`
4. No code changes or container rebuilds required

The admin scans `CONFIG_HOME/channels/` at runtime to discover all `.yml` files and includes them in the docker compose command.

### Network choice

- `channel_lan` — default network for channels (LAN/public exposure is controlled by route file)
- `channel_public` — optional network for channels that need that segment
- No `.caddy` file — Docker-network only (host + other containers, no HTTP route)

The network name in the compose overlay determines which Docker network the channel joins. HTTP routing/access is controlled by the `.caddy` file and staging rules: LAN by default, public only with `import public_access`.