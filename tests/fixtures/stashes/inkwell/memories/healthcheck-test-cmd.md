---
description: Docker Compose healthcheck test field requires array form or CMD-SHELL wrapper — bare strings are invalid
tags: [docker, docker-compose, healthcheck, yaml, inkwell]
observed_at: "2026-05-01"
---

Docker Compose `healthcheck.test` must be either an array starting with `CMD` or `CMD-SHELL`, or the string `NONE`.

Correct array form (exec directly, no shell):
`test: ["CMD", "redis-cli", "ping"]`

Correct shell form (needed for pipes, env vars, or shell builtins):
`test: ["CMD-SHELL", "redis-cli ping || exit 1"]`

Common trap — bare string without wrapper:
`test: redis-cli ping` — Docker interprets this as a custom command string in the legacy format and may silently treat it as `CMD-SHELL`, but compose schema validation rejects it and some engines ignore the healthcheck entirely.

Second common trap — omitting the `CMD`/`CMD-SHELL` sentinel in the array:
`test: ["redis-cli", "ping"]` — Docker requires the first element to be `CMD` or `CMD-SHELL`; without it the healthcheck is misconfigured and always reports unhealthy.
