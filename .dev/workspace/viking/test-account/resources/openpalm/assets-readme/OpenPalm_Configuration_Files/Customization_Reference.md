## Customization Reference

| What you want to change | What to edit |
|--------------------------|-------------|
| Add a channel | Drop a `.yml` into `registry/` (optionally add a `.caddy`) |
| Remove a channel | Delete the `.yml` (and `.caddy` if present) from `registry/` |
| Add HTTP routing to a channel | Create a `.caddy` file for it |
| Remove HTTP routing | Delete the `.caddy` file (channel becomes docker-network only) |
| Change channel access (LAN ↔ public) | Edit the `.caddy` file: add/remove `import public_access` |
| Change LAN IP ranges | Edit the `(lan_only)` snippet in `Caddyfile` |
| Restrict to localhost only | Change `(lan_only)` IPs to `127.0.0.1 ::1` |
| Change ingress port | Set `OPENPALM_INGRESS_PORT` in env file (default: 8080) |
| Change bind address | Set `OPENPALM_INGRESS_BIND_ADDRESS` in env file (default: 127.0.0.1) |
| Use different image registry | Set `OPENPALM_IMAGE_NAMESPACE` in env file |
| Change config location | Set `OPENPALM_CONFIG_HOME` in env file (default: ~/.config/openpalm) |
| Change data storage location | Set `OPENPALM_DATA_HOME` in env file (default: ~/.local/share/openpalm) |