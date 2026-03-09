# Agent-i-Kit

Agent-i-Kit gives AI coding agents a shared library of capabilities they can
search and use. You organize tools, skills, commands, agents, knowledge, and
scripts into a **stash**, and agents discover what they need through
`akm` (Agent Kit Manager).

## What Is a Kit?

A kit is a shareable package of assets. Any directory with asset
subdirectories is a valid kit:

```text
my-kit/
  tools/          # Executable scripts (.sh, .ts, .js)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md)
  agents/         # Agent definitions (.md)
  knowledge/      # Reference documents (.md)
  scripts/        # General scripts (.py, .rb, .go, etc.)
```

Kits can be published to npm or hosted on GitHub. Tag them with `akm` or
`agentikit` so others can discover them through registry search.

## What Is a Stash?

The stash is your local library of assets. It combines three sources:

1. **Working stash** -- Your personal assets (`AKM_STASH_DIR`). Read-write.
2. **Mounted dirs** -- Shared team directories. Read-only.
3. **Installed kits** -- Kits from npm or GitHub via `akm add`. Read-only.

When you search or open an asset, the working stash takes priority. This
means you can install a kit and override individual assets by cloning them
into your working stash.

## Prerequisites

Agent-i-Kit requires [Bun](https://bun.sh) (v1.0+) as its runtime. It uses
Bun-specific APIs (`bun:sqlite`) that are not available in Node.js.

```sh
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

> **Don't want to install Bun?** Use the [standalone binary](#standalone-binary)
> instead -- it has no runtime dependencies.

## Quick Start

```sh
# Install
bun install -g agentikit

# Initialize your stash
akm init

# Search for assets
akm search "deploy"

# Show an asset
akm show tool:deploy.sh

# Install a kit from npm
akm add @scope/my-kit

# Search installed and registry kits
akm search "lint" --source both
```

### Standalone Binary

The standalone binary bundles everything it needs and does **not** require Bun
or Node.js.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

## Searching and Showing Assets

Search returns scored results with metadata explaining why each hit matched:

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

Use `openRef` from search results to show the full asset:

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

For knowledge assets, views let you navigate large documents:

```sh
akm show knowledge:api-guide.md --view toc
akm show knowledge:api-guide.md --view section --heading "Authentication"
```

## Using With AI Agents

Agent-i-Kit is designed to be called by AI coding agents. The agent searches
for capabilities, reads the results, and acts on them.

### OpenCode

In an OpenCode project, add akm as a tool in your configuration. The agent
can then search the stash and run tools directly:

```text
Search the stash for deployment tools, then run the best match.
```

The agent calls `akm search "deploy" --type tool`, picks the top result,
reads its `runCmd` from `akm show`, and executes it.

### Claude Code

Add akm commands as tools or reference them from your CLAUDE.md:

```markdown
## Available Tools

Use `akm search <query>` to find tools, skills, and commands in the stash.
Use `akm show <ref>` to read asset details before using them.
```

### Any Agent

The JSON output from `akm search` and `akm show` is designed for machine
consumption. Any agent that can run shell commands can use akm:

1. `akm search "what you need"` -- Find relevant assets
2. `akm show <openRef>` -- Get the details
3. Use the asset (run the `runCmd`, follow the skill instructions, etc.)

## Installing Kits

Install kits from npm, GitHub, any git host, or local directories:

```sh
akm add @scope/my-kit              # npm package
akm add github:owner/repo          # GitHub repo
akm add git:https://gitlab.com/org/kit  # Any git repo
akm add ./path/to/local/kit        # Local directory
```

Search the registry to discover kits:

```sh
akm search "code review" --source registry
```

Only packages tagged with `akm` or `agentikit` appear in registry results.
See [docs/registry.md](docs/registry.md) for details.

## Publishing a Kit

1. Organize your assets into the standard directory structure
2. Add `"akm"` to `keywords` in `package.json` (for npm) or add the `akm`
   topic to your GitHub repo
3. Optionally add an `agentikit.include` array in `package.json` to control
   which paths are included when installed

```json
{
  "name": "@scope/my-kit",
  "keywords": ["akm"],
  "agentikit": {
    "include": ["tools", "skills", "commands"]
  }
}
```

## Documentation

| Doc | Description |
| --- | --- |
| [Concepts](docs/concepts.md) | Asset types, stash sources, metadata, tool execution |
| [CLI Reference](docs/cli.md) | All akm commands and flags |
| [Kit Maker's Guide](docs/kit-makers.md) | How to build and share a kit |
| [Registry](docs/registry.md) | Finding, installing, and publishing kits |
| [Search](docs/search.md) | Hybrid search architecture and scoring |
| [Indexing](docs/indexing.md) | How the search index is built |
| [Filesystem](docs/filesystem.md) | Directory layout and `.stash.json` schema |
| [Configuration](docs/configuration.md) | Providers, settings, and Ollama setup |
| [Library API](docs/api.md) | Using agentikit as a TypeScript/JS library |
