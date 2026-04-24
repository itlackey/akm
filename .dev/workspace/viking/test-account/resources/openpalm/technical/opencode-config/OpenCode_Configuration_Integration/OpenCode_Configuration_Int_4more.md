# OpenCode Configuration Integration

This document explains how OpenPalm integrates with
[OpenCode](https://opencode.ai) — the AI coding runtime that powers the
assistant service.

---

## Overview

`CONFIG_HOME` is the user-owned persistent source of truth for all OpenCode
user extensions. See [core-principles.md](./core-principles.md) for the
full allowed-writers policy and filesystem contract.

OpenCode supports a layered configuration model. OpenPalm uses three layers:

1. **User config** — persisted on the host at
   `$OPENPALM_CONFIG_HOME/assistant/` and bind-mounted into the container at
   `~/.config/opencode/`. Users can add custom tools, plugins, or skills here.
   This is the lowest-precedence layer.
2. **System config** — persisted on the host at
   `$OPENPALM_DATA_HOME/assistant/` and bind-mounted into the container at
   `/etc/opencode/` via `OPENCODE_CONFIG_DIR`. Contains plugin declarations
   and persona (AGENTS.md). Overrides user config for keys it sets.
3. **Project config** — an `opencode.json` in the `/work` directory (if present).
   Highest precedence, overrides everything.

Plugins declared in the system config (`@openpalm/assistant-tools`,
`akm-opencode`) are auto-installed by OpenCode at startup via `bun` —
no `npm install` in the Dockerfile.

---

## Build-Time: Image Contents

The `core/assistant/Dockerfile` installs OpenCode, Bun, and system tools.
It does **not** bake in plugins, config files, or persona — those are
mounted at runtime.

```dockerfile
FROM node:lts-trixie
RUN apt-get update && apt-get install -y tini curl git ca-certificates bash openssh-server python3 python3-pip
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path
RUN mkdir -p /home/opencode /work && chown node:node /home/opencode /work
COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
```

---

## Startup: Entrypoint Script

When the container starts, `entrypoint.sh` runs via `tini`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

# 1. Optionally start SSH daemon (key-only, no root, no tunneling)
if [ "$ENABLE_SSH" = "1" ] || [ "$ENABLE_SSH" = "true" ]; then
  # ... SSH setup (authorized_keys, host keys, sshd) ...
fi

# 2. Start the OpenCode web server
cd /work
exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
```

OpenCode discovers tools, plugins, and skills from both `OPENCODE_CONFIG_DIR`
and `~/.config/opencode/`. Plugins declared in the config are auto-installed
on first boot (cached at `~/.cache/opencode/node_modules/`).

---