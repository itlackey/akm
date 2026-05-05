---
description: Docker Compose configuration reference
tags:
  - docker
  - compose
  - reference
quality: curated
---
# Docker Compose Reference

## Basics

Docker Compose defines multi-container applications in a YAML file.

```yaml
version: "3.8"
services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
```

## Common Commands

- `docker compose up -d` — start services in background
- `docker compose down` — stop and remove containers
- `docker compose logs` — view service logs
- `docker compose ps` — list running services
