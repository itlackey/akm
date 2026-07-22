# akm -- Agent Knowledge Management

> **akm** (Agent Knowledge Management) -- A package manager for AI agent skills, commands, tools, and knowledge.

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![npm downloads](https://img.shields.io/npm/dm/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![license](https://img.shields.io/github/license/itlackey/akm)](https://github.com/itlackey/akm/blob/main/LICENSE)

`akm` is a package manager for AI agent capabilities -- scripts, skills, commands,
agents, knowledge, memories, workflows, wikis, env files, secrets, lessons, and
scheduled tasks. It works with any AI coding assistant that can run shell commands,
including [Claude Code](https://claude.ai/code),
[OpenCode](https://opencode.ai), [Cursor](https://cursor.com), and more.

## Install

**Option 1 — Prebuilt binary (recommended, no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

**Option 2 — npm package (requires [Node.js](https://nodejs.org) >= 22):**

```sh
npm install -g akm-cli
```

Upgrade in place with `akm upgrade`.

The npm package always uses Node.js to bootstrap its cross-platform command.
If a working [Bun](https://bun.sh) >= 1.0 is also on `PATH`, the launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall back
to Node.js. Node.js remains required for the npm package. The standalone
binaries are runtime-free.

> The old `vault` asset type was removed in 0.9.0; use `env` for whole `.env`
> groups and `secret` for standalone sensitive values.

## Quick Start

```sh
akm setup                         # Guided setup: configure, initialize, and index
akm add github:owner/repo         # Add a stash from GitHub
akm search "deploy"               # Find assets across all sources
akm show scripts/deploy.sh        # View details and run command
```

## Why akm?

- **Works with any AI agent** -- No plugins or SDKs required. Any model that can run shell commands can use `akm`.
- **One command to search everything** -- Local stash, registries, and community skills from [skills.sh](https://skills.sh) in a single query.
- **Install stashes from anywhere** -- npm, GitHub, GitLab, local directories.
- **Semantic search** -- Optional local embeddings (via Ollama or HuggingFace) for finding assets by meaning, not just keywords.
- **Private registries** -- Host your own registry for team or enterprise use.

## Agent Integration

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, memories, workflows, wikis, env files, secrets, lessons, and scheduled tasks
via the `akm` CLI. Use `akm -h` for details.
```

## Install Stashes from Anywhere

```sh
akm add @scope/my-stash                     # npm
akm add github:owner/repo#v1.2.3            # GitHub with tag
akm add git+https://gitlab.com/org/stash    # Any git repo
akm add ./path/to/local/stash               # Local directory
```

Manage stashes with `akm list`, `akm update --all`, and `akm remove`.

## Publish Your Own Stash

1. Organize your assets into a directory
2. Add `"akm"` to `keywords` in `package.json`
3. Optionally add `akm.include` in `package.json` to control what gets installed
4. Publish to npm or push to GitHub

## Documentation

Full docs, CLI reference, and guides are available on [GitHub](https://github.com/itlackey/akm):

- [Getting Started](https://github.com/itlackey/akm/blob/main/docs/guides/getting-started.md)
- [CLI Reference](https://github.com/itlackey/akm/blob/main/docs/reference/cli.md)
- [Configuration](https://github.com/itlackey/akm/blob/main/docs/reference/configuration.md)
- [Stash Maker's Guide](https://github.com/itlackey/akm/blob/main/docs/guides/stash-makers.md)
- [Registry](https://github.com/itlackey/akm/blob/main/docs/reference/registry.md)

## License

[MPL-2.0](https://github.com/itlackey/akm/blob/main/LICENSE)
