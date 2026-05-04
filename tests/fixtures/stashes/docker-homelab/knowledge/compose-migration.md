---
description: Migrating Docker Compose files from v2 to v3 format
---
# Docker Compose v2 → v3 Migration

## Version string

Change `version: "2"` (or `"2.x"`) to `version: "3.8"`.

## Removed service-level keys

These v2 keys are not valid in v3 and must be removed entirely:

| v2 key | v3 alternative |
|---|---|
| `mem_limit` | `deploy.resources.limits.memory` (Swarm only) |
| `cpu_shares` | `deploy.resources.limits.cpus` (Swarm only) |
| `volume_driver` | (remove; specify driver in top-level `volumes:`) |
| `cpuset` | (no direct v3 equivalent; remove) |
| `cpu_quota` | (no direct v3 equivalent; remove) |

For non-Swarm deployments (typical homelab), simply delete these keys. Do not add `deploy:` blocks unless running in Swarm mode.

## What stays the same

Service images, ports, environment, volumes, networks, depends_on, restart, and healthcheck all work identically in v3.
