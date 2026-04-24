## 8. Start the stack

```bash
docker compose \
  -f ~/.local/state/openpalm/artifacts/docker-compose.yml \
  --env-file ~/.local/state/openpalm/artifacts/stack.env \
  --env-file ~/.local/state/openpalm/artifacts/secrets.env \
  --project-name openpalm \
  up -d
```

The admin starts first and runs an apply on startup, which re-stages config and starts the remaining services.

---

## 9. Verify

```bash
# Check all containers are running
docker compose --project-name openpalm ps

# Test admin health
curl -s http://localhost:8080/admin/health | head
```

The admin UI is available at `http://localhost:8080/admin/` (through Caddy) or directly at `http://localhost:8100/` (bypassing proxy). Both require the `x-admin-token` header for API calls.

---

## What the admin does on startup

When the admin container starts, it automatically runs an **apply** that:

1. Reads `CONFIG_HOME/channels/` and `CONFIG_HOME/automations/`
2. Stages compose overlays, Caddy routes, and automation files into `STATE_HOME`
3. Merges infrastructure config into `stack.env`
4. Runs `docker compose up -d` against staged files
5. Reloads Caddy with staged routes

This startup apply does not overwrite existing user files in `CONFIG_HOME`; it
only seeds missing defaults and restages runtime artifacts.

After the first apply, the admin manages `stack.env` and `STATE_HOME` — you only need to edit files in `CONFIG_HOME` and restart the admin (or call the apply API) to pick up changes. See [directory-structure.md](technical/directory-structure.md) for the full staging flow.

---

## Adding a channel manually

Channels are compose overlays placed in CONFIG_HOME. Example for the built-in chat channel:

1. Copy the channel definition into CONFIG_HOME:
   ```bash
   cp registry/channels/chat/chat.yml ~/.config/openpalm/channels/chat.yml
   # If it has a Caddy route:
   cp registry/channels/chat/chat.caddy ~/.config/openpalm/channels/chat.caddy
   ```

2. Restart the admin (or call `POST /admin/apply`) to stage and activate:
   ```bash
   docker compose --project-name openpalm restart admin
   ```

The admin auto-generates HMAC secrets for new channels and writes them to `stack.env`. See [managing-openpalm.md](managing-openpalm.md) for details.

---

## File summary

After completing all steps, your host should have:

```
~/.config/openpalm/                  # CONFIG_HOME
├── secrets.env                      # ADMIN_TOKEN + LLM keys
├── channels/                        # Channel overlays (.yml + .caddy)
├── automations/                     # User automation definitions
└── assistant/                       # OpenCode extensions
    ├── opencode.json
    ├── tools/
    ├── plugins/
    └── skills/

~/.local/share/openpalm/             # DATA_HOME
├── stack.env                        # System config (source of truth)
├── docker-compose.yml               # Core compose (source of truth)
├── memory/
│   └── default_config.json
├── assistant/
├── guardian/
├── automations/
└── caddy/
    ├── Caddyfile                    # Core Caddy config (source of truth)
    ├── data/
    └── config/

~/.local/state/openpalm/             # STATE_HOME
├── artifacts/
│   ├── docker-compose.yml           # Staged compose
│   ├── stack.env                    # Staged stack config
│   ├── secrets.env                  # Staged secrets
│   ├── Caddyfile                    # Staged Caddy config
│   └── channels/                    # Staged channel routes
├── automations/                     # Staged automation files
└── audit/                           # Audit logs

~/openpalm/                          # WORK_DIR (assistant workspace)
```

---

## Further reading

- [directory-structure.md](technical/directory-structure.md) — Full tree, volume mounts, networks
- [environment-and-mounts.md](technical/environment-and-mounts.md) — Every env var and mount point
- [core-principles.md](technical/core-principles.md) — Security invariants and architectural rules
- [managing-openpalm.md](managing-openpalm.md) — Channels, secrets, access control, automations
- [setup-guide.md](setup-guide.md) — Automated installer reference