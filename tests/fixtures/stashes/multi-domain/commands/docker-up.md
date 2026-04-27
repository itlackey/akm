---
description: Bring up a docker-compose stack with healthcheck wait
---
# docker-up

Run `docker compose up -d` then poll `docker compose ps` until every service reports healthy or 90 seconds elapses. Exit non-zero if any service is unhealthy at the deadline.
