## Memory Configuration

Manage the Memory (mem0) LLM and embedding provider configuration stored
at `DATA_HOME/memory/default_config.json`. Changes are persisted to disk
and pushed to the running Memory container via its REST API (`PUT /api/v1/config/`).

### `GET /admin/memory/config`

Returns the persisted config, the live runtime config (if reachable), provider
lists, and known embedding dimension mappings.

Response:

```json
{
  "config": {
    "mem0": {
      "llm": { "provider": "openai", "config": { "model": "gpt-4o-mini", "temperature": 0.1, "max_tokens": 2000, "api_key": "env:OPENAI_API_KEY" } },
      "embedder": { "provider": "openai", "config": { "model": "text-embedding-3-small", "api_key": "env:OPENAI_API_KEY" } },
      "vector_store": { "provider": "qdrant", "config": { "collection_name": "memory", "path": "/data/qdrant", "embedding_model_dims": 1536 } }
    },
    "memory": { "custom_instructions": "" }
  },
  "runtimeConfig": null,
  "providers": {
    "llm": ["openai", "anthropic", "ollama", "groq", "together", "mistral", "deepseek", "xai", "lmstudio", "model-runner"],
    "embed": ["openai", "ollama", "huggingface", "lmstudio"]
  },
  "embeddingDims": {
    "openai/text-embedding-3-small": 1536,
    "ollama/nomic-embed-text": 768
  }
}
```

### `POST /admin/memory/config`

Saves a full Memory config to disk and pushes it to the running container.

Body: A complete `MemoryConfig` object (same shape as `config` in the GET response).

Response:

```json
{
  "ok": true,
  "persisted": true,
  "pushed": true,
  "pushError": null,
  "dimensionWarning": null,
  "dimensionMismatch": false
}
```

- `dimensionMismatch` is `true` when the new config's embedding dimensions
  differ from the previously persisted config. Requires a collection reset.
- `dimensionWarning` is a human-readable message when `dimensionMismatch` is `true`.

Error responses:

- `400 bad_request` -- Missing or invalid `mem0` structure.

### `POST /admin/memory/models`

Proxy endpoint for listing available models from a provider's API. Resolves
`env:` API key references server-side before making the upstream request.

Body:

```json
{
  "provider": "ollama",
  "apiKeyRef": "env:OPENAI_API_KEY",
  "baseUrl": "http://host.docker.internal:11434"
}
```

- `provider` (required) -- Must be a recognized LLM or embedding provider name.
- `apiKeyRef` -- Raw API key or `env:VAR_NAME` reference resolved from
  `process.env` then `CONFIG_HOME/secrets.env`.
- `baseUrl` -- Provider API base URL. Falls back to provider defaults when empty.

Provider API conventions:

| Provider | URL Pattern | Auth |
| -------- | ----------- | ---- |
| Ollama | `{baseUrl}/api/tags` | None |
| Anthropic | Static list (no API) | N/A |
| OpenAI, Groq, Mistral, Together, DeepSeek, xAI, LM Studio, Model Runner | `{baseUrl}/v1/models` | `Bearer {key}` (optional) |

Response:

```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "error": null }
```

On failure (unreachable provider, timeout, etc.):

```json
{ "models": [], "error": "Request timed out after 5s" }
```

Error responses:

- `400 bad_request` -- Invalid or missing provider name.

### `POST /admin/memory/reset-collection`

Deletes the embedded Qdrant vector data so the memory service recreates the
collection with the correct embedding dimensions on next restart. This is a
destructive operation that deletes all stored memories.

Response:

```json
{
  "ok": true,
  "collection": "memory",
  "restartRequired": true
}
```

The memory container must be restarted after a successful reset for the new
collection to be created.

Error responses:

- `502 collection_reset_failed` -- Failed to delete the Qdrant data directory.