---
name: stash
description: Search, open, and run extension assets from an Agentikit stash directory. Use when the user wants to find tools, skills, commands, or agents in their stash, view asset contents, or execute stash tools.
---

# Agentikit Stash

You have access to the `agentikit` CLI to manage extension assets from a stash directory.

The stash directory is configured via the `AGENTIKIT_STASH_DIR` environment variable and contains:

- **tools/** — executable scripts (.sh, .ts, .js, .ps1, .cmd, .bat)
- **skills/** — skill directories containing SKILL.md
- **commands/** — markdown template files
- **agents/** — markdown agent definition files

## Commands

### Build the search index

Scan stash directories, auto-generate missing `.stash.json` metadata, and build a semantic search index.

```bash
agentikit index
```

Run this after adding new extensions to enable semantic search ranking.

### Search the stash

Find assets by semantic similarity (if indexed) or name substring. Returns JSON with matching hits including `openRef` identifiers.

```bash
agentikit search [query] [--type tool|skill|command|agent|any] [--limit N]
```

### Open an asset

Retrieve the full content/payload of an asset using its `openRef` from search results.

```bash
agentikit open <openRef>
```

Returns type-specific payloads:
- **skill** → full SKILL.md content
- **command** → markdown template + description
- **agent** → prompt + description, toolPolicy, modelHint
- **tool** → execution command and kind

### Run a tool

Execute a tool asset by its `openRef`. Only tool refs are supported.

```bash
agentikit run <openRef>
```

Returns the tool's stdout/stderr output and exit code.

## Workflow

1. Build the index: `agentikit index`
2. Search for assets: `agentikit search "deploy" --type tool`
3. Inspect a result: `agentikit open <openRef>`
4. Run a tool: `agentikit run <openRef>`

All output is JSON for easy parsing.
