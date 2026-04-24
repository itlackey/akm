## Filesystem contract (file assembly, not rendering)

Configuration is managed by **copying whole files** between tiers — never by string interpolation, template expansion, or dynamic code generation. The admin acts as a **file assembler**: it stages user files (from CONFIG) and system defaults into STATE, and Docker/Caddy read from STATE at runtime. OpenCode core config is image-baked at `/etc/opencode`, with user extensions mounted from CONFIG.

### 1) Config (authoritative, user-owned)

**Location:** `$XDG_CONFIG_HOME/openpalm` (default `~/.config/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** user-owned, persistent source of truth for user configuration. The primary touchpoint for user-managed config.

Minimum required subtrees:

* `channels/` — channel definitions: compose overlays (`.yml`) and optional Caddy routes (`.caddy`)
* `opencode/` — user OpenCode config + user extensions/assets
* `secrets.env` — user secrets only: `ADMIN_TOKEN` and LLM provider keys. No paths, UID/GID, or infra config belongs here.

**Rule:** allowed writers for this tree are: user direct edits; explicit admin UI/API config actions; assistant calls through authenticated/allowlisted admin APIs on user request. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults.

### 2) Data (durable, backup/restore)

**Location:** `$XDG_DATA_HOME/openpalm` (default `~/.local/share/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

**Write policy:** DATA_HOME is admin- and service-writable. Containers own their
durable runtime data (memory, guardian, caddy TLS/config, opencode data).
The admin manages system-policy files directly: `DATA_HOME/caddy/Caddyfile`,
`DATA_HOME/stack.env`, and `DATA_HOME/automations/`. The assistant must not write
to DATA_HOME directly — it interacts with the stack exclusively through the admin
API, which mediates all DATA_HOME mutations on the assistant's behalf.

### 3) State (assembled runtime)

**Location:** `$XDG_STATE_HOME/openpalm` (default `~/.local/state/openpalm`). ([Freedesktop Specifications][2])
**Purpose:** the assembled runtime consumed by Docker, Caddy, and OpenCode. Also holds logs and operational records (audit trail, history).

The admin copies system defaults (bundled compose, Caddyfile) and user-provided files (channel configs, secrets) into this directory. Services read their configuration from STATE at runtime. Files here are overwritten on install/update — they are not user-edited.

**Rule:** STATE is system-writable. The admin may overwrite files here freely when applying changes.

---