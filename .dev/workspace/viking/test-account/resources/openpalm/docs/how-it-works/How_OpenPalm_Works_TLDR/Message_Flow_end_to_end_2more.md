## Message Flow (end to end)

```
User sends message via chat client
        │
        ▼
channel-chat :8181
  Signs message: HMAC-SHA256(CHANNEL_CHAT_SECRET, payload)
  POSTs to guardian:8080/channel/inbound
        │
        ▼
Guardian validates:
  ✓ HMAC signature correct
  ✓ Timestamp within 5 min skew
  ✓ Not a replayed nonce
  ✓ Rate limit not exceeded
  ✓ Payload shape valid
        │
        ▼
Guardian forwards to assistant:4096
        │
        ▼
Assistant (OpenCode) processes the message
  Calls tools, reads memory, generates response
        │
        ▼
Response flows back through Guardian → channel-chat → user
```

If the assistant needs to do a stack operation during its turn (e.g., restart
a service):

```
Assistant calls POST http://admin:8100/admin/containers/restart
  Header: x-admin-token: <ADMIN_TOKEN>
  Body:   { "service": "channel-chat" }
        │
        ▼
Admin validates token + allowlists service name
Runs: docker compose restart channel-chat
Writes audit entry
Returns result
```

---

## Lifecycle (install / update)

```
openpalm install   →   POST /admin/install
                             │
                             ▼
                   Admin stages artifacts:
                     copies core compose → STATE_HOME/artifacts/docker-compose.yml
                      stages core Caddyfile (from DATA_HOME) → STATE_HOME/artifacts/Caddyfile
                     copies secrets.env  → STATE_HOME/artifacts/secrets.env
                     stages channel .yml → STATE_HOME/artifacts/channels/
                     stages channel .caddy → STATE_HOME/artifacts/channels/lan/ or public/
                             │
                             ▼
                   Admin runs: docker compose -f <staged files> up -d
```

**Apply is idempotent.** The admin also runs it automatically on startup —
restarting the admin container syncs your latest config changes into the
running stack.

Automatic lifecycle operations (install/update/startup/apply/setup reruns/upgrades)
are non-destructive for existing user config files in `CONFIG_HOME`; they only seed
missing defaults.

---