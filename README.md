# Agent-i-Kit

[![npm version](https://img.shields.io/npm/v/agentikit)](https://www.npmjs.com/package/agentikit)
[![CI](https://github.com/itlackey/agentikit/actions/workflows/ci.yml/badge.svg)](https://github.com/itlackey/agentikit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/agentikit)](LICENSE)

A package manager for AI agent capabilities — tools, skills, commands, agents,
knowledge, and scripts — that works with any AI coding assistant that can run
shell commands.

You build up useful scripts, prompts, and agent configs. Agent-i-Kit lets you
organize them into a searchable **stash**, share them as installable **kits**,
and give any model a way to discover and use them through `akm` (Agent Kit
Manager). No plugins required — just CLI output any tool-calling model can read.

## Requirements

Agent-i-Kit requires [Bun](https://bun.sh) v1.0+ as its runtime. It uses
Bun-specific APIs (`bun:sqlite`) that are **not available in Node.js**.

## Quick Start

```sh
# Install (requires Bun v1.0+)
bun install -g agentikit

# Initialize your stash
akm init

# Add a kit from GitHub
akm add github:owner/repo

# Search for assets
akm search "deploy"

# Show an asset
akm show script:deploy.sh
```

> **Don't want Bun?** Use the [standalone binary](#standalone-binary) instead — it
> bundles everything and has no runtime dependencies.

## Using With Any AI Agent

Agent-i-Kit is platform agnostic. Any model that can execute shell commands can
search your stash and use what it finds. The workflow is three commands:

1. `akm search "what you need"` — find relevant assets (returns JSON)
2. `akm show <openRef>` — get the details (run command, instructions, prompt, etc.)
3. Use the asset — execute the `runCmd`, follow the skill instructions, fill in the template

### Drop-in prompt snippet

Add this to your `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, system prompt, or any instruction
file to give your agent access to your stash without any additional setup:

~~~markdown

You have access to a searchable library of tools, skills, commands, agents,
and knowledge documents via `akm`. Use it to find and
use capabilities before writing something from scratch.

**Finding assets:**
```sh
akm search "<query>"              # Search by keyword
akm search "<query>" --type tool  # Filter by type (tool, skill, command, agent, knowledge, script)
akm search "<query>" --source <source>  # Filter by source (e.g., "local", "registry", "both")
```

Search returns JSON with scored results. Each hit includes an `openRef` you
use to retrieve the full asset.

**Using assets:**
```sh
akm show <openRef>                # Get full asset details
```

What you get back depends on the asset type:
- **script** — A `runCmd` you can execute directly
- **skill** — Instructions to follow (read the full content)
- **command** — A prompt template with placeholders to fill in
- **agent** — A system prompt with model and tool hints
- **knowledge** — A reference doc (use `--view toc` or `--view section --heading "..."` to navigate)

Always search the stash first when you need a capability. Prefer existing
assets over writing new code.

Use `akm -h` for more options and details on searching and using assets.

~~~

That's it. No plugin, no SDK, no integration code. The model reads the JSON
output from `akm` and acts on it.

### Platform plugins (optional)

For tighter integration, plugins are available for some platforms. These add
native tool bindings so the agent doesn't need to shell out, but they're
purely optional — the CLI works everywhere.

**OpenCode** — Add the [OpenCode plugin](https://github.com/itlackey/agentikit-plugins?tab=readme-ov-file#agentikit-opencode) to your `opencode.json`:

```json
{
  "plugin": ["agentikit-opencode"]
}
```

**Claude Code** — Add the prompt snippet above to your `CLAUDE.md` or
project instructions. Claude Code can run `akm` commands directly.

**Everything else** — If your agent can run shell commands, it can use `akm`.
Add the prompt snippet to whatever instruction mechanism your platform uses.

## What's In a Kit?

A kit is a directory of assets you can share and install. There's no required
structure — agentikit classifies assets by **file extension and content**, not
by directory name. A `.sh` file is a script whether it lives in `scripts/`,
`deploy/`, or at the root. A `.md` file with `tools` in its frontmatter is an
agent definition wherever you put it.

That said, using these directory names as an opt-in convention improves
indexing confidence:

```text
my-kit/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
```

### Asset types

| Type | What it is | What the agent gets |
| --- | --- | --- |
| **script** | An executable script | A `runCmd` the agent can execute, or source for unsupported runtimes |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |

Assets are referenced by type and name (e.g. `script:deploy.sh`,
`knowledge:api-guide.md`). See [Concepts](docs/concepts.md) for details on
how classification works.

## The Stash

Your stash is the local library where assets live. It combines three sources
in priority order:

1. **Primary stash** — Your personal assets (`AKM_STASH_DIR`), created by `akm init`
2. **Search paths** — Additional directories (team shares, project dirs, etc.)
3. **Installed kits** — Kits from npm, GitHub, or git via `akm add` (cache-managed)

The first match wins, so local assets always override installed ones. Use
`akm clone` to fork an installed asset into your stash for editing.

## Searching and Showing Assets

Search returns scored results with explainability:

```sh
akm search "docker" --type tool
```

```json
{
  "hits": [
    {
      "name": "docker-build",
      "type": "tool",
      "description": "Build and push Docker images",
      "openRef": "tool:docker-build.sh",
      "score": 0.92,
      "whyMatched": "matched name tokens, fts bm25 relevance"
    }
  ]
}
```

Show returns everything the agent needs to act:

```sh
akm show tool:docker-build.sh
```

```json
{
  "type": "tool",
  "name": "docker-build.sh",
  "runCmd": "cd \"/path/to/tools\" && bash \"/path/to/tools/docker-build.sh\"",
  "kind": "bash"
}
```

For knowledge assets, navigate without loading the entire document:

```sh
akm show knowledge:api-guide.md --view toc
akm show knowledge:api-guide.md --view section --heading "Authentication"
```

## Installing and Sharing Kits

Install kits from npm, GitHub, any git host, or local directories:

```sh
akm add @scope/my-kit                       # npm
akm add github:owner/repo#v1.2.3            # GitHub with tag
akm add git+https://gitlab.com/org/kit      # Any git repo
akm add ./path/to/local/kit                 # Local directory
```

Search the registry for community kits:

```sh
akm search "code review" --source registry
```

Manage installed kits:

```sh
akm list                        # Show installed kits with status
akm update --all                # Update all (reports version changes)
akm remove owner/repo           # Remove and reindex
akm clone tool:deploy.sh        # Fork an asset into your stash for editing
```

### Publishing your own kit

1. Organize your assets (directory conventions are optional)
2. Add `"akm"` to `keywords` in `package.json` or add the `akm` topic to your GitHub repo
3. Optionally add `agentikit.include` to control what gets installed
4. Publish to npm or push to GitHub

See the [Kit Maker's Guide](docs/kit-makers.md) for a full walkthrough.

## Installation

Agent-i-Kit requires [Bun](https://bun.sh) v1.0+ as its runtime. It uses
Bun-specific APIs (`bun:sqlite`) that are not available in Node.js.

```sh
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Install agentikit
bun install -g agentikit
```

### Standalone binary

The standalone binary bundles everything and has **no runtime dependencies** —
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
| [Concepts](docs/concepts.md) | Asset types, classification, stash sources, metadata |
| [CLI Reference](docs/cli.md) | All `akm` commands and flags |
| [Kit Maker's Guide](docs/kit-makers.md) | Build and share a kit on GitHub, npm, or a network share |
| [Registry](docs/registry.md) | Finding, installing, and publishing kits |
| [Search](docs/search.md) | Hybrid search architecture and scoring |
| [Indexing](docs/indexing.md) | How the search index is built |
| [Filesystem](docs/filesystem.md) | Directory layout and `.stash.json` schema |
| [Configuration](docs/configuration.md) | Providers, settings, and Ollama setup |

## Status

Agent-i-Kit is approaching v1.0. The core CLI, stash model, and registry are
stable and in daily use. Feedback, issues, and PRs welcome — especially around
real-world usage patterns and integrations with different AI coding assistants.

## License

[MPL-2.0](LICENSE)
