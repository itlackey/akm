# Supported Formats

AKM is a portable capability library for AI agents: one library for every
agent. Interoperability is the point — AKM doesn't only manage its own asset
library, it can point at a directory that already follows a *different*
convention (a Claude Code project, an OKF knowledge base, a Karpathy-style LLM
wiki, a crawled website, …) and index, search, and validate it in place,
without you converting anything first.

A directory AKM indexes this way is a **bundle**. AKM auto-detects which
format a bundle uses — you never declare it yourself unless you want to pin
one explicitly. 0.9.0 recognizes 11 formats.

## Format compatibility

| Format | What AKM indexes | Auto-detection marker | Current read/write support | Typical use |
| --- | --- | --- | --- | --- |
| `website-snapshot` | Crawled pages tagged `website` (name, description, full body, original crawl URL) | Root `manifest.json` with `url` + `fetchedAt` | Read-only | A website materialized locally via `akm bundle add <url>` |
| `agent-skills` | Standalone Agent Skills packages as type `skill` (name, description, tags, body) | A direct child directory containing `SKILL.md` | Read-only | The [github.com/anthropics/skills](https://github.com/anthropics/skills) layout — one `<name>/SKILL.md` per package at the bundle root |
| `claude` | `CLAUDE.md` as `instruction`; `commands/`, `agents/`, `skills/<name>/SKILL.md` as their matching types | Root `CLAUDE.md` plus at least one of `commands/`, `agents/`, `skills/` | Read-only | Point AKM at an existing Claude Code `.claude` tool directory |
| `opencode` | Same shape as `claude`, rooted on `AGENTS.md` | `opencode.json`/`opencode.jsonc`, or root `AGENTS.md` plus a canonical plural tool directory | Read-only | Point AKM at an existing OpenCode `.opencode` tool directory |
| `dotenv` | `env` entries as key names only (never values); `secret` entries as file names only (never content) | Every top-level directory is `env/` and/or `secrets/`, with at least one present | Writable, narrowly — `akm env create`/`env remove`/`secret set` only | A standalone env/secrets-only bundle |
| `akm-workflow` | Workflow steps, name, description, tags | A top-level `.md` file with explicit `type: workflow` frontmatter | Writable — `akm workflow create` only | A standalone workflow bundle, one workflow per file |
| `akm-task` | Task source v4 (`version: 4`) `.yml` sources as type `task`, including local schedules/manual triggers and the exact authored YAML | A top-level `.yml` file accepted by the task source v4 parser (`version: 4`, one `uses`/`run` executable selector, optional top-level `schedule:`) | Read-only | A standalone scheduled-task bundle; `.yaml` is rejected |
| `llm-wiki` | `raw/` sources as `wiki-source`; `pages/` as their `pageKind` (default `note`), with resolved cross-reference links | Root `schema.md` plus a `pages/` directory | Read-only (author by writing directly into `pages/`; AKM indexes and serves the result) | [Karpathy's LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — agent-authored reference wikis |
| `akm` (native) | AKM's own 14 native asset types — see [Asset Types](https://github.com/itlackey/akm/blob/main/docs/reference/asset-types.md) | A `.stash` marker directory, or two-plus native subdirectories, or the fallback when nothing else matches | Fully writable — every AKM-native write command | Your working bundle, and any bundle authored as AKM's own format |
| `okf` | Frontmatter `type` (defaults to `knowledge`); name, description, tags, links, body | A root `index.md`, or any `.md` file anywhere carrying a non-empty frontmatter `type` | Read-only | The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — the portable baseline every markdown-based format here is a superset of |
| `generic-files` | Files classified by extension: scripts, markdown/text as `document`, everything else as `file` | None — only claimed via an explicit `components.<id>.adapter: "generic-files"` config override | Read-only | A catch-all for a directory that doesn't match any other format |

**Read-only** here means AKM's own write commands (`akm remember`, `akm
import`, `proposal accept`, and similar) won't create or edit files in a
bundle of that format. Reading, searching, and `akm lint` validation work
against every format in the table above regardless of write support.

For native tool formats such as `claude` and `opencode`, the adapter translates
recognized native agents and commands into AKM's indexed/runtime representation
when the bundle is read. AKM does not create a canonical copy, synchronize tool
directories, or write translated assets back into those native bundles. The
native files remain authoritative.

## Task format

The `akm-task` adapter and native AKM task directory accept exactly one task
source grammar: `version: 4` task source v4 (typed `inputs:`, a single
bounded `output:` schema, and OPTIONAL scheduling). A `version: 3` or
`version: 2` document is no longer read by `src` at all — it fails to load
with `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming `akm migrate` as the path
forward. An `akm-task` source is `.yml` only; `.yaml` is diagnosed but never
indexed, scheduled, or executed. See [Tasks](tasks.md).

## Workflow formats

Workflow sources are `.md` and compile to source IR. Task sources are `.yml`
only, authored as task source v4. See
[Tasks](tasks.md) and [Workflow Schema](workflow-schema.md).

## Why this matters

This table is the proof of the first pillar: **one library for every agent**.
You don't migrate a Claude Code project, an OpenCode project, or an OKF
knowledge base into AKM's own layout to get search, curation, and validation
over it — AKM meets each format where it already lives. Writing new
capabilities back into a foreign-format bundle is a separate, narrower
guarantee; see [Adapters](https://github.com/itlackey/akm/blob/main/docs/architecture/adapters.md) for exactly which
formats are writable today and why.

## See also

- [Asset Types](https://github.com/itlackey/akm/blob/main/docs/reference/asset-types.md) — the 14 native asset types AKM's own format recognizes
- [Adapters](https://github.com/itlackey/akm/blob/main/docs/architecture/adapters.md) — how AKM picks a format, the write-path internals, and current caveats
- [Agent, Command, Engine, and Model Resolution](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/agent-command-engine-model-design.md) — approved runtime semantics for translated native agents and commands
- [Concepts](https://github.com/itlackey/akm/blob/main/docs/guides/concepts.md) — the retrieval loop these formats feed
- [Wikis](https://github.com/itlackey/akm/blob/main/docs/guides/wikis.md) — the `llm-wiki` authoring workflow
