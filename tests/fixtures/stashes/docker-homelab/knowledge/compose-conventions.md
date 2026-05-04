---
description: Project conventions for docker-compose files in a homelab repo
---
# Compose Conventions

## File layout

```
homelab/
  stacks/
    media/
      docker-compose.yml
      .env
      config/
        plex/
        sonarr/
    monitoring/
      docker-compose.yml
      .env
```

One stack per directory. The directory name is the compose project name (`COMPOSE_PROJECT_NAME` is set automatically). Keep stacks small enough that `docker compose up -d` from the directory brings the whole unit online.

## Image pinning

Always pin to a specific tag (`postgres:16.2`), never `:latest`. Use a renovate or dependabot config to bump pinned versions on a schedule rather than chasing rolling tags.

## Environment

Use a per-stack `.env` for non-secret configuration. Secrets go in a sibling `.env.secrets` that's gitignored, loaded via `env_file:`. Never commit credentials.

## Loading environment from a file

Use the `env_file:` field at the service level to load environment variables from a file. Both string and list forms are valid:

```yaml
services:
  app:
    image: myapp:1.0
    env_file: app.env
    # or as a list:
    # env_file:
    #   - app.env
```

The file is loaded relative to the compose file location. Use `env_file:` for general app configuration; secrets go in a separate `.env.secrets` (gitignored) also loaded via `env_file:` on services that need them.

## Restart policies

`restart: unless-stopped` is the right default for homelab. `always` makes maintenance painful; `on-failure` hides bugs.
