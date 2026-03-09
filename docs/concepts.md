# Concepts

Agentikit is a capability discovery system for AI agents. Instead of searching
files, agents discover capabilities -- tools, skills, commands, agents,
knowledge, and scripts -- through indexed metadata and hybrid search.

## Kits

A kit is a package of assets that can be shared and installed. Kits can be
published to npm or hosted on GitHub. Any directory with asset type
subdirectories (`tools/`, `skills/`, etc.) is a valid kit.

Kits are tagged with `akm` or `agentikit` so they can be discovered through
registry search. See [registry.md](registry.md) for details on publishing
and installing kits.

## Asset Types

Agentikit organizes capabilities into six asset types:

| Type | Directory | File Pattern | Purpose |
| --- | --- | --- | --- |
| tool | `tools/` | `.sh`, `.ts`, `.js`, `.ps1`, `.cmd`, `.bat` | Executable scripts with generated run commands |
| skill | `skills/` | Directory containing `SKILL.md` | Structured skill packages |
| command | `commands/` | `.md` files | Slash commands with frontmatter |
| agent | `agents/` | `.md` files | Agent definitions with model hints |
| knowledge | `knowledge/` | `.md` files | Reference documents with section navigation |
| script | `scripts/` | `.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`, etc. | Broad script collection across languages |

Each type has a dedicated handler that controls file detection, naming,
metadata extraction, search enrichment, and show formatting.

## The Stash

The stash is where assets live on disk. Assets are resolved from three
sources in priority order:

1. **Working stash** (read-write) -- The user's main stash directory
   (`AKM_STASH_DIR`). Created by `akm init`.

2. **Mounted stash dirs** (read-only) -- Additional directories listed in
   config. Useful for sharing assets across teams or projects.

3. **Installed kits** (read-only) -- Kits installed via `akm add`. Stored
   in the cache directory and tracked in config.

The first match wins when searching or showing assets. This means local
edits always override installed versions.

## Metadata

Each asset type directory can contain a `.stash.json` sidecar file with
structured metadata. When no `.stash.json` exists, the indexer generates one
automatically from filenames, code comments, frontmatter, and package.json.
See [filesystem.md](filesystem.md) for the full field reference.

## Tool Execution

For tool and script assets, agentikit generates execution metadata:

| Extension | Runtime | Example `runCmd` |
| --- | --- | --- |
| `.sh` | bash | `cd "/path/to/tools" && bash "/path/to/deploy.sh"` |
| `.ts`, `.js` | bun | `cd "/path/to/tools" && bun "/path/to/run.ts"` |
| `.ps1` | powershell | `powershell -ExecutionPolicy Bypass -File ...` |
| `.cmd`, `.bat` | cmd | `cmd /c ...` |

When a `package.json` is found in the tool's directory tree, the working
directory is set to that package root.

## Further Reading

- [CLI Reference](cli.md)
- [Kit Maker's Guide](kit-makers.md) -- How to build and share a kit
- [Registry](registry.md) -- Finding and installing kits
- [Search Architecture](search.md) -- Hybrid search details
- [Indexing](indexing.md) -- How the search index is built
- [Filesystem Layout](filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
- [Library API](api.md) -- Using agentikit as a library
