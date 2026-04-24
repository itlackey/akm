# How OpenPalm Works — TLDR

OpenPalm is a local-first AI assistant platform. It runs as a Docker Compose
stack on your machine. Everything is LAN-only by default, nothing is in the
cloud, and all persistent data stays on your host.

---

## The Big Picture

```
You (browser / CLI / chat client)
        │
        ▼
   Caddy :80 (→ host:8080)    ← only public-facing ingress
   │         │
   ▼         ▼
Admin      Channel adapter (e.g. channel-chat :8181)
:8100            │
                 ▼
            Guardian :8080 (internal)   ← validates every channel message
                 │
                 ▼
            Assistant :4096             ← OpenCode runtime
                 │
                 ▼
            Admin API                   ← assistant requests stack ops here
```

> **Port note:** Caddy listens on port 80 inside its container, mapped to
> host port 8080. Guardian listens on port 8080 inside its container but is
> not exposed on the host — it is only reachable on the Docker network.
> They do not conflict because they are on different Docker networks.

Three hard rules define the whole design:
1. **Admin is the only component that touches Docker.**
2. **Every channel message goes through Guardian.** No exceptions.
3. **Assistant has no Docker socket.** It asks Admin to do things.

---