# Directory Structure & Volume Design

OpenPalm follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)
to organize host-side files into three tiers. Each tier has a clear owner
(user vs. system) and a single Docker mount target.

---

## Three-Tier Layout

```
~/.config/openpalm/         CONFIG_HOME  — user-editable
~/.local/share/openpalm/    DATA_HOME    — admin/service-managed data
~/.local/state/openpalm/    STATE_HOME   — assembled runtime
```

| Tier | Env Variable | Default | Owner | Purpose |
|------|-------------|---------|-------|---------|
| **CONFIG_HOME** | `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User | Secrets, channels, OpenCode extensions |
| **DATA_HOME** | `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Admin + Services | Memory, assistant home, guardian, caddy data, stack.env |
| **STATE_HOME** | `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Admin | Assembled runtime, audit logs |

**CONFIG_HOME is the user-owned persistent source of truth** and the primary touchpoint for user-managed config.
Allowed writers are: direct user edits; explicit admin UI/API config actions;
and assistant-triggered admin API config actions that are authenticated,
allowlisted, and executed on user request. Automatic lifecycle sync
(install/update/startup apply/setup reruns/upgrades) is non-destructive:
it may seed missing defaults but must not overwrite existing user files.
Services write their durable runtime data to DATA_HOME; the admin also manages
system-policy files there (`stack.env`, `caddy/Caddyfile`, `automations/`).
The admin assembles runtime artifacts in STATE_HOME.

---