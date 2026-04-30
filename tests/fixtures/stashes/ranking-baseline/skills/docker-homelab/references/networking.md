# Docker Networking Reference

## Network Types

- **bridge** — default network for standalone containers
- **host** — share the host network stack
- **overlay** — multi-host networking for Swarm
- **macvlan** — assign MAC addresses to containers

## Creating Networks

```bash
docker network create --driver bridge my-network
docker run --network my-network myapp
```

## Inspecting Networks

```bash
docker network ls
docker network inspect bridge
```
