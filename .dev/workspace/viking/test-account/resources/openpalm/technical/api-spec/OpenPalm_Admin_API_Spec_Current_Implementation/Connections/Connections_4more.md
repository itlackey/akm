## Connections

Manage LLM provider credentials and related configuration stored in
`CONFIG_HOME/secrets.env`. Values are patched in-place by `patchSecretsEnvFile`
-- existing keys not in the allowed set are never removed or overwritten.

### `GET /admin/connections`

Returns the canonical v1 DTO plus a compatibility `connections` map.

- `profiles` contains canonical connection profiles (`openai_compatible_remote` or `openai_compatible_local`).
- `assignments` contains canonical required-capability assignments (`llm`, `embeddings`).
- `connections` preserves the legacy masked key/value response for existing clients.

Response:

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
  ],
  "assignments": {
    "llm": {
      "connectionId": "primary",
      "model": "gpt-4.1-mini"
    },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  },
  "connections": {
    "OPENAI_API_KEY": "*********************1234",
    "ANTHROPIC_API_KEY": "",
    "GROQ_API_KEY": "",
    "MISTRAL_API_KEY": "",
    "GOOGLE_API_KEY": "",
    "SYSTEM_LLM_PROVIDER": "openai",
    "SYSTEM_LLM_BASE_URL": "",
    "SYSTEM_LLM_MODEL": "gpt-4o-mini",
    "OPENAI_BASE_URL": "",
    "EMBEDDING_MODEL": "text-embedding-3-small",
    "EMBEDDING_DIMS": "1536",
    "MEMORY_USER_ID": "default_user"
  }
}
```

Allowed keys (`ALLOWED_CONNECTION_KEYS`):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `GOOGLE_API_KEY`
- `SYSTEM_LLM_PROVIDER`
- `SYSTEM_LLM_BASE_URL`
- `SYSTEM_LLM_MODEL`
- `OPENAI_BASE_URL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMS`
- `MEMORY_USER_ID`

### `POST /admin/connections`

Supports three payload shapes:

1) **Canonical DTO (preferred)**

```json
{
  "profiles": [
    {
      "id": "primary",
      "name": "Primary connection",
      "kind": "openai_compatible_remote",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "auth": { "mode": "api_key" }
    }
  ],
  "assignments": {
    "llm": { "connectionId": "primary", "model": "gpt-4.1-mini" },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  },
  "memoryUserId": "default_user",
  "customInstructions": "",
  "memoryModel": ""
}
```

2) **Unified save (has `provider` key)**

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "baseUrl": "",
  "systemModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDims": 1536,
  "memoryUserId": "default_user",
  "customInstructions": "",
  "capabilities": ["llm", "embeddings"]
}
```

3) **Legacy key patch (compatibility)**

Patches one or more allowed keys into `CONFIG_HOME/secrets.env`. Keys not in
`ALLOWED_CONNECTION_KEYS` are silently ignored. Existing keys outside the
allowed set are preserved.

```json
{
  "OPENAI_API_KEY": "sk-...",
  "SYSTEM_LLM_PROVIDER": "anthropic"
}
```

Response (canonical DTO and unified save paths):

```json
{
  "ok": true,
  "pushed": true,
  "pushError": null,
  "dimensionWarning": null,
  "dimensionMismatch": false
}
```

Response (legacy key patch path):

```json
{ "ok": true, "updated": ["OPENAI_API_KEY", "SYSTEM_LLM_PROVIDER"] }
```

Error responses:

- `400 bad_request` -- No valid connection keys were provided.
- `500 internal_error` -- Failed to write `secrets.env`.

### `GET /admin/connections/status`

Checks whether the system LLM connection is configured. Returns `complete: true`
when both `SYSTEM_LLM_PROVIDER` and `SYSTEM_LLM_MODEL` are set. API keys are
never required (optional for all providers).

Response:

```json
{ "complete": true, "missing": [] }
```

`complete` is `true` when provider and model are set; `false` with `missing` listing what's absent.