# Concepts

`akm` is built around a small stash of kits that contain reusable assets that agents can search,
inspect, and execute.

## What's In a Kit?

A kit is a directory of assets you can share and install. There's no required
structure — `akm` classifies assets by **file extension and content**, not by
directory name. A `.sh` file is a script whether it lives in `scripts/`,
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

## Asset Types

There are five primary asset types:

| Type | Purpose | What the agent gets |
| --- | --- | --- |
| **script** | Executable code or shell automation | A `run` command and optional `setup` / `cwd` |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |

Assets are identified by a `ref` handle (for example `script:deploy.sh` or
`agent:reviewer`). An agent discovers assets through `akm search` and
retrieves full details with `akm show`.

## Stash Sources

akm searches three source layers in priority order:

1. **Primary stash** -- Your personal assets under `AKM_STASH_DIR`
2. **Search paths** -- Additional directories listed in config
3. **Installed kits** -- Cache-managed assets added via `akm add`

The first match wins when searching or showing assets. Local edits therefore
override installed versions.

## Metadata

Each asset type directory can contain a `.stash.json` sidecar file with
structured metadata. When no `.stash.json` exists, the indexer derives metadata
in memory for the search index from filenames, code comments, frontmatter, and
package.json.

See [technical/filesystem.md](technical/filesystem.md) for the full field reference.

## Script Execution (ExecHints)

For script assets, akm resolves execution hints in this order:

1. `.stash.json` fields (`run`, `setup`, `cwd`)
2. Header comment tags (`@run`, `@setup`, `@cwd`)
3. Auto-detection from extension and nearby dependency files

## Further Reading

- [CLI Reference](cli.md)
- [Kit Maker's Guide](kit-makers.md) -- How to build and share a kit
- [Registry](registry.md) -- Finding and installing kits
- [Search Architecture](technical/search.md) -- Hybrid search details
- [Indexing](technical/indexing.md) -- How the search index is built
- [Filesystem Layout](technical/filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
