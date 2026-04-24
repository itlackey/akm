## Access Scope

Controls which IPs the admin UI and LAN channels accept.

| Scope | Accepts |
|---|---|
| `lan` (default) | Private network ranges + localhost |
| `host` | Localhost only |

The source of truth is the system-managed core Caddyfile at:

`~/.local/share/openpalm/caddy/Caddyfile`

`POST /admin/access-scope` updates that file and restages
`~/.local/state/openpalm/artifacts/Caddyfile`.

---

## OpenCode / Assistant Extensions

The assistant runs OpenCode. Core extensions are baked into the container
(`/etc/opencode`). User extensions overlay on top — no rebuild needed.

**To add a tool/plugin/skill:**

```bash
# Drop files into the matching subdirectory:
~/.config/openpalm/assistant/tools/my-tool.ts
~/.config/openpalm/assistant/plugins/my-plugin.ts
~/.config/openpalm/assistant/skills/my-skill/SKILL.md
```

OpenCode picks them up on next restart of the assistant container.

**To configure OpenCode (LLM provider, models, etc.):**

Edit `~/.config/openpalm/assistant/opencode.json` directly. If you use explicit
admin UI/API config actions (including assistant-triggered admin actions), they
write to the same `CONFIG_HOME` files.

---

## Apply / Sync

The admin assembles your config into runtime state via an **apply** action.
Apply runs automatically on admin startup. You can also trigger it manually.

Apply/install/update/startup/setup reruns/upgrades are safe to re-run: they do
not overwrite existing user config files in `CONFIG_HOME`. They may seed
missing default files.

**When apply runs:**
1. Assembles `STATE_HOME/artifacts/secrets.env` from user secrets + system-managed secrets
2. Copies core compose → `STATE_HOME/artifacts/docker-compose.yml`
3. Copies core Caddyfile (`DATA_HOME/caddy/Caddyfile`) → `STATE_HOME/artifacts/Caddyfile`
4. Stages channel `.yml` files → `STATE_HOME/artifacts/channels/`
5. Stages channel `.caddy` snippets → `STATE_HOME/artifacts/channels/lan/` or `channels/public/`
6. Runs `docker compose up`

**To trigger apply without a full reinstall:**

```bash
# Restart the admin container:
docker compose restart admin

# Or POST to install (idempotent — safe to re-run):
curl -X POST http://localhost:8100/admin/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

---

## Backup & Restore

```bash
# Backup: archive config + data (state is regenerated, optional)
tar czf openpalm-backup.tar.gz \
  ~/.config/openpalm \
  ~/.local/share/openpalm

# Restore: extract then restart
tar xzf openpalm-backup.tar.gz -C /
docker compose restart admin   # triggers apply
```

---

## Admin UI & Ports

| URL | Service |
|---|---|
| `http://localhost:8100/admin` | Admin UI (direct) |
| `http://localhost:8080/admin` | Admin UI via Caddy |
| `http://localhost:8080/opencode` | OpenCode assistant UI |
| `http://localhost:8765` | Memory API (direct) |
| `http://localhost:8765/docs` | Memory API docs (Swagger UI) |

All ports are `127.0.0.1`-bound by default. Caddy at `:8080` is the main ingress.

---