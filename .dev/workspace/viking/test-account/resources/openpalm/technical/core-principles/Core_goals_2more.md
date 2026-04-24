## Core goals

The filesystem and volume-mount contract exists to guarantee:

1. **Add containers and routes by file-drop** into known host locations (no code changes required).
2. **Add assistant extensions by copying OpenCode assets** into known host locations.
3. **Core container and routing configuration is stored on the host** for advanced users.
4. **Leverage Docker Compose, Caddy, and OpenCode configuration features** to avoid custom config/orchestration implementations.
5. **No template rendering** — manage configuration by copying whole files, not by string interpolation or code generation.
6. **Never overwrite existing user-modified files in CONFIG_HOME during automatic lifecycle operations** (install/update/startup apply/setup reruns/upgrades); only seed missing defaults.
7. **All persistent container data lives on the host** for backup/restore.
8. **All host-stored container files are user-accessible** (ownership/permissions contract).
9. **Core assistant extensions are baked into the assistant container** and loaded from a fixed OpenCode config directory to ensure core extensions take precedence.

For (9), OpenCode supports a custom config directory via `OPENCODE_CONFIG_DIR`; it is searched like a standard `.opencode` directory for agents/commands/tools/skills/plugins. ([OpenCode][1])

---

## Security invariants

These are hard constraints that must never be violated during development:

1. **Admin is the sole orchestrator.** Only the admin container has Docker socket access. No other container may mount or access the Docker socket.
2. **Guardian-only ingress.** All channel traffic enters through the guardian, which enforces HMAC verification, timestamp skew rejection, replay detection, and rate limiting. No channel may communicate directly with the assistant.
3. **Assistant isolation.** The assistant has no Docker socket, no host filesystem access beyond its designated mounts (`DATA_HOME/assistant`, `CONFIG_HOME/assistant`, `DATA_HOME/opencode`, `STATE_HOME/opencode`, `WORK_DIR`), and interacts with the stack exclusively through the admin API.
4. **LAN-first by default.** Admin interfaces, dashboards, and channels are LAN-restricted by default. Nothing is publicly exposed without explicit user opt-in.

---