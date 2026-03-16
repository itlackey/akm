# OpenViking Test Fixture

Local OpenViking server for manual testing of the `openviking` stash provider
and `akm show viking://...` remote show support.

## Prerequisites

- Docker and Docker Compose

## Quick Start

```sh
cd tests/fixtures/openviking

# Start the server
docker compose up -d

# Seed content (wait a few seconds for startup)
./seed.sh

# Register with akm
akm sources add http://localhost:1933 --provider openviking

# Test remote show
akm show viking://resources/project-context/project-context.md

# Tear down
docker compose down
```

## Configuration

`ov.conf` configures the server:
- **Workspace**: `/workspace` (mapped from `.dev/workspace` at repo root)
- **Embedding**: OpenAI-compatible provider (pointed at localhost — embedding
  will fail without a real service, but content read/stat APIs still work)
- **Server**: Bound to `0.0.0.0:1933` with test API key `akm-test-key`
- **Auth**: The provider should be configured with `options.apiKey: "akm-test-key"`

To use with akm's openviking provider including auth:
```sh
akm sources add http://localhost:1933 \
  --provider openviking \
  --options '{"apiKey":"akm-test-key"}'
```

## Directory Structure

```
tests/fixtures/openviking/
  content/              # Seed files (git-tracked)
    memories/           #   Memory markdown files
    resources/          #   Resource markdown files
  docker-compose.yml    # Server definition
  ov.conf               # Server config
  seed.sh               # Copies content/ to workspace and ingests via API
  README.md

.dev/workspace/         # OV runtime data (gitignored, created by docker)
  vectordb/             #   Vector index storage
  viking/               #   OV internal file system
  memories/             #   Seed files (copied by seed.sh)
  resources/            #   Seed files (copied by seed.sh)
```

## Embedding / Semantic Search

Semantic search (`POST /api/v1/search/find`) requires a working embedding service.
To enable it, either:

1. Run Ollama locally and update `ov.conf` to point at it:
   ```json
   "api_base": "http://host.docker.internal:11434/v1"
   ```
2. Use an OpenAI API key in `ov.conf`

Without embeddings, text search (`grep`) and content read/stat APIs still work.
