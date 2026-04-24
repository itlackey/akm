# OpenPalm Configuration Files

This directory contains the static infrastructure configuration for OpenPalm. These files work in two modes:

1. **Standalone** — Copy to a directory, create a `.env` or `secrets.env`, run `docker compose up`.
2. **Admin-managed** — The admin service bundles channel definitions from `registry/` at build time as a catalog. Channels are installed on demand via `POST /admin/channels/install`, which copies files to `CONFIG_HOME/channels/`. Channels can also be added manually by dropping files into the same directory.

`CONFIG_HOME` is the user-owned persistent source of truth. Automatic lifecycle
operations are non-destructive for existing user config files and only seed
missing defaults. Allowed writers: user direct edits; explicit admin UI/API
config actions; authenticated, allowlisted assistant calls on user request.
See [docs/core-principles.md](../docs/technical/core-principles.md) for the full
filesystem contract.

## File Layout

```
docker-compose.yml       # Core services (never changes for channel additions)
Caddyfile                # Core reverse proxy routes (auto-imports channel routes)
secrets.env              # Environment variable reference with documentation
```

Channel definitions live in the `registry/` directory at the repo root (see `registry/`).