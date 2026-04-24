## 10. Security Notes

- **Docker socket** — Only the `docker-socket-proxy` container mounts the
  Docker socket (read-only). The proxy lives on an isolated `admin_docker_net`
  network shared only with the admin — no other service can reach it. The
  proxy allowlists only the Docker API categories needed for compose operations.
- **Caddy config** — Caddyfile and channel routes mounted read-only (`:ro`).
- **ADMIN_TOKEN** — Required at startup (`${ADMIN_TOKEN:?...}`). The compose
  file will fail if unset in `secrets.env`.
- **Bind addresses** — All service ports default to `127.0.0.1` (localhost only).
- **UID/GID mapping** — The assistant, guardian, and admin run with the host
  user's UID/GID for correct file ownership on bind-mounted volumes.
- **Secrets isolation** — Most containers receive only the secrets they
  explicitly declare in their `environment:` block. The guardian loads the
  staged `stack.env` via `env_file` and reads all `CHANNEL_*_SECRET`
  variables at startup (and re-reads them at runtime from the bind-mounted
  file via `GUARDIAN_SECRETS_PATH`). Channel HMAC secrets are system-generated
  by the admin and stored in `DATA_HOME/stack.env`; they
  are never present in user-editable files.