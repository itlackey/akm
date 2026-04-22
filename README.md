# Agent Kit Manager

> **akm** — Agent Kit Manager

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/akm/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/akm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

A package manager for AI agent capabilities -- scripts, skills, commands,
agents, knowledge, and memories -- that works with any AI coding assistant that
can run shell commands.

## Why akm?

AI agent skills, commands, and knowledge are scattered across different tools --
Claude Code, OpenCode, Cursor, Windsurf -- with no unified way to manage, share,
or discover them. Each tool has its own format and its own silo. akm gives you a
single CLI to manage all your agent assets regardless of which coding assistant
you use, so you can build a personal library once and take it everywhere.

## Install

```sh
# Standalone binary (no runtime dependencies)
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash

# Or via Bun
bun install -g akm-cli

# Or via skills
npx skills add itlackey/akm

```

Upgrade in place with `akm upgrade`.

## Quick Start

```sh
akm setup                         # Guided setup: configure, initialize, and index
akm add ~/.claude/skills          # Add your existing local skills
akm add github:owner/repo         # Add a kit from GitHub
akm search "deploy"               # Find assets
akm show script:deploy.sh         # View details and run command
akm remember "Deployment needs VPN access"
akm import ./notes/release.md
akm feedback skill:deploy --positive
```

If you want to skip the wizard, `akm init --dir ~/custom-stash` initializes the
working stash at a custom path.

## Features

### Works with Any AI Agent

Any model that can run shell commands can use `akm`. Add this to your
`AGENTS.md`, `CLAUDE.md`, or system prompt (see `docs/AGENTS.full.md` for a
more detailed version with advanced usage):

~~~markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
~~~

No plugins, SDKs, or integration code required. Platform-specific plugins
(e.g., [OpenCode](https://github.com/itlackey/akm-plugins?tab=readme-ov-file#opencode))
are available for tighter integration but purely optional.

When your agent uses an asset, have it record whether that asset helped:

```sh
akm feedback <ref> --positive
akm feedback <ref> --negative --note "Outdated for the current repo layout"
```

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
- Remote packages are fetched on-demand without registering as managed sources
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
akm add http://host:1933 --provider openviking \
  --options '{"apiKey":"key"}'                                            # Add an OpenViking source
akm registry list                                                        # List configured registries
akm show knowledge:my-doc                                                # Show content from any source (local or remote)
```

Private access is supported through:
- **GitHub tokens** -- Set `GITHUB_TOKEN` to access private GitHub repos when installing kits
- **Provider options** -- `--options` flag accepts JSON for provider-specific configuration (API keys, custom headers)
- **Pluggable providers** -- Built-in registry providers include `static-index` and `skills-sh`; source providers include `filesystem` and `openviking`; custom providers can implement their own authentication

See the [Registry docs](docs/registry.md) for hosting your own registry and
the index format.

### Add Sources from Anywhere

```sh
akm add ~/.claude/skills                    # Local directory
akm add @scope/my-kit                       # npm
akm add github:owner/repo#v1.2.3            # GitHub with tag
akm add github:owner/private-kit --trust    # One-off trusted install
akm add git+https://gitlab.com/org/kit      # Any git repo
akm add https://docs.example.com --name docs  # Website as knowledge
```

Manage sources with `akm list`, `akm update --all`, and `akm remove`.

### Website Sources

Add any site as a searchable knowledge source. Pages are crawled,
converted to markdown, and indexed:

```sh
akm add https://docs.example.com --name my-docs
akm add https://www.agentic-patterns.com/ --name agent-patterns
akm add https://docs.example.com --name docs --max-pages 100 --max-depth 5
```

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
| [Concepts](docs/concepts.md) | Sources, registries, asset types |
| [Kit Maker's Guide](docs/kit-makers.md) | Build and share assets |
| [Registry](docs/registry.md) | Registries, search, and the v2 index format |
| [Blog Posts](docs/posts/) | Articles and posts about akm |

## License

[MPL-2.0](LICENSE)
