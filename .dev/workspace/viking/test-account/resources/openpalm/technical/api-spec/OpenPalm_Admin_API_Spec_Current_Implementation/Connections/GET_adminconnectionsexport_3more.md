### `GET /admin/connections/export/mem0`

Exports the mem0 config derived from current connection profiles and assignments.
Returns the config as a downloadable JSON file (`mem0-config.json`).

Auth: admin token or setup token.

Response: `application/json` with `Content-Disposition: attachment; filename="mem0-config.json"`.

Error responses:

- `404 not_found` -- No connection profiles found.
- `409 conflict` -- LLM or embeddings connection profile not found.

### `GET /admin/connections/export/opencode`

Exports the generated `opencode.json` config from `CONFIG_HOME/assistant/opencode.json`.
Returns the config as a downloadable JSON file with `_nextSteps` guidance.

Auth: admin token or setup token.

Response: `application/json` with `Content-Disposition: attachment; filename="opencode.json"`.

Error responses:

- `404 not_found` -- opencode.json has not been generated yet.
- `500 internal_error` -- Failed to read opencode.json.

### Setup-token route variants

During setup (or with admin token), the same handlers are available at:

- `GET/POST/PUT/DELETE /admin/setup/connections/profiles`
- `GET/POST /admin/setup/connections/assignments`

These routes use setup-token compatible auth and preserve the same payload and
error semantics as their `/admin/connections/*` counterparts.