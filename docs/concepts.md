# Concepts

Agent-i-Kit (akm) is a capability discovery system for AI agents. Instead of searching
files, agents discover capabilities -- tools, skills, commands, agents,
knowledge, and scripts -- through indexed metadata and hybrid search.

## Kits

A kit is a package of assets that can be shared and installed. Any directory
containing asset files is a valid kit -- there is no required structure.
Kits can be published to npm or hosted on GitHub and tagged with `akm` or
`agentikit` for registry discovery. See [registry.md](registry.md) for
details.

## Assets

An asset is a single capability -- a file or small group of files -- that an
AI agent can discover, inspect, and act on. Every asset has a **type** that
controls how it is classified, displayed, and used.

Assets are identified by a `ref` handle (for example `script:deploy.sh` or
`agent:reviewer`). An agent discovers assets through `akm search` and
retrieves full details with `akm show`. In normal use, the agent should treat
the ref as opaque: get it from search, pass it to show, and rely on structured
fields rather than parsing it. The show response includes everything the agent
needs to use the asset: a run command for scripts, a prompt payload for agents,
navigable content for knowledge, and so on.

Assets live inside [kits](#kits) and are stored in the [stash](#the-stash).
Their type is determined by the [classification system](#asset-classification)
described below.

## Asset Types

akm organizes capabilities into five primary asset types:

| Type | Classified by | Preferred Directory | Purpose |
| --- | --- | --- | --- |
| script | File extension (`.sh`, `.ts`, `.js`, `.py`, `.rb`, `.go`, etc.) | `scripts/` | Executable scripts with generated run commands |
| skill | Filename (`SKILL.md`) | `skills/` | Structured skill packages |
| command | `.md` with `agent` frontmatter or `$ARGUMENTS`/`$1`-`$3` body placeholders | `commands/` | Prompt templates with dispatch targets |
| agent | `.md` with `tools` or `toolPolicy` frontmatter, or `model` alone | `agents/` | Agent definitions with model hints |
| knowledge | Any `.md` without agent/command signals | `knowledge/` | Reference documents with section navigation |

Classification is driven by **file extension and content**, not directory
structure. A `.sh` file is recognized as a script whether it lives in
`scripts/`, `tools/`, or any other directory. A `.md` file with `model` in
its frontmatter is classified as an agent even if it sits at the kit root.

The "Preferred Directory" column lists opt-in conventions that increase
classification confidence during indexing, but they are never required.
Organize your kit however makes sense for your project.

> **Scripts and tools:** `tool` is a transparent alias for `script`. The
> `tool:` prefix is accepted in refs and transparently maps to `script:`.
> Both `tools/` and `scripts/` directories are recognized and their
> contents are treated identically. Use whichever name fits your mental
> model.

## Asset Classification

akm uses a two-layer classification system: **matchers** determine
what an asset is, and **renderers** determine how it is presented.

### Matchers

Four built-in matchers are evaluated for every file. Each returns a
specificity score; the highest score wins. This means extension and content
always provide a baseline classification, and directory placement is an
optional boost:

| Matcher | Specificity | Strategy |
| --- | --- | --- |
| Extension matcher | 3 | Classifies by file extension alone -- works in any directory |
| Directory matcher | 10 | Boosts confidence when the first directory segment matches a known name (`scripts/`, `agents/`, etc.) |
| Parent-dir hint matcher | 15 | Boosts confidence when the immediate parent directory matches a known name |
| Smart markdown matcher | 20 / 18 / 8 / 5 | Agent-exclusive (`tools`/`toolPolicy`) at 20; command signals (`agent` frontmatter, `$ARGUMENTS`/`$1`-`$3`) at 18; `model` alone at 8; knowledge fallback at 5 |

Because the extension matcher runs at the base level, every file with a
known extension is discoverable regardless of directory. Placing a file in
a preferred directory (e.g. `scripts/`) simply raises the specificity from
3 to 10 or 15, which can matter when matchers disagree.

Content signals override directory hints. A `.md` file with `tools` or
`toolPolicy` in its frontmatter is classified as an agent at specificity
20. Command signals -- `agent` frontmatter (OpenCode dispatch target) or
`$ARGUMENTS`/`$1`-`$3` placeholders in the body -- classify at specificity
18, overriding directory placement. The `model` key alone is a weak agent
signal (specificity 8) that loses to directory hints (10/15), so a `.md`
with `model` in `commands/` stays a command.

### Renderers

Each asset type has a dedicated renderer:

| Renderer | Asset Type | Output |
| --- | --- | --- |
| `script-source` | script | `run` command for supported extensions, source for others |
| `skill-md` | skill | Full SKILL.md content |
| `command-md` | command | Extracted template and description |
| `agent-md` | agent | Prompt content plus `action`, model hint, and tool policy |
| `knowledge-md` | knowledge | Content with view modes (full, toc, section, lines) |

### Extensibility

Custom matchers and renderers can be registered in source to support new
asset types. Later registrations win ties at the same specificity, so
custom matchers override built-in ones. See `src/matchers.ts` and
`src/renderers.ts` for examples.

## The Stash

The stash is where assets live on disk. Assets are resolved from three
sources in priority order:

1. **Primary stash** -- The user's main stash directory
   (`AKM_STASH_DIR`). Created by `akm init`. Default destination for `clone`.

2. **Search paths** -- Additional directories listed in config (`searchPaths`).
   Useful for sharing assets across teams or projects.

3. **Installed kits** (cache-managed) -- Kits installed via `akm add`. Stored
   in the cache directory and tracked in config. Not safe to edit in place
   because `akm update` may overwrite changes.

The first match wins when searching or showing assets. This means local
edits always override installed versions.

## Metadata

Each asset type directory can contain a `.stash.json` sidecar file with
structured metadata. When no `.stash.json` exists, the indexer derives metadata
in memory for the search index from filenames, code comments, frontmatter, and
package.json.
See [filesystem.md](filesystem.md) for the full field reference.

## Script Execution (ExecHints)

For script assets, akm resolves execution hints with three
levels of precedence:

1. **`.stash.json`** fields (`run`/`setup`/`cwd`) take highest priority
2. **Header comment tags** (`@run`/`@setup`/`@cwd`) in the script file
3. **Auto-detection** from extension + nearby dependency files

### Interpreter auto-detection

| Extension | Interpreter |
| --- | --- |
| `.sh` | bash |
| `.ts`, `.js` | bun |
| `.py` | python |
| `.rb` | ruby |
| `.go` | go run |
| `.ps1` | powershell -File |
| `.cmd`, `.bat` | cmd /c |
| `.pl` | perl |
| `.php` | php |
| `.lua` | lua |
| `.r` | Rscript |
| `.swift` | swift |
| `.kt`, `.kts` | kotlin |

### Setup signal detection

When a dependency file is found in the script's directory, a setup command
is auto-suggested:

| File | Setup command |
| --- | --- |
| `package.json` | `bun install` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `Gemfile` | `bundle install` |
| `go.mod` | `go mod download` |

## Further Reading

- [CLI Reference](cli.md)
- [Kit Maker's Guide](kit-makers.md) -- How to build and share a kit
- [Registry](registry.md) -- Finding and installing kits
- [Search Architecture](search.md) -- Hybrid search details
- [Indexing](indexing.md) -- How the search index is built
- [Filesystem Layout](filesystem.md) -- Directory structure and metadata schema
- [Configuration](configuration.md) -- Providers and settings
