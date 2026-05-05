---
description: Docker container management reference documentation
tags:
  - docker
  - containers
  - reference
quality: curated
---
# Container Management Reference

## Running Containers

Use `docker run` to start containers from images.

```bash
docker run -d --name myapp -p 8080:80 nginx:latest
```

## Inspecting Containers

```bash
docker inspect myapp
docker logs myapp
docker stats myapp
```

## Container Lifecycle

- `docker start` / `docker stop` — start or stop a container
- `docker restart` — restart a running container
- `docker rm` — remove a stopped container
- `docker exec` — run a command inside a running container
