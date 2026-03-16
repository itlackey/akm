# Getting Started

This guide walks you through installing akm, adding your first asset, and
using search and show to discover capabilities.

## Install

Install from npm:

```sh
bun install -g akm-cli
```

Or download a standalone binary from the
[GitHub releases](https://github.com/itlackey/agentikit/releases) page.

## Initialize the Stash

Run `akm init` to create the stash directory structure:

```sh
akm init
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

Any file with a known extension (`.sh`, `.ts`, `.py`, etc.) placed in the
stash is automatically recognized. The `scripts/` directory is not required
-- it just increases classification confidence. See [concepts.md](concepts.md)
for how classification works.

## Index

Build the search index so your assets are discoverable:

```sh
akm index
```

This scans all stash sources and generates metadata for each asset. Run
`akm index --full` to force a complete rebuild instead of an incremental
update.

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

## Install a Kit

Install a kit from npm, GitHub, or any git host:

```sh
akm add @scope/kit
akm add github:owner/repo
```

Installed kits are cached locally and their assets become searchable
immediately. Use `akm list` to see installed kits and `akm update --all`
to keep them current.

See [registry.md](registry.md) for the full install flow and supported
ref formats.

## Next Steps

- [Concepts](concepts.md) -- Asset types, classification, and the stash
- [CLI Reference](cli.md) -- All commands and flags
- [Ref Format](technical/ref.md) -- How asset references work
- [Kit Maker's Guide](kit-makers.md) -- Build and share your own kits
