# Concepts

`akm` is a package manager for AI agent capabilities. It organizes scripts,
skills, commands, agents, knowledge documents, and memories into a searchable
library that any AI coding assistant can use.

## Mental Model

Four layers, from broadest to most specific:

```text
registries --> kits --> stash --> assets
```

1. **Registries** are indexes of available kits. The official registry ships
   by default; you can add third-party registries with `akm registry add`.
2. **Kits** are installable packages of assets. Install them with `akm add`
   from npm, GitHub, any git host, or a local directory.
3. **The stash** is the local library where assets live. It merges your
   personal assets, search-path directories, and installed kits into a
   single searchable collection.
4. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, and memories.

## What's In a Kit?

A kit is a directory of assets you can share and install. There's no required
structure -- `akm` classifies assets by **file extension and content**, not by
directory name. A `.sh` file is a script whether it lives in `scripts/`,
`deploy/`, or at the root.

That said, using these directory names as an opt-in convention improves
indexing confidence:

```text
my-kit/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
  memories/       # Recalled context fragments (.md)
```

## Asset Types

There are six asset types:

| Type | Purpose | What the agent gets |
| --- | --- | --- |
| **script** | Executable code or shell automation | A `run` command and optional `setup` / `cwd` |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |
| **memory** | A recalled context fragment | Contextual information the agent should consider |

### Classification Taxonomy

Scripts and knowledge are classified by **what they are**: a `.sh` file is a
script; a plain `.md` file is knowledge. Commands and agents are classified by
**how an LLM should use them**: a `.md` file with `$ARGUMENTS` placeholders is
a command template; one with `tools` or `toolPolicy` in its frontmatter is an
agent definition. Skills are a **packaging convention**: a directory containing
a `SKILL.md` file.

See [technical/classification.md](technical/classification.md) for the full
specificity-based matching system.

## Refs

Assets are identified by a **ref** -- a compact handle returned by
`akm search` and consumed by `akm show`. The format is:

```text
type:name
```

For example: `script:deploy.sh`, `agent:reviewer`, `knowledge:api-guide`.

When an asset comes from an installed kit, refs can include an **origin**
prefix to narrow lookup to that specific source:

```text
origin//type:name
```

For example: `npm:@scope/pkg//script:deploy.sh`,
`github:owner/repo//knowledge:guide`.

Agents should treat refs as opaque tokens -- get them from search, pass them
to show. The structured fields `type`, `name`, and `origin` in search results
provide the same information in a parseable form.

`akm show` also accepts `viking://` URIs for remote OpenViking content, in
addition to the standard `type:name` format.

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
