# akm -- Agent Knowledge Manager

> Give every coding agent the capabilities your team has already built.

[![npm version](https://img.shields.io/npm/v/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![npm downloads](https://img.shields.io/npm/dm/akm-cli)](https://www.npmjs.com/package/akm-cli)
[![license](https://img.shields.io/github/license/itlackey/akm)](https://github.com/itlackey/akm/blob/main/LICENSE)

**akm** is a portable capability library for AI agents. Build your agent
library once. Use it from any shell-capable coding agent. It indexes existing
agent assets in place, loads only what a task needs, packages capabilities
into shareable bundles, improves the library through reviewable proposals,
and runs durable workflows -- locally and without tying the library to one
assistant, including [Claude Code](https://claude.ai/code),
[OpenCode](https://opencode.ai), [Cursor](https://cursor.com), and more.

## Install

**Option 1 — npm package (recommended; requires [Node.js](https://nodejs.org) >= 22):**

```sh
npm install -g akm-cli
```

**Option 2 — Prebuilt binary (no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

Upgrade in place with `akm upgrade`.

The npm package always uses Node.js to bootstrap its cross-platform command.
If a working [Bun](https://bun.sh) >= 1.0 is also on `PATH`, the launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall
back to Node.js. Node.js remains required for the npm package. The standalone
binaries are runtime-free.

## Quick Start

```sh
akm setup                          # Guided setup: configure, initialize, and index
akm bundle add github:owner/repo   # Add a bundle from GitHub
akm index                          # Index sources into the library
akm search "deploy"                # Find assets across all sources
akm show scripts/deploy.sh         # View details and run command
```

## Why akm?

- **One library for every agent** -- Use the same capability library from Claude Code, OpenCode, Cursor, Aider, Windsurf, or any assistant that can run shell commands.
- **Load only what the task needs** -- Search or curate a shortlist, then load full content by ref. No giant startup prompt is required.
- **Package complete capabilities** -- Install and share bundles containing skills, scripts, workflows, agents, instructions, memories, and knowledge -- not just prompt snippets.
- **Improve through evidence, with review** -- Feedback re-ranks assets right away. A negative report can carry an exact text fix, and `akm improve` repairs metadata; every edit lands as a diffable proposal you accept, reject or revert, and only writable bundles are changed.
- **Turn knowledge into repeatable work** -- Run persisted workflows with dispatch, gates, retries, budgets, and resume instead of reconstructing a process from prose every session.

akm retrieves every supported capability type. It directly orchestrates
defined execution surfaces such as workflows, agent dispatch, tasks, and
guarded subprocess injection -- it does not blindly execute arbitrary indexed
content merely because that content appears in search results. It
complements MCP and assistant-native skills rather than replacing them.

## Agent Integration

Add this to your `AGENTS.md`, `CLAUDE.md`, or system prompt:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, instructions, memories, workflows, env files, secrets, lessons, tasks,
sessions, and facts via the `akm` CLI. Use `akm -h` for details.
```

Or generate it directly: `akm help agents >> AGENTS.md`

## Documentation

Full docs, CLI reference, and guides are at **[akm.fwdslsh.dev](https://akm.fwdslsh.dev/)**:

- [Getting Started](https://akm.fwdslsh.dev/docs/guides/getting-started/)
- [Supported Formats](https://akm.fwdslsh.dev/docs/reference/supported-formats/)
- [CLI Reference](https://akm.fwdslsh.dev/docs/reference/cli/)
- [Task v3 Reference](https://akm.fwdslsh.dev/docs/reference/tasks/)
- [0.9.2 Migration Guide](https://akm.fwdslsh.dev/docs/migration/v0.9.1-to-v0.9.2/)
- [Configuration](https://akm.fwdslsh.dev/docs/reference/configuration/)
- [Bundle Authoring Guide](https://akm.fwdslsh.dev/docs/guides/author-bundles/)
- [Registry](https://akm.fwdslsh.dev/docs/reference/registry/)

## License

[MPL-2.0](https://github.com/itlackey/akm/blob/main/LICENSE)
