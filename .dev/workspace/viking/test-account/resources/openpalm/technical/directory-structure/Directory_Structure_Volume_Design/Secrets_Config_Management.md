## Secrets & Config Management

All runtime configuration is split into two staged env files in `STATE_HOME/artifacts/`:

### `stack.env` — ALL system-managed config

The source of truth is `DATA_HOME/stack.env`, seeded by `setup.sh` (or
`scripts/dev-setup.sh --seed-env` in dev). Contains host-detected infrastructure
config. The admin reads, merges, and updates this file on each apply — it is
system-managed and not intended for direct user editing:

- **XDG paths:** `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_WORK_DIR`
- **User/Group:** `OPENPALM_UID`, `OPENPALM_GID` (auto-detected from host)
- **Docker Socket:** `OPENPALM_DOCKER_SOCK` (auto-detected, supports OrbStack/Colima)
- **Images:** `OPENPALM_IMAGE_NAMESPACE`, `OPENPALM_IMAGE_TAG`
- **Networking:** `OPENPALM_INGRESS_BIND_ADDRESS`, `OPENPALM_INGRESS_PORT`
- **Memory:** `MEMORY_DASHBOARD_API_URL`, `MEMORY_USER_ID`
- **Channel HMAC keys:** `CHANNEL_<NAME>_SECRET` (auto-generated per channel by admin)

On each apply, the admin reads `DATA_HOME/stack.env`, merges in its dynamic
values (`OPENPALM_SETUP_COMPLETE`, `CHANNEL_*_SECRET`),
updates `DATA_HOME/stack.env`, and stages the result to
`STATE_HOME/artifacts/stack.env` for compose consumption.

### `secrets.env` — user secrets

A staged copy of `CONFIG_HOME/secrets.env`, copied as-is. By convention this
file contains only `ADMIN_TOKEN` and LLM provider keys:

```env
# CONFIG_HOME/secrets.env
ADMIN_TOKEN=<token>
OPENAI_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=
```

System-managed values (`CHANNEL_*_SECRET`, `OPENPALM_*`)
live in `stack.env` and do not need to appear here, but extra variables are
allowed if a user has a specific need.

### Adding a secret for a new channel

No manual secret creation is required. Installing a channel via the admin API
auto-generates a channel HMAC secret, writes it into `DATA_HOME/stack.env`,
and stages the result to `STATE_HOME/artifacts/stack.env` on the next apply.
The guardian reads channel secrets from the bind-mounted `stack.env`.

---