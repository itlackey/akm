# Agent Kit Manager

> Agent-i-Kit

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![CI](https://github.com/itlackey/agentikit/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/agentikit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/akm-cli)](LICENSE)

A package manager for AI agent capabilities -- scripts, skills, commands,
agents, and knowledge -- that works with any AI coding assistant that can run
shell commands.

`akm` organizes reusable scripts, prompts, and agent configs into a searchable
**stash**, shares them as installable **kits** via **registries**, and gives
any model a way to discover and use them. No plugins required -- just CLI
output any tool-calling model can read.

## Requirements

`akm` requires [Bun](https://bun.sh) v1.0+ as its runtime. It uses Bun-specific
APIs (`bun:sqlite`) that are **not available in Node.js**.

> **Don't want Bun?** Use the [standalone binary](#standalone-binary) instead -- it
> bundles everything and has no runtime dependencies.

## Quick Start

```sh
# Install (requires Bun v1.0+)
bun install -g akm-cli

# Initialize your stash
akm init

# Add a kit from GitHub
akm add github:owner/repo

# Clone an asset to a specific directory
akm clone script:deploy.sh --dest ./project/.claude

# Search for assets
akm search "deploy"

# Show an asset
akm show script:deploy.sh
```

## Works Any AI Agent

`akm` is platform agnostic. Any model that can execute shell commands can search
your stash and use what it finds. The workflow is three commands:

1. `akm search "what you need"` -- find relevant assets (returns JSON by default)
2. `akm show <ref>` -- get the details (run command, instructions, prompt, etc.)
3. Use the asset -- execute the `run` command, follow the skill instructions, fill in the template

### Drop-in prompt snippet

Add this to your `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, system prompt, or any instruction
file to give your agent access to your stash without any additional setup:

~~~markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents, and knowledge documents via the `akm` CLI. Use it to find and use capabilities before writing something from scratch. Always search the stash first when you need a capability.

Use `akm -h` for more information about searching and using assets.
~~~

That's it. No plugin, no SDK, no integration code. The model reads the JSON
output from `akm` and acts on it. If you would like more detailed instructions, check out the example [AGENTS.md](docs/AGENTS.md)

### Platform plugins (optional)

For tighter integration, plugins are available for some platforms. These add
native tool bindings so the agent doesn't need to shell out, but they're
purely optional -- the CLI works everywhere.

**OpenCode** -- Add the [OpenCode plugin](https://github.com/itlackey/akm-plugins?tab=readme-ov-file#opencode) to your `opencode.json`:

```json
{
  "plugin": ["akm-opencode"]
}
```

**Claude Code** -- Add the prompt snippet above to your `CLAUDE.md` or
project instructions. Claude Code can run `akm` commands directly.

**Everything else** -- If your agent can run shell commands, it can use `akm`.
Add the prompt snippet above or in [AGENTS.md](docs/AGENTS.md) to whatever instruction/rules mechanism your platform uses.

## The Stash

Your stash is the local library where assets live. It combines three sources
in priority order:

1. **Primary stash** -- Your personal assets (`AKM_STASH_DIR`), created by `akm init`
2. **Search paths** -- Additional directories (team shares, project dirs, etc.)
3. **Installed kits** -- Kits from npm, GitHub, or git via `akm add` (cache-managed)

The first match wins, so local assets always override installed ones. Use
`akm clone` to fork an installed asset into your stash for editing.

## Registries

Registries are indexes of available kits. akm ships with the official
[akm-registry](https://github.com/itlackey/akm-registry) pre-configured.

```sh
# Search the official registry
akm registry search "code review"

# Add a third-party registry
akm registry add https://example.com/registry/index.json --name team

# List configured registries
akm registry list
```

See the [Registry docs](docs/registry.md) for hosting your own registry,
the v2 index format with asset-level metadata, and more.

## Searching and Showing Assets

Search returns brief JSON by default. Use `--detail normal` or `--detail full`
when you want origin, tags, or explainability metadata:

```sh
akm search "docker" --type script
```

```json
{
  "hits": [
    {
      "name": "docker-build",
      "type": "script",
      "description": "Build and push Docker images",
      "action": "akm show script:docker-build.sh -> execute the run command"
    }
  ]
}
```

Show returns everything the agent needs to act:

```sh
akm show script:docker-build.sh
```

```json
{
  "type": "script",
  "name": "docker-build.sh",
  "origin": null,
  "action": "Execute the run command below",
  "run": "bash /path/to/scripts/docker-build.sh",
  "setup": "bun install",
  "cwd": "/path/to/scripts"
}
```

For knowledge assets, navigate without loading the entire document:

```sh
akm show knowledge:api-guide toc
akm show knowledge:api-guide section "Authentication"
```

## Installing and Sharing Kits

Install kits from npm, GitHub, any git host, or local directories:

```sh
akm add @scope/my-kit                       # npm
akm add github:owner/repo#v1.2.3            # GitHub with tag
akm add git+https://gitlab.com/org/kit      # Any git repo
akm add ./path/to/local/kit                 # Local directory
```

Manage installed kits:

```sh
akm list                        # Show installed kits with status
akm update --all                # Update all (reports version changes)
akm remove owner/repo           # Remove and reindex
akm clone script:deploy.sh      # Fork an asset into your stash for editing
```

### Publishing your own kit

1. Organize your assets (directory conventions are optional)
2. Add `"akm"` to `keywords` in `package.json` or add the `akm` topic to your GitHub repo
3. Optionally add `akm.include` in `package.json` to control what gets installed
4. Publish to npm or push to GitHub

See the [Kit Maker's Guide](docs/kit-makers.md) for a full walkthrough.

## Installation

`akm` requires [Bun](https://bun.sh) v1.0+ as its runtime. It uses Bun-specific
APIs (`bun:sqlite`) that are not available in Node.js.

```sh
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Install akm
bun install -g akm-cli
```

### Standalone binary

The standalone binary bundles everything and has **no runtime dependencies** --
no Bun, no Node.js.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

The shell installer verifies the binary against release checksums.

Upgrade the binary in place:

```sh
akm upgrade           # Download and replace the running binary
akm upgrade --check   # Check for updates without installing
```

## Documentation

| Doc | Description |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Quick setup guide |
| [CLI Reference](docs/cli.md) | All `akm` commands and flags |
| [Configuration](docs/configuration.md) | Providers, settings, and Ollama setup |
| [Concepts](docs/concepts.md) | Asset types, classification, stash sources, metadata |
| [Kit Maker's Guide](docs/kit-makers.md) | Build and share a kit on GitHub, npm, or a network share |
| [Registry](docs/registry.md) | Registries, search, and managing kits |

## Status

`akm` is approaching v1.0. The core CLI, stash model, and registry are generally stable
and in daily use. Feedback, issues, and PRs welcome -- especially around
real-world usage patterns and integrations with different AI coding assistants.

## License

[MPL-2.0](LICENSE)
