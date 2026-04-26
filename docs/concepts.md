# Concepts

`akm` is a package manager for AI agent capabilities. It organizes scripts,
skills, commands, agents, knowledge documents, vaults, workflows, wikis, and
memories into a searchable library that any AI coding assistant can use.

## Mental Model

Two core concepts:

```text
sources       → where assets come from (local dirs, git repos, websites, npm)
registries    → where you discover sources you don't know about yet
```

A **source** is anything you add with `akm add`. Every source materialises
files to a local directory; the indexer walks that directory and builds the
search index. Each source has a **kind** inferred from the input:

| Input | Kind | Behavior |
| --- | --- | --- |
| `~/.claude/skills` | `filesystem` | Indexed in place. Not updatable. Writable by default. |
| `github:owner/repo` | `git` | Cloned into `~/.cache/akm/`. Updatable via `akm update`. Read-only by default. |
| `npm:@scope/stash` | `npm` | Installed into `~/.cache/akm/`. Updatable via `akm update`. Read-only. |
| `https://docs.example.com` | `website` | Crawled, converted to markdown, cached. Refreshed every 12 hours. Read-only. |

The user never picks the kind. `akm add` infers it from the input shape.

1. **Sources** are places assets come from. Add any source with `akm add` —
   a local directory, a GitHub repo, an npm package, or a website. Use
   `akm list` to see all your sources.
2. **Registries** are discovery indexes for finding sources you don't know
   about yet. The official registry ships by default; add third-party
   registries with `akm registry add`.
3. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, vaults,
   workflows, wikis, and memories.

Your **working stash** (`~/akm`) is created by `akm init` — it's the
primary directory for your personal, editable assets, and is registered as
a `filesystem` source automatically.

When you search, akm queries the unified local FTS5 index, which includes
every source's directory. There is no per-source fan-out at search time.

### Source vs. working stash

The two terms come up often:

- **Source** is the configuration concept (`sources[]` in your config file).
  It's any directory akm has been told to index. Configured via `akm add`.
- **Working stash** is the special source created by `akm init` — the
  default destination for `akm remember`, `akm import`, and other writes.
  Tracked as `stashDir` in config and registered automatically as a
  `filesystem` source.

If you don't pick a write destination explicitly with `--target` or
`defaultWriteTarget`, writes land in the working stash.

## What's In a Stash?

A stash is a directory of assets you can share and install. There's no required
structure -- `akm` classifies assets by **file extension and content**, not by
directory name. A `.sh` file is a script whether it lives in `scripts/`,
`deploy/`, or at the root.

That said, using these directory names as an opt-in convention improves
indexing confidence. Vaults are the current exception: `.env` vault assets are
only discovered under `vaults/` paths.

```text
my-stash/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
  vaults/         # Environment vaults (.env)
  workflows/      # Step-by-step workflow documents (.md)
  wikis/          # Multi-wiki knowledge bases (see docs/wikis.md)
  memories/       # Recalled context fragments (.md)
```

## Asset Types

There are nine asset types:

| Type | Purpose | What the agent gets |
| --- | --- | --- |
| **script** | Executable code or shell automation | A `run` command and optional `setup` / `cwd` |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |
| **vault** | A key/value environment vault | Key names and comments, never secret values |
| **workflow** | A structured multi-step procedure | Parsed steps, completion criteria, and resumable run state |
| **wiki** | A page inside a multi-wiki knowledge base | Markdown page with TOC / section / lines views (see [wikis.md](wikis.md)) |
| **memory** | Context from external systems | Background information the agent should consider |

### Classification Taxonomy

Scripts and knowledge are classified by **what they are**: a `.sh` file is a
script; a plain `.md` file is knowledge. Commands and agents are classified by
**how an LLM should use them**: a `.md` file with `$ARGUMENTS` placeholders is
a command template; one with `tools` or `toolPolicy` in its frontmatter is an
agent definition. Workflows are classified by their markdown structure (`#
Workflow:`, `## Step:`, `Step ID:`, `### Instructions`). Skills are a
**packaging convention**: a directory containing a `SKILL.md` file.

See [technical/classification.md](technical/classification.md) for the full
specificity-based matching system.

### Memories

Memories are context fragments — observations, decisions, snippets — captured
as markdown files. You can capture a memory directly in your working stash
with `akm remember "..."`, or point akm at any directory of memory files
written by another tool.

