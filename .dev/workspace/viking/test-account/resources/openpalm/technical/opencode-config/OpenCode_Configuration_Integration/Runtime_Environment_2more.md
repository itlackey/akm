## Runtime Environment

### Volume Mounts

Five non-overlapping mounts, each at a distinct container path:

| Host Path | Container Path | Purpose |
|---|---|---|
| `DATA_HOME/assistant` | `/etc/opencode` | System config (`OPENCODE_CONFIG_DIR`) — model, plugins, persona |
| `CONFIG_HOME/assistant` | `~/.config/opencode` | User extensions — custom tools, plugins, skills |
| `STATE_HOME/opencode` | `~/.local/state/opencode` | Logs and session state |
| `DATA_HOME/opencode` | `~/.local/share/opencode` | OpenCode data directory |
| `WORK_DIR` | `/work` | Project files |

### Environment Variables

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | System config directory (overrides user config) |
| `OPENCODE_PORT` | `4096` | Web-server listen port |
| `OPENCODE_AUTH` | `false` | Disabled — host-only binding (127.0.0.1) provides the security boundary |
| `OPENCODE_ENABLE_SSH` | `0` (default) | SSH server (disabled by default, toggleable) |
| `HOME` | `/home/opencode` | User home for dotfiles, caches, and user config |
| `OPENPALM_ADMIN_API_URL` | `http://admin:8100` | Admin API base URL (used by admin tools) |
| `OPENPALM_ADMIN_TOKEN` | *(from secrets.env)* | Bearer token for Admin API calls |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL (used by memory tools and plugin) |
| `MEMORY_USER_ID` | `default_user` | User identifier for memory operations |

LLM provider keys are passed through from the host:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `GROQ_API_KEY` | Groq provider |
| `MISTRAL_API_KEY` | Mistral provider |
| `GOOGLE_API_KEY` | Google AI provider |

---

## System Config (`DATA_HOME/assistant/`)

System config is managed by the admin control plane. Files are seeded by
`ensureOpenCodeSystemConfig()` (called on every install, update, and startup)
and overwritten when the bundled version changes (with backup).

### opencode.jsonc

Declares plugins for auto-install and security rules. The model is not
set here; it comes from the user's connection setup (see below):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openpalm/assistant-tools", "akm-opencode"],
  "permission": {
    "read": {
      "/home/opencode/.local/share/opencode/auth.json": "deny",
      "/home/opencode/.local/share/opencode/mcp-auth.json": "deny"
    }
  }
}
```

The `permission.read` deny rules prevent the assistant from reading
credential files that contain session tokens. This is part of the
context window protection strategy (see below).

The model is **not** set in the system config. It is determined by the
user's connection setup: the setup wizard or admin UI writes the selected
model to `CONFIG_HOME/assistant/opencode.json`, which OpenCode picks up
as the user config layer.

### AGENTS.md

Persona definition for the OpenPalm assistant. Describes role, memory
guidelines, behavior rules, and available skills.

---