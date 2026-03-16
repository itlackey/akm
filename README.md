# Agent Kit Manager

> Agent-i-Kit

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/agentikit/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/agentikit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

A package manager for AI agent capabilities -- scripts, skills, commands,
agents, knowledge, and memories -- that works with any AI coding assistant that
can run shell commands.

## Install

```sh
# Standalone binary (no runtime dependencies)
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash

# Or via Bun
bun install -g akm-cli
```

Upgrade in place with `akm upgrade`.

## Quick Start

```sh
akm init                          # Initialize your stash
akm add github:owner/repo         # Add a kit from GitHub
akm search "deploy"               # Find assets
akm show script:deploy.sh         # View details and run command
```

## Features

### Works with Any AI Agent

Any model that can run shell commands can use `akm`. Add this to your
`AGENTS.md`, `CLAUDE.md`, or system prompt:

~~~markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
~~~

No plugins, SDKs, or integration code required. Platform-specific plugins
(e.g., [OpenCode](https://github.com/itlackey/akm-plugins?tab=readme-ov-file#opencode))
are available for tighter integration but purely optional.

### Clone Assets Anywhere

`akm clone` copies any asset from your stash or a remote source into a
target directory for local editing:

```sh
akm clone script:deploy.sh                              # Clone to your stash
akm clone script:deploy.sh --dest ./project/.claude     # Clone to a specific directory
akm clone script:deploy.sh --name my-deploy.sh          # Clone with a new name
akm clone "npm:@scope/pkg//script:deploy.sh" --force    # Clone from a remote package
```

Key behaviors:
- Type subdirectories are appended automatically (e.g., `--dest ./project/.claude` becomes `./project/.claude/scripts/deploy.sh`)
- Skills clone as entire directories; scripts/commands clone as single files
- Remote packages are fetched on-demand without registering as installed kits
- `--force` overwrites existing assets

### skills.sh Integration

`akm` includes [skills.sh](https://skills.sh) as a built-in registry. Community
skills from skills.sh are searchable out of the box alongside the official
registry -- no setup required:

```sh
akm search "code review"             # Searches skills.sh and official registry
akm registry search "code review"    # Search registries directly
```

Results include install counts and link back to skills.sh for details. The
provider caches queries for 15 minutes with a 24-hour stale fallback.

### Registries and Private Registry Support

Registries are indexes of available kits. The official
[akm-registry](https://github.com/itlackey/akm-registry) is pre-configured.

```sh
akm registry search "code review"                                        # Search registries
akm registry add https://example.com/registry/index.json --name team     # Add a registry
akm sources add http://host:1933 --provider openviking \
  --options '{"apiKey":"key"}'                                            # Add an OpenViking stash source
akm registry list                                                        # List configured registries
akm show viking://resources/my-doc                                       # Fetch remote content from OpenViking
```

Private access is supported through:
- **GitHub tokens** -- Set `GITHUB_TOKEN` to access private GitHub repos when installing kits
- **Provider options** -- `--options` flag accepts JSON for provider-specific configuration (API keys, custom headers)
- **Pluggable providers** -- Built-in registry providers include `static-index` and `skills-sh`; stash providers include `filesystem` and `openviking`; custom providers can implement their own authentication

See the [Registry docs](docs/registry.md) for hosting your own registry and
the v2 index format.

### Install Kits from Anywhere

```sh
akm add @scope/my-kit                       # npm
akm add github:owner/repo#v1.2.3            # GitHub with tag
akm add git+https://gitlab.com/org/kit      # Any git repo
akm add ./path/to/local/kit                 # Local directory
```

Manage kits with `akm list`, `akm update --all`, and `akm remove`.

### Publish Your Own Kit

1. Organize your assets into a directory
2. Add `"akm"` to `keywords` in `package.json` or the `akm` topic to your GitHub repo
3. Optionally add `akm.include` in `package.json` to control what gets installed
4. Publish to npm or push to GitHub

See the [Kit Maker's Guide](docs/kit-makers.md) for a full walkthrough.

## Documentation

| Doc | Description |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Quick setup guide |
| [CLI Reference](docs/cli.md) | All commands and flags |
| [Configuration](docs/configuration.md) | Settings, providers, and Ollama setup |
| [Concepts](docs/concepts.md) | Asset types, classification, stash model |
| [Kit Maker's Guide](docs/kit-makers.md) | Build and share kits |
| [Registry](docs/registry.md) | Registries, search, and the v2 index format |

## License

[MPL-2.0](LICENSE)
