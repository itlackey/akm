## Key files reference

| File | Location | Purpose |
|------|----------|---------|
| `secrets.env` | CONFIG_HOME | Admin token, LLM provider API keys |
| `channels/*.yml` | CONFIG_HOME | Installed channel compose overlays |
| `channels/*.caddy` | CONFIG_HOME | Channel Caddy routes |
| `automations/*.yml` | CONFIG_HOME | User-defined scheduled automations |
| `assistant/` | CONFIG_HOME | User OpenCode extensions (tools, plugins, skills) |
| `stack.env` | DATA_HOME | Host-detected infrastructure config, channel HMAC secrets |
| `memory/` | DATA_HOME | Memory SQLite database and vector index |
| `assistant/` | DATA_HOME | System-managed OpenCode config |
| `caddy/` | DATA_HOME | TLS certificates and Caddy runtime config |
| `connections/profiles.json` | CONFIG_HOME | LLM connection profiles and role assignments |