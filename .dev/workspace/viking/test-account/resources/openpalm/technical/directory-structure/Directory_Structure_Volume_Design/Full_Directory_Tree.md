## Full Directory Tree

```
CONFIG_HOME (~/.config/openpalm/)
├── secrets.env              # User secrets only: ADMIN_TOKEN and LLM provider keys
├── connections/             # Canonical connection profile storage (user-editable JSON)
│   └── profiles.json        # Canonical profiles + assignments (v1 schema)
├── channels/                # Installed channel definitions (populated via admin API or manually)
│   ├── <name>.yml           # Compose overlay for channel-<name> (installed from registry or manually added)
│   └── <name>.caddy         # Caddy route (optional — installed alongside .yml)
├── automations/             # Scheduled automations (YAML format, executed in-process)
│   └── <name>.yml          # Automation YAML file: schedule, action type, and config
└── assistant/               # OpenCode user extensions (tools, plugins, skills)
    ├── opencode.json        # User OpenCode config (schema ref only; never overwritten)
    ├── tools/               # Custom tool definitions
    ├── plugins/             # Custom plugin definitions
    └── skills/              # Custom skill definitions

STATE_HOME (~/.local/state/openpalm/)
├── artifacts/
│   ├── docker-compose.yml   # Staged core compose file
│   ├── stack.env            # Staged stack config (merged from DATA_HOME/stack.env + admin-managed values)
│   ├── secrets.env          # Staged copy of CONFIG_HOME/secrets.env
│   ├── manifest.json        # Artifact checksums & timestamps
│   ├── Caddyfile            # Staged Caddy config (copied from DATA_HOME/caddy/Caddyfile)
│   └── channels/            # Staged channel overlays/snippets used at runtime
├── automations/             # Staged automation YAML files (assembled from DATA_HOME + CONFIG_HOME)
│   └── <name>.yml          # Staged automation YAML loaded by in-process scheduler
└── audit/
    ├── admin-audit.jsonl    # Admin audit log
    └── guardian-audit.log    # Guardian audit log

DATA_HOME (~/.local/share/openpalm/)
├── stack.env                # Source of truth for host-detected infrastructure config
├── admin/                   # Admin runtime home (varlock state, future per-admin cache)
├── memory/              # Memory persistent data (SQLite + embedded Qdrant)
├── assistant/               # System-managed OpenCode config (opencode.jsonc, AGENTS.md)
├── opencode/                # OpenCode data directory
├── guardian/                 # Guardian runtime data
├── automations/             # System-managed automations (YAML, pre-installed, survive updates)
│   └── <name>.yml          # System automation YAML file
└── caddy/
    ├── Caddyfile            # System-managed core Caddy policy source
    ├── data/                # Caddy TLS certificates
    └── config/              # Caddy runtime config
```

---