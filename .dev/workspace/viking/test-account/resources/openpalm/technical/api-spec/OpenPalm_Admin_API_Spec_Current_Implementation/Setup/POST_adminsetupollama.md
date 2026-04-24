### `POST /admin/setup/ollama`

Starts the Ollama enable sequence in the background. Configures Ollama in
`stack.env`, starts the Ollama container, waits for health, and pulls default
models. Returns immediately. Poll `GET /admin/setup/ollama` for progress.

Auth: setup token or admin token.

Response:

```json
{
  "ok": true,
  "async": true,
  "phase": "starting",
  "message": "Ollama enable started in background. Poll GET /admin/setup/ollama for status."
}
```

Error responses:

- `503 docker_unavailable` -- Docker is not available.