# Concepts

`akm` is a package manager for AI agent capabilities. It organizes scripts,
skills, commands, agents, knowledge documents, and memories into a searchable
library that any AI coding assistant can use.

## Mental Model

Three core concepts:

```text
registries    → where you discover kits (indexes of what's available)
kits          → packages you install (cached separately, managed by akm)
stashes       → directories of assets you own (your working stash + any extras)
```

1. **Registries** are indexes of available kits. The official registry ships
   by default; add third-party registries with `akm registry add`. Registries
   contain **installable** kits.
2. **Kits** are installable packages of assets. Install them with `akm add`
   from npm, GitHub, any git host, or a local directory. Installed kits are
   cached in a separate directory (`~/.cache/akm/registry/`) managed by akm —
   you don't edit these files directly.
3. **Stashes** are directories of assets you own. Your **working stash**
   (`~/akm`) is created by `akm init`. You can register additional stashes
   with `akm stash add` — team shared folders, project-specific directories,
   or remote providers like OpenViking.
4. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, and memories.

When you search, akm merges all three sources transparently — your stashes
and installed kits appear as one unified collection.

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

Assets from remote stash providers (such as OpenViking) use the same
`type:name` ref format as everything else.

## Search Priority

When you search or show an asset, akm checks three layers in order. The
first match wins:

1. **Working stash** -- Your personal assets under `AKM_STASH_DIR` (`~/akm`)
2. **Additional stashes** -- Directories and remote providers added via
   `akm stash add`
3. **Installed kits** -- Cache-managed packages added via `akm add`

This means your local assets always override installed kit versions. Use
`akm clone` to copy a kit asset into your working stash for editing.

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
| **ref** (asset ref) | A `type:name` handle for an asset | `script:deploy.sh` |
| **origin** | Optional prefix narrowing an asset ref to a source | `npm:@scope/pkg//script:deploy.sh` |
| **registry ref** | A package identifier passed to `akm add` | `npm:@scope/pkg`, `github:owner/repo` |
| **git ref** | A branch, tag, or commit (used when installing) | `main`, `v1.0.0` |
| **stash** | A directory of assets you own | `~/akm`, `~/.claude/skills` |
| **working stash** | Your primary stash, created by `akm init` | `~/akm` |
| **additional stash** | An extra directory or remote provider registered via `akm stash add` | A filesystem path or OpenViking URL |
| **kit** | An installable package of assets, cached separately from stashes | An npm package or GitHub repo |
| **registry** | An index of available (installable) kits | The official registry, skills.sh |
| **search source** | Where to look: `stash` (local), `registry`, or `both` | `--source stash` |

## Further Reading

- [CLI Reference](cli.md)
- [Kit Maker's Guide](kit-makers.md) -- How to build and share a kit
- [Registry](registry.md) -- Finding and installing kits
- [Search Architecture](technical/search.md) -- Hybrid search details
- [Indexing](technical/indexing.md) -- How the search index is built
- [Filesystem Layout](technical/filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
