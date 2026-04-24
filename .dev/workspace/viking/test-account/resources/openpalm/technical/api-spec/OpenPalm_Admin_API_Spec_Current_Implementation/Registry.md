## Registry

Unified registry for channels and automations. Tries the cloned registry repo
(`STATE_HOME/registry-repo/registry/`) first, then falls back to build-time
bundled assets.

### `GET /admin/registry`

Lists all registry items (channels and automations) with install status.

Response:

```json
{
  "channels": [
    { "name": "chat", "type": "channel", "installed": true, "hasRoute": true, "description": "..." }
  ],
  "automations": [
    { "name": "daily-summary", "type": "automation", "installed": false, "description": "...", "schedule": "0 9 * * *" }
  ],
  "source": "remote"
}
```

`source` is `"remote"` when using the cloned registry repo, `"bundled"` when
falling back to build-time assets.

### `POST /admin/registry/install`

Install a registry item (channel or automation).

Body:

```json
{ "name": "chat", "type": "channel" }
```

- `name` (required) — Must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- `type` (required) — Must be `"channel"` or `"automation"`.

For channels: copies `.yml` and optional `.caddy` into `CONFIG_HOME/channels/`,
generates HMAC secret, re-stages artifacts, and runs compose up.

For automations: copies `.yml` into `CONFIG_HOME/automations/` and reloads
the scheduler.

Response (channel):

```json
{
  "ok": true,
  "name": "chat",
  "type": "channel",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

Response (automation):

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

Error responses:

- `400 invalid_input` — Invalid name, invalid type, item not found in registry,
  or item already installed.

### `POST /admin/registry/refresh`

Pulls the latest registry from GitHub via `git pull` on the cloned repo.

Response:

```json
{ "ok": true, "updated": true }
```

Error responses:

- `500 registry_sync_error` — Git pull failed.

### `POST /admin/registry/uninstall`

Uninstall a registry item (channel or automation).

Body:

```json
{ "name": "chat", "type": "channel" }
```

For channels: removes files from `CONFIG_HOME/channels/`, clears channel secret,
re-stages artifacts, and stops the Docker service.

For automations: removes `.yml` from `CONFIG_HOME/automations/` and reloads
the scheduler.

Response (channel):

```json
{
  "ok": true,
  "name": "chat",
  "type": "channel",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

Response (automation):

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```