To add a memory source:

```sh
# File-based memory store from another tool
akm add ~/my-agent/memories
```

Memory assets appear in search results with the `memory` type, giving agents
access to recalled context from previous sessions.

Memories captured with `akm remember` can carry optional YAML frontmatter
(`tags`, `source`, `observed_at`, `expires`, `subjective`, `description`) that
the indexer uses for ranking. Supply those fields explicitly with
`--tag`/`--expires`/`--source`, derive them from the body heuristically with
`--auto`, or have the configured LLM propose them with `--enrich`. See
[`akm remember`](cli.md#remember) for the full flag list.

## Refs

Assets are identified by a **ref** -- a compact handle returned by
`akm search` and consumed by `akm show`. The format is:

```text
type:name
```

For example: `script:deploy.sh`, `agent:reviewer`, `knowledge:api-guide`,
`workflow:ship-release`.

When an asset comes from an installed stash, refs can include an **origin**
prefix to narrow lookup to that specific source:

```text
origin//type:name
```

For example: `npm:@scope/pkg//script:deploy.sh`,
`github:owner/repo//knowledge:guide`.

Agents should treat refs as opaque tokens -- get them from search, pass them
to show. The structured fields `type`, `name`, and `origin` in search results
provide the same information in a parseable form.

Source locators like `github:owner/repo` and `npm:@scope/pkg` are **install
refs**, accepted only by `akm add` and `akm clone`. They are not asset refs.

## Search Priority

`akm search` and `akm show` query a single local FTS5 index that covers every
configured source's directory. Within the index, results are ranked by
relevance and utility — there is no source-by-source fan-out.

When two sources contain an asset with the same name, the working stash wins
by convention because its files are usually more recent, but precedence is
expressed through ranking rather than a fixed lookup order. Use `akm clone`
to copy an asset into your working stash for local editing — your edits
override the upstream copy in subsequent searches.

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

## Writable sources and write targets

Each source has a `writable` flag (config field `writable`). Defaults:

- `filesystem` — `true` (you usually own directories you point akm at)
- `git` — `false` (set `writable: true` per source if you intend to push back)
- `website`, `npm` — always `false`. Setting `writable: true` for these is
  rejected at config load — the next `sync()` would clobber your edits.

Write commands (`akm remember`, `akm import`, etc.) pick a destination using
this precedence:

1. `--target <name>` flag (must name a writable source)
2. The root-level `defaultWriteTarget` field in config
3. The working stash (`stashDir` from `akm init`)

If none are configured, write commands raise a `ConfigError` pointing at
`akm init`.

## Glossary

These terms have precise meanings in akm. Use this table to avoid confusion:

| Term | Meaning | Example |
| --- | --- | --- |
| **source** | A place assets come from — added via `akm add` | A directory, git repo, npm package, or website |
| **filesystem source** | A directory on disk, indexed in place | `~/akm`, `~/.claude/skills` |
| **git source** | A git repo cloned into akm's cache, updatable | A GitHub repo |
| **npm source** | An npm package installed into akm's cache, updatable | `@scope/my-stash` |
| **website source** | A crawled website stored as knowledge | `https://docs.example.com` |
| **working stash** | Your primary directory for editable assets (`~/akm`) | Created by `akm init` |
| **registry** | A discovery index for finding sources | The official registry, skills.sh |
| **ref** (asset ref) | A `type:name` handle for an asset | `script:deploy.sh` |
| **origin** | Optional prefix narrowing an asset ref to a source | `npm:@scope/pkg//script:deploy.sh` |
| **install ref** | A package identifier passed to `akm add` or `akm clone` | `npm:@scope/pkg`, `github:owner/repo` |
| **git ref** | A branch, tag, or commit (used when installing) | `main`, `v1.0.0` |
| **search source** | Where to look: `stash` (local), `registry`, or `both` | `--source stash` |

## Further Reading

- [CLI Reference](cli.md)
- [Wikis](wikis.md) -- Multi-wiki knowledge bases (Karpathy-style)
- [Stash Maker's Guide](stash-makers.md) -- How to build and share a stash
- [Registry](registry.md) -- Finding and installing stashes
- [Search Architecture](technical/search.md) -- Hybrid search details
- [Indexing](technical/indexing.md) -- How the search index is built
- [Filesystem Layout](technical/filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
