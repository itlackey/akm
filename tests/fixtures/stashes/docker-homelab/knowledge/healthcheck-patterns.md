---
description: Common docker-compose healthcheck recipes for typical homelab services
---
# Healthcheck Patterns

## HTTP services

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "http://localhost:8080/healthz"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 20s
```

`start_period` is critical for services with slow first-time migrations; without it the container is marked unhealthy before it finishes booting.

## Postgres

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
  interval: 10s
  timeout: 5s
  retries: 5
```

Note the `$$` to escape variable expansion in compose.

## Redis

```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]
  interval: 10s
  timeout: 3s
  retries: 5
```

## Gating dependent services

```yaml
depends_on:
  db:
    condition: service_healthy
```

Avoid the older shorthand list form — it only waits for "started," not "healthy."
