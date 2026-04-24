### 2.5 Docker Socket Proxy

| Host Path | Container Path | Mode | Purpose |
|---|---|---|---|
| `$OPENPALM_DOCKER_SOCK` | `/var/run/docker.sock` | **ro** | Docker daemon socket (proxy only) |

The `docker-socket-proxy` (Tecnativa) is the **only** container that mounts
the Docker socket. It exposes a filtered HTTP API on port 2375 within the
isolated `admin_docker_net` network — a dedicated network shared only with the
admin service. No other service can reach the proxy. The admin connects via
`DOCKER_HOST=tcp://docker-socket-proxy:2375`.

This eliminates Docker socket permission/GID issues across runtimes (Docker
Desktop, OrbStack, Colima, Podman). The admin never mounts the socket directly
and runs as a non-root user.

**`OPENPALM_DOCKER_SOCK`** is auto-detected by the setup scripts via
`docker context inspect` and written to `STATE_HOME/artifacts/stack.env`.
This supports Docker runtimes whose socket is not at the default
`/var/run/docker.sock` (e.g. OrbStack, Colima, Rancher Desktop).
If not set, it defaults to `/var/run/docker.sock`.

### 2.6 Admin

| Host Path | Container Path | Mode | Purpose |
|---|---|---|---|
| `$CONFIG_HOME` | `$CONFIG_HOME` (same path) | rw | Channel source files, secrets, extensions |
| `$DATA_HOME` | `$DATA_HOME` (same path) | rw | Manage system-policy files (stack.env, caddy/Caddyfile, automations/), pre-create subdirs |
| `$STATE_HOME` | `$STATE_HOME` (same path) | rw | Assembled runtime, audit logs |

The admin is the sole orchestrator. It connects to Docker via the socket proxy
(HTTP over the internal network) and mounts CONFIG_HOME, DATA_HOME, and
STATE_HOME. The DATA_HOME mount allows the admin to manage system-policy files
(`stack.env`, `caddy/Caddyfile`, `automations/`), pre-create subdirectories
with correct ownership, and seed missing defaults before other services start.

The admin container starts as root for scheduled automation setup, then
drops privileges to the target UID/GID (`$OPENPALM_UID:$OPENPALM_GID`,
default `1000:1000`) via gosu before running the SvelteKit app. Staged
automation files from `STATE_HOME/automations/` are installed on startup.
See [directory-structure.md](./directory-structure.md) for format and
configuration details.

---