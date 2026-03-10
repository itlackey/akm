# Agent-i-Kit

Agent-i-Kit gives AI coding agents a shared library of capabilities they can
search and use. You organize tools, skills, commands, agents, knowledge, and
scripts into a **stash**, and agents discover what they need through
`akm` (Agent Kit Manager).

## What Is a Kit?

A kit is a shareable package of assets (aka files and directories). You can organize a kit however you
like -- agentikit classifies assets by their **file extension and content**,
not by directory structure. A `.sh` file is a script whether it lives in
`scripts/`, `tools/`, or `my-stuff/`. A `.md` file with `tools` in its
frontmatter is an agent definition no matter where you put it.

That said, a recommended directory layout exists as an **opt-in convention**
that improves indexing confidence:

```text
my-kit/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md)
  agents/         # Agent definitions (.md)
  knowledge/      # Reference documents (.md)
```

Using these directory names is not required. They act as hints that increase
classification confidence during indexing. See [Concepts](docs/concepts.md)
for details on how classification works.

## What Is an Asset?

An asset is a single capability that an AI agent can discover and use. Each
asset has a **type** that determines how it behaves:

| Type | What it is | What the agent gets |
| --- | --- | --- |
| **script** | An executable script | A `runCmd` the agent can execute, or source for unsupported runtimes |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |

> **Scripts and tools:** Agentikit also supports a `tool` type that behaves
> identically to `script`. The only difference is convention: `tools/`
> accepts a focused set of extensions (.sh, .ts, .js, .ps1, .cmd, .bat)
> while `scripts/` accepts those plus .py, .rb, .go, and more. Use
> whichever name fits your mental model -- they produce the same output.

Assets are referenced by type and name, e.g. `script:deploy.sh` or
`knowledge:api-guide.md`. Agents discover assets through `akm search` and
retrieve their details with `akm show`.

## What Is a Stash?

The stash is your local library of assets. It combines three sources:

1. **Working stash** -- Your personal assets (`AKM_STASH_DIR`). Read-write.
2. **Mounted dirs** -- Shared team directories. Read-only.
3. **Installed kits** -- Kits from npm or GitHub via `akm add`. Read-only.

When you search or open an asset, the working stash takes priority. This
means you can install a kit and override individual assets by cloning them
into your working stash (or any directory with `--dest`).

## Prerequisites

Agent-i-Kit requires [Bun](https://bun.sh) (v1.0+) as its runtime. It uses
Bun-specific APIs (`bun:sqlite`) that are not available in Node.js.

```sh
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
# Install
bun install -g agentikit
```

### Standalone Binary

> **Don't want to install Bun?** Use the standalone binary
> instead -- it has no runtime dependencies.

The standalone binary bundles everything it needs and does **not** require Bun
or Node.js.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
```

```sh
# Windows (PowerShell)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
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


## Quick Start

```sh
# Initialize your stash
akm init

# Install a kit from npm
akm add @scope/my-kit

# Search for assets
akm search "deploy"

# Show an asset
akm show tool:deploy.sh

# Search installed and registry kits
akm search "lint" --source both
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

## Installing Kits

Install kits from npm, GitHub, any git host, or local directories:

```sh
akm add @scope/my-kit              # npm package
akm add github:owner/repo          # GitHub repo
akm add git+https://gitlab.com/org/kit  # Any git repo
akm add ./path/to/local/kit        # Local directory
```

Search the registry to discover kits:

```sh
akm search "code review" --source registry
```

Only packages tagged with [Agent-i-Kit Registry](https://github.com/itlackey/agentikit-registry) appear in registry results.
See [docs/registry.md](docs/registry.md) for details.

## Publishing a Kit

1. Organize your assets (preferred directory names are optional but improve indexing)
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

When you're ready to request inclusion in `agentikit-registry`, run:

```sh
akm submit
akm submit --dry-run
```

From a local kit directory, `akm submit` infers metadata from `package.json`,
validates the public npm package or GitHub repo, and opens a PR with `gh`.

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
