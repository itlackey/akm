### `POST /admin/connections/test`

Tests a connection endpoint by fetching models from the given base URL. Derives
the provider type from the URL (Ollama for URLs containing `ollama` or `:11434`,
otherwise OpenAI-compatible). Accepts setup token or admin token.

Body:

```json
{
  "baseUrl": "http://host.docker.internal:11434",
  "apiKey": "",
  "kind": "openai_compatible_local"
}
```

- `baseUrl` (required) -- The endpoint to test.
- `apiKey` -- Optional API key for authentication.
- `kind` -- Connection kind hint (informational).

Response:

```json
{
  "ok": true,
  "models": ["llama3.2:3b", "nomic-embed-text"],
  "error": null,
  "errorCode": null
}
```

On failure:

```json
{
  "ok": false,
  "error": "Connection refused",
  "errorCode": "connection_error"
}
```

### `GET /admin/connections/profiles`

Returns canonical connection profiles from `CONFIG_HOME/connections/profiles.json`.

```json
{
  "profiles": [
    {
      "id": "primary",
      "name": "Primary connection",
      "kind": "openai_compatible_remote",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "auth": {
        "mode": "api_key",
        "apiKeySecretRef": "env:OPENAI_API_KEY"
      }
    }
  ]
}
```

### `POST /admin/connections/profiles`

Create a profile.

```json
{
  "profile": {
    "id": "local-lmstudio",
    "name": "LM Studio",
    "kind": "openai_compatible_local",
    "provider": "lmstudio",
    "baseUrl": "http://host.docker.internal:1234",
    "auth": { "mode": "none" }
  }
}
```

When `auth.mode` is `"api_key"`, the profile payload may include a top-level
`apiKey` field with the raw key. The handler derives the `apiKeySecretRef`
from the provider and patches the key into `secrets.env`.

### `PUT /admin/connections/profiles`

Update an existing profile by id (id provided inside `profile` object).

### `DELETE /admin/connections/profiles`

Delete by id:

```json
{ "id": "local-lmstudio" }
```

Error responses:

- `400 bad_request` -- malformed profile payload.
- `404 not_found` -- profile id not found.
- `409 conflict` -- duplicate create or profile currently referenced by assignments.

### `GET /admin/connections/profiles/:id`

Returns a single profile by URL parameter id.

```json
{
  "profile": {
    "id": "primary",
    "name": "Primary connection",
    "kind": "openai_compatible_remote",
    "provider": "openai",
    "baseUrl": "https://api.openai.com",
    "auth": {
      "mode": "api_key",
      "apiKeySecretRef": "env:OPENAI_API_KEY"
    }
  }
}
```

Error responses:

- `404 not_found` -- profile id not found.

### `PUT /admin/connections/profiles/:id`

Update a profile by URL parameter id. The `id` from the URL takes precedence
over any id in the request body.

Body:

```json
{
  "profile": {
    "name": "Updated Name",
    "kind": "openai_compatible_local",
    "provider": "ollama",
    "baseUrl": "http://host.docker.internal:11434",
    "auth": { "mode": "none" }
  }
}
```

Response:

```json
{ "ok": true, "profile": { "id": "primary", "..." : "..." } }
```

### `DELETE /admin/connections/profiles/:id`

Delete a profile by URL parameter id. No request body needed.

Response:

```json
{ "ok": true, "id": "primary" }
```

Error responses:

- `404 not_found` -- profile id not found.
- `409 conflict` -- profile currently referenced by assignments.

### `GET /admin/connections/assignments`

Returns canonical capability assignments:

```json
{
  "assignments": {
    "llm": { "connectionId": "primary", "model": "gpt-4.1-mini" },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  }
}
```

### `POST /admin/connections/assignments`

Save canonical assignments. Also writes the OpenCode provider config as a
side effect. If any `connectionId` does not exist in profiles, returns
`409 conflict`.

Response:

```json
{ "ok": true, "assignments": { "llm": { "..." : "..." }, "embeddings": { "..." : "..." } } }
```