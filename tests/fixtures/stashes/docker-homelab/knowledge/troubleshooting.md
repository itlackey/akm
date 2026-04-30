---
description: First-line troubleshooting steps for compose-based homelab incidents
---
# Troubleshooting

## Service won't start

1. `docker compose ps` — is it actually missing, or stuck in `Restarting`?
2. `docker compose logs --tail=200 <service>` — read the last error first.
3. `docker compose config` — verify the resolved compose file is what you expect after env-var substitution.

## Service is unhealthy

`docker inspect <container> --format '{{json .State.Health}}'` shows the last few healthcheck attempts including stderr. Most "unhealthy" issues are wrong probe paths or `start_period` set too short.

## Networking issue

1. `docker network inspect <network>` — is the container actually attached?
2. `docker compose exec <service> getent hosts <peer>` — does DNS resolve?
3. `docker compose exec <service> nc -vz <peer> <port>` — does the port respond?

## Disk full

Compose pulls and old containers accumulate. `docker system df` shows where the space went; `docker system prune -af --volumes` reclaims it. Be cautious with `--volumes` on prod-ish boxes — it deletes any unreferenced named volumes.

## Permissions

Bind-mounted directories often hit UID/GID mismatches. Either set `user:` in the compose file to match the host owner, or pre-create the directory with the container's expected UID.
