# Wikis

akm provides multi-wiki support modelled on [Andrej Karpathy's LLM
Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern: a markdown-based knowledge base that an LLM agent maintains
together with a human, on a filesystem it can read and write directly,
with no special SDK.

## The design

A wiki is a directory. Full stop.

```
<stashDir>/
  wikis/
    <wiki-name>/
      schema.md            rulebook the agent reads first
      index.md             catalog of pages, regenerable
      log.md               append-only activity log
      raw/                 immutable ingested sources (never edit)
      <page>.md            agent-authored pages
      <topic>/<page>.md    optional nesting
```

Three layers, from Karpathy's gist:

- **Raw sources** (`raw/`) — what you ingest. Articles, papers,
  transcripts, notes. Immutable.
- **Wiki pages** (`<page>.md`, optionally nested) — what the agent writes.
  Summaries, entity pages, concept pages, FAQs. Cross-referenced via
  `xrefs:` frontmatter.
- **Schema** (`schema.md`) — the per-wiki configuration: voice, page
  kinds, contradiction policy, any conventions the agent should follow.
  You edit it freely; akm never touches it after `create`.

### Principle — akm surfaces, the agent writes

Karpathy's workflow is a conversation between a human, an agent, and a
filesystem. akm is not that agent. akm's job is to make the conversation
safer and more discoverable.

akm owns only operations with invariants an agent could get wrong:

- Lifecycle (`create`, `list`, `show`, `remove`)
- Raw immutability + unique slug generation (`stash`)
- Structural lint — deterministic checks only, no LLM (`lint`)
- Index regeneration (side effect of `akm index`)
- Workflow discovery (`ingest` — prints the recipe; does nothing else)

Page writes — create, append, xref, log — all use the agent's native
`Read` / `Write` / `Edit` tools. akm surfaces the paths; the agent does
the writing.

No LLM calls are made anywhere in the wiki surface. No network access.
No `--llm` flag.

## Command surface (10 verbs)

### Lifecycle

```sh
akm wiki create <name>       # scaffold wikis/<name>/ with empty schema/index/log/raw
akm wiki register <name> <path-or-repo>
                             # register an existing directory/repo as a wiki
akm wiki list                # table: name, pages, raws, last-modified
akm wiki show <name>         # path, description, counts, last 3 log entries
akm wiki remove <name> --force [--with-sources]
                              # deletes pages/index/log/schema; preserves raw/
                              # unless --with-sources. For external wikis,
                              # unregisters without touching source files.
```

Wiki names must match `^[a-z0-9][a-z0-9-]*$`.

`akm add --type wiki --name <name> <path-or-repo>` is a shortcut to
`akm wiki register <name> <path-or-repo>`.

### Orientation

```sh
akm wiki pages <name>        # list page refs + frontmatter descriptions
akm wiki search <name> <q>   # scope-filtered search (see below)
akm wiki ingest <name>       # print the ingest workflow; no action
```

`akm wiki search <n> <q>` is a convenience — wiki pages are first-class
in stash-wide `akm search`, so `akm search <q> --type wiki` returns
them too, mixed with skills, commands, and everything else. Raw sources
under `raw/` plus the wiki root infrastructure files `schema.md`,
`index.md`, and `log.md` are intentionally excluded from the search
index and search results.

### The one akm-owned write

```sh
akm wiki stash <name> <source>        # copy to raw/<slug>.md with frontmatter
cat source.md | akm wiki stash <n> -  # stdin form
akm wiki stash <name> <source> --as <slug>  # override derived slug
```

Invariants `stash` guarantees:

1. Raw files never overwrite. Collisions get `-1`, `-2`, … suffixes.
2. The final path is guaranteed to be under `<wiki>/raw/`.
3. If the content has no frontmatter, a `wikiRole: raw` block is added.

### Structural health

```sh
akm wiki lint <name>
```

Lint findings (deterministic):

| Kind | Meaning |
| --- | --- |
| `orphan` | Page has no incoming AND no outgoing xrefs |
| `broken-xref` | xref points at a non-existent page in this wiki |
| `missing-description` | Page frontmatter `description` is empty/missing |
| `uncited-raw` | `raw/<slug>.md` not listed in any page's `sources:` |
| `stale-index` | `index.md` mtime older than newest page, or missing |

## Page frontmatter

Every page should carry frontmatter so the lint + index machinery can
find and link it:

```yaml
---
description: one-sentence summary used in search and lint
pageKind: entity | concept | question | note | <your-custom-kind>
xrefs:
  - wiki:<this-wiki>/other-page
  - wiki:<other-wiki>/relevant-page   # cross-wiki xrefs are allowed
sources:
  - raw/<slug>.md
---
```

`pageKind` accepts any non-empty string. Add new categories freely by
using them in a page's frontmatter; the next `akm index` run surfaces
them in `index.md` as a new section automatically.

## The ingest workflow (what agents do)

Run `akm wiki ingest <name>` to see the workflow inline — it prints the
full recipe parameterised with the wiki's absolute path and schema
location. The workflow in prose:

1. **Read the schema.** Open `wikis/<name>/schema.md`. It defines the
   voice, page kinds, contradiction policy, and any wiki-specific
   conventions.
2. **File the source under `raw/`.** `akm wiki stash <name> <source>`.
   The raw copy is immutable — never edit it afterwards.
3. **Find related pages.** `akm wiki search <name> "<key terms>"`.
4. **Decide for each candidate.** Append a section, note a
   contradiction, or skip. Follow the schema's contradiction policy.
5. **Create new pages** for concepts/entities the source introduces.
   Every new page needs `description`, `pageKind`, `xrefs`, and
   `sources` in its frontmatter.
6. **Update xrefs both ways.** `akm wiki lint` flags violations.
7. **Append to `log.md`.** One entry per ingest: date, source slug,
   one-line summary, refs to created/edited pages. Newest at the top.
8. **Regenerate + verify.** `akm index` rebuilds each wiki's
   `index.md`. `akm wiki lint <name>` confirms the changes are clean.

## Example session

```sh
# Set up a fresh research wiki
akm wiki create research
akm wiki list
# NAME       PAGES  RAWS  LAST-MODIFIED
# research   0      0     2026-04-23T01:50:54.428Z

# Stash a source
echo "# Attention Is All You Need" | akm wiki stash research - --as attention
# { "slug": "attention", "path": "…/wikis/research/raw/attention.md", ... }

# Get the workflow for this wiki
akm wiki ingest research
# (prints the recipe — agent follows it)

# Agent creates pages with its native file tools, then:
akm index
akm wiki pages research
akm wiki lint research        # → "0 finding(s) — clean."

# Search within this wiki
akm wiki search research "attention mechanism"
# (returns page hits scoped to wikis/research/…; excludes raw/schema/index/log)

# Or mix wiki hits with everything else
akm search "attention" --type wiki
```

## Filesystem layout and refs

Wiki pages are addressable as `wiki:<name>/<page-path>`:

| File | Ref |
| --- | --- |
| `wikis/research/ml-basics.md` | `wiki:research/ml-basics` |
| `wikis/research/sub/page.md` | `wiki:research/sub/page` |

Use `akm show wiki:research/ml-basics` to read a page with the standard
akm show machinery — `toc`, `section <heading>`, `lines <start> <end>`,
and `frontmatter` views all work.

Files in `raw/` and the wiki root infrastructure files still exist on
disk for ingest, linting, and regeneration, but they are not indexed as
wiki search results.

## What's deliberately absent

None of the following exist as akm verbs:

- `page-create`, `page-append`, `page-section`
- `xref`, `log-append`
- `frontmatter`, `schema`, `page`, `raw`
- `chat`, `query`
- `migrate`, `reindex`

Those are either semantic (contradiction resolution, answer synthesis)
or trivial (`ls`, `sed`) and belong in the agent's hands. Index
regeneration is a side effect of `akm index`, not a separate verb.
