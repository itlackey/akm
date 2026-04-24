## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining a base Compose file with channel overlays using Compose’s native multi-file mechanisms (merge rules and/or `include`). ([Docker Documentation][3])
**Implication:** adding a channel is dropping a `.yml` compose overlay into `config/channels/`, then running an explicit apply action that stages that file into `state/` and uses the staged files for Compose execution.

### B) Caddy: modular by native `import`

Caddy loads a stable root Caddyfile that uses `import` (with globs) to include snippets from `channels/`. ([Caddy Web Server][4])
**Implication:** adding an HTTP route for a channel is dropping a `.caddy` snippet into `config/channels/`, then running an explicit apply action that stages snippets into `state/` and reloads Caddy from staged files. If no `.caddy` file is present, the channel has no HTTP route and is only accessible on the Docker network.

### C) OpenCode: core precedence via baked-in `/etc/opencode`

* The assistant container includes core extensions/config at **`/etc/opencode`**.
* The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
* Advanced users *may* bind-mount a host directory over `/etc/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container’s original contents. ([Docker Documentation][5])

### D) Non-destructive lifecycle sync is enforced by tier boundaries

To guarantee lifecycle operations never clobber user configuration:

* **CONFIG_HOME is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults and never overwrites existing user files. Explicit mutation paths — user direct edits, admin UI/API config actions, authenticated/allowlisted assistant calls to admin API on user request — may create/update/remove files as requested. (See Config section above for the full allowed-writers rule.)
* **STATE_HOME is system-writable.** The admin freely overwrites files here when assembling the runtime (install, update, access-scope changes).
* **DATA_HOME is admin- and service-writable.** Containers own durable data; the admin manages system-policy files (`DATA_HOME/caddy/Caddyfile`, `DATA_HOME/stack.env`, `DATA_HOME/automations/`) directly. The assistant may not write to DATA_HOME directly — it must go through the admin API. ([Freedesktop Specifications][2])

### E) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### F) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---