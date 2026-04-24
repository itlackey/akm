## Volume Mounts

Each container mounts only what it needs. The table below shows every bind
mount in the stack.

### Caddy (Reverse Proxy)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$STATE_HOME/artifacts/Caddyfile` | `/etc/caddy/Caddyfile` | ro | Staged Caddy config |
| `$STATE_HOME/artifacts/channels` | `/etc/caddy/channels` | ro | Staged channel `.caddy` route files |
| `$DATA_HOME/caddy/data` | `/data/caddy` | rw | TLS certificates and state |
| `$DATA_HOME/caddy/config` | `/config/caddy` | rw | Caddy runtime config |

The staged Caddyfile includes `import channels/public/*.caddy` and
`import channels/lan/*.caddy` — Caddy loads staged route files from
`/etc/caddy/channels/` at startup. Adding or removing a `.caddy` file in
CONFIG_HOME/channels/ requires an apply action that re-stages channel files
into STATE_HOME/artifacts/channels before Caddy reload.

The source-of-truth core Caddyfile is `DATA_HOME/caddy/Caddyfile` and is
system-managed by admin logic.

### Memory

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/memory` | `/data` | rw | Memory service data |
| `$DATA_HOME/memory/default_config.json` | `/app/default_config.json` | ro | mem0 LLM/embedder config |

### Assistant (OpenCode Runtime)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/assistant` | `/etc/opencode` | rw | System config (`OPENCODE_CONFIG_DIR`) — model, plugins, persona |
| `$CONFIG_HOME/assistant` | `/home/opencode/.config/opencode` | rw | User extensions — custom tools, plugins, skills |
| `$STATE_HOME/opencode` | `/home/opencode/.local/state/opencode` | rw | Logs and session state |
| `$DATA_HOME/opencode` | `/home/opencode/.local/share/opencode` | rw | OpenCode data directory |
| `$OPENPALM_WORK_DIR` | `/work` | rw | Working directory for projects |

Users drop tools, plugins, or skills into `CONFIG_HOME/assistant/` and they
appear inside the container at the standard OpenCode user config path. This
complements the system config at `/etc/opencode/` without requiring a rebuild.

### Guardian

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/guardian` | `/app/data` | rw | Guardian runtime data |
| `$STATE_HOME/audit` | `/app/audit` | rw | Guardian audit log (guardian-audit.log) |
| `$STATE_HOME/artifacts/stack.env` | `/app/secrets/stack.env` | ro | Channel HMAC secrets (file-based discovery) |

The guardian discovers channel secrets via the `loadChannelSecrets()` function
(server.ts). It reads from the bind-mounted `stack.env` file at the path
specified by `GUARDIAN_SECRETS_PATH` (default: `/app/secrets/stack.env`).
If the file is unavailable, it falls back to reading `CHANNEL_*_SECRET`
environment variables directly (useful for dev/test without a secrets file).