## Automations

You can schedule recurring tasks — like backups, cleanup scripts, or health checks —
by dropping a `.yml` file into `~/.config/openpalm/automations/`.

Automations run in-process using the Croner scheduler (no system cron required).
The admin container does not need root privileges.

### How to add an automation

1. Create a `.yml` file in `~/.config/openpalm/automations/`
2. Define a schedule and action (see format below)
3. Restart admin to activate: `docker compose restart admin`

**Example** — pull the latest container images every Sunday at 3 AM:

```yaml
# ~/.config/openpalm/automations/update-containers.yml
name: Update Containers
description: Pull latest images and recreate containers weekly
schedule: weekly-sunday-3am
enabled: true

action:
  type: api
  method: POST
  path: /admin/containers/pull
  timeout: 300000
```

OpenPalm ships several ready-to-use examples in `registry/automations/` — install them
from the Registry tab in the admin console, or copy any of them into `~/.config/openpalm/automations/` to activate:

| File | What it does |
|---|---|
| `health-check.yml` | Check admin health every 5 minutes |
| `prompt-assistant.yml` | Send a daily prompt to the assistant via the chat channel |
| `cleanup-logs.yml` | Weekly trim audit logs to prevent unbounded disk growth |
| `update-containers.yml` | Weekly pull latest images and recreate containers |

### Automation YAML format

```yaml
name: My Automation          # optional display name
description: What it does    # optional
schedule: every-5-minutes    # cron expression or preset name
timezone: UTC                # optional, default UTC
enabled: true                # optional, default true

action:
  type: api                  # "api" | "http" | "shell"
  method: GET
  path: /health
  timeout: 30000             # optional, ms

on_failure: log              # "log" (default) | "audit"
```

### Action types

| Type | Purpose | Key fields |
|---|---|---|
| `api` | Admin API call — auto-injects admin token and `x-requested-by: automation` | `method`, `path`, `body?`, `headers?` |
| `http` | Any HTTP endpoint — no auto-auth | `method`, `url`, `body?`, `headers?` |
| `shell` | Run a command via `execFile` (argument array, no shell interpolation) | `command` (string array) |

### Schedule presets

You can use a human-readable preset name instead of a cron expression:

| Preset | Cron |
|---|---|
| `every-minute` | `* * * * *` |
| `every-5-minutes` | `*/5 * * * *` |
| `every-15-minutes` | `*/15 * * * *` |
| `every-hour` | `0 * * * *` |
| `daily` | `0 0 * * *` |
| `daily-8am` | `0 8 * * *` |
| `weekly` | `0 0 * * 0` |
| `weekly-sunday-3am` | `0 3 * * 0` |
| `weekly-sunday-4am` | `0 4 * * 0` |

Or use standard cron syntax directly (e.g., `"0 2 * * *"` for daily at 2 AM).

### Rules

- **Filenames** must use `.yml` extension (e.g., `backup.yml`, `weekly-cleanup.yml`)
- Filenames must be lowercase letters, numbers, and hyphens only (before the `.yml` extension)
- Automations run in-process on the **admin container**, which has access to Docker (via socket proxy), your config, and data directories
- Shell actions use `execFile` with an argument array — no shell interpolation for security

### When do changes take effect?

Automation files are picked up during **apply** (admin startup) and whenever
channels are installed or uninstalled. After adding or editing a file, restart
admin to activate:

```bash
docker compose restart admin
```

### Overriding system automations

OpenPalm may ship system-managed automations in `~/.local/share/openpalm/automations/`.
If you create a user file with the **same name**, your version takes priority.
You don't need to edit system files directly.

---