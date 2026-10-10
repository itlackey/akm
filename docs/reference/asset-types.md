# Asset Types

Reference for the capability taxonomy the native `akm` adapter recognizes,
the bundle directory layout, and the metadata every asset carries.

## Contract

- akm's own native format (the `akm` adapter) recognizes **fourteen asset
  types**: script, skill, command, agent, knowledge, instruction, env,
  secret, workflow, lesson, memory, task, session, and fact.
- Scripts, knowledge, commands, agents, skills, and workflows are classified
  by **file extension and content**, not by directory name. A `.sh` file is
  a script whether it lives in `scripts/`, `deploy/`, or the bundle root; for
  these types the conventional directory names below are an **opt-in
  convention that improves indexing confidence**. The remaining types are
  **directory-required**: env, secret, memory, lesson, fact, session, task,
  and instruction assets are only discovered under their placement
  directories (a memory-shaped `.md` outside `memories/` indexes as plain
  knowledge).
- `type` is not part of an asset's ref — the placement subdirectory carries
  that signal. See [Refs](refs.md).
- Ten additional *bundle formats* beyond akm's own (Claude Code and OpenCode
  tool directories, OKF, LLM wikis, and more) are recognized, indexed, and
  validated in place by their own adapters — see
  [Bundle Types](bundle-types.md) for the full type-by-type table (purpose,
  what the agent gets, and example ref) and the other-format read/write
  picture.

## Directory layout

There's no required structure, but this skeleton is the opt-in convention:

```text
my-bundle/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (directories with SKILL.md)
  commands/       # Slash commands (.md with $ARGUMENTS or agent frontmatter)
  agents/         # Agent definitions (.md with model/tools frontmatter)
  knowledge/      # Reference documents (.md)
  instructions/   # Project guidance (.md)
  env/            # Environment files (.env) — groups of related config, loaded whole
  secrets/        # Secrets — one sensitive value per file (auth tokens, keys, certs)
  workflows/      # Workflow sources (.md)
  lessons/        # Distilled lessons (.md, see akm improve / proposals)
  memories/       # Recalled context fragments (.md, see Memory reference)
  facts/          # Durable bundle-level facts (.md)
  tasks/          # Task source v4 scheduled or on-demand automation (.yml only)
  sessions/       # Machine-placed indexed session summaries (.md)
  .meta/          # Optional bundle orientation, not indexed (see "Bundle orientation" below)
```

LLM Wikis are a related but separate concept: a wiki is its own installable
bundle (`akm bundle add github:team/research-wiki`), not a type-subdirectory
inside a regular bundle. See [Wikis](../guides/wikis.md) for how akm
recognizes and indexes them.

## Classification taxonomy

Scripts and knowledge are classified by **what they are**: a `.sh` file is a
script; a plain `.md` file is knowledge. Commands and agents are classified
by **how an LLM should use them**: a `.md` file with `$ARGUMENTS`
placeholders is a command template; one with `tools` in its frontmatter is an
agent definition. Workflow assets are `.md`, classified by `type: workflow`
or placement. Skills are a
**packaging convention**: a directory containing a `SKILL.md` file.

See [Classification](../architecture/internals/classification.md) for the
full specificity-based matching system.

## Metadata field reference

Metadata lives with the asset itself, not in a separate sidecar file:
frontmatter for markdown assets, and structured comments for scripts. The
indexer derives metadata from filenames, code comments, frontmatter, and
`package.json`.

See [Filesystem Layout](../architecture/internals/storage-locations.md) for
the full field reference.

### Bundle orientation: the `.meta/` convention

A bundle may carry an optional `.meta/` directory at its root holding
human-authored orientation for the bundle *as a whole* — purpose, key
assets, conventions, maintainer. This is distinct from per-asset metadata,
which still lives with each asset: `.meta/` never describes individual
assets, only the bundle itself.

```text
my-bundle/
  .meta/
    index.md          # shown by `akm show meta` — the default orientation doc
    about.md          # shown by `akm show meta:about`
    conventions.md     # shown by `akm show meta:conventions`
```

Because `.meta/` is a dot-directory, the indexer skips it — these docs never
appear in `akm search` and never compete for ranking. They are **direct-read
on demand**:

```sh
akm show meta                       # working bundle's .meta/index.md
akm show meta:about                 # working bundle's .meta/about.md
akm show akm//meta                  # the primary bundle explicitly
```

`akm show <origin>//meta:<name>` resolves `<name>.md` first, then an
extensionless `<name>`. The convention is open-ended: bundle owners add new
docs by dropping files into `.meta/` — no configuration or code changes
required. `akm bundle create` scaffolds a starter `.meta/index.md`.

**Known gap:** an install-ref origin (`akm show github:owner/repo//meta`)
does not currently resolve even for an installed bundle — origin resolution
matches only derived installation ids, not raw install refs. Use `akm//meta`
for the primary bundle, or the bundle key you gave it in `bundles`
(`config.json`), not the original install ref.

## Script execution (ExecHints)

For script assets, akm resolves execution hints in this order:

1. Header comment tags (`@run`, `@setup`, `@cwd`)
2. Auto-detection from extension and nearby dependency files

## Defaults

- Directory placement is advisory for scripts, knowledge, commands, agents,
  skills, and workflows; it is required for env, secret, memory, lesson,
  fact, session, task, and instruction discovery.
- A memory asset with no source directory pointed at it is written to the
  working bundle by `akm remember`.
- `facts/` holds durable bundle-level facts, including the organization,
  backlink, and domain convention facts the bundle skeleton ships with (see
  [Refs — namespacing](refs.md#namespacing)).

## Security / persistence implications

- `env` and `secret` assets carry protected values: key names are
  discoverable, but values are never written to stdout, the index, or
  structured output. See `STABILITY.md`'s "Protected env & secret values"
  entry for the exact contract and the safe injection path
  (`akm env run` / `akm secret run`).
- All asset content is plain files inside the bundle directory — the search
  index (`index.db`) is a derived, regenerable cache rebuilt by `akm index`;
  it is never the source of truth for asset content.
- `akm lint` only operates on writable sources, and `akm improve` on one of
  them: the bundle it writes to (`--bundle`, else `defaultWriteTarget`, else the
  working bundle). Read-only registry caches (`git`, `npm`, `website`) are
  excluded from improvement and lint passes even when they are indexed.

## Stability

Per `STABILITY.md`: asset `type` is a free-form, open string — `--type`
filtering is exact-match against an open set and deliberately unvalidated
(an unrecognized type returns zero hits, not an error). The `lesson` asset
type's schema (`when_to_use`, `description`) is stable, but its
distillation triggers and ranking are Experimental tuning targets. See
`STABILITY.md` for the full command- and surface-level tier index.

## See also

- [Concepts](../guides/concepts.md) — the four core ideas asset types fit into
- [Refs](refs.md) — how a conceptId is built from an asset's placement
- [Memory](memory.md) — the memory asset type's belief-state and derived-memory model
- [Bundle Types](bundle-types.md) — every bundle format akm recognizes, not just its own
- [Classification](../architecture/internals/classification.md) — the specificity-based matcher
- [Filesystem Layout](../architecture/internals/storage-locations.md) — full metadata field reference
