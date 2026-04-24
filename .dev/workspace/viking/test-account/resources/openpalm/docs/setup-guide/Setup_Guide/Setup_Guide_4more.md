# Setup Guide

Get OpenPalm running on your machine in under five minutes.

---

## Prerequisites

You need **one thing** installed before starting: a container runtime.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop _or_ OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com \| sh` |

After installing, open the app and wait for it to finish starting (you'll see a green/running indicator).

---

## Install

Copy-paste **one** command into your terminal and the installer does the rest:

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

**Mac or Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

### What happens when you run the installer

1. Checks your system for Docker, Docker Compose, curl, and openssl
2. Creates the XDG directory tree and downloads core assets (compose file, Caddyfile)
3. Generates an admin token (or lets you set your own) and seeds missing default config files
4. Pulls and starts the admin service, then opens the setup wizard in your browser
5. The wizard walks you through connecting your AI provider and choosing channels (see [Setup Walkthrough](setup-walkthrough.md) for a detailed screen-by-screen guide)
6. When you finish the wizard, the full stack starts automatically

No code to clone. You can run fully from the UI if you want, and edit files directly any time. Existing user config files in `CONFIG_HOME` are never overwritten on subsequent runs; only missing defaults are seeded.

### Installer options

Run `scripts/setup.ps1 --help` (Windows) or `scripts/setup.sh --help` (Mac/Linux) for all flags:

| Flag | Effect |
|---|---|
| `--force` | Skip confirmation prompts (useful for scripted updates) |
| `--version TAG` | Download assets from a specific GitHub ref (default: `main`) |
| `--no-start` | Set up files but don't start Docker services |
| `--no-open` | Don't open the admin UI in a browser after install |

Custom paths via environment variables:

```bash
OPENPALM_CONFIG_HOME=/opt/openpalm/config \
OPENPALM_DATA_HOME=/opt/openpalm/data \
OPENPALM_STATE_HOME=/opt/openpalm/state \
  bash setup.sh
```

---

## Update

Re-run the same install command to update:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

The installer re-downloads core assets and restarts the admin service. Your config, channels, and data are preserved — automatic lifecycle operations never overwrite existing user files in `CONFIG_HOME` (they may seed missing defaults).

To pull the latest container images without re-running setup:

```bash
curl -X POST http://localhost:8100/admin/containers/pull \
  -H "x-admin-token: $ADMIN_TOKEN"
```

Or use `--force` for non-interactive updates:

```bash
setup.sh --force
```

```powershell
.\scripts\setup.ps1 --force
```

---