## Tools

Tools are TypeScript files provided by the `@openpalm/assistant-tools` plugin
(auto-installed at runtime). They fall into two groups:

### Admin Tools

These call the Admin API at `$OPENPALM_ADMIN_API_URL` using
`$OPENPALM_ADMIN_TOKEN` for authentication.

| Tool | Purpose |
|---|---|
| `admin-lifecycle` | Start, stop, and restart stack services |
| `admin-containers` | List running containers and their status |
| `admin-config` | Read and update the network access scope |
| `admin-artifacts` | Inspect generated compose/caddy/env artifacts |
| `admin-audit` | Query the admin audit log |
| `admin-channels` | List installed and available channels |

### Memory Tools

These call the Memory API service at `$MEMORY_API_URL`.

| Tool | Purpose |
|---|---|
| `memory-search` | Semantic search across stored memories |
| `memory-add` | Store a new memory |
| `memory-get` | Retrieve a specific memory by ID |
| `memory-list` | List memories with optional filters |
| `memory-update` | Update an existing memory |
| `memory-delete` | Delete a memory |
| `memory-stats` | Get memory store statistics |
| `memory-apps` | List applications that have stored memories |

### Utility Tools

| Tool | Purpose |
|---|---|
| `health-check` | Verify connectivity to stack services |

---

## Plugins

### memory-context.ts

The memory-context plugin provides "compound memory" — the assistant
accumulates knowledge over time and recalls it automatically. It hooks into two
OpenCode lifecycle events:

**`experimental.session.compacting`** — When the context window is compacted,
the plugin searches Memory for relevant context (user preferences, project
decisions) and injects it into the compaction output so that memories survive
the context window reset.

**`shell.env`** — Injects `MEMORY_API_URL` and `MEMORY_USER_ID` into
the shell environment so that child processes and tools can resolve the memory
service.

---

## Skills

Skills are markdown reference documents that OpenCode surfaces on demand:

| Skill | File | Purpose |
|---|---|---|
| `memory` | `skills/memory/SKILL.md` | How to use compound memory with Memory |
| `openpalm-admin` | `skills/openpalm-admin/SKILL.md` | Admin API reference for the assistant |

---

## User Extensions

Users can add their own tools, plugins, or skills without rebuilding the image.

**Host path:** `$OPENPALM_CONFIG_HOME/assistant/`
**Container path:** `/home/opencode/.config/opencode/`

This directory lives under CONFIG_HOME — the user-owned persistent source of truth for all
editable configuration. It is bind-mounted into the assistant container at the
standard OpenCode user config path.

This is created by `ensureXdgDirs()` during installation and persists across
container restarts. `ensureOpenCodeConfig()` (called on every install and
update) seeds a starter `opencode.json` (schema reference only) and creates
the `tools/`, `plugins/`, and `skills/` subdirectories if they are absent.
The config file is never overwritten once it exists, so user edits are safe.

OpenCode merges configuration from both `~/.config/opencode/` (user) and
`OPENCODE_CONFIG_DIR` (system), so user-added extensions complement the
system-managed set.

---