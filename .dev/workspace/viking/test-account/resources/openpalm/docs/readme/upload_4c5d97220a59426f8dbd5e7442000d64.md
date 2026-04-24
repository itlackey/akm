# docs

Documentation index for OpenPalm.

Repo layout convention:
- `packages/*` contains app/package source code.
- `core/*` contains container/runtime assembly assets and Docker build contexts.

## Getting started

| Document | Description |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | **Dev environment cheatsheet** — clone, bootstrap, run, test |
| [system-requirements.md](system-requirements.md) | CPU, RAM, disk, network — minimum and recommended specs |
| [setup-guide.md](setup-guide.md) | Installation, updating, troubleshooting |
| [setup-walkthrough.md](setup-walkthrough.md) | Visual walkthrough of every setup wizard screen |
| [troubleshooting.md](troubleshooting.md) | Top 10 common problems and solutions |
| [manual-setup.md](manual-setup.md) | Step-by-step manual host configuration (no scripts) |
| [how-it-works.md](how-it-works.md) | Architecture overview and data flow |
| [managing-openpalm.md](managing-openpalm.md) | Configuration, channels, secrets, access control, automations |
| [discord-setup.md](discord-setup.md) | Discord bot setup — create app, install channel, invite bot |

## Architecture (must-read for contributors)

| Document | Description |
|---|---|
| [core-principles.md](technical/core-principles.md) | **Authoritative.** 9 core goals, 4 security invariants, filesystem + volume-mount contracts |
| [directory-structure.md](technical/directory-structure.md) | XDG three-tier layout (CONFIG / DATA / STATE) |
| [docker-dependency-resolution.md](technical/docker-dependency-resolution.md) | **Mandatory.** Docker build patterns — no Bun in admin, no symlinks |

## Implementation rules

| Document | Applies to |
|---|---|
| [code-quality-principles.md](technical/code-quality-principles.md) | All code |
| [bunjs-rules.md](technical/bunjs-rules.md) | Guardian, channels, channels-sdk |
| [sveltekit-rules.md](technical/sveltekit-rules.md) | Admin UI (`packages/admin/`) |

## Release notes

| Document | Description |
|---|---|
| [CHANGELOG.md](../CHANGELOG.md) | Version history in Keep a Changelog format |

## Reference

| Document | Description |
|---|---|
| [api-spec.md](technical/api-spec.md) | Admin API endpoint contract |
| [backup-restore.md](backup-restore.md) | Backup, restore, and migration procedures |
| [environment-and-mounts.md](technical/environment-and-mounts.md) | All env vars and volume mounts |
| [opencode-configuration.md](technical/opencode-configuration.md) | OpenCode runtime integration |
| [community-channels.md](community-channels.md) | BaseChannel SDK for custom adapters |
| [memory-privacy.md](memory-privacy.md) | Memory service data privacy — what is stored, external calls, how to wipe |
| [prd.md](technical/prd.md) | MVP product requirements |
