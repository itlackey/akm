# LLM Wikis

akm supports [Andrej Karpathy's LLM
Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern: a markdown-based knowledge base that an LLM agent maintains
together with a human, on a filesystem it can read and write directly,
with no special SDK.

**As of 0.9.0 an LLM wiki is a bundle format, not an akm asset type.**
The `akm wiki` command family was removed with the 0.9.0 bundle-adapter
architecture; recognition moved into the first-class LLM Wiki adapter.

## The design

A wiki is a directory. Full stop.

```
<wiki-root>/
  schema.md                  rulebook the agent reads first
  index.md                   catalog of pages, regenerable
  log.md                     append-only activity log
  raw/                       immutable ingested sources (never edit)
  pages/<page>.md            agent-authored pages
  pages/<topic>/<page>.md    optional nesting
```

Three layers, from Karpathy's gist:

- **Raw sources** (`raw/`) — what you ingest. Articles, papers,
  transcripts, notes. Immutable.
- **Wiki pages** (`pages/<page>.md`, optionally nested) — what the agent
  writes. Summaries, entity pages, concept pages, FAQs. Cross-referenced
  via `xrefs:` frontmatter; provenance recorded via `sources:`
  frontmatter pointing at the cited raw files.
- **Schema** (`schema.md`) — the per-wiki configuration: voice, page
  kinds, contradiction policy, any conventions the agent should follow.
  akm never touches it.

### Principle — akm surfaces, the agent writes

Karpathy's workflow is a conversation between a human, an agent, and a
filesystem. akm is not that agent. Page writes — create, append, xref,
log — all use the agent's native `Read` / `Write` / `Edit` tools. akm's
job is recognition and discovery: it mounts the wiki, indexes the pages,
and makes them searchable alongside every other asset.

No LLM calls are made anywhere in the wiki surface. No network access.

## How akm sees a wiki (0.9.0)

The LLM Wiki adapter recognizes a wiki **deterministically at install
time**: a bundle component whose root holds a `schema.md` plus a
`pages/` directory is mounted as an `llm-wiki` component. From there:

- `pages/**.md` are indexed as searchable documents; each page's ref is
  `bundle//conceptId`, where the conceptId is the root-relative path
  minus `.md` (a page at `pages/attention.md` in bundle `research-wiki`
  is `research-wiki//pages/attention`).
- `raw/`, `schema.md`, `index.md`, and `log.md` are structural — they
  are never indexed as pages.
- `xrefs:` frontmatter becomes cross-reference edges; `sources:`
  frontmatter becomes citation edges back to raw files.

## Working with a wiki

```sh
akm add github:team/research-wiki        # install a wiki bundle (or point at a local dir)
akm search "attention"                   # pages rank alongside all other indexed content
akm show research-wiki//pages/attention  # read a page by ref
akm show research-wiki//pages/attention section "History"
```

To build a new wiki, create the directory shape above by hand (or have
your agent do it — `schema.md` plus an empty `pages/` is enough for
recognition), then add it as a bundle. Ingesting raw sources, writing
pages, and maintaining `index.md`/`log.md` are the agent's job, guided
by `schema.md`.
