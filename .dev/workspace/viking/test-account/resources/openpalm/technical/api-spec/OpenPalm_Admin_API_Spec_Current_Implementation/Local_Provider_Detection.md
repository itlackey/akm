## Local Provider Detection

### `GET /admin/providers/local`

Probes well-known local LLM provider endpoints to detect which are running.
During first-run setup, accepts the ephemeral setup token; after setup,
requires admin auth.

Probed providers:

| Provider | Probe URLs |
|----------|-----------|
| `model-runner` | `model-runner.docker.internal/engines/v1/models`, `:12434` variants, `localhost:12434` |
| `ollama` | `host.docker.internal:11434/api/tags`, `localhost:11434` |
| `lmstudio` | `host.docker.internal:1234/v1/models`, `localhost:1234` |

Response:

```json
{
  "providers": [
    { "provider": "model-runner", "url": "http://model-runner.docker.internal/engines", "available": true },
    { "provider": "ollama", "url": "", "available": false },
    { "provider": "lmstudio", "url": "", "available": false }
  ]
}
```