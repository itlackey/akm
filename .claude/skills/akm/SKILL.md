---
name: akm
description: Search, install, and manage AI agent skills, commands, tools, knowledge, and memories from any source. Works with Claude Code, OpenCode, Cursor, and any AI coding assistant.
---

# akm — Agent Kit Manager

A package manager for AI agent capabilities. Use `akm` to search, install, and
manage skills, commands, agents, knowledge, scripts, and memories from local
stashes, registries, and community sources.

## When to use this skill

Use `akm` when you need to:

- **Find a capability** you don't already have (a deployment script, a code review skill, a debugging agent)
- **Install a kit** of assets from npm, GitHub, or a private registry
- **Search across sources** — local stash, official registry, and community skills in one query
- **Manage installed kits** — list, update, or remove

## Usage

```sh
# Setup (first time only)
akm setup

# Search for assets across all sources
akm search "deploy"
akm search "code review" --source registry

# Install a kit
akm add github:owner/repo
akm add @scope/my-kit

# Show asset details
akm show skill:code-review
akm show script:deploy.sh

# List and manage installed kits
akm list
akm update --all
akm remove my-kit

# Clone an asset to your project
akm clone skill:code-review --dest ./.claude/skills
```

## Integration

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt so any AI agent
can use `akm`:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI. Use `akm -h` for details.
```

No plugins, SDKs, or integration code required.

## Install

```sh
# via Bun
bun install -g akm-cli

```

## Links

- [GitHub](https://github.com/itlackey/akm) - Binary releases, source code, and documentation
- [npm](https://www.npmjs.com/package/akm-cli)
- [Documentation](https://github.com/itlackey/akm/blob/main/docs/getting-started.md)
