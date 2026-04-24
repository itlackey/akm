## 3. Secrets

Runtime configuration is split into two staged files in `STATE_HOME/artifacts/`:

- **`stack.env`** — ALL system-managed config. Source of truth is `DATA_HOME/stack.env` (seeded by setup.sh). Contains:
  - Infrastructure: paths, UID/GID, Docker socket, image namespace/tag, networking, Memory URLs
  - Channel HMAC keys: `CHANNEL_<NAME>_SECRET` (generated per channel, persisted in `DATA_HOME/stack.env`)
- **`secrets.env`** — a staged copy of `CONFIG_HOME/secrets.env`. By convention contains `ADMIN_TOKEN` and LLM provider keys; copied as-is.

Docker compose is invoked with both: `--env-file stack.env --env-file secrets.env`.

Channel HMAC secrets are persisted in `DATA_HOME/stack.env` and staged to `STATE_HOME/artifacts/stack.env` on every apply. Users typically only need to edit `CONFIG_HOME/secrets.env` for tokens and LLM keys.

Configuration changes are activated only through an explicit **apply** action:
the admin stages user config + system assets into STATE_HOME, then runs
compose operations and service reload/restarts from STATE_HOME. The admin also
runs apply automatically on application startup, so restarting the admin
container syncs latest configuration into runtime state when the app starts.

This automatic apply path is lifecycle sync, not config mutation: it does
not overwrite existing user configuration files in CONFIG_HOME. CONFIG_HOME
writes occur only through explicit user-intent actions (see
[core-principles.md](./core-principles.md) for the allowed-writers rule).

**User-managed** (`CONFIG_HOME/secrets.env` → staged to `STATE_HOME/artifacts/secrets.env`):

| Secret | Consumed By | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | admin, guardian, assistant | Admin API authentication |
| `OPENAI_API_KEY` | assistant, memory | OpenAI API key (optional) |
| `ANTHROPIC_API_KEY` | assistant | Anthropic API key (optional) |
| `GROQ_API_KEY` | assistant | Groq API key (optional) |
| `MISTRAL_API_KEY` | assistant | Mistral API key (optional) |
| `GOOGLE_API_KEY` | assistant | Google API key (optional) |

**System-managed** (persisted in `DATA_HOME/stack.env`, staged to `STATE_HOME/artifacts/stack.env`):

| Secret | Consumed By | Purpose |
|---|---|---|
| `CHANNEL_<NAME>_SECRET` | guardian, channel-\<name\> | HMAC signing key — generated per channel, never user-edited |

Channel HMAC secrets are generated when a channel is installed and reused on subsequent restarts.
They are written into `DATA_HOME/stack.env` and staged to `STATE_HOME/artifacts/stack.env` on each apply.

---