# Getting Started

This guide walks you through installing akm, adding your first asset, and
using search and show to discover capabilities.

## Install

Install from npm:

```sh
bun install -g akm-cli
```

Or download a standalone binary from the
[GitHub releases](https://github.com/itlackey/akm/releases) page.

## First-Time Setup

For a guided first run, start with:

```sh
akm setup
```

`akm setup` walks through stash location, embedding/LLM settings, semantic
search asset preparation, registries, and sources, then saves your
config, initializes the stash directory, and builds the search index.

## Initialize Your Working Stash

If you prefer to skip the wizard, run `akm init` to create your working stash —
the primary directory where your personal assets live:

```sh
akm init
akm init --dir ~/custom-stash
```

This creates `~/akm` with subdirectories for each asset type: `scripts/`,
`skills/`, `commands/`, `agents/`, `knowledge/`, and `memories/`. See
[technical/filesystem.md](technical/filesystem.md) for platform-specific paths and environment
variable overrides.

## Add Your First Asset

Create a simple shell script in the `scripts/` directory:

```sh
cat > ~/akm/scripts/hello.sh << 'EOF'
#!/usr/bin/env bash
# A simple greeting script
echo "Hello from akm!"
EOF
chmod +x ~/akm/scripts/hello.sh
```

Any file with a known extension (`.sh`, `.ts`, `.py`, etc.) placed in your
working stash is automatically recognized. The `scripts/` directory is not
required -- it just increases classification confidence. See
[concepts.md](concepts.md) for how classification works.

## Index

Build the search index so your assets are discoverable:

```sh
akm index
```

**`init` vs `index`:** `akm init` creates your working stash directory (run
once). `akm index` scans all sources, then builds the
search database (run whenever you add or change assets). They are separate
steps — `init` sets up the folders, `index` makes their contents searchable.

Run `akm index --full` to force a complete rebuild instead of an incremental
update. If a workflow file is malformed, akm now skips that asset, continues
indexing the rest of the stash, and reports the skipped file in `warnings`.

## Search

Find assets by keyword:

```sh
akm search "hello"
```

Results include a `ref` field (for example `script:hello.sh`) that you pass
directly to `akm show`. Filter by type or limit results:

```sh
akm search "deploy" --type script --limit 5
```

See [cli.md](cli.md) for the full set of search flags.

## Show

Inspect an asset by its ref:

```sh
akm show script:hello.sh
```

The output is structured JSON containing everything an agent needs to use
the asset. For scripts, this includes a `run` command plus optional `cwd`
and `setup`. For agents, a `prompt` payload. For knowledge, navigable
`content` with view modes.

See [technical/show-response.md](technical/show-response.md) for the full per-type field
reference.

## Add Sources

Add any source — a local directory, a GitHub repo, an npm package, or a website:

```sh
akm add ~/.claude/skills              # Your Claude Code skills
akm add github:owner/repo             # A team's shared kit
akm add @scope/my-kit                 # An npm package
akm add https://docs.example.com --name docs  # A documentation site
```

All become searchable immediately. Use `akm list` to see your sources and
`akm update --all` to keep managed sources current.

Website sources are crawled and converted to markdown knowledge assets. Control
the crawl with `--max-pages` and `--max-depth`:

```sh
akm add https://www.agentic-patterns.com/ --name agent-patterns --max-pages 100
```

See [registry.md](registry.md) for the full install flow and supported
ref formats.

## Next Steps

- [Concepts](concepts.md) -- Asset types, classification, and the stash
- [CLI Reference](cli.md) -- All commands and flags
- [Ref Format](technical/ref.md) -- How asset references work
- [Kit Maker's Guide](kit-makers.md) -- Build and share your own kits
