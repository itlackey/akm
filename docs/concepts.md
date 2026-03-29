# Concepts

`akm` is a package manager for AI agent capabilities. It organizes scripts,
skills, commands, agents, knowledge documents, and memories into a searchable
library that any AI coding assistant can use.

## Mental Model

Two core concepts:

```text
sources       → where assets come from (local dirs, packages, providers)
registries    → where you discover sources you don't know about yet
```

A **source** is anything you add with `akm add`. Each source has a **kind**
inferred from the input:

| Input | Kind | Behavior |
| --- | --- | --- |
| `~/.claude/skills` | `local` | Indexed in place. Not updatable. |
| `github:owner/repo` | `managed` | Cached in `~/.cache/akm/`. Updatable. |
| `npm:@scope/kit` | `managed` | Cached in `~/.cache/akm/`. Updatable. |
| `http://host --provider openviking` | `remote` | Queried at search time. Not cached. |

The user never picks the kind. `akm add` infers it.

1. **Sources** are places assets come from. Add any source with `akm add` —
   a local directory, an npm package, a GitHub repo, or a remote provider.
   Use `akm list` to see all your sources and their kinds.
2. **Registries** are discovery indexes for finding sources you don't know
   about yet. The official registry ships by default; add third-party
   registries with `akm registry add`.
3. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, and memories.

Your **working stash** (`~/akm`) is created by `akm init` — it's the
primary directory for your personal, editable assets.

When you search, akm merges all sources transparently into one unified
collection.

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
| **memory** | Context from external systems | Background information the agent should consider |

### Classification Taxonomy

Scripts and knowledge are classified by **what they are**: a `.sh` file is a
script; a plain `.md` file is knowledge. Commands and agents are classified by
**how an LLM should use them**: a `.md` file with `$ARGUMENTS` placeholders is
a command template; one with `tools` or `toolPolicy` in its frontmatter is an
agent definition. Skills are a **packaging convention**: a directory containing
a `SKILL.md` file.

See [technical/classification.md](technical/classification.md) for the full
specificity-based matching system.

### Memories

Memories are context fragments managed by external systems — OpenViking
servers, file-based memory stores, or agent memory frameworks that write
recalled context as markdown files. akm does not create or manage memories
directly. It makes them searchable alongside your other assets.

To add a memory source:

```sh
# File-based memory store
akm add ~/my-agent/memories

# OpenViking memory server
akm add http://host:1933 --provider openviking --options '{"apiKey":"key"}'
```

Memory assets appear in search results with the `memory` type, giving agents
access to recalled context from previous sessions or external knowledge bases.

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

Assets from remote stash providers (such as OpenViking) use the same
`type:name` ref format as everything else.

## Search Priority

When you search or show an asset, akm checks sources in order. The first
match wins:

1. **Working stash** -- Your personal assets under `AKM_STASH_DIR` (`~/akm`)
2. **Local sources** -- Directories added via `akm add`
3. **Managed sources** -- Packages added via `akm add` (cached in `~/.cache/akm/`)
4. **Remote sources** -- Providers queried at search time

This means your local assets always override managed package versions. Use
`akm clone` to copy an asset into your working stash for editing.

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

## Glossary

These terms have precise meanings in akm. Use this table to avoid confusion:

| Term | Meaning | Example |
| --- | --- | --- |
| **source** | A place assets come from — added via `akm add` | A directory, npm package, or remote provider |
| **local source** | A directory on disk, indexed in place | `~/akm`, `~/.claude/skills` |
| **managed source** | A package fetched and cached by akm, updatable | An npm package or GitHub repo |
| **remote source** | An API provider queried at search time | An OpenViking URL |
| **working stash** | Your primary directory for editable assets (`~/akm`) | Created by `akm init` |
| **registry** | A discovery index for finding sources | The official registry, skills.sh |
| **ref** (asset ref) | A `type:name` handle for an asset | `script:deploy.sh` |
| **origin** | Optional prefix narrowing an asset ref to a source | `npm:@scope/pkg//script:deploy.sh` |
| **registry ref** | A package identifier passed to `akm add` | `npm:@scope/pkg`, `github:owner/repo` |
| **git ref** | A branch, tag, or commit (used when installing) | `main`, `v1.0.0` |
| **kit** | A managed source (backward-compatible term) | An npm package or GitHub repo |
| **search source** | Where to look: `stash` (local), `registry`, or `both` | `--source stash` |

## Further Reading

- [CLI Reference](cli.md)
- [Kit Maker's Guide](kit-makers.md) -- How to build and share a kit
- [Registry](registry.md) -- Finding and installing kits
- [Search Architecture](technical/search.md) -- Hybrid search details
- [Indexing](technical/indexing.md) -- How the search index is built
- [Filesystem Layout](technical/filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
