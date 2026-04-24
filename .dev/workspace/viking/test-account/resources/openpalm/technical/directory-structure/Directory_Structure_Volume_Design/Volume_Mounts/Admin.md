### Admin

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$CONFIG_HOME` | `$CONFIG_HOME` (same path) | rw | Channel files, secrets, extensions |
| `$DATA_HOME` | `$DATA_HOME` (same path) | rw | Pre-create DATA_HOME subdirs, ensure ownership |
| `$STATE_HOME` | `$STATE_HOME` (same path) | rw | Assembled runtime, audit logs, staged automations |

The admin accesses Docker via the socket proxy (HTTP over `admin_docker_net`).
It mounts CONFIG_HOME, DATA_HOME, and STATE_HOME using identical
host-to-container paths, and uses `process.env.OPENPALM_*` to resolve paths
at runtime. The DATA_HOME mount allows the admin to manage system-policy files
(`stack.env`, `caddy/Caddyfile`, `automations/`), pre-create subdirectories
with correct ownership, and seed missing defaults before other services start.

Scheduled automations run in-process on the admin container using the
Croner scheduler. Staged YAML automation files from `STATE_HOME/automations/`
are loaded on startup. The admin container runs as non-root (USER node).
See the Automations section below for file format and configuration.

---