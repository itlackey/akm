# Manual Setup

Step-by-step guide for configuring an OpenPalm host by hand, without using the installer scripts or CLI. This is useful for understanding what the automation does under the hood, for air-gapped environments, or for custom deployments.

For the automated path, see [setup-guide.md](setup-guide.md). For the developer quick-start, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Prerequisites

- Docker Engine 24+ with Compose V2 (`docker compose` subcommand)
- `openssl` (for generating secrets)
- The `assets/` files from this repository (or download them from a GitHub release)

---

## 1. Choose your paths

OpenPalm uses three host directories following the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/). Pick paths that work for your system:

| Tier | Default | Purpose |
|------|---------|---------|
| **CONFIG_HOME** | `~/.config/openpalm` | User-editable: secrets, channels, OpenCode extensions |
| **DATA_HOME** | `~/.local/share/openpalm` | Admin/service-managed data (memory, stack.env, caddy, assistant home, etc.) |
| **STATE_HOME** | `~/.local/state/openpalm` | Assembled runtime artifacts, audit logs |
| **WORK_DIR** | `~/openpalm` | Assistant working directory |

`CONFIG_HOME` is the user-owned persistent source of truth. Allowed writers are:
user direct edits, explicit admin UI/API config actions, and assistant actions
through authenticated/allowlisted admin APIs on user request. Automatic
lifecycle operations are non-destructive for existing user config files and
only seed missing defaults. See [core-principles.md](technical/core-principles.md) for
the full filesystem contract.

The rest of this guide uses the defaults. Substitute your own paths if needed.

See [directory-structure.md](technical/directory-structure.md) for the full tree and rationale.

---

## 2. Create the directory tree

```bash
# CONFIG_HOME
mkdir -p ~/.config/openpalm/channels
mkdir -p ~/.config/openpalm/automations
mkdir -p ~/.config/openpalm/assistant/{tools,plugins,skills}

# DATA_HOME
mkdir -p ~/.local/share/openpalm/admin
mkdir -p ~/.local/share/openpalm/memory
mkdir -p ~/.local/share/openpalm/assistant
mkdir -p ~/.local/share/openpalm/guardian
mkdir -p ~/.local/share/openpalm/caddy/{data,config}
mkdir -p ~/.local/share/openpalm/automations

# STATE_HOME
mkdir -p ~/.local/state/openpalm/artifacts/channels
mkdir -p ~/.local/state/openpalm/automations
mkdir -p ~/.local/state/openpalm/audit

# Working directory
mkdir -p ~/openpalm
```

---

## 3. Place the core assets

Two files from `assets/` are needed: the Docker Compose definition and the Caddyfile.

Copy them to DATA_HOME (source of truth) **and** stage them to STATE_HOME (runtime):

```bash
# Source of truth (DATA_HOME)
cp assets/docker-compose.yml ~/.local/share/openpalm/docker-compose.yml
cp assets/Caddyfile           ~/.local/share/openpalm/caddy/Caddyfile

# Staged for runtime (STATE_HOME)
cp assets/docker-compose.yml ~/.local/state/openpalm/artifacts/docker-compose.yml
cp assets/Caddyfile           ~/.local/state/openpalm/artifacts/Caddyfile
```

If you don't have a local clone, download them from GitHub:

```bash
BASE_URL="https://raw.githubusercontent.com/itlackey/openpalm/main/assets"
curl -fsSL "$BASE_URL/docker-compose.yml" -o ~/.local/share/openpalm/docker-compose.yml
curl -fsSL "$BASE_URL/Caddyfile"           -o ~/.local/share/openpalm/caddy/Caddyfile

cp ~/.local/share/openpalm/docker-compose.yml ~/.local/state/openpalm/artifacts/docker-compose.yml
cp ~/.local/share/openpalm/caddy/Caddyfile    ~/.local/state/openpalm/artifacts/Caddyfile
```

---