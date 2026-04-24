## Automations

### `GET /admin/automations`

Lists all automation configs from `STATE_HOME` with scheduler status and
execution logs.

Response:

```json
{
  "automations": [
    {
      "name": "daily-summary",
      "description": "Generate a daily summary",
      "schedule": "0 9 * * *",
      "timezone": "UTC",
      "enabled": true,
      "action": {
        "type": "http",
        "method": "POST",
        "path": "/admin/...",
        "url": null,
        "content": null,
        "agent": null
      },
      "on_failure": "log",
      "fileName": "daily-summary.yml",
      "logs": []
    }
  ],
  "scheduler": {
    "running": true,
    "jobCount": 1
  }
}
```

## Access Scope

### `GET /admin/access-scope`

```json
{ "accessScope": "lan" }
```

Notes:

- Scope is derived from the system-managed core Caddyfile at
  `DATA_HOME/caddy/Caddyfile`.
- If the file contains user-edited IP ranges that don't match the known
  `host` or `lan` patterns, the response returns `"custom"`.

### `POST /admin/access-scope`

Body:

```json
{ "scope": "host" }
```

Accepted values: `"host"` or `"lan"`. The value `"custom"` is read-only --
it cannot be set via POST.

Behavior:

- Updates the `@denied not remote_ip ...` line in
  `DATA_HOME/caddy/Caddyfile`.
- Re-stages `STATE_HOME/artifacts/Caddyfile` and channel snippets.
- Attempts Caddy reload.

**Warning:** If the current scope is `"custom"` (user-edited IP ranges),
a POST to this endpoint will overwrite those custom ranges with the
standard `host` or `lan` pattern. Custom ranges cannot be restored via the
API after being overwritten -- they must be re-applied by editing the
Caddyfile directly.

Response:

```json
{ "ok": true, "accessScope": "host" }
```