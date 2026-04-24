### `GET /admin/setup`

**No authentication required.** Returns setup status and which config keys are set
(booleans only, never values). During first-run (before setup is complete), also
returns an ephemeral `setupToken` for authenticating the setup POST.

Response:

```json
{
  "setupComplete": false,
  "installed": false,
  "setupToken": "abc123...",
  "detectedUserId": "node",
  "configured": {
    "OPENAI_API_KEY": false,
    "OPENAI_BASE_URL": false,
    "MEMORY_USER_ID": false,
    "GROQ_API_KEY": false,
    "MISTRAL_API_KEY": false,
    "GOOGLE_API_KEY": false,
    "OWNER_NAME": false,
    "OWNER_EMAIL": false
  }
}
```

### `POST /admin/setup`

Runs the setup wizard. During first-run, authenticates with the ephemeral
`setupToken` via `x-admin-token` header. After setup is complete, requires
normal admin auth.

Body:

```json
{
  "adminToken": "my-secure-token",
  "ownerName": "Jane Doe",
  "ownerEmail": "jane@example.com",
  "memoryUserId": "default_user",
  "ollamaEnabled": false,
  "connections": [
    {
      "id": "openai-1",
      "name": "OpenAI",
      "provider": "openai",
      "baseUrl": "",
      "apiKey": "sk-..."
    }
  ],
  "assignments": {
    "llm": {
      "connectionId": "openai-1",
      "model": "gpt-4o-mini",
      "smallModel": ""
    },
    "embeddings": {
      "connectionId": "openai-1",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  }
}
```

Required fields: `connections` (non-empty array), `assignments.llm` (`connectionId`, `model`),
`assignments.embeddings` (`connectionId`, `model`). All other fields are optional.

The endpoint:
1. Writes credentials to `CONFIG_HOME/secrets.env`
2. Persists connection profiles and capability assignments
3. Builds and writes Memory config
4. Starts background deployment: pulls images per-service, then runs `docker compose up`
5. Pushes config to Memory and provisions the user (fire-and-forget, after containers start)

Response:

```json
{
  "ok": true,
  "async": true,
  "started": ["caddy", "memory", "assistant", "guardian"],
  "dockerAvailable": true
}
```

The `async: true` flag indicates deployment runs in the background. Poll
`GET /admin/setup/deploy-status` for progress.

Error responses:

- `400 bad_request` -- Missing or invalid connections/assignments.
- `503 docker_unavailable` -- Docker is not available.

### `POST /admin/setup/models`

Proxy endpoint for listing available models during setup. Accepts the ephemeral
setup token for first-run authentication. Body and response same as
`POST /admin/memory/models`, but also accepts an optional `capability` field
(`"llm"` or `"embeddings"`) and validates the provider is within wizard scope.

### `GET /admin/setup/deploy-status`

Poll background deployment progress during setup. Auth: setup token during
wizard, admin token after setup.

Response (active deployment):

```json
{
  "active": true,
  "services": [
    { "service": "caddy", "label": "Caddy (reverse proxy)", "imageReady": true, "running": false }
  ],
  "allImagesReady": false,
  "allRunning": false,
  "error": null
}
```

Response (no active deployment):

```json
{ "active": false }
```

### `GET /admin/setup/ollama`

Poll background Ollama enable status. Returns the current phase of the
Ollama enable task. Auth: setup token or admin token.

Response (no active task):

```json
{ "active": false }
```

Response (active or terminal):

```json
{
  "active": true,
  "phase": "pulling",
  "message": "Pulling default models...",
  "ollamaUrl": "http://ollama:11434",
  "models": {
    "qwen2.5-coder:3b": { "ok": true },
    "nomic-embed-text": { "ok": false, "error": "..." }
  },
  "allModelsPulled": false,
  "defaultChatModel": "qwen2.5-coder:3b",
  "defaultEmbeddingModel": "nomic-embed-text"
}
```

Phases: `starting`, `waiting`, `pulling`, `done`, `error`.
Terminal states (`done`, `error`) are cleared after being consumed by one GET.