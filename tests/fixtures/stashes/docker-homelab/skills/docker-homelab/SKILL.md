---
description: Manage docker-compose stacks in a single-host homelab environment
---
# Docker Homelab

End-to-end skill for running a docker-compose-based homelab on a single host. Covers stack composition, healthchecks, networking between services, persistent volumes, and routine troubleshooting.

## Stack composition

Use `docker-compose.yml` (compose v3+) to declare services. Pin image tags rather than `:latest`. Group related services under a single project so `docker compose up` brings the whole stack up.

## Healthchecks

Every long-running service should declare a `healthcheck` block. Prefer in-container probes (curl localhost, pg_isready, redis-cli ping) over external port probes. Use `depends_on.condition: service_healthy` to gate startup order.

## Networking

Default bridge networking is fine for most homelabs. Create one project network per stack so service names resolve via Docker's embedded DNS. Reverse proxy (caddy/traefik) sits on its own network and joins each stack network as needed.

## Volumes

Bind-mount config directories under `./config/<service>` so they live alongside the compose file in git. Use named volumes for opaque state (databases, caches) where bind mounts would leak permission issues.

Declare named volumes at the top-level `volumes:` key (no options required for the default local driver) and reference them in each service's `volumes:` list using `name:path` shorthand:

```yaml
services:
  db:
    image: postgres:16.2
    volumes:
      - dbdata:/var/lib/postgresql/data

volumes:
  dbdata:
```

The top-level `dbdata:` entry with no value tells Compose to manage the volume lifecycle. Docker creates it on first `up` and preserves it across restarts and recreates.

## Troubleshooting

`docker compose logs -f <service>` and `docker compose ps` are the first two commands for any incident. For network issues, `docker network inspect <name>` reveals which containers are attached and their resolved IPs.
