---
description: Networking patterns for multi-stack homelab compose setups
---
# Homelab Networking

## One network per stack

Each compose file creates its own bridge network by default. Service names resolve via Docker's embedded DNS within that network.

## Reverse proxy attachment

The reverse proxy (caddy, traefik, nginx-proxy-manager) lives in its own stack with an external network:

```yaml
networks:
  proxy:
    external: true
```

Other stacks then attach the services they want exposed:

```yaml
services:
  app:
    networks:
      - default
      - proxy
networks:
  proxy:
    external: true
```

This keeps internal service-to-service traffic on the stack's private network and only exposes what the proxy needs to reach.

## DNS resolution

Containers reach each other by service name within the same network. Across networks, use the proxy or a fully-qualified container name. Avoid hardcoding container IPs — they change on recreate.

## Custom named networks

Declare a named network at the top-level `networks:` key and attach services to it by listing the network name under each service's `networks:` key.

```yaml
services:
  service-a:
    image: myapp:1.0
    networks:
      - backend

  service-b:
    image: myworker:1.0
    networks:
      - backend

networks:
  backend:
    driver: bridge
```

Services on the same named network can reach each other by container name (e.g., `service-a` can connect to `service-b:8080`).

## IPv6

Most homelab setups disable IPv6 in the daemon config. If you need it, declare `enable_ipv6: true` per network and assign static `/64` subnets per stack.
