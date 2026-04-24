## Container Operations

### `GET /admin/containers/list`

Returns in-memory service state synced with live Docker container data when
Docker is available.

Response:

```json
{
  "containers": { "assistant": "running", "guardian": "stopped" },
  "dockerContainers": [],
  "dockerAvailable": true
}
```

### `POST /admin/containers/pull`

- Pulls the latest images for all services in the current compose file list.
- After a successful pull, recreates containers with the updated images via `compose up`.

Response:

```json
{ "ok": true, "pulled": "...", "started": ["caddy", "memory", "assistant", "guardian"] }
```

Note: `started` is an array of managed service names.

Error responses:

- `503 docker_unavailable` — Docker is not reachable.
- `502 pull_failed` — `docker compose pull` failed.
- `502 up_failed` — Images pulled but container recreation failed.

### `POST /admin/containers/up`
### `POST /admin/containers/down`
### `POST /admin/containers/restart`

Body:

```json
{ "service": "channel-chat" }
```

Rules:

- Allowed core services:
  `assistant`, `guardian`, `memory`, `admin`, `caddy`
- Allowed channel services: `channel-*` only if a matching staged
  `STATE_HOME/artifacts/channels/<name>.yml` exists.

Success response:

```json
{ "ok": true, "service": "channel-chat", "status": "running" }
```

## Channel Management

### `GET /admin/channels`

Returns staged-installed and registry-available channels:

```json
{
  "installed": [
    { "name": "chat", "hasRoute": true, "service": "channel-chat", "status": "running" }
  ],
  "available": [
    { "name": "discord", "hasRoute": false }
  ]
}
```

Notes:

- `installed` is derived from staged `STATE_HOME/artifacts/channels/*.yml`.
- `hasRoute` is derived from staged `STATE_HOME/artifacts/channels/public|lan/*.caddy`.

### `POST /admin/channels/install`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Copies registry files into `CONFIG_HOME/channels/`.
- Ensures system-managed channel secret exists.
- Re-stages artifacts and runs compose up.

Response:

```json
{
  "ok": true,
  "channel": "chat",
  "service": "channel-chat",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

### `POST /admin/channels/uninstall`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Removes channel `.yml` and optional `.caddy` from `CONFIG_HOME/channels/`.
- Removes system-managed channel secret from runtime state.
- Re-stages artifacts and stops the channel service.

Response:

```json
{
  "ok": true,
  "channel": "chat",
  "service": "channel-chat",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```