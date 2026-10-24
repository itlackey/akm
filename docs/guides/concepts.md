# Concepts

AKM is a portable capability library for AI agents: one local index that
holds every capability you've connected, and a small set of verbs any agent
can use to find, load, and improve it. Four ideas cover the whole mental
model.

## 1. A capability is something an agent can discover and use

A **capability** is any asset an agent can search for and act on: a script,
skill, command, agent definition, knowledge document, instruction, env file,
secret, workflow, lesson, memory, task, session summary, or fact. Scripts,
knowledge documents, commands, agents and workflows are classified by **what
they are** (file extension and content), not by which directory they live in:
a `.sh` file is a script whether it lives in `scripts/`, `deploy/`, or the
bundle root. Env files, secrets, memories and the other placement-based types
are recognized by their own directory.

See [Asset Types](../reference/asset-types.md) for the full taxonomy,
directory layout, and metadata field reference.

## 2. A bundle is a portable directory of capabilities

A **bundle** is a directory of capabilities you can connect, share, and
install: a local folder, a git repo, an npm package, or a crawled website.
`akm bundle add` infers the bundle's kind from the input shape; you never
pick it yourself. Every bundle materializes to a local directory that the
indexer walks.

Your **working bundle** (`~/akm` by default, created by `akm setup`) is where
writes go unless you say otherwise. The destination for `akm remember`,
`akm import`, `akm clone` and other writes is, in order: the destination flag
on the command, then `defaultWriteTarget` in config, then the working bundle.

Each bundle is read through one **adapter**, which decides what its files are
(a skill, a task, a wiki page) and how they are validated and written. akm
picks the adapter once, by probing the bundle in a fixed order from the most
specific layout to the least specific, records the choice in config, and falls
back to the native `akm` adapter; `akm bundle add <dir> --adapter <id>`
overrides the probe for a local directory. See [Adapters](../architecture/adapters.md) and
[Supported Formats](../reference/supported-formats.md).

See [Author Bundles](author-bundles.md) for how to build and share a bundle,
and [Registry](../reference/registry.md) for finding bundles other people have
published.

## 3. AKM builds a local index and uses progressive disclosure

Every connected bundle is folded into one local FTS5 index; there is no
per-bundle fan-out at query time. Two verbs work that index:

```text
search decides   -- a lean menu: type, name, ref, action, estimatedTokens (and keys for env assets)
show delivers    -- the full dispatch envelope: run command, prompt, content
```

That is the default (`--detail brief`) output of `akm search`. Search should
not accumulate show-level detail, and show should not require a prior search
call.

Search ranks by relevance (keyword match, fused with vector similarity when
semantic search is on), adjusted by [feedback](improve-the-library.md#akm-feedback)
within a bounded range, and has no preference for any bundle. A short ref
given to `akm show` resolves against the default bundle first, then the
remaining bundles in installation order. `akm clone` copies an asset into your
working bundle (or the bundle named by `--bundle`). The copy is a separate
asset with its own ref; when it lands in your default bundle under the same
name, the short ref resolves to it.

## 4. A ref names one asset

A **ref** is the compact identifier `akm search` and `akm curate` return and
`akm show` takes: `[bundle//]conceptId[#fragment]`. Copy it from the output
rather than building it. Refs for assets in the default bundle drop the
`bundle//` prefix; refs for assets in any other bundle carry it, and `akm show`
accepts the short form for any bundle.

See [Refs](../reference/refs.md) for the full grammar, rename semantics, and
namespacing conventions.

## How it fits together

```text
local folders / git / npm / websites
              |
              v
           bundles
              |
              v
        one local index
              |
              v
   curate -> show -> use/run -> feedback -> proposals
```

This is the retrieval loop: **connect** a source, **index** it, **curate** a
shortlist for a task, **show** the full payload, **use/run** it, send
**feedback**, and let accumulated signal become a **proposal**. Search and
show only return content; running a script, workflow, task or agent is a
separate command. See [Core Principles](../architecture/akm-core-principles.md).

## See also

- [Asset Types](../reference/asset-types.md) — the full capability taxonomy, directory layout, and metadata fields
- [Refs](../reference/refs.md) — ref grammar, rename semantics, and namespacing
- [Memory](../reference/memory.md) — belief states, capture modes, and derived memories
- [Registry](../reference/registry.md) — finding and installing bundles
- [Architecture](../architecture/architecture.md) — how indexing, search, and execution fit together
- [Author Bundles](author-bundles.md) — how to build and share a bundle
