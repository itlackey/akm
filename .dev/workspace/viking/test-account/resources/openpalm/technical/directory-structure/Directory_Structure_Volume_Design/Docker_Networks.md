## Docker Networks

| Network | Services | Purpose |
|---------|----------|---------|
| `assistant_net` | caddy, memory, assistant, guardian, admin | Internal service mesh |
| `channel_lan` | caddy, guardian, channel services | LAN-restricted channel access |
| `channel_public` | caddy, guardian, channel services | Publicly accessible channels |

Channel compose overlays specify which network they join. HTTP routing access is
controlled by staged `.caddy` files: routes are LAN-restricted by default and
become public only when the source `.caddy` includes `import public_access`.
A channel with no `.caddy` file gets no HTTP route regardless of network — it's
only reachable on the Docker network.

---