## After Setup

Once the wizard completes, your stack is running. Here's where everything lives:

### Access the UI

| URL | What |
|---|---|
| `http://localhost/` | Admin dashboard (via Caddy) |
| `http://localhost/opencode/` | OpenCode assistant UI |
| `http://localhost:8100/` | Admin API (direct, no proxy) |
| `http://localhost:8765/docs` | Memory API docs |

All ports are localhost-bound by default. Nothing is publicly exposed unless you explicitly change the access scope.

### Your files

`CONFIG_HOME` (default `~/.config/openpalm`) is your persistent source of truth.
Allowed writers are: direct edits, explicit admin UI/API config actions, and
authenticated assistant API actions on user request. See
[core-principles.md](technical/core-principles.md) for the full filesystem contract.
All of those paths write the same files:

| Path | Purpose |
|---|---|
| `secrets.env` | Admin token and LLM provider API keys |
| `channels/` | Channel compose overlays (`.yml`) and Caddy routes (`.caddy`) |
| `automations/` | Scheduled automations — see [Managing OpenPalm](managing-openpalm.md#automations) |
| `assistant/` | OpenCode extensions — tools, plugins, skills, and config |

You normally do not need to touch the other two directories directly. `DATA_HOME` is managed by the admin and services (stack.env, caddy, memory, etc.); `STATE_HOME` is the assembled runtime assembled by the admin. See [directory-structure.md](technical/directory-structure.md) for the complete layout.

### XDG path defaults

| Variable | Default |
|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` |
| `OPENPALM_WORK_DIR` | `~/openpalm` |

---

## Common Tasks

**Change an LLM API key:**
1. Edit `~/.config/openpalm/secrets.env`
2. Restart admin: `docker compose restart admin`

Or use the Connections page in the admin UI, or ask the assistant to perform the same authenticated config update through the admin API.

**Add a channel:**
Install from the registry via the admin UI, or manually drop a `.yml` (and optional `.caddy`) into `~/.config/openpalm/channels/` and restart admin.

**Check container status:**
```bash
curl http://localhost:8100/admin/containers/list \
  -H "x-admin-token: $ADMIN_TOKEN"
```

**View audit logs:**
```bash
tail -f ~/.local/state/openpalm/audit/admin-audit.jsonl
```

**Backup:**
```bash
tar czf openpalm-backup.tar.gz \
  ~/.config/openpalm \
  ~/.local/share/openpalm
```

See [managing-openpalm.md](managing-openpalm.md) for the full operations guide.

---