# Concepts

`akm` is a package manager for AI agent capabilities. It organizes scripts,
skills, commands, agents, knowledge documents, env files, secrets, workflows,
wikis, and memories into a searchable library that any AI coding assistant can use.

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
| `github:owner/repo` | `git` | Cloned into `~/.cache/akm/registry/`. Updatable via `akm update`. Read-only by default. |
| `npm:@scope/stash` | `npm` | Installed into `~/.cache/akm/registry/`. Updatable via `akm update`. Read-only. |
| `https://docs.example.com` | `website` | Crawled, converted to markdown, cached. Refreshed every 12 hours. Read-only. |

The user never picks the kind. `akm add` infers it from the input shape.

1. **Sources** are places assets come from. Add any source with `akm add` —
   a local directory, a GitHub repo, an npm package, or a website. Use
   `akm list` to see all your sources.
2. **Registries** are discovery indexes for finding sources you don't know
   about yet. The official registry ships by default; add third-party
   registries with `akm registry add`.
3. **Assets** are the individual capabilities an agent discovers and uses:
   scripts, skills, commands, agents, knowledge documents, env files,
   secrets, workflows, wikis, and memories.

Your **working stash** (`~/akm`) is created by `akm setup` — it's the
primary directory for your personal, editable assets, and is registered as
a `filesystem` source automatically.

When you search, akm queries the unified local FTS5 index, which includes
every source's directory. There is no per-source fan-out at search time.

### Source vs. working stash

The two terms come up often:

- **Source** is the configuration concept (`sources[]` in your config file).
  It's any directory akm has been told to index. Configured via `akm add`.
- **Working stash** is the special source created by `akm setup` — the
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
indexing confidence. Env files are the current exception: `.env` env assets are
only discovered under `env/` paths.

```text
my-stash/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
  env/            # Environment files (.env) — groups of related config, loaded whole
  secrets/        # Secrets — one sensitive value per file (auth tokens, keys, certs)
  workflows/      # Workflow documents (.md) and YAML v2 programs (.yaml/.yml)
  wikis/          # Multi-wiki knowledge bases (see docs/wikis.md)
   lessons/        # Distilled lessons (.md, see akm improve / proposals)
  memories/       # Recalled context fragments (.md)
  .meta/          # Optional stash orientation, not indexed (see "Metadata" below)
```

## Asset Types

There are eleven asset types:

