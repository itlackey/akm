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

## IPv6

Most homelab setups disable IPv6 in the daemon config. If you need it, declare `enable_ipv6: true` per network and assign static `/64` subnets per stack.
