## Configuration Endpoints

### `GET /admin/config/validate`

Run varlock environment validation against `CONFIG_HOME/secrets.env` using the
schema at `DATA_HOME/secrets.env.schema`. Always returns 200; validation failures
are non-fatal and are logged to the audit trail.

**Authentication:** Required (`x-admin-token`)

**Response:**

```json
{ "ok": true, "errors": [], "warnings": [] }
```

When validation finds issues:

```json
{
  "ok": false,
  "errors": ["ERROR: ADMIN_TOKEN is required but not set"],
  "warnings": ["WARN: OPENAI_BASE_URL is not a valid URL"]
}
```

**Error responses:**

- `401 unauthorized` — Missing or invalid `x-admin-token`.

**Notes:**

- `ok: true` means all required variables are present and valid.
- `ok: false` is non-fatal — services continue running.
- Failures are logged to the audit trail under action `config.validate`.
- This endpoint is called periodically by the `validate-config` core automation.

## Artifact and Audit APIs

### `GET /admin/artifacts`

```json
{ "artifacts": [{ "name": "compose", "sha256": "...", "generatedAt": "...", "bytes": 1234 }] }
```

### `GET /admin/artifacts/manifest`

```json
{ "manifest": [{ "name": "compose", "sha256": "...", "generatedAt": "...", "bytes": 1234 }] }
```

### `GET /admin/artifacts/:name`

- Allowed names: `compose`, `caddyfile` (alias `caddy` accepted).
- Returns `text/plain` and may include `x-artifact-sha256` header.

### `GET /admin/audit?limit=<n>`

```json
{ "audit": [{ "at": "...", "action": "install", "ok": true }] }
```

## Installed Services

### `GET /admin/installed`

```json
{
  "installed": ["chat"],
  "activeServices": { "assistant": "running" }
}
```