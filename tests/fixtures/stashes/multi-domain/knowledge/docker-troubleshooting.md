---
description: First-line diagnostics for failing Docker containers
---
# Docker Troubleshooting

`docker compose ps` reveals which services are stopped or restarting. `docker compose logs --tail=200 <svc>` is the next step. For network problems, `docker network inspect <name>` shows attached containers and resolved IPs.
