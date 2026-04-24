# Environment Variables & Container Mount Points

This document describes every environment variable and volume mount used by the
OpenPalm stack. The `assets/docker-compose.yml` is the source of truth —
this document mirrors its content for reference.

**Canonical sources:** Volume mounts and directory layout are also described in
[directory-structure.md](./directory-structure.md). LLM provider keys are also
listed in [api-spec.md](./api-spec.md) (connections API) and
[opencode-configuration.md](./opencode-configuration.md). Security invariants
are defined in [core-principles.md](./core-principles.md). When in doubt, the
compose file and `core-principles.md` are authoritative.

---

## 1. Host-Level Path Variables

These variables control where OpenPalm stores data on the **host** filesystem.
They follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/).

| Variable | Default | Purpose |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User-editable: secrets.env, channels/, opencode extensions |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Admin/service-managed data (memory, stack.env, caddy, assistant home, etc.) |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Assembled runtime, audit logs |
| `OPENPALM_WORK_DIR` | `$HOME/openpalm` | Assistant working directory mounted at /work |

CONFIG_HOME is the user-owned persistent source of truth. See
[directory-structure.md](./directory-structure.md) for the full allowed-writers
policy and tier layout. See [core-principles.md](./core-principles.md) for the
authoritative filesystem contract.

---