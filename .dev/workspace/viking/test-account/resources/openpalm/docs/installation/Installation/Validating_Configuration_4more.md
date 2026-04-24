## Validating Configuration

The `openpalm validate` command checks `CONFIG_HOME/secrets.env` against the schema at `assets/secrets.env.schema`. It downloads the `varlock` binary on first use and caches it in `STATE_HOME/bin/`.

```bash
openpalm validate
```

Output is human-readable. The command exits `0` when all required variables are present and valid, and exits non-zero when there are validation errors. Warnings are printed but do not affect the exit code.

---

## CLI Command Reference

| Command | Description |
|---|---|
| `openpalm install` | Full install or update: creates directories, downloads assets, starts the stack |
| `openpalm validate` | Validates `CONFIG_HOME/secrets.env` against the schema |
| `openpalm start` | Start all stack services |
| `openpalm stop` | Stop all stack services |
| `openpalm restart` | Restart all stack services |
| `openpalm logs [service]` | Stream container logs (all services, or a specific one) |
| `openpalm status` | Show running container status |
| `openpalm update` | Pull latest images and restart services |
| `openpalm uninstall` | Stop services and remove OpenPalm data directories |
| `openpalm service` | Manage individual services (start, stop, restart a single container) |

Run `openpalm --help` or `openpalm <command> --help` for flags and options.

---

## XDG Path Defaults

| Variable | Default (Linux/macOS) | Purpose |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User-owned persistent config (secrets, channels, assistant config) |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Service data (memory DB, Caddy certs, `host.json`) |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Generated runtime artifacts (compose files, Caddyfile, audit logs) |

On Windows the defaults follow `%APPDATA%` / `%LOCALAPPDATA%` conventions.

Automatic lifecycle operations (install, update, setup reruns) are non-destructive for existing files in `CONFIG_HOME` — they only seed missing defaults.

---

## Next Steps

| Guide | Description |
|---|---|
| [setup-walkthrough.md](setup-walkthrough.md) | Screen-by-screen walkthrough of the setup wizard |
| [system-requirements.md](system-requirements.md) | CPU, RAM, disk, and network requirements |
| [managing-openpalm.md](managing-openpalm.md) | Day-to-day administration: secrets, channels, access control |
| [troubleshooting.md](troubleshooting.md) | Common problems and solutions |