| Type | Purpose | What the agent gets |
| --- | --- | --- |
| **script** | Executable code or shell automation | A `run` command and optional `setup` / `cwd` |
| **skill** | A set of instructions | Step-by-step guidance the agent follows |
| **command** | A prompt template | A template with placeholders to fill in |
| **agent** | An agent definition | A system prompt, model hint, and tool policy |
| **knowledge** | A reference document | Navigable content with TOC and section views |
| **env** | A `.env` file of related **configuration** for an app/service | Key names and comments, never values. Holds a group of related settings (URLs, flags, and any credentials it needs); values may or may not be sensitive but are always protected. Key names are intentionally discoverable — they appear in `env list`, search results, and agent context by design. Inject via `akm env run <ref> -- <cmd>`; prefer `--clean` in agent contexts so the child starts from a minimal inherited environment. |
| **secret** | A single sensitive value for **authentication** (token, key, cert) | Name only — the entire file is the value and never appears in output. Use for one credential used on its own; for a group of related config use `env`. Access via `akm secret path` / `akm secret run` |
| **workflow** | A structured multi-step procedure | Parsed steps, completion criteria, and resumable run state |
| **wiki** | A page inside a multi-wiki knowledge base | Markdown page with TOC / section / lines views (see [wikis.md](wikis.md)) |
| **lesson** | A distilled feedback lesson | `when_to_use` guidance plus the lesson body (see [`akm improve`](cli.md#improve)) |
| **memory** | Context from external systems | Background information the agent should consider |
| **fact** | A durable stash-level fact | Mostly-static semantic knowledge — personal/team/project details, coding conventions / "constitution", and stash-meta (naming conventions, active projects). `category` scopes it; `pinned: true` marks always-injected core context (see [design note](design/fact-asset-type.md)) |

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

Hot-path memories (those written via `akm remember`) also receive
`captureMode: hot` and `beliefState: asserted` in their frontmatter
automatically. Background-derived memories (those inferred from other assets
by `akm improve`) receive `captureMode: background`. The indexer applies a
small ranking boost to hot-captured memories so explicit user-recorded context
ranks above passive inference when both match a query.

### Belief states

Memories carry a `beliefState` field that signals how the indexer should weigh
them in search. The supported values, from strongest to weakest authority:

| State | When it's set | Ranking effect |
|-------|---------------|----------------|
| `asserted` | Written directly by `akm remember` (user-explicit) | strongest active boost |
| `active` | Default for memories with no explicit state | active boost |
| `deprecated` | Marked as no-longer-current but not yet superseded | small penalty; frozen (never auto-refreshed) |
| `superseded` | Replaced by another memory via the `supersededBy` field | larger penalty |
| `contradicted` | Marked as contradicted by other evidence | strong penalty |
| `archived` | Soft-deleted; retained for audit | strongest penalty |

`akm search` filters via `--belief current|historical|all`:
- `current` (default for memory search) → `active` + `asserted`
- `historical` → `deprecated` + `superseded` + `contradicted` + `archived`
- `all` → no filter

### Derived memories as retrieval shortcuts

When `akm improve` infers a derived memory from a parent (e.g. distilling a
verbose memory into a focused summary), the derived memory is written with a
`source: memory:<parent>` frontmatter field and the indexer records the
parent/child link in the `derived_from` column.

Search hits for the parent memory are then enriched in-place: the parent's
description and tags are swapped with the derived child's surface text, and an
`expandTo: memory:<derived>` field on the hit points at the richer derived
ref. The parent ref itself is preserved on the hit, so existing automation
keeps working — agents that want the deeper summary follow `expandTo`.

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

### Namespacing assets across projects and teams

AKM already supports **physical-subdirectory namespacing** today — no extra
flags required. Drop assets under nested directories beneath the type folder
and the path becomes part of the ref's name. Examples:

```text
memories/projectA/auth-tip.md    →  memory:projectA/auth-tip
memories/teamA/clientX/notes.md  →  memory:teamA/clientX/notes
skills/projectB/lint-fix.md      →  skill:projectB/lint-fix
knowledge/clientX/api-guide.md   →  knowledge:clientX/api-guide
```

This works for **any** asset type. Search and show treat the prefixed name
like any other ref, so `akm search "memory:projectA/"` narrows results to
that subtree.

**Recommendation:** use physical subdirectories now to organize multi-project
or multi-team stashes. They survive renames, sort cleanly on disk, and
require no configuration.

Future iterations (no committed dates):

- A `--namespace <ns>` flag will provide a thin name-prefix normalizer on
  `search`, `remember`, `improve`, `distill`, and `feedback` so the same
  prefix doesn't have to be typed every time.
- A `::` delimiter (for example `projectA::memory:auth-tip`) will provide
  strict isolation so refs from different namespaces never collide in
  ranking or recall.

Until those land, physical subdirectories remain the recommended pattern.

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

`.stash.json` support was removed in v0.8.0. Prefer metadata that lives with
the asset itself: frontmatter for markdown assets, and structured comments for
scripts. The indexer derives metadata from filenames, code comments,
frontmatter, and package.json.

See [technical/filesystem.md](technical/filesystem.md) for the full field reference.

### Stash orientation: the `.meta/` convention

A stash may carry an optional `.meta/` directory at its root holding
human-authored orientation for the stash *as a whole* — purpose, key assets,
conventions, maintainer. This is distinct from per-asset metadata (which still
lives with each asset) and from the removed `.stash.json` sidecar (which
enumerated per-asset entries): `.meta/` never describes individual assets, only
the stash itself.

```text
my-stash/
  .meta/
    index.md          # shown by `akm show meta` — the default orientation doc
    about.md          # shown by `akm show meta:about`
    conventions.md    # shown by `akm show meta:conventions`
```

Because `.meta/` is a dot-directory, the indexer skips it — these docs never
appear in `akm search` and never compete for ranking. They are **direct-read on
demand**:

```sh
akm show meta                       # working stash's .meta/index.md
akm show meta:about                 # working stash's .meta/about.md
akm show local//meta                # the primary stash explicitly
akm show github:owner/repo//meta    # an installed stash's .meta/index.md
```

`akm show <origin>//meta:<name>` resolves `<name>.md` first, then an
extensionless `<name>`. The convention is open-ended: stash owners add new docs
by dropping files into `.meta/` — no configuration or code changes required.
`akm init` scaffolds a starter `.meta/index.md`.

## Script Execution (ExecHints)

For script assets, akm resolves execution hints in this order:

1. Header comment tags (`@run`, `@setup`, `@cwd`)
2. Auto-detection from extension and nearby dependency files

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
3. The working stash (`stashDir` from `akm setup`)

If none are configured, write commands raise a `ConfigError` pointing at
`akm setup`.

`akm improve` and `akm lint` only operate on writable sources. Read-only
registry caches (`git`, `npm`, `website`) are excluded from improvement and
lint passes even if they are indexed.

## Storage

akm uses four XDG-compliant directories:

| Location | What lives there |
| --- | --- |
| `~/.local/share/akm/index.db` | Search index, embeddings, LLM cache, registry index cache |
| `~/.local/share/akm/workflow.db` | Workflow run state |
| `~/.local/share/akm/state.db` | Events, proposals, and task history |
| `~/.local/share/akm/akm.lock` | Installed stash lockfile |
| `~/.cache/akm/registry/` | Downloaded stash packages (regenerable) |
| `~/.config/akm/config.json` | User configuration |
| `~/akm` (or custom `stashDir`) | Your writable working stash |

Events, proposals, and task history are stored in `state.db` — not in flat
files or in the search index. The search index (`index.db`) is derived from
the asset directories and is rebuildable with `akm index`.

Users upgrading from v0.7 should run `akm-migrate-storage --yes`
once to move `index.db`, `workflow.db`, and flat-file state to their new
locations. See [migration/v0.7-to-v0.8.md](migration/v0.7-to-v0.8.md) for
the full guide.

## Glossary

These terms have precise meanings in akm. Use this table to avoid confusion:

| Term | Meaning | Example |
| --- | --- | --- |
| **source** | A place assets come from — added via `akm add` | A directory, git repo, npm package, or website |
| **filesystem source** | A directory on disk, indexed in place | `~/akm`, `~/.claude/skills` |
| **git source** | A git repo cloned into akm's cache, updatable | A GitHub repo |
| **npm source** | An npm package installed into akm's cache, updatable | `@scope/my-stash` |
| **website source** | A crawled website stored as knowledge | `https://docs.example.com` |
| **working stash** | Your primary directory for editable assets (`~/akm`) | Created by `akm setup` |
